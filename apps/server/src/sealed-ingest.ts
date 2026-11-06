import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, statfsSync } from 'node:fs';
import { readdir, rename, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { HttpError, jobIdSchema, type JobId, type SealedState, type StoredJob } from './contracts.js';
import { Jobs, hashToken } from './jobs.js';
import type { PairingAuthority, PairingDestination, PairingKeyStore } from './pairing.js';
import { Binding, GenerationKeys, Manifest, VerifiedAck, VerifiedGroup, VerifiedReceipt, decodeQuery, encodeAck, encodeOutcome, encodeReceipt, encodeSetup, encodeStatus, limits, parseGroupHeader, type GroupSource } from './sealed-protocol.js';
import { fileIdentity, originalPath, prepareOriginal, privateDirectory, privateFile, repairOriginalOrphans, syncDirectory, type PublicationBoundary } from './originals.js';

export type IngestBoundary = PublicationBoundary | 'group-sync' | 'group-rename' | 'group-directory-sync' | 'group-db' | 'publication-db' | 'before-response' | 'cleanup';
type Config = {
  directory: string;
  jobs: Jobs;
  authority: Pick<PairingAuthority, 'identity' | 'serviceOrigin' | 'authorize' | 'assertActiveEpoch'>;
  // No default provider. Implement with an authenticated OS-held wrapping key;
  // missing/replaced/locked key must throw, never regenerate.
  wrappingStore: PairingKeyStore;
  assertDestinationAccess: (manifest: Manifest) => void;
  now?: () => bigint;
  bodyTimeoutMs?: number;
  boundary?: (point: IngestBoundary) => void;
};

export function schemaUuid(hex: string): string {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new HttpError(400, 'Invalid UUID bytes.');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function pairingDestination(manifest: Manifest): PairingDestination {
  const d = manifest.fields.destination;
  return d.kind === 'standalone' ? { kind: 'intake', intake: jobIdSchema.parse(schemaUuid(d.intake)) } : { kind: 't3', environment: d.environment, project: d.project };
}
function jobId(manifest: Manifest): JobId { return jobIdSchema.parse(schemaUuid(manifest.fields.job)); }
function sealed(job: StoredJob): SealedState {
  if (job.transport !== 'sealed-v1' || !job.sealed) throw new HttpError(409, 'Transport is not sealed-v1.');
  return job.sealed;
}
function bitmap(state: SealedState): bigint { return state.groups.reduce((bits, group) => bits | (1n << BigInt(group.index)), 0n); }
function next(state: SealedState): string {
  const revision = BigInt(state.revision) + 1n;
  if (revision > 0xffffffffffffffffn) throw new Error('Revision exhausted.');
  return revision.toString();
}

class BodySource implements GroupSource {
  private readonly iterator: AsyncIterator<unknown>;
  private pending: Buffer = Buffer.alloc(0);
  private ended = false;
  private bytes = 0;
  constructor(req: IncomingMessage, private readonly declared: number | undefined) { this.iterator = req[Symbol.asyncIterator](); }
  private async more(): Promise<void> {
    const item = await this.iterator.next();
    if (item.done) {
      this.ended = true;
      if (this.declared !== undefined && this.bytes !== this.declared) throw new HttpError(400, 'Body length mismatch.');
      return;
    }
    if (!Buffer.isBuffer(item.value)) throw new HttpError(400, 'Invalid body.');
    this.bytes += item.value.length;
    if (this.bytes > limits.groupWire) throw new HttpError(413, 'Encrypted body exceeds wire limit.');
    this.pending = item.value;
  }
  async readExactly(length: number): Promise<Buffer> {
    if (length > limits.frame + 52) throw new HttpError(413, 'Frame limit.');
    const result = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      if (this.pending.length === 0) { if (this.ended) throw new HttpError(400, 'Truncated group.'); await this.more(); continue; }
      const count = Math.min(length - written, this.pending.length);
      this.pending.copy(result, written, 0, count);
      this.pending = this.pending.subarray(count); written += count;
    }
    return result;
  }
  async atEnd(): Promise<boolean> {
    if (this.pending.length) return false;
    if (!this.ended) await this.more();
    return this.ended;
  }
}

/** Isolated functional component: not instantiated or routed by main/server.
 * The caller owns Jobs' exclusive process lock and must await operations before closing it.
 */
export class SealedIngest {
  private busy = false;
  private activeBodyId: JobId | undefined;
  private readonly finalizers = new Map<JobId, Promise<void>>();
  private constructor(private readonly config: Config) {}
  static async open(config: Config): Promise<SealedIngest> {
    const owner = new SealedIngest(config);
    await privateDirectory(config.directory);
    await privateDirectory(owner.groupsDirectory);
    await privateDirectory(owner.quarantineDirectory);
    // Probe even empty storage; a provider cannot defer missing-key failure until setup.
    const probe = randomBytes(32);
    const context = `footage/sealed-v1/provider-check/${config.authority.identity.toString('hex')}/${config.authority.serviceOrigin}`;
    if (!config.wrappingStore.unwrap(config.wrappingStore.wrap(probe, context), context).equals(probe)) throw new Error('Wrapping provider unavailable.');
    for (const job of config.jobs.all()) {
      if (job.transport !== 'sealed-v1') continue;
      const manifest = owner.manifest(job);
      owner.keys(job, manifest); // Key loss blocks startup, not a fresh generation.
    }
    await owner.repair();
    return owner;
  }
  private get groupsDirectory(): string { return join(this.config.directory, 'sealed-groups'); }
  private get quarantineDirectory(): string { return join(this.config.directory, 'sealed-quarantine'); }
  private now(): bigint { return this.config.now?.() ?? BigInt(Math.floor(Date.now() / 1000)); }
  private boundary(point: IngestBoundary): void { this.config.boundary?.(point); }
  private manifest(job: StoredJob): Manifest {
    const manifest = Manifest.decode(Buffer.from(sealed(job).manifest, 'base64'));
    Binding.match(manifest, { receiver: this.config.authority.identity.toString('hex'), origin: this.config.authority.serviceOrigin });
    if (jobId(manifest) !== job.id || Number(manifest.fields.originalBytes) !== job.bytes || manifest.fields.originalSHA256 !== job.sha256) throw new Error('Stored manifest identity mismatch.');
    pairingDestination(manifest);
    return manifest;
  }
  private context(manifest: Manifest): string {
    return `footage/sealed-v1/master/${manifest.fields.receiver}/${manifest.fields.origin}/${manifest.fields.job}/${manifest.fields.generation}/${manifest.digest}`;
  }
  private master(job: StoredJob, manifest: Manifest): Buffer {
    const master = this.config.wrappingStore.unwrap(Buffer.from(sealed(job).wrappedMaster, 'base64'), this.context(manifest));
    if (master.length !== 32) throw new Error('Invalid wrapped master.');
    return master;
  }
  private keys(job: StoredJob, manifest: Manifest): GenerationKeys {
    const master = this.master(job, manifest);
    try { return GenerationKeys.fromSetup(master, manifest); } finally { master.fill(0); }
  }
  private authorize(manifest: Manifest, credential: Buffer, permission: 1 | 2 | 4): void {
    const f = manifest.fields;
    this.config.authority.authorize({ device: Buffer.from(f.device, 'hex'), owner: Buffer.from(f.device, 'hex'), epoch: f.enrollmentEpoch, credential, permission, destination: pairingDestination(manifest) });
  }
  private active(manifest: Manifest): void {
    this.config.authority.assertActiveEpoch(Buffer.from(manifest.fields.device, 'hex'), manifest.fields.enrollmentEpoch);
    this.config.assertDestinationAccess(manifest);
  }
  private healthy(job: StoredJob): void {
    if (job.storageFault || sealed(job).frozen) throw new HttpError(503, 'Storage integrity requires recovery.');
  }
  private groupName(job: StoredJob, index: number): string { return `${job.id}.${this.manifest(job).fields.generation}.${index}`; }
  private groupPath(job: StoredJob, index: number): string { return join(this.groupsDirectory, this.groupName(job, index)); }

  async setup(bytes: Buffer, credential: Buffer): Promise<Buffer> {
    const manifest = Manifest.decode(bytes);
    const id = jobId(manifest); // Reject broad binary UUIDs incompatible with the shared profile now.
    Binding.match(manifest, { receiver: this.config.authority.identity.toString('hex'), origin: this.config.authority.serviceOrigin });
    pairingDestination(manifest);
    return this.config.jobs.exclusive(id, async () => {
      this.authorize(manifest, credential, 1); this.active(manifest);
      let existing: StoredJob | undefined;
      try { existing = this.config.jobs.get(id); } catch (error) { if (!(error instanceof HttpError && error.status === 404)) throw error; }
      if (existing) {
        const saved = sealed(existing);
        if (this.manifest(existing).digest !== manifest.digest) throw new HttpError(409, 'Immutable setup binding conflicts.');
        this.healthy(existing);
        if (saved.state !== 'received' && manifest.fields.expiresAt <= this.now()) { await this.terminate(existing, 'expired'); throw new HttpError(410, 'Expired.'); }
        if (['cancelled', 'expired', 'failed'].includes(saved.state)) throw new HttpError(410, 'Terminal generation.');
        await syncDirectory(this.config.directory);
        const master = this.master(existing, manifest);
        try { return encodeSetup(this.keys(existing, manifest), master); } finally { master.fill(0); }
      }
      manifest.validateSetupTime(this.now());
      const disk = statfsSync(this.config.directory, { bigint: true });
      const required = BigInt(this.config.jobs.reservedBytes()) + manifest.fields.originalBytes * 2n + 64n * 1024n ** 2n;
      if (disk.bavail * disk.bsize < required) throw new HttpError(507, 'Insufficient free storage for reserved plaintext and assembly.');
      const { master, keys } = GenerationKeys.fresh(manifest);
      try {
        const wrapped = this.config.wrappingStore.wrap(master, this.context(manifest));
        if (!this.config.wrappingStore.unwrap(wrapped, this.context(manifest)).equals(master)) throw new Error('Wrapping failed.');
        this.config.jobs.insertSealed({
          id, name: manifest.fields.safeName, bytes: Number(manifest.fields.originalBytes), sha256: manifest.fields.originalSHA256,
          tokenHash: hashToken(randomBytes(32).toString('hex')), transport: 'sealed-v1', status: 'uploading', receipt: null,
          sealed: { manifest: bytes.toString('base64'), wrappedMaster: wrapped.toString('base64'), revision: '0', state: 'uploading', cleanup: 0, frozen: false, groups: [], receiptEnvelope: null },
        });
        await syncDirectory(this.config.directory);
        return encodeSetup(keys, master);
      } finally { master.fill(0); }
    });
  }

  async ingest(req: IncomingMessage): Promise<Buffer> {
    if (req.method !== 'POST') throw new HttpError(405, 'POST required.');
    if (req.headers.authorization !== undefined || req.headers['proxy-authorization'] !== undefined || req.headers.cookie !== undefined || req.headers['content-encoding'] !== undefined || req.headers['content-type'] !== 'application/octet-stream' || (req.url ?? '').includes('?')) throw new HttpError(400, 'Encrypted bodies carry no control authority or encoding.');
    const length = req.headers['content-length'];
    const declared = length === undefined ? undefined : Number(length);
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 128 || declared > limits.groupWire)) throw new HttpError(413, 'Wire limit.');
    if (this.busy) throw new HttpError(503, 'Encrypted quarantine busy; retry later.');
    this.busy = true;
    const timer = setTimeout(() => req.destroy(new Error('Encrypted body deadline.')), this.config.bodyTimeoutMs ?? 30_000);
    timer.unref();
    const temporary = join(this.quarantineDirectory, randomUUID());
    let file: Awaited<ReturnType<typeof privateFile>> | undefined;
    try {
      const source = new BodySource(req, declared);
      const header = await source.readExactly(128);
      if (header.toString('ascii', 0, 8) !== 'FTSEAL01') throw new HttpError(400, 'Invalid group header.');
      const id = jobIdSchema.parse(schemaUuid(header.subarray(40, 56).toString('hex')));
      this.activeBodyId = id;
      const initial = this.config.jobs.get(id); // Never register through a public body.
      const manifest = this.manifest(initial), binding = Binding.match(manifest, manifest.fields);
      const partition = parseGroupHeader(header, binding);
      this.healthy(initial);
      if (!['uploading', 'verifying', 'received'].includes(sealed(initial).state) || (initial.status !== 'received' && manifest.fields.expiresAt <= this.now())) throw new HttpError(410, 'Terminal generation.');
      const expectedWire = 128 + partition.length + partition.frameCount * 52;
      if (declared !== undefined && declared !== expectedWire) throw new HttpError(400, 'Partition wire length mismatch.');
      const keys = this.keys(initial, manifest);
      file = await privateFile(temporary);
      const output = file;
      const hash = createHash('sha256');
      const sealIds: string[] = [];
      let first = true;
      const verified = await VerifiedGroup.authenticate({
        async readExactly(count) {
          if (first) { first = false; return header; }
          const packet = await source.readExactly(count);
          sealIds.push(packet.subarray(8, 24).toString('hex'));
          return packet;
        },
        atEnd: () => source.atEnd(),
      }, {
        async write(_frame, plaintext) { hash.update(plaintext); await output.writeFile(plaintext); },
        async discard() { await output.close(); await rm(temporary, { force: true }); },
      }, binding, keys);
      clearTimeout(timer); // No socket work or response delivery participates in the job lock.
      const plaintextHash = hash.digest('hex');
      const ack = await this.config.jobs.exclusive(id, async () => {
        const job = this.config.jobs.get(id), state = sealed(job);
        this.healthy(job);
        if (this.manifest(job).digest !== manifest.digest) throw new HttpError(409, 'Generation changed.');
        if (!['uploading', 'verifying', 'received'].includes(state.state)) throw new HttpError(410, 'Terminal generation.');
        if (job.status !== 'received' && manifest.fields.expiresAt <= this.now()) { await this.terminate(job, 'expired'); throw new HttpError(410, 'Expired.'); }
        // A received replay preserves its immutable receipt; revocation denies new commits.
        if (job.status !== 'received') {
          try { this.active(manifest); }
          catch (error) { await this.terminate(job, 'cancelled'); throw error; }
        }
        const prior = state.groups.find(group => group.index === partition.group);
        if (prior) {
          if (prior.wireHash !== verified.wireSHA256) throw new HttpError(409, 'Conflicting ciphertext.');
          return Buffer.from(prior.ack, 'base64');
        }
        if (job.status === 'received') throw new HttpError(409, 'Received original is immutable.');
        const used = new Set(state.groups.flatMap(group => group.sealIds));
        if (sealIds.some(seal => used.has(seal))) throw new HttpError(409, 'Seal identity reused.');
        const revision = next(state);
        const ack = encodeAck(keys, { group: partition.group, wireSHA256: verified.wireSHA256, revision: BigInt(revision) });
        await output.sync(); this.boundary('group-sync');
        await output.close();
        await rename(temporary, this.groupPath(job, partition.group)); this.boundary('group-rename');
        await syncDirectory(this.groupsDirectory); this.boundary('group-directory-sync');
        const groups = [...state.groups, { index: partition.group, wireHash: verified.wireSHA256, plaintextHash, ack: ack.toString('base64'), sealIds }];
        this.config.jobs.save({ ...job, sealed: { ...state, groups, revision, state: groups.length === manifest.groupCount ? 'verifying' : 'uploading' } });
        this.boundary('group-db');
        return ack;
      });
      await this.finalize(id);
      const current = this.config.jobs.get(id);
      this.boundary('before-response');
      return encodeOutcome(ack, Buffer.from(sealed(current).receiptEnvelope ?? '', 'base64'));
    } finally {
      clearTimeout(timer);
      try { await file?.close(); await rm(temporary, { force: true }); }
      finally { this.activeBodyId = undefined; this.busy = false; }
    }
  }

  async status(id: JobId, bytes: Buffer, credential: Buffer, revoke = false): Promise<Buffer> {
    return this.config.jobs.exclusive(id, async () => {
      let job = this.config.jobs.get(id);
      const manifest = this.manifest(job), query = decodeQuery(bytes, manifest);
      this.authorize(manifest, credential, revoke ? 4 : 2);
      this.healthy(job);
      if (job.status !== 'received') {
        if (revoke) job = await this.terminate(job, 'cancelled');
        else if (manifest.fields.expiresAt <= this.now()) job = await this.terminate(job, 'expired');
        else if (sealed(job).cleanup === 1) job = await this.cleanup(job);
      }
      const state = sealed(job);
      const codes = { uploading: 1, verifying: 2, received: 3, cancelled: 4, expired: 5, failed: 6 };
      return encodeStatus(this.keys(job, manifest), query, { revision: BigInt(state.revision), state: codes[state.state], cleanup: state.cleanup, groupBitmap: bitmap(state) }, Buffer.from(state.receiptEnvelope ?? '', 'base64'));
    });
  }

  /** Trusted local pairing/destination owner calls this after revocation/access changes.
   * Packet commit and final publication also recheck, even if this sweep has not run.
   */
  async reconcileAuthority(): Promise<void> {
    for (const initial of this.config.jobs.all()) {
      if (initial.transport !== 'sealed-v1' || initial.status !== 'uploading') continue;
      await this.config.jobs.exclusive(initial.id, async () => {
        const job = this.config.jobs.get(initial.id);
        if (job.status !== 'uploading' || sealed(job).frozen) return;
        try { this.active(this.manifest(job)); }
        catch { await this.terminate(job, 'cancelled'); }
      });
    }
  }

  private async terminate(job: StoredJob, outcome: 'cancelled' | 'expired' | 'failed'): Promise<StoredJob> {
    const state = sealed(job);
    if (job.status === 'received') return job;
    if (state.state === 'uploading' || state.state === 'verifying') {
      job = { ...job, status: outcome === 'cancelled' || outcome === 'expired' ? 'cancelled' : 'failed', sealed: { ...state, state: outcome, cleanup: 1, revision: next(state) } };
      this.config.jobs.save(job); // Durable tombstone precedes all deletion.
    }
    return this.cleanup(job);
  }
  private async cleanup(job: StoredJob): Promise<StoredJob> {
    const state = sealed(job);
    if (state.cleanup !== 1 || state.frozen || this.activeBodyId === job.id || this.finalizers.has(job.id)) return job;
    try {
      this.boundary('cleanup');
      for (const group of state.groups) await rm(this.groupPath(job, group.index), { force: true });
      await rm(join(this.config.directory, 'originals', job.id), { force: true });
      await syncDirectory(this.groupsDirectory);
      await syncDirectory(join(this.config.directory, 'originals'));
      // Keep acknowledged ranges/acks and keys for truthful reconciliation; never lower the prefix.
      const updated = { ...job, sealed: { ...state, cleanup: 2, revision: next(state) } } satisfies StoredJob;
      this.config.jobs.save(updated);
      return updated;
    } catch { return job; } // Offline/unavailable storage is pending, never false cleanup success.
  }

  private async finalize(id: JobId): Promise<void> {
    const running = this.finalizers.get(id);
    if (running) return running;
    const task = this.finish(id);
    this.finalizers.set(id, task);
    try { await task; } finally { this.finalizers.delete(id); }
  }
  private async finish(id: JobId): Promise<void> {
    const initial = this.config.jobs.get(id), state = sealed(initial);
    if (state.state !== 'verifying' || state.frozen) return;
    const manifest = this.manifest(initial), keys = this.keys(initial, manifest);
    // Validate receipt UUID/time/profile BEFORE writing a publishable original.
    const receipt = { ...this.config.jobs.newReceipt(initial, this.now()), binding: { receiver: manifest.fields.receiver, generation: manifest.fields.generation, manifestDigest: manifest.digest, destinationDigest: manifest.destinationDigest } };
    const envelope = encodeReceipt(keys, { id: receipt.id.replaceAll('-', ''), verifiedAt: BigInt(Date.parse(receipt.verifiedAt) / 1000), revision: BigInt(next(state)) });
    VerifiedReceipt.verify(envelope, keys).toOriginalReceipt();
    const owner = this;
    async function* chunks() {
      for (let index = 0; index < manifest.groupCount; index++) {
        yield* createReadStream(owner.groupPath(initial, index));
      }
    }
    try { await prepareOriginal(this.config.directory, initial, chunks(), point => this.boundary(point)); }
    catch (error) {
      if (error instanceof HttpError && error.status === 422) {
        await this.config.jobs.exclusive(id, async () => { await this.terminate(this.config.jobs.get(id), 'failed'); });
      }
      throw error;
    }
    await this.config.jobs.exclusive(id, async () => {
      const job = this.config.jobs.get(id), current = sealed(job);
      this.healthy(job);
      if (current.state !== 'verifying') { await this.cleanup(job); return; }
      if (manifest.fields.expiresAt <= this.now()) { await this.terminate(job, 'expired'); return; }
      try { this.active(manifest); }
      catch (error) { await this.terminate(job, 'cancelled'); throw error; }
      if (this.manifest(job).digest !== manifest.digest || current.revision !== state.revision) throw new HttpError(409, 'Publication state changed.');
      this.config.jobs.publish({ ...job, sealed: { ...current, state: 'received', revision: next(current), receiptEnvelope: envelope.toString('base64') } }, receipt);
      this.boundary('publication-db');
    });
  }

  private async repair(): Promise<void> {
    const jobs = this.config.jobs;
    await repairOriginalOrphans(this.config.directory, jobs.all());
    for (const name of await readdir(this.quarantineDirectory)) await rm(join(this.quarantineDirectory, name), { force: true });
    await syncDirectory(this.quarantineDirectory);
    const referenced = new Set<string>();
    for (const job of jobs.all()) {
      if (job.transport !== 'sealed-v1') continue;
      const state = sealed(job);
      if (state.cleanup !== 0) continue;
      for (const group of state.groups) referenced.add(this.groupName(job, group.index));
      try {
        const manifest = this.manifest(job), keys = this.keys(job, manifest);
        if ((job.status === 'received') !== (state.state === 'received')) throw new Error('Terminal state mismatch.');
        const indices = new Set(state.groups.map(group => group.index));
        if (indices.size !== state.groups.length) throw new Error('Duplicate persisted range.');
        manifest.contiguous(bitmap(state));
        const sealIds = state.groups.flatMap(group => group.sealIds);
        if (new Set(sealIds).size !== sealIds.length) throw new Error('Persisted seal identity reused.');
        for (const group of state.groups) {
          const ack = VerifiedAck.verify(Buffer.from(group.ack, 'base64'), keys, { group: group.index, wireSHA256: group.wireHash });
          if (ack.revision > BigInt(state.revision)) throw new Error('Persisted ack revision mismatch.');
          const identity = await fileIdentity(this.groupPath(job, group.index));
          if (identity.bytes !== manifest.partition(group.index).length || identity.sha256 !== group.plaintextHash) throw new Error('Committed group mismatch.');
        }
        if (job.status === 'received') {
          const identity = await fileIdentity(originalPath(this.config.directory, job));
          if (identity.bytes !== job.bytes || identity.sha256 !== job.sha256) throw new Error('Published original mismatch.');
          if (!job.receipt || !state.receiptEnvelope) throw new Error('Missing receipt.');
          const decoded = VerifiedReceipt.verify(Buffer.from(state.receiptEnvelope, 'base64'), this.keys(job, manifest)).toOriginalReceipt();
          const binding = job.receipt.binding;
          if (decoded.id !== job.receipt.id || decoded.verifiedAt !== job.receipt.verifiedAt || decoded.jobId !== job.receipt.jobId || decoded.bytes !== job.receipt.bytes || decoded.sha256 !== job.receipt.sha256 || binding?.receiver !== manifest.fields.receiver || binding.generation !== manifest.fields.generation || binding.manifestDigest !== manifest.digest || binding.destinationDigest !== manifest.destinationDigest) throw new Error('Receipt mismatch.');
        }
      } catch { jobs.save({ ...job, storageFault: true, sealed: { ...state, frozen: true, revision: state.frozen ? state.revision : next(state) } }); }
    }
    for (const name of await readdir(this.groupsDirectory)) if (!referenced.has(name)) await rm(join(this.groupsDirectory, name), { force: true });
    await syncDirectory(this.groupsDirectory);
    await this.reconcileAuthority();
    await syncDirectory(this.config.directory);
    for (const job of jobs.all()) {
      if (job.transport !== 'sealed-v1' || sealed(job).frozen) continue;
      await jobs.exclusive(job.id, async () => {
        const current = jobs.get(job.id);
        if (current.status !== 'received' && this.manifest(current).fields.expiresAt <= this.now()) await this.terminate(current, 'expired');
        else if (sealed(current).cleanup === 1) await this.cleanup(current);
      });
      await this.finalize(job.id);
    }
  }
}

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { receiptSchema as originalReceiptSchema, type Receipt } from './contracts.js';
/** Isolated sealed-v1 primitives. No routing, storage publication or success authority. */
export const limits = Object.freeze({
  frame: 8 * 1024 * 1024, framesPerGroup: 8, original: 4n * 1024n ** 3n, manifest: 65536, outcome: 4096, header: 128, groupWire: 64 * 1024 * 1024 + 544
});
function requireValid(ok: unknown, message = 'Invalid sealed-v1 record'): asserts ok {
  if (!ok)
    throw new Error(message);
}
const uuid = z.string().regex(/^[0-9a-f]{32}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const u64 = z.bigint().min(0n).max(0xffffffffffffffffn);
const index = z.number().int().min(0).max(511);
const opaque = z.string().refine(s => canonicalText(s, 128, false));
function canonicalText(s: string, max: number, name: boolean): boolean {
  return s.length > 0 && s.normalize('NFC') === s && Buffer.byteLength(s) <= max && Buffer.from(s).toString('utf8') === s && (!name || !/[\p{Cc}\p{Cf}/\\]/u.test(s));
}
export function canonicalOrigin(input: string): string {
  requireValid(Buffer.byteLength(input) <= 512 && /^https:\/\/[^/@?#%]+:[0-9]+$/.test(input));
  const url = new URL(input);
  const match = input.match(/^https:\/\/(\[[^\]]+\]|[^:]+):([1-9][0-9]*)$/);
  requireValid(match && match[1] && match[2]);
  const host = match[1];
  const port = Number(match[2]);
  requireValid(port <= 65535 && port >= 1 && String(port) === match[2]);
  requireValid(url.hostname === host && host === host.toLowerCase() && !host.endsWith('.'));
  if (!host.startsWith('[') && isIP(host) !== 4) {
    requireValid(host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)));
  }
  return input;
}
const destinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('standalone'), intake: uuid.brand<'IntakeID'>() }).strict(),
  z.object({
    kind: z.literal('t3'), environment: opaque.brand<'EnvironmentID'>(), project: opaque.brand<'ProjectID'>(), thread: opaque.brand<'ThreadID'>(), workspace: opaque.brand<'WorkspaceID'>(), consent: uuid.brand<'ConsentID'>()
  }).strict(),
]);
export type Destination = z.infer<typeof destinationSchema>;
class Writer {
  private parts: Buffer[] = [];
  bytes(b: Uint8Array): this {
    this.parts.push(Buffer.from(b));
    return this;
  }
  text(s: string): this {
    return this.bytes(Buffer.from(s, 'utf8'));
  }
  n(value: bigint | number, size: number): this {
    const n = BigInt(value);
    requireValid(n >= 0n && n < 1n << BigInt(size * 8));
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i++)
      b[size - i - 1] = Number((n >> BigInt(i * 8)) & 255n);
    return this.bytes(b);
  }
  hex(s: string): this {
    return this.bytes(Buffer.from(s, 'hex'));
  }
  lp(b: Uint8Array, size = 2): this {
    return this.n(b.length, size).bytes(b);
  }
  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}
class Reader {
  private offset = 0;
  constructor(private readonly data: Buffer, max: number) {
    requireValid(data.length <= max);
  }
  bytes(length: number): Buffer {
    requireValid(Number.isSafeInteger(length) && length >= 0 && length <= this.data.length - this.offset);
    const b = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return b;
  }
  n(size: number): bigint {
    let v = 0n;
    for (const b of this.bytes(size))
      v = (v << 8n) | BigInt(b);
    return v;
  }
  small(size: number, max: number): number {
    const n = this.n(size);
    requireValid(n <= BigInt(max));
    return Number(n);
  }
  hex(length: number): string {
    return this.bytes(length).toString('hex');
  }
  magic(s: string): void {
    requireValid(this.bytes(8).equals(Buffer.from(s)));
  }
  lp(max: number, size = 2): Buffer {
    return this.bytes(this.small(size, max));
  }
  text(max: number): string {
    const b = this.lp(max);
    const s = b.toString('utf8');
    requireValid(Buffer.from(s).equals(b));
    return s;
  }
  end(): void {
    requireValid(this.offset === this.data.length, 'Trailing sealed-v1 bytes');
  }
}
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function encodeDestination(input: unknown): Buffer {
  const d = destinationSchema.parse(input);
  const w = new Writer();
  if (d.kind === 'standalone')
    return w.n(1, 1).hex(d.intake).done();
  return w.n(2, 1).lp(Buffer.from(d.environment)).lp(Buffer.from(d.project)).lp(Buffer.from(d.thread)).lp(Buffer.from(d.workspace)).hex(d.consent).done();
}
export function decodeDestination(bytes: Buffer): Destination {
  const r = new Reader(bytes, 16 + 1 + 4 * 130);
  const kind = r.small(1, 2);
  const d = kind === 1 ? destinationSchema.parse({ kind: 'standalone', intake: r.hex(16) }) : kind === 2 ? destinationSchema.parse({ kind: 't3', environment: r.text(128), project: r.text(128), thread: r.text(128), workspace: r.text(128), consent: r.hex(16) }) : undefined;
  requireValid(d);
  r.end();
  requireValid(encodeDestination(d).equals(bytes));
  return d;
}
const manifestSchema = z.object({
  receiver: digest.brand<'ReceiverID'>(), origin: z.string().refine(s => {
    try {
      return canonicalOrigin(s) === s;
    }
    catch {
      return false;
    }
  }).brand<'ExactHTTPSOrigin'>(), job: uuid.brand<'SealedJobID'>(), generation: uuid.brand<'GenerationID'>(), device: uuid.brand<'DeviceID'>(), enrollmentEpoch: u64, destination: destinationSchema, originalBytes: u64.min(1n).max(limits.original), originalSHA256: digest, safeName: z.string().refine(s => canonicalText(s, 240, true)), expiresAt: u64, frameBytes: z.literal(limits.frame), framesPerGroup: z.literal(8), frameHashes: z.array(digest).min(1).max(512)
}).strict();
export type ManifestFields = z.infer<typeof manifestSchema>;
export type Partition = Readonly<{
  group: number;
  firstFrame: number;
  frameCount: number;
  offset: bigint;
  length: number;
}>;
export class Manifest {
  private constructor(private readonly encoded: Buffer, private readonly value: ManifestFields) {
  }
  static create(input: unknown): Manifest {
    const m = manifestSchema.parse(input);
    requireValid(BigInt(m.frameHashes.length) === (m.originalBytes + BigInt(limits.frame) - 1n) / BigInt(limits.frame));
    const w = new Writer().text('FTMAN001').hex(m.receiver).lp(Buffer.from(m.origin)).hex(m.job).hex(m.generation).hex(m.device).n(m.enrollmentEpoch, 8).lp(encodeDestination(m.destination)).n(m.originalBytes, 8).hex(m.originalSHA256).lp(Buffer.from(m.safeName)).n(m.expiresAt, 8).n(m.frameBytes, 4).n(m.framesPerGroup, 2).n(m.frameHashes.length, 4);
    for (const h of m.frameHashes)
      w.hex(h);
    const encoded = w.done();
    requireValid(encoded.length <= limits.manifest);
    return new Manifest(encoded, m);
  }
  static decode(bytes: Buffer): Manifest {
    const r = new Reader(bytes, limits.manifest);
    r.magic('FTMAN001');
    const receiver = r.hex(32), origin = r.text(512), job = r.hex(16), generation = r.hex(16), device = r.hex(16), enrollmentEpoch = r.n(8), destination = decodeDestination(r.lp(537)), originalBytes = r.n(8), originalSHA256 = r.hex(32), safeName = r.text(240), expiresAt = r.n(8), frameBytes = r.small(4, limits.frame), framesPerGroup = r.small(2, 8), count = r.small(4, 512);
    const frameHashes: string[] = [];
    for (let i = 0; i < count; i++)
      frameHashes.push(r.hex(32));
    r.end();
    const m = Manifest.create({
      receiver, origin, job, generation, device, enrollmentEpoch, destination, originalBytes, originalSHA256, safeName, expiresAt, frameBytes, framesPerGroup, frameHashes
    });
    requireValid(m.bytes.equals(bytes));
    return m;
  }
  get bytes(): Buffer {
    return Buffer.from(this.encoded);
  }
  get fields(): ManifestFields {
    return manifestSchema.parse(this.value);
  }
  get digest(): string {
    return sha256(this.encoded);
  }
  get destinationDigest(): string {
    return sha256(encodeDestination(this.value.destination));
  }
  get groupCount(): number {
    return Math.ceil(this.value.frameHashes.length / 8);
  }
  validateSetupTime(now: bigint): void {
    u64.parse(now);
    requireValid(this.value.expiresAt > now && this.value.expiresAt - now <= 7n * 86400n);
  }
  frameLength(frame: number): number {
    index.parse(frame);
    requireValid(frame < this.value.frameHashes.length);
    const offset = BigInt(frame) * BigInt(limits.frame);
    return Number(this.value.originalBytes - offset < BigInt(limits.frame) ? this.value.originalBytes - offset : BigInt(limits.frame));
  }
  partition(group: number): Partition {
    z.number().int().min(0).max(63).parse(group);
    requireValid(group < this.groupCount);
    const firstFrame = group * 8, frameCount = Math.min(8, this.value.frameHashes.length - firstFrame), offset = BigInt(firstFrame) * BigInt(limits.frame);
    const length = Number(this.value.originalBytes - offset < 8n * BigInt(limits.frame) ? this.value.originalBytes - offset : 8n * BigInt(limits.frame));
    return Object.freeze({ group, firstFrame, frameCount, offset, length });
  }
  contiguous(bitmap: bigint): bigint {
    u64.parse(bitmap);
    requireValid(bitmap >> BigInt(this.groupCount) === 0n);
    let prefix = 0n;
    for (let i = 0; i < this.groupCount; i++) {
      if (!(bitmap & (1n << BigInt(i))))
        break;
      prefix += BigInt(this.partition(i).length);
    }
    return prefix;
  }
}
export class Binding {
  private constructor(readonly manifest: Manifest) {
  }
  static match(manifest: Manifest, listener: {
    receiver: string;
    origin: string;
  }): Binding {
    requireValid(manifest.fields.receiver === digest.parse(listener.receiver) && manifest.fields.origin === canonicalOrigin(listener.origin));
    return new Binding(manifest);
  }
}
export function groupHeader(m: Manifest, group: number): Buffer {
  const p = m.partition(group), f = m.fields;
  return new Writer().text('FTSEAL01').hex(f.receiver).hex(f.job).hex(f.generation).hex(m.digest).n(group, 4).n(p.firstFrame, 4).n(p.frameCount, 2).n(0, 2).n(p.offset, 8).n(p.length, 4).done();
}
export function parseGroupHeader(bytes: Buffer, binding: Binding): Partition {
  requireValid(bytes.length === 128);
  const r = new Reader(bytes, 128);
  r.magic('FTSEAL01');
  r.bytes(96);
  const group = r.small(4, 63);
  const p = binding.manifest.partition(group);
  requireValid(groupHeader(binding.manifest, group).equals(bytes));
  return p;
}
export function frameAAD(header: Buffer, frame: number, length: number, sealID: Buffer): Buffer {
  requireValid(header.length === 128 && sealID.length === 16);
  index.parse(frame);
  z.number().int().min(1).max(limits.frame).parse(length);
  return new Writer().text('FTBODY01').bytes(header).n(frame, 4).n(length, 4).bytes(sealID).done();
}
export class GenerationKeys {
  private constructor(private readonly master: Buffer, readonly manifest: Manifest) {
  }
  static fromSetup(master: Buffer, manifest: Manifest): GenerationKeys {
    requireValid(master.length === 32);
    return new GenerationKeys(Buffer.from(master), manifest);
  }
  static fresh(manifest: Manifest): Readonly<{
    keys: GenerationKeys;
    master: Buffer;
  }> {
    const master = randomBytes(32);
    return Object.freeze({ keys: GenerationKeys.fromSetup(master, manifest), master });
  }
  derive(domain: 'body' | 'ack' | 'receipt' | 'status', frame?: {
    index: number;
    sealID: Buffer;
  }): Buffer {
    const w = new Writer().text(`footage/sealed-v1/${domain}`);
    if (domain === 'body') {
      requireValid(frame && frame.sealID.length === 16);
      this.manifest.frameLength(frame.index);
      w.n(frame.index, 4).bytes(frame.sealID);
    }
    else
      requireValid(!frame);
    return Buffer.from(hkdfSync('sha256', this.master, Buffer.from(this.manifest.digest, 'hex'), w.done(), 32));
  }
}
/** The caller must durably persist this intent as consumed before returning. This is not a crash ledger. */
export type ConsumeIntent = (intent: Readonly<{
  manifestDigest: string;
  frame: number;
  sealID: string;
}>) => Promise<void>;
export class SealSession {
  private readonly ids = new Set<string>();
  private readonly frames = new Set<number>();
  constructor(private readonly keys: GenerationKeys) {
  }
  async consume(frame: number, persistConsumed: ConsumeIntent): Promise<ConsumedSealIntent> {
    this.keys.manifest.frameLength(frame);
    requireValid(!this.frames.has(frame), 'Frame seal already consumed');
    this.frames.add(frame);
    const id = randomBytes(16);
    requireValid(!this.ids.has(id.toString('hex')));
    this.ids.add(id.toString('hex'));
    await persistConsumed(Object.freeze({ manifestDigest: this.keys.manifest.digest, frame, sealID: id.toString('hex') }));
    return ConsumedSealIntent.afterPersistence(this.keys, frame, id, intentAuthority);
  }
}
const intentAuthority = Symbol('consumed seal intent');
export class ConsumedSealIntent {
  private used = false;
  private constructor(private readonly keys: GenerationKeys, private readonly frame: number, private readonly id: Buffer) {
  }
  static afterPersistence(keys: GenerationKeys, frame: number, id: Buffer, authority: symbol): ConsumedSealIntent {
    requireValid(authority === intentAuthority);
    return new ConsumedSealIntent(keys, frame, id);
  }
  seal(plaintext: Buffer): Buffer {
    requireValid(!this.used, 'Seal intent consumed');
    this.used = true;
    const m = this.keys.manifest, length = m.frameLength(this.frame);
    requireValid(plaintext.length === length && sha256(plaintext) === m.fields.frameHashes[this.frame]);
    const header = groupHeader(m, Math.floor(this.frame / 8)), nonce = randomBytes(12), aad = frameAAD(header, this.frame, length, this.id);
    const cipher = createCipheriv('aes-256-gcm', this.keys.derive('body', { index: this.frame, sealID: this.id }), nonce);
    cipher.setAAD(aad);
    return new Writer().n(this.frame, 4).n(length, 4).bytes(this.id).bytes(nonce).bytes(cipher.update(plaintext)).bytes(cipher.final()).bytes(cipher.getAuthTag()).done();
  }
}
function openFrame(packet: Buffer, header: Buffer, frame: number, keys: GenerationKeys): Buffer {
  const m = keys.manifest, length = m.frameLength(frame);
  requireValid(packet.length === length + 52);
  const r = new Reader(packet, limits.frame + 52);
  requireValid(r.n(4) === BigInt(frame) && r.n(4) === BigInt(length));
  const sealID = r.bytes(16), nonce = r.bytes(12), ciphertext = r.bytes(length), tag = r.bytes(16);
  r.end();
  const decipher = createDecipheriv('aes-256-gcm', keys.derive('body', { index: frame, sealID }), nonce);
  decipher.setAAD(frameAAD(header, frame, length, sealID));
  decipher.setAuthTag(tag);
  const untrusted = decipher.update(ciphertext);
  try {
    const end = decipher.final();
    const plaintext = Buffer.concat([untrusted, end]);
    requireValid(sha256(plaintext) === m.fields.frameHashes[frame]);
    return plaintext;
  }
  catch (error) {
    untrusted.fill(0);
    throw error;
  }
}
/** Private quarantine only: write MUST NOT publish ranges/content. Caller discards on failure. */
export interface GroupSource {
  readExactly(length: number): Promise<Buffer>;
  atEnd(): Promise<boolean>;
}
export interface GroupQuarantine {
  write(frame: number, plaintext: Buffer): Promise<void>;
  discard(): Promise<void>;
}
export class VerifiedGroup {
  private readonly verified = true;
  private constructor(readonly partition: Partition, readonly wireSHA256: string, readonly manifestDigest: string) {
  }
  static async authenticate(source: GroupSource, quarantine: GroupQuarantine, binding: Binding, keys: GenerationKeys): Promise<VerifiedGroup> {
    try {
      requireValid(keys.manifest.digest === binding.manifest.digest);
      const header = await source.readExactly(128), p = parseGroupHeader(header, binding), hash = createHash('sha256').update(header), seals = new Set<string>();
      for (let i = 0; i < p.frameCount; i++) {
        const frame = p.firstFrame + i, packet = await source.readExactly(binding.manifest.frameLength(frame) + 52);
        requireValid(packet.length === binding.manifest.frameLength(frame) + 52);
        const seal = packet.subarray(8, 24).toString('hex');
        requireValid(!seals.has(seal));
        seals.add(seal);
        const plaintext = openFrame(packet, header, frame, keys);
        hash.update(packet);
        try {
          await quarantine.write(frame, plaintext);
        }
        finally {
          plaintext.fill(0);
        }
      }
      requireValid(await source.atEnd());
      return new VerifiedGroup(p, hash.digest('hex'), binding.manifest.digest);
    }
    catch (error) {
      await quarantine.discard();
      throw error;
    }
  }
}
function context(w: Writer, magic: string, m: Manifest): Writer {
  const f = m.fields;
  return w.text(magic).hex(f.receiver).hex(f.job).hex(f.generation).hex(m.digest);
}
function readContext(r: Reader, magic: string, m: Manifest): void {
  r.magic(magic);
  const f = m.fields;
  requireValid(r.hex(32) === f.receiver && r.hex(16) === f.job && r.hex(16) === f.generation && r.hex(32) === m.digest);
}
function signed(payload: Buffer, keys: GenerationKeys, domain: 'ack' | 'receipt' | 'status'): Buffer {
  requireValid(payload.length + 32 <= limits.outcome);
  return Buffer.concat([payload, createHmac('sha256', keys.derive(domain)).update(payload).digest()]);
}
function authenticated(bytes: Buffer, keys: GenerationKeys, domain: 'ack' | 'receipt' | 'status'): Reader {
  requireValid(bytes.length >= 40 && bytes.length <= limits.outcome);
  const payload = bytes.subarray(0, -32), mac = bytes.subarray(-32), expected = createHmac('sha256', keys.derive(domain)).update(payload).digest();
  requireValid(timingSafeEqual(mac, expected), 'Outcome authentication failed');
  return new Reader(payload, limits.outcome);
}
const ackSchema = z.object({ group: z.number().int().min(0).max(63), wireSHA256: digest, revision: u64 }).strict();
export function encodeAck(keys: GenerationKeys, input: unknown): Buffer {
  const a = ackSchema.parse(input), p = keys.manifest.partition(a.group);
  return signed(context(new Writer(), 'FTACK001', keys.manifest).n(a.group, 4).hex(a.wireSHA256).n(p.offset, 8).n(p.length, 4).n(a.revision, 8).done(), keys, 'ack');
}
export class VerifiedAck {
  private readonly verified = true;
  private constructor(readonly group: number, readonly originalOffset: bigint, readonly originalLength: number, readonly revision: bigint) {
  }
  static verify(bytes: Buffer, keys: GenerationKeys, expected: {
    group: number;
    wireSHA256: string;
  }): VerifiedAck {
    requireValid(bytes.length === 192);
    const r = authenticated(bytes, keys, 'ack');
    readContext(r, 'FTACK001', keys.manifest);
    const group = r.small(4, 63), wire = r.hex(32), offset = r.n(8), length = r.small(4, 64 * 1024 * 1024), revision = r.n(8);
    r.end();
    const p = keys.manifest.partition(group);
    requireValid(group === expected.group && wire === digest.parse(expected.wireSHA256) && offset === p.offset && length === p.length);
    return new VerifiedAck(group, offset, length, revision);
  }
}
const receiptSchema = z.object({ id: uuid, verifiedAt: u64, revision: u64 }).strict();
export function encodeReceipt(keys: GenerationKeys, input: unknown): Buffer {
  const r = receiptSchema.parse(input);
  return signed(context(new Writer(), 'FTRCPT01', keys.manifest).hex(keys.manifest.destinationDigest).hex(r.id).n(r.verifiedAt, 8).n(r.revision, 8).done(), keys, 'receipt');
}
export class VerifiedReceipt {
  private readonly verified = true;
  /** Preserve the common receipt shape; no caller-supplied original identity is accepted. */
  toOriginalReceipt(): Receipt {
    requireValid(this.verifiedAt <= 253402300799n, 'Timestamp cannot be rendered as a shared ISO8601 receipt');
    const uuidText = (hex: string): string => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    return originalReceiptSchema.parse({
      id: uuidText(this.id), jobId: uuidText(this.jobId), bytes: this.bytes, sha256: this.sha256, verifiedAt: new Date(Number(this.verifiedAt) * 1000).toISOString()
    });
  }
  private constructor(readonly id: string, readonly jobId: string, readonly bytes: number, readonly sha256: string, readonly verifiedAt: bigint, readonly revision: bigint, readonly manifestDigest: string, readonly destinationDigest: string, readonly generation: string, readonly receiver: string) {
  }
  static verify(bytes: Buffer, keys: GenerationKeys): VerifiedReceipt {
    const r = authenticated(bytes, keys, 'receipt');
    const m = keys.manifest;
    readContext(r, 'FTRCPT01', m);
    requireValid(r.hex(32) === m.destinationDigest);
    const id = r.hex(16), verifiedAt = r.n(8), revision = r.n(8);
    r.end();
    const f = m.fields;
    return new VerifiedReceipt(id, f.job, Number(f.originalBytes), f.originalSHA256, verifiedAt, revision, m.digest, m.destinationDigest, f.generation, f.receiver);
  }
}
export function encodeOutcome(ack: Buffer, receipt: Buffer = Buffer.alloc(0)): Buffer {
  requireValid(ack.length === 192 && (receipt.length === 0 || receipt.length === 200));
  const b = new Writer().text('FTOUT001').lp(ack, 4).lp(receipt, 4).done();
  requireValid(b.length <= limits.outcome);
  return b;
}
export function verifyOutcome(bytes: Buffer, status: number, keys: GenerationKeys, expected: {
  group: number;
  wireSHA256: string;
}): Readonly<{
  ack: VerifiedAck;
  receipt: VerifiedReceipt | null;
}> {
  requireValid(status === 200);
  const r = new Reader(bytes, limits.outcome);
  r.magic('FTOUT001');
  const ack = VerifiedAck.verify(r.lp(192, 4), keys, expected), receiptBytes = r.lp(200, 4);
  r.end();
  const receipt = receiptBytes.length ? VerifiedReceipt.verify(receiptBytes, keys) : null;
  requireValid(!receipt || receipt.revision >= ack.revision);
  return Object.freeze({ ack, receipt });
}
const querySchema = z.object({ operation: uuid, challenge: digest }).strict();
export type Query = z.infer<typeof querySchema>;
export function freshQuery(operation: string): Query {
  return querySchema.parse({ operation, challenge: randomBytes(32).toString('hex') });
}
export function encodeQuery(m: Manifest, input: unknown): Buffer {
  const q = querySchema.parse(input);
  return new Writer().text('FTQUERY1').hex(m.fields.job).hex(m.fields.generation).hex(m.digest).hex(q.operation).hex(q.challenge).done();
}
export function decodeQuery(bytes: Buffer, m: Manifest): Query {
  const r = new Reader(bytes, 120);
  r.magic('FTQUERY1');
  requireValid(r.hex(16) === m.fields.job && r.hex(16) === m.fields.generation && r.hex(32) === m.digest);
  const q = querySchema.parse({ operation: r.hex(16), challenge: r.hex(32) });
  r.end();
  return q;
}
const statusSchema = z.object({ revision: u64, state: z.number().int().min(1).max(6), cleanup: z.number().int().min(0).max(2), groupBitmap: u64 }).strict();
export type StatusFields = z.infer<typeof statusSchema>;
function statusRules(s: StatusFields, m: Manifest, receipt: VerifiedReceipt | null): void {
  requireValid(s.state >= 4 ? s.cleanup === 1 || s.cleanup === 2 : s.cleanup === 0);
  m.contiguous(s.groupBitmap);
  requireValid((s.state === 3) === (receipt !== null));
  if (s.state === 2 || s.state === 3)
    requireValid(s.groupBitmap === (1n << BigInt(m.groupCount)) - 1n);
  if (receipt)
    requireValid(receipt.revision <= s.revision);
}
export function encodeStatus(keys: GenerationKeys, query: Query, input: unknown, receipt: Buffer = Buffer.alloc(0)): Buffer {
  const q = querySchema.parse(query), s = statusSchema.parse(input), m = keys.manifest;
  statusRules(s, m, receipt.length ? VerifiedReceipt.verify(receipt, keys) : null);
  return signed(context(new Writer(), 'FTSTAT01', m).hex(q.operation).hex(q.challenge).n(s.revision, 8).n(s.state, 1).n(s.cleanup, 1).n(m.fields.expiresAt, 8).n(s.groupBitmap, 8).n(m.contiguous(s.groupBitmap), 8).lp(receipt, 4).done(), keys, 'status');
}
export class VerifiedStatus {
  private readonly verified = true;
  private constructor(readonly revision: bigint, readonly state: number, readonly cleanup: number, readonly groupBitmap: bigint, readonly contiguousOriginalBytes: bigint, readonly receipt: VerifiedReceipt | null) {
  }
  static verify(bytes: Buffer, keys: GenerationKeys, query: Query, highWater: bigint): VerifiedStatus {
    const q = querySchema.parse(query);
    u64.parse(highWater);
    const r = authenticated(bytes, keys, 'status'), m = keys.manifest;
    readContext(r, 'FTSTAT01', m);
    requireValid(r.hex(16) === q.operation && r.hex(32) === q.challenge);
    const revision = r.n(8), state = r.small(1, 6), cleanup = r.small(1, 2), expires = r.n(8), groupBitmap = r.n(8), contiguous = r.n(8), rb = r.lp(200, 4);
    r.end();
    const s = statusSchema.parse({ revision, state, cleanup, groupBitmap }), receipt = rb.length ? VerifiedReceipt.verify(rb, keys) : null;
    statusRules(s, m, receipt);
    requireValid(revision >= highWater && expires === m.fields.expiresAt && contiguous === m.contiguous(groupBitmap));
    return new VerifiedStatus(revision, state, cleanup, groupBitmap, contiguous, receipt);
  }
}
export function encodeSetup(keys: GenerationKeys, master: Buffer): Buffer {
  requireValid(master.length === 32);
  const candidate = GenerationKeys.fromSetup(master, keys.manifest);
  requireValid(timingSafeEqual(candidate.derive('ack'), keys.derive('ack')));
  return new Writer().text('FTSET001').hex(keys.manifest.digest).bytes(master).n(keys.manifest.fields.expiresAt, 8).done();
}
export function decodeSetup(bytes: Buffer, m: Manifest): GenerationKeys {
  const r = new Reader(bytes, 80);
  r.magic('FTSET001');
  requireValid(r.hex(32) === m.digest);
  const master = r.bytes(32);
  requireValid(r.n(8) === m.fields.expiresAt);
  r.end();
  return GenerationKeys.fromSetup(master, m);
}

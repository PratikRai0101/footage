// Explicit test-only listener and generated credentials. Never imported by server startup.
import { createCipheriv, createDecipheriv, createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer, request, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Jobs } from '../../../apps/server/src/jobs.js';
import { HttpError, jobIdSchema } from '../../../apps/server/src/contracts.js';
import { streamContent } from '../../../apps/server/src/content.js';
import { originalPath } from '../../../apps/server/src/originals.js';
import { PairingAuthority, type PairingKeyStore } from '../../../apps/server/src/pairing.js';
import { lp16, PairingReader, u32 } from '../../../apps/server/src/pairing-wire.js';
import { GenerationKeys, Manifest, SealSession, groupHeader, limits, sha256 } from '../../../apps/server/src/sealed-protocol.js';
import { SealedIngest, schemaUuid, type IngestBoundary } from '../../../apps/server/src/sealed-ingest.js';
import { ViewerAccess } from '../../../apps/server/src/viewer-access.js';

export function backend(key = randomBytes(32)): PairingKeyStore {
  return {
    wrap(plain, context) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(context));
      return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    unwrap(bytes, context) {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
    },
  };
}
const credentialsSchema = z.object({ key: z.string(), credential: z.string(), device: z.string(), intake: z.uuid(), origin: z.string() });
export async function generateDirectory(permissionMask = 31) {
  const directory = await mkdtemp(join(tmpdir(), 'footage-sealed-test-'));
  const key = randomBytes(32), origin = 'https://localhost:443', intake = randomUUID();
  const opened = PairingAuthority.open({ path: join(directory, 'pair.sqlite'), keyStore: backend(key), origin, ca: randomBytes(64), pin: randomBytes(32), now: () => 2_000_000_000n });
  try {
    const qr = new PairingReader(opened.local.createOffer({ mask: permissionMask, scopes: { intakes: [intake], projects: [{ environment: 'Env', project: 'Project' }] } }), 'FTQR0001');
    qr.lp16(128); qr.lp16(1024); qr.take(32); qr.lp16(512);
    const offer = qr.take(16), secret = qr.take(32), device = randomBytes(16);
    const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const prefix = Buffer.concat([Buffer.from('FTENRL01'), offer, secret, device, lp16(createPublicKey(privateKey).export({ format: 'der', type: 'spki' })), randomBytes(32), u32(permissionMask)]);
    const enrollment = Buffer.concat([prefix, lp16(sign('sha256', Buffer.concat([prefix, opened.authority.identity, lp16(origin)]), privateKey))]);
    opened.local.approve(enrollment, { intakes: [intake], projects: [{ environment: 'Env', project: 'Project' }] });
    const result = new PairingReader(opened.authority.enroll(enrollment), 'FTENRO01');
    const credential = result.take(32);
    await writeFile(join(directory, 'test-credentials.json'), JSON.stringify({ key: key.toString('hex'), credential: credential.toString('hex'), device: device.toString('hex'), intake, origin }), { mode: 0o600 });
    return directory;
  } finally { opened.authority.close(); }
}

export async function openFixture(directory: string, options: { boundary?: (point: IngestBoundary) => void; bodyTimeoutMs?: number; wrongKey?: boolean; now?: () => bigint; access?: () => void } = {}) {
  const decoded: unknown = JSON.parse(await readFile(join(directory, 'test-credentials.json'), 'utf8'));
  const credentials = credentialsSchema.parse(decoded);
  const now = options.now ?? (() => 2_000_000_000n);
  const authority = PairingAuthority.open({ path: join(directory, 'pair.sqlite'), keyStore: backend(Buffer.from(credentials.key, 'hex')), origin: credentials.origin, ca: randomBytes(64), pin: randomBytes(32), now });
  const jobs = new Jobs(join(directory, 'jobs.sqlite'));
  let ingest: SealedIngest;
  try {
    ingest = await SealedIngest.open({ directory, jobs, authority: authority.authority, wrappingStore: backend(options.wrongKey ? randomBytes(32) : Buffer.from(credentials.key, 'hex')), assertDestinationAccess: options.access ?? (() => {}), now, ...(options.bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs: options.bodyTimeoutMs }), ...(options.boundary === undefined ? {} : { boundary: options.boundary }) });
  } catch (error) { jobs.close(); authority.authority.close(); throw error; }
  const credential = Buffer.from(credentials.credential, 'hex');
  const viewer = new ViewerAccess({});
  async function body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) throw new HttpError(400, 'Body');
      length += chunk.length;
      if (length > 65536) throw new HttpError(413, 'Body');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  const active = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const operation = (async () => {
      if (req.url === '/sealed/v1/ingest') {
        const reply = await ingest.ingest(req); res.writeHead(200); res.end(reply); return;
      }
      // Test-only read adapter exercises the SAME content and viewer invariants.
      if (req.url === '/viewer/content') {
        const job = jobs.get(viewer.authorize(req.headers.cookie));
        await streamContent({ req, res, job, path: originalPath(directory, job), download: false }); return;
      }
      const auth = req.headers.authorization;
      if (!auth?.startsWith('Bearer ') || !/^[0-9a-f]{64}$/.test(auth.slice(7))) throw new HttpError(401, 'Credential');
      const token = Buffer.from(auth.slice(7), 'hex');
      const bytes = await body(req);
      const reply = req.url === '/sealed/v1/setup' ? await ingest.setup(bytes, token) : await ingest.status(jobIdSchema.parse(schemaUuid(bytes.subarray(8, 24).toString('hex'))), bytes, token, req.url === '/sealed/v1/revoke');
      res.writeHead(200); res.end(reply);
    })().catch((error: unknown) => {
      if (res.destroyed) return;
      res.setHeader('connection', 'close');
      res.writeHead(error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500);
      res.end(); req.resume();
    });
    active.add(operation);
    void operation.finally(() => active.delete(operation));
  });
  server.maxConnections = 4; server.requestTimeout = 2000; server.headersTimeout = 2000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Address');
  let closed = false;
  return {
    directory, credentials, credential, jobs, ingest, authority, viewer, server, base: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await Promise.allSettled(active);
      await stopped;
      jobs.close(); authority.authority.close();
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof openFixture>>;

export function frameBytes(index: number, length: number): Buffer { return Buffer.alloc(length, (index * 31 + 17) % 256); }
export function manifest(f: Fixture, bytes = 173, change: object = {}): Manifest {
  const hashes: string[] = [], hash = createHash('sha256');
  for (let offset = 0, index = 0; offset < bytes; offset += limits.frame, index++) {
    const frame = frameBytes(index, Math.min(limits.frame, bytes - offset)); hash.update(frame); hashes.push(sha256(frame));
  }
  return Manifest.create({ receiver: f.authority.authority.identity.toString('hex'), origin: f.credentials.origin, job: randomUUID().replaceAll('-', ''), generation: randomBytes(16).toString('hex'), device: f.credentials.device, enrollmentEpoch: 1n, destination: { kind: 'standalone', intake: f.credentials.intake.replaceAll('-', '') }, originalBytes: BigInt(bytes), originalSHA256: hash.digest('hex'), safeName: 'generated-original.bin', expiresAt: 2_000_003_600n, frameBytes: limits.frame, framesPerGroup: 8, frameHashes: hashes, ...change });
}
export async function savePackets(f: Fixture, m: Manifest, keys: GenerationKeys, suffix = '') {
  const session = new SealSession(keys);
  const packets: { path: string; wireHash: string; group: number }[] = [];
  for (let group = 0; group < m.groupCount; group++) {
    const path = join(f.directory, `test-packet-${m.fields.job}-${group}${suffix}`), file = await open(path, 'wx', 0o600), header = groupHeader(m, group), hash = createHash('sha256').update(header);
    try {
      await file.writeFile(header);
      const partition = m.partition(group);
      for (let frame = partition.firstFrame; frame < partition.firstFrame + partition.frameCount; frame++) {
        const intent = await session.consume(frame, async () => {});
        const packet = intent.seal(frameBytes(frame, m.frameLength(frame)));
        hash.update(packet); await file.writeFile(packet);
      }
      await file.sync(); packets.push({ path, wireHash: hash.digest('hex'), group });
    } finally { await file.close(); }
  }
  return packets;
}
export async function control(f: Fixture, path: string, bytes: Buffer, credential = f.credential) {
  const response = await fetch(`${f.base}/sealed/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${credential.toString('hex')}`, 'content-type': 'application/octet-stream' }, body: Uint8Array.from(bytes) });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}
export function rawRequest(f: Pick<Fixture, 'base'>, headers: Record<string, string> = {}) {
  const client = request(`${f.base}/sealed/v1/ingest`, { method: 'POST', agent: false, headers: { 'content-type': 'application/octet-stream', ...headers } });
  const reply = new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
    client.once('error', reject);
    client.once('response', response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: unknown) => { if (Buffer.isBuffer(chunk)) chunks.push(chunk); });
      response.once('end', () => resolve({ status: response.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
    });
  });
  void reply.catch(() => {});
  return { client, reply };
}

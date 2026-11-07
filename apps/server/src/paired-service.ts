import { createServer, type ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP, Socket } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { HttpError, jobIdSchema } from './contracts.js';
import { DesktopKeyStore } from './desktop-key-store.js';
import { Jobs } from './jobs.js';
import { PairingAuthority } from './pairing.js';
import { origin, sha256 } from './pairing-wire.js';
import { SealedIngest, schemaUuid, type IngestBoundary } from './sealed-ingest.js';
import { Manifest } from './sealed-protocol.js';
import { handoffOperationSchema, handoffSchema, phoneDestinationSchema, type Handoff, type HandoffOperation, type PhoneDestination } from './phone-intake.js';
import type { StoredJob } from './contracts.js';
import { PairedViewer } from './paired-viewer.js';

type LocalController = ReturnType<typeof PairingAuthority.open>['local'];
type Config = {
  origin: string;
  listenHost: string;
  tls: { key: Buffer; cert: Buffer; ca: Buffer };
  authority: PairingAuthority;
  local: LocalController;
  jobs: Jobs;
  keyStore: DesktopKeyStore;
  directory: string;
  // Trusted local owner updates this in-memory set after resolving access. No I/O
  // or indeterminate lookup is interpreted as an authoritative removal under lock.
  allowedIntakes: ReadonlySet<string>;
  phone?: { destinations: () => readonly PhoneDestination[]; handoff: (job: StoredJob, operation: HandoffOperation) => Promise<Handoff> };
  bodyTimeoutMs?: number;
  supervisionMs?: number;
  boundary?: (point: IngestBoundary) => void;
};

async function body(req: IncomingMessage, cap: number): Promise<Buffer> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > cap)) throw new HttpError(413, 'Body limit.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    if (!Buffer.isBuffer(chunk)) throw new HttpError(400, 'Binary body required.');
    size += chunk.length;
    if (size > cap) throw new HttpError(413, 'Body limit.');
    chunks.push(chunk);
  }
  if (declared !== undefined && Number(declared) !== size) throw new HttpError(400, 'Body length mismatch.');
  return Buffer.concat(chunks, size);
}
function credential(req: IncomingMessage): Buffer {
  const auth = req.headers.authorization;
  if (!auth || !/^Bearer [0-9a-f]{64}$/.test(auth)) throw new HttpError(403, 'Control authority required.');
  return Buffer.from(auth.slice(7), 'hex');
}

/** Explicit HTTPS service only. Not imported by main/createReceiver. The local
 * controller is returned separately; HTTP never creates offers or approves devices.
 * Owns the supplied Jobs/authority lifetime after open succeeds. */
export class PairedService {
  static readonly advertisedMaxOriginalBytes = 1024 ** 3; // Conservative slice admission, NOT the 4GiB wire maximum.
  private readonly server;
  private readonly viewer: PairedViewer;
  private readonly sockets = new Set<Socket>();
  private readonly operations = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sweep: Promise<void> = Promise.resolve();
  private stopping = false;
  private started = false;
  private shutdown: Promise<void> | undefined;
  private backoff: number;
  private readonly enrollments = new Map<string, { body: Buffer; inspection: ReturnType<PairingAuthority['inspectEnrollment']>; finish: (approved: boolean) => void }>();
  private constructor(private readonly config: Config, readonly ingest: SealedIngest) {
    this.backoff = config.supervisionMs ?? 1000;
    this.viewer = new PairedViewer(config.directory, config.jobs, config.origin);
    const options: ServerOptions = { ...config.tls, minVersion: 'TLSv1.2', handshakeTimeout: 5000, maxHeaderSize: 8192, headersTimeout: Math.min(5000, config.bodyTimeoutMs ?? 30000), requestTimeout: config.bodyTimeoutMs ?? 30000, connectionsCheckingInterval: 1000 };
    this.server = createServer(options, (req, res) => {
      const operation = this.handle(req, res);
      this.operations.add(operation);
      void operation.finally(() => this.operations.delete(operation));
    });
    this.server.maxConnections = 8;
    this.server.maxRequestsPerSocket = 16;
    this.server.keepAliveTimeout = 1000;
    this.server.on('connection', socket => {
      if (!(socket instanceof Socket)) { socket.destroy(); return; }
      this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket));
      socket.setTimeout(config.bodyTimeoutMs ?? 30000, () => socket.destroy());
    });
    this.server.on('clientError', (_error, socket) => socket.destroy());
    this.server.on('tlsClientError', () => {}); // No secret-bearing TLS diagnostics.
  }
  static async open(config: Config) {
    origin(config.origin);
    const url = new URL(config.origin), cert = new X509Certificate(config.tls.cert);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!isIP(config.listenHost) || !(isIP(host) ? cert.checkIP(host) : cert.checkHost(host, { wildcards: false })) || Date.parse(cert.validFrom) > Date.now() || Date.parse(cert.validTo) <= Date.now()) throw new Error('Listener TLS binding invalid.');
    config.authority.assertListenerBinding(config.origin, config.tls.ca, sha256(cert.publicKey.export({ type: 'spki', format: 'der' })));
    if (!(config.keyStore instanceof DesktopKeyStore)) throw new Error('OS wrapping store required.');
    if (config.bodyTimeoutMs !== undefined && (!Number.isInteger(config.bodyTimeoutMs) || config.bodyTimeoutMs < 100 || config.bodyTimeoutMs > 300000)) throw new Error('Invalid body deadline.');
    if (config.supervisionMs !== undefined && (!Number.isInteger(config.supervisionMs) || config.supervisionMs < 100 || config.supervisionMs > 30000)) throw new Error('Invalid supervision interval.');
    const ingest = await SealedIngest.open({ directory: config.directory, jobs: config.jobs, authority: config.authority,
      wrappingStore: config.keyStore, assertDestinationAccess: m => {
        if (m.fields.destination.kind !== 'standalone' || !config.allowedIntakes.has(schemaUuid(m.fields.destination.intake))) throw new HttpError(403, 'Destination unavailable.');
      }, ...(config.bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs: config.bodyTimeoutMs }),
      ...(config.boundary === undefined ? {} : { boundary: config.boundary }) });
    const service = new PairedService(config, ingest);
    // This object must stay in trusted LOCAL desktop code. It is not an HTTP API.
    const local = {
      createOffer: config.local.createOffer,
      pendingEnrollments: () => [...service.enrollments].map(([id, e]) => ({ id, ...e.inspection })),
      approveEnrollment: (id: string, scopes: Parameters<LocalController['approve']>[1]) => {
        const pending = service.enrollments.get(id);
        if (!pending || service.stopping) throw new Error('Enrollment unavailable.');
        config.local.approve(pending.body, scopes); pending.finish(true);
      },
      revoke: config.local.revoke,
      rotation: config.local.rotation,
    };
    return { service, local };
  }
  async listen(): Promise<void> {
    if (this.started || this.stopping) throw new Error('Service already started or stopped.');
    this.started = true;
    const port = Number(new URL(this.config.origin).port || 443);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, this.config.listenHost, () => {
        this.server.off('error', reject);
        const address = this.server.address();
        if (!address || typeof address === 'string' || address.port !== port || address.address !== this.config.listenHost) { reject(new Error('Listener binding mismatch.')); return; }
        resolve();
      });
    });
    this.schedule();
  }
  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.sweep = (async () => {
        try {
          const { pending } = await this.ingest.retryPending();
          this.backoff = pending ? Math.min(30000, this.backoff * 2) : this.config.supervisionMs ?? 1000;
        } catch { this.backoff = Math.min(30000, this.backoff * 2); }
      })().finally(() => this.schedule());
    }, this.backoff);
    this.timer.unref();
  }
  private async enroll(bytes: Buffer, req: IncomingMessage): Promise<Buffer> {
    const inspection = this.config.authority.inspectEnrollment(bytes);
    if (this.enrollments.size >= 8) throw new HttpError(503, 'Local approval queue full.');
    const id = sha256(bytes).toString('hex');
    if (this.enrollments.has(id)) throw new HttpError(409, 'Enrollment already pending.');
    try {
      const approved = await new Promise<boolean>(resolve => {
        const finish = (ok: boolean) => { clearTimeout(timer); req.off('aborted', abort); resolve(ok); };
        const abort = () => finish(false);
        const timer = setTimeout(() => finish(false), Math.min(15000, this.config.bodyTimeoutMs ?? 30000));
        req.once('aborted', abort);
        this.enrollments.set(id, { body: bytes, inspection, finish });
      });
      if (!approved || this.stopping) throw new HttpError(403, 'Local approval required.');
      return this.config.authority.enroll(bytes);
    } finally { this.enrollments.delete(id); bytes.fill(0); }
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const timer = setTimeout(() => req.destroy(), this.config.bodyTimeoutMs ?? 30000); timer.unref();
    try {
      if (this.stopping) throw new HttpError(503, 'Stopping.');
      // Host is validated, never used to derive any credential/origin/identity.
      if ((req.headers.host !== this.config.origin.slice(8) && req.headers.host !== new URL(this.config.origin).host) || req.headers.forwarded !== undefined || Object.keys(req.headers).some(k => k.startsWith('x-forwarded-'))) throw new HttpError(400, 'Listener binding mismatch.');
      const names = req.rawHeaders.filter((_v, i) => i % 2 === 0).map(v => v.toLowerCase());
      if (new Set(names).size !== names.length) throw new HttpError(400, 'Duplicate headers.');
      if ((req.method === 'GET' || req.method === 'HEAD') && (req.url === '/receive' || req.url?.startsWith('/viewer/'))) clearTimeout(timer);
      if (await this.viewer.handle(req, res)) return;
      if (req.method !== 'POST') throw new HttpError(405, 'POST required.');
      const path = req.url;
      if (!['/pair/v1/destinations', '/pair/v1/enroll', '/pair/v1/challenge', '/pair/v1/recover', '/sealed/v1/setup', '/sealed/v1/status', '/sealed/v1/revoke', '/sealed/v1/view', '/sealed/v1/ingest', '/sealed/v1/handoff/status', '/sealed/v1/handoff/deliver', '/sealed/v1/handoff/send'].includes(path ?? '')) throw new HttpError(404, 'Unavailable.');
      if (req.headers['content-type'] !== 'application/octet-stream' || req.headers['content-encoding'] !== undefined || req.headers.cookie !== undefined || req.headers['proxy-authorization'] !== undefined) throw new HttpError(400, 'Binary unencoded body required.');
      let reply: Buffer;
      if (path === '/pair/v1/destinations') {
        if (!this.config.phone) throw new HttpError(503, 'Destination browsing unavailable.');
        const auth = credential(req);
        try {
          const scopes = this.config.authority.authorizeListing(await body(req, 64), auth);
          const destinations = this.config.phone.destinations().filter(d => this.config.allowedIntakes.has(d.id) && scopes.intakes.includes(d.id)).map(d => phoneDestinationSchema.parse(d));
          reply = Buffer.from(JSON.stringify({ version: 1, destinations }));
        } finally { auth.fill(0); }
      } else if (path?.startsWith('/sealed/v1/handoff/')) {
        const auth = credential(req);
        try {
          const operation = handoffOperationSchema.parse(path.slice('/sealed/v1/handoff/'.length));
          const bytes = await body(req, 121);
          const id = jobIdSchema.parse(schemaUuid(bytes.subarray(9, 25).toString('hex')));
          const job = await this.ingest.authorizeHandoff(id, bytes, auth, operation);
          const result = this.config.phone ? await this.config.phone.handoff(job, operation) : { kind: 'unavailable' };
          reply = Buffer.from(JSON.stringify(handoffSchema.parse(result)));
        } finally { auth.fill(0); }
      } else if (path === '/sealed/v1/ingest') reply = await this.ingest.ingest(req);
      else if (path?.startsWith('/pair/')) {
        if (req.headers.authorization !== undefined) throw new HttpError(400, 'Unexpected authority.');
        const bytes = await body(req, 16384);
        reply = path === '/pair/v1/enroll' ? await this.enroll(bytes, req) : path === '/pair/v1/challenge' ? this.config.authority.challenge(bytes) : this.config.authority.recover(bytes);
      } else {
        const auth = credential(req);
        try {
          const bytes = await body(req, path === '/sealed/v1/setup' ? 65536 : 4096);
          if (path === '/sealed/v1/setup') {
            // G3 still enforces its immutable manifest, scope, amplification and disk budgets.
            if (Manifest.decode(bytes).fields.originalBytes > BigInt(PairedService.advertisedMaxOriginalBytes)) throw new HttpError(507, 'Slice admission limit.');
            reply = await this.ingest.setup(bytes, auth);
          } else {
            if (bytes.length !== 120 || bytes.toString('ascii', 0, 8) !== 'FTQUERY1') throw new HttpError(400, 'Query required.');
            const id = jobIdSchema.parse(schemaUuid(bytes.subarray(8, 24).toString('hex')));
            if (path === '/sealed/v1/view') {
              await this.ingest.authorizeReceived(id, bytes, auth);
              reply = Buffer.from(JSON.stringify({ path: this.viewer.grants.issue(id) }));
            } else reply = await this.ingest.status(id, bytes, auth, path === '/sealed/v1/revoke');
          }
        } finally { auth.fill(0); }
      }
      const cap = path === '/sealed/v1/setup' || path === '/pair/v1/destinations' ? 65536 : path?.startsWith('/pair/') ? 16384 : 4096;
      if (reply.length > cap) throw new HttpError(503, 'Outcome unavailable.');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(reply);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof Error && error.message === 'Pairing rejected.' ? 403 : 503;
      if (!res.destroyed) { res.writeHead(status, { Connection: 'close', 'Cache-Control': 'no-store' }); res.end(); }
      // Do not drain arbitrary hostile bodies or keep a connection carrying secrets alive.
      res.once('finish', () => { if (!req.complete) req.destroy(); });
    } finally { clearTimeout(timer); }
  }
  close(): Promise<void> { return this.shutdown ??= this.stop(); }
  private async stop(): Promise<void> {
    this.stopping = true; clearTimeout(this.timer);
    for (const pending of this.enrollments.values()) pending.finish(false);
    const socketsClosed = this.started && this.server.listening ? new Promise<void>(resolve => this.server.close(() => resolve())) : Promise.resolve();
    this.server.closeIdleConnections();
    // Bound slow peers, not filesystem publication. Never close Jobs under a finalizer.
    const deadline = setTimeout(() => { for (const socket of this.sockets) socket.destroy(); }, this.config.bodyTimeoutMs ?? 30000);
    deadline.unref();
    try {
      await socketsClosed;
      await Promise.allSettled([...this.operations]);
      await this.sweep;
      await this.ingest.drain();
    } finally { clearTimeout(deadline); this.config.jobs.close(); this.config.authority.close(); }
  }
}

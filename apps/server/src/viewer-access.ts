import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { TLSSocket } from 'node:tls';
import { HttpError, viewerCodeSchema, viewerSessionSchema, type JobId } from './contracts.js';
import { hashToken } from './jobs.js';

export const viewerCookieName = 'footage_viewer';
const capacity = 256;
type Grant = { jobId: JobId; expiresAt: number };

export type ViewerOptions = {
  viewerCodeTtlMs?: number;
  viewerSessionTtlMs?: number;
};

export function usesTls(req: IncomingMessage): boolean {
  return req.socket instanceof TLSSocket && req.socket.encrypted;
}

// Forwarded headers cannot turn an untrusted cleartext peer into a trusted one.
export function requirePrivateTransport(req: IncomingMessage): void {
  if (usesTls(req)) return;
  const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    const [first, second = -1] = parts;
    if (first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254)) return;
  }
  if (version === 6 && (address === '::1' || /^(?:fc|fd|fe[89ab])/i.test(address))) return;
  throw new HttpError(403, 'Cleartext viewing is restricted to a trusted private network.');
}

export class ViewerAccess {
  private readonly codes = new Map<string, Grant>();
  private readonly sessions = new Map<string, Grant>();
  private readonly codeTtl: number;
  readonly sessionTtl: number;

  constructor(options: ViewerOptions) {
    this.codeTtl = options.viewerCodeTtlMs ?? 2 * 60_000;
    this.sessionTtl = options.viewerSessionTtlMs ?? 10 * 60_000;
    for (const ttl of [this.codeTtl, this.sessionTtl]) {
      if (!Number.isSafeInteger(ttl) || ttl < 0 || ttl > 24 * 60 * 60_000) throw new Error('Viewer lifetimes must be milliseconds between zero and one day.');
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const grants of [this.codes, this.sessions]) {
      for (const [key, grant] of grants) if (grant.expiresAt <= now) grants.delete(key);
    }
  }

  issue(jobId: JobId): string {
    this.prune();
    if (this.codes.size >= capacity) throw new HttpError(503, 'Too many pending viewing links. Try again after they expire.');
    const code = viewerCodeSchema.parse(randomBytes(32).toString('hex'));
    this.codes.set(hashToken(code), { jobId, expiresAt: Date.now() + this.codeTtl });
    return `/receive#${code}`;
  }

  exchange(code: ReturnType<typeof viewerCodeSchema.parse>): string {
    this.prune();
    const key = hashToken(code);
    const grant = this.codes.get(key);
    if (!grant) throw new HttpError(401, 'Invalid or expired viewing link. Open a fresh link from the sender.');
    if (this.sessions.size >= capacity) throw new HttpError(503, 'Too many viewing sessions. Try again after they expire.');
    this.codes.delete(key);
    const session = viewerSessionSchema.parse(randomBytes(32).toString('hex'));
    this.sessions.set(hashToken(session), { jobId: grant.jobId, expiresAt: Date.now() + this.sessionTtl });
    return session;
  }

  authorize(cookie: string | undefined): JobId {
    this.prune();
    const values = (cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${viewerCookieName}=`));
    const parsed = viewerSessionSchema.safeParse(values.length === 1 ? values[0]?.slice(viewerCookieName.length + 1) : undefined);
    const grant = parsed.success ? this.sessions.get(hashToken(parsed.data)) : undefined;
    if (!grant) throw new HttpError(401, 'A current viewing session is required. Open a fresh link from the sender.');
    return grant.jobId;
  }
}

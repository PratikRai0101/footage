import type { IncomingMessage, ServerResponse } from 'node:http';
import { originalPath } from './originals.js';
import { contentType, requireReceived, streamContent } from './content.js';
import { HttpError, viewerExchangeSchema } from './contracts.js';
import type { Jobs } from './jobs.js';
import { ViewerAccess, viewerCookieName } from './viewer-access.js';
import { viewerCsp, viewerHtml } from './viewer-page.js';

/** Read-only browser grants remain separate from paired write authority. */
export class PairedViewer {
  readonly grants = new ViewerAccess({});
  constructor(private readonly directory: string, private readonly jobs: Jobs, private readonly origin: string) {}
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', this.origin);
    if (url.pathname !== '/receive' && !url.pathname.startsWith('/viewer/')) return false;
    res.setHeader('Content-Security-Policy', viewerCsp);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    if (url.pathname === '/receive' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(viewerHtml) });
      res.end(req.method === 'HEAD' ? undefined : viewerHtml); return true;
    }
    if (req.method === 'POST' && url.pathname === '/viewer/session') {
      if (req.headers.origin && req.headers.origin !== this.origin && req.headers.origin !== new URL(this.origin).origin) throw new HttpError(403, 'Use the same receiver origin.');
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, 'Send JSON.');
      const chunks: Buffer[] = []; let count = 0;
      for await (const chunk of req) {
        if (!Buffer.isBuffer(chunk)) throw new HttpError(400, 'Invalid body.');
        count += chunk.length; if (count > 4096) throw new HttpError(413, 'Metadata limit.'); chunks.push(chunk);
      }
      let input: unknown;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
      const parsed = viewerExchangeSchema.safeParse(input);
      if (!parsed.success) throw new HttpError(400, 'Viewing code required.');
      const session = this.grants.exchange(parsed.data.code);
      res.setHeader('Set-Cookie', `${viewerCookieName}=${session}; Path=/viewer/; HttpOnly; SameSite=Strict; Secure; Max-Age=${Math.ceil(this.grants.sessionTtl / 1000)}`);
      res.writeHead(204); res.end(); return true;
    }
    const job = this.jobs.get(this.grants.authorize(req.headers.cookie)); requireReceived(job);
    const path = originalPath(this.directory, job);
    if (req.method === 'GET' && url.pathname === '/viewer/job') {
      const type = await contentType(path);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: job.id, name: job.name, bytes: job.bytes, sha256: job.sha256, receipt: job.receipt, status: job.status, contentType: type, previewSupported: type !== 'application/octet-stream', contentPath: '/viewer/content', downloadPath: '/viewer/content?download=1' }));
      return true;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/viewer/content') {
      await streamContent({ req, res, job, path, download: url.searchParams.get('download') === '1' }); return true;
    }
    throw new HttpError(405, 'Viewing sessions are read-only.');
  }
}

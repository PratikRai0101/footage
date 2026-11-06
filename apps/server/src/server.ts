import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { FileStore } from '@tus/file-store';
import { Server, Upload } from '@tus/server';
import { NodeRequest } from 'srvx/node';
import { ZodError } from 'zod';
import { capabilitySchema, HttpError, jobIdSchema, registrationSchema, viewerExchangeSchema, type JobId, type StoredJob } from './contracts.js';
import { Jobs } from './jobs.js';
import { contentType, requireReceived, streamContent } from './content.js';
import { requirePrivateTransport, usesTls, ViewerAccess, viewerCookieName, type ViewerOptions } from './viewer-access.js';
import { viewerCsp, viewerHtml } from './viewer-page.js';

function tokenFrom(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'An upload capability is required.');
  const parsed = capabilitySchema.safeParse(header.slice(7));
  if (!parsed.success) throw new HttpError(401, 'Invalid upload capability.');
  return parsed.data;
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 4096) throw new HttpError(413, 'Request metadata is too large.');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function createReceiver(directory: string, options: ViewerOptions = {}) {
  await mkdir(directory, { recursive: true });
  const viewer = new ViewerAccess(options);
  const jobs = new Jobs(join(directory, 'jobs.sqlite'));
  const store = new FileStore({ directory: join(directory, 'uploads') });
  const tus = new Server({ path: '/files', datastore: store, allowedOrigins: [], maxSize: 4 * 1024 ** 3 });
  // One process only. All mutation and tus requests for an identity share this lock.
  const tails = new Map<JobId, Promise<void>>();
  async function exclusive<T>(id: JobId, action: () => Promise<T>): Promise<T> {
    const previous = tails.get(id) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    tails.set(id, current);
    await previous;
    try { return await action(); }
    finally { release(); if (tails.get(id) === current) tails.delete(id); }
  }

  async function ensureUpload(job: StoredJob): Promise<void> {
    try { await store.getUpload(job.id); }
    catch (error) {
      // Only absence permits creation; never replace data after an I/O failure.
      if (typeof error !== 'object' || error === null || !('status_code' in error) || error.status_code !== 404) throw error;
      await store.create(new Upload({ id: job.id, size: job.bytes, offset: 0, metadata: {} }));
    }
  }

  async function snapshot(job: StoredJob) {
    const offset = job.status === 'cancelled' ? 0 : (await store.getUpload(job.id)).offset;
    return { id: job.id, name: job.name, bytes: job.bytes, confirmedBytes: offset, status: job.status, receipt: job.receipt, uploadPath: `/files/${job.id}` };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // tus-java-client uses this standard fallback on JREs that cannot issue PATCH directly.
    if (req.method === 'POST' && req.headers['x-http-method-override'] === 'PATCH') req.method = 'PATCH';
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { service: 'footage-receiver', scope: 'private-network spike', protocol: 'tus/1.0.0' });
      return;
    }
    if (url.pathname === '/receive' && (req.method === 'GET' || req.method === 'HEAD')) {
      requirePrivateTransport(req);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(viewerHtml) });
      res.end(req.method === 'HEAD' ? undefined : viewerHtml);
      return;
    }
    if (url.pathname.startsWith('/viewer/')) {
      requirePrivateTransport(req);
      if (req.method === 'POST' && url.pathname === '/viewer/session') {
        if (req.headers.origin && req.headers.origin !== `${usesTls(req) ? 'https' : 'http'}://${req.headers.host}`) throw new HttpError(403, 'Use the same receiver origin.');
        if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Send application/json.');
        const input = viewerExchangeSchema.safeParse(await body(req));
        if (!input.success) throw new HttpError(400, 'A valid viewing code is required.');
        const session = viewer.exchange(input.data.code);
        res.setHeader('set-cookie', `${viewerCookieName}=${session}; Path=/viewer/; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(viewer.sessionTtl / 1000)}${usesTls(req) ? '; Secure' : ''}`);
        res.writeHead(204); res.end();
        return;
      }
      const job = jobs.get(viewer.authorize(req.headers.cookie));
      requireReceived(job);
      const path = join(store.directory, job.id);
      if (req.method === 'GET' && url.pathname === '/viewer/job') {
        const type = await contentType(path);
        json(res, 200, { id: job.id, name: job.name, bytes: job.bytes, sha256: job.sha256, status: job.status, receipt: job.receipt, contentType: type, previewSupported: type !== 'application/octet-stream', contentPath: '/viewer/content', downloadPath: '/viewer/content?download=1' });
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/viewer/content') {
        await streamContent({ req, res, job, path, download: url.searchParams.get('download') === '1' });
        return;
      }
      throw new HttpError(405, 'Viewing sessions are read-only.');
    }
    if (req.method === 'POST' && url.pathname === '/jobs') {
      const token = tokenFrom(req);
      const input = registrationSchema.parse(await body(req));
      await exclusive(input.id, async () => {
        if (req.aborted || res.destroyed) return;
        const job = jobs.register(input, token);
        if (job.status === 'uploading') await ensureUpload(job);
        json(res, 200, await snapshot(job));
      });
      return;
    }
    const match = /^\/(jobs|files)\/([^/]+)(?:\/(complete|content|view))?$/.exec(url.pathname);
    if (!match) throw new HttpError(404, 'Not found.');
    const id = jobIdSchema.parse(match[2]);
    const token = tokenFrom(req);
    // Receipt publication makes the original immutable; playback never queues behind a socket.
    if (match[1] === 'jobs' && match[3] === 'content' && (req.method === 'GET' || req.method === 'HEAD')) {
      const job = jobs.authorize(id, token);
      await streamContent({ req, res, job, path: join(store.directory, id), download: true });
      return;
    }
    if (match[1] === 'jobs' && match[3] === 'view' && req.method === 'POST') {
      requirePrivateTransport(req);
      const job = jobs.authorize(id, token);
      requireReceived(job);
      json(res, 200, { path: viewer.issue(id) });
      return;
    }
    await exclusive(id, async () => {
      if (req.aborted || res.destroyed) return;
      if (match[1] === 'jobs' && !match[3] && req.method === 'DELETE' && jobs.cancelBeforeRegistration(id, token)) {
        json(res, 200, { id, status: 'cancelled', cleanup: 'complete' });
        return;
      }
      const job = jobs.authorize(id, token);
      if (match[1] === 'files') {
        if (match[3] || !['HEAD', 'PATCH', 'OPTIONS'].includes(req.method ?? '')) throw new HttpError(405, 'Use the job API for creation and cancellation.');
        if (job.status !== 'uploading' && req.method === 'PATCH') throw new HttpError(409, `Upload is ${job.status}.`);
        if (job.status === 'cancelled') throw new HttpError(410, 'Upload cancelled.');
        // Await tus storage/lock completion, not delivery to a possibly disconnected socket.
        const response = await tus.handleWeb(new NodeRequest({ req, res }));
        const payload = Buffer.from(await response.arrayBuffer());
        if (!res.destroyed) {
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(payload);
        }
        return;
      }
      if (req.method === 'GET' && !match[3]) { json(res, 200, await snapshot(job)); return; }
      if (req.method === 'POST' && match[3] === 'complete') {
        if (job.status === 'received') { json(res, 200, job.receipt); return; }
        if (job.status !== 'uploading') throw new HttpError(409, `Upload is ${job.status}.`);
        const upload = await store.getUpload(id);
        if (upload.offset !== job.bytes || upload.size !== job.bytes) throw new HttpError(409, 'The server has not received the full file.');
        const hash = createHash('sha256');
        for await (const chunk of store.read(id)) hash.update(chunk);
        if (hash.digest('hex') !== job.sha256) {
          jobs.save({ ...job, status: 'failed' });
          throw new HttpError(422, 'The received file does not match the original.');
        }
        json(res, 200, jobs.receive(job));
        return;
      }
      if (req.method === 'DELETE' && !match[3]) {
        // Commit wins if a receipt was already published. Deletion of received artifacts is a separate operation.
        if (job.status === 'received') { json(res, 409, { error: 'Already received; cancellation cannot revoke a receipt.', receipt: job.receipt }); return; }
        jobs.save({ ...job, status: 'cancelled' });
        try { await store.remove(id); }
        catch (error) {
          if (typeof error !== 'object' || error === null || !('status_code' in error) || error.status_code !== 404) throw error;
        }
        json(res, 200, { id, status: 'cancelled', cleanup: 'complete' });
        return;
      }
      throw new HttpError(405, 'Method not allowed.');
    });
  }

  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', viewerCsp);
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    route(req, res).catch((error: unknown) => {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : error instanceof ZodError ? 400 : 500;
      json(res, status, { error: status === 500 ? 'Receiver storage or internal error.' : error instanceof Error ? error.message : 'Request failed.' });
    });
  });
  server.requestTimeout = 30_000;
  return {
    server,
    async listen(port = 0, host = '127.0.0.1'): Promise<string> {
      server.listen(port, host); await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Missing TCP address.');
      return `http://${host}:${address.port}`;
    },
    async close(): Promise<void> {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      jobs.close();
    },
  };
}

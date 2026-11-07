import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { constants, createReadStream, closeSync, fstatSync, fsyncSync, openSync } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { type StoredJob } from './contracts.js';
import { fileIdentity, originalPath, privateDirectory, syncDirectory } from './originals.js';

const id = z.string().min(1).max(256);
export const targetSchema = z.object({ intake: z.uuid(), environment: id, project: id, thread: id, workspace: z.string().min(1), title: z.string().min(1).max(120) }).strict();
export type ThreadTarget = z.infer<typeof targetSchema>;
const rpcResult = z.object({ id: z.union([z.string(), z.number()]), result: z.unknown().optional(), error: z.unknown().optional() });
const toolResult = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Persistent MCP credential namespace; no stock CLI send, no attachment-limit bypass. */
export class T3Client {
  private initialized = false;
  private session: string | undefined;
  readonly credentialIdentity: string;
  private constructor(private readonly endpoint: string, private readonly token: string) { this.credentialIdentity = sha(token); }
  static async fromFile(endpoint: string, tokenFile: string): Promise<T3Client> {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/mcp' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use the approved HTTPS MCP endpoint (or local loopback).');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Workspace delivery requires T3 MCP on this same computer; remote filesystem paths are not upload destinations.');
    const file = await open(tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    let token: string;
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16384) throw new Error('MCP credential file must be a private regular file.');
      const bounded = Buffer.alloc(16385);
      let bytesRead = 0;
      while (bytesRead < bounded.length) {
        const part = await file.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
        if (part.bytesRead === 0) break;
        bytesRead += part.bytesRead;
      }
      if (bytesRead > 16384) throw new Error('MCP credential file exceeds its limit.');
      token = bounded.subarray(0, bytesRead).toString('utf8').trim();
    } finally { await file.close(); }
    if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('Invalid MCP credential file.');
    return new T3Client(url.href, token);
  }
  private async rpc(method: string, params: unknown, notification = false): Promise<unknown> {
    const requestId = randomUUID();
    const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26', ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params }) });
    if (!response.ok) throw new Error('T3 MCP request was refused or unavailable.');
    const session = response.headers.get('mcp-session-id'); if (session) this.session = session;
    if (notification || response.status === 202) return null;
    if (!response.body) throw new Error('Missing T3 response.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 2 * 1024 * 1024) throw new Error('T3 response limit.'); chunks.push(part.value); }
    } finally { await reader.cancel(); }
    const text = Buffer.concat(chunks).toString('utf8');
    const payload = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean).map(value => JSON.parse(value)).find(value => rpcResult.safeParse(value).success && typeof value === 'object' && value !== null && 'id' in value)
      : JSON.parse(text);
    const parsed = rpcResult.parse(payload); if (parsed.id !== requestId || parsed.error !== undefined) throw new Error('T3 MCP operation failed or returned a different request.'); return parsed.result;
  }
  async call(name: string, args: unknown): Promise<unknown> {
    if (!this.initialized) {
      await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'footage', version: '0.5.0' } });
      await this.rpc('notifications/initialized', {}, true); this.initialized = true;
    }
    const reply = toolResult.parse(await this.rpc('tools/call', { name, arguments: args }));
    if (reply.isError) throw new Error('T3 refused the operation.');
    if (reply.structuredContent !== undefined) return reply.structuredContent;
    const text = reply.content?.find(c => c.type === 'text')?.text;
    if (!text) throw new Error('T3 returned no structured result.');
    return JSON.parse(text);
  }
  async target(environment: string, project: string, thread: string, intake: string): Promise<ThreadTarget> {
    const env = z.object({ environmentId: id }).parse(await this.call('t3_environment_read', {}));
    if (env.environmentId !== environment) throw new Error('Wrong T3 environment.');
    const projectInfo = z.object({ id: id.optional(), projectId: id.optional(), workspaceRoot: z.string().min(1) }).parse(await this.call('t3_project_read', { projectId: project }));
    if ((projectInfo.id ?? projectInfo.projectId) !== project) throw new Error('Wrong T3 project.');
    const info = z.object({ thread: z.object({ threadId: id, projectId: id, title: z.string(), archived: z.boolean(), worktreePath: z.string().nullable() }) }).parse(await this.call('t3_thread_read', { threadId: thread, limit: 1, runLimit: 1, maxCharsPerItem: 1 }));
    if (info.thread.threadId !== thread || info.thread.projectId !== project || info.thread.archived) throw new Error('The chosen T3 thread is unavailable.');
    const workspace = await realpath(info.thread.worktreePath ?? projectInfo.workspaceRoot);
    let title = '';
    for (const character of info.thread.title.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')) {
      if (Buffer.byteLength(title + character) > 120) break;
      title += character;
    }
    return targetSchema.parse({ intake, environment, project, thread, workspace, title: title.trim() || 'Chosen thread' });
  }
}
const recordSchema = z.object({ target: targetSchema, receipt: z.uuid(), path: z.string(), bytes: z.number(), sha256: z.string(), credential: z.string(), requestId: z.uuid(), message: z.string(), state: z.enum(['copying', 'ready', 'unknown', 'sent']), messageId: z.string().nullable() });
type Delivery = z.infer<typeof recordSchema>;

export class T3Delivery {
  private readonly db: DatabaseSync;
  private readonly tails = new Map<string, Promise<void>>();
  private async exclusive<T>(job: string, action: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(job) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(job, current); await prior;
    try { return await action(); }
    finally { release(); if (this.tails.get(job) === current) this.tails.delete(job); }
  }
  constructor(private readonly directory: string, private readonly client: T3Client) {
    const fd = openSync(join(directory, 'delivery.sqlite'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { if (!fstatSync(fd).isFile()) throw new Error('Delivery storage must be a regular file.'); } finally { closeSync(fd); }
    this.db = new DatabaseSync(join(directory, 'delivery.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS deliveries(job TEXT PRIMARY KEY, record TEXT NOT NULL)');
  }
  private get(job: string): Delivery | null {
    const row = this.db.prepare('SELECT record FROM deliveries WHERE job=?').get(job);
    return row && typeof row.record === 'string' ? recordSchema.parse(JSON.parse(row.record)) : null;
  }
  private save(job: string, record: Delivery): void {
    this.db.prepare('INSERT OR REPLACE INTO deliveries VALUES (?,?)').run(job, JSON.stringify(recordSchema.parse(record)));
    const directory = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  materialize(job: StoredJob, target: ThreadTarget): Promise<Delivery> { return this.exclusive(job.id, () => this.materializeLocked(job, target)); }
  private async materializeLocked(job: StoredJob, target: ThreadTarget): Promise<Delivery> {
    if (job.status !== 'received' || !job.receipt || job.storageFault || job.receipt.jobId !== job.id || job.receipt.bytes !== job.bytes || job.receipt.sha256 !== job.sha256) throw new Error('Wait for a matching durable original receipt.');
    const live = await this.client.target(target.environment, target.project, target.thread, target.intake);
    if (live.workspace !== target.workspace) throw new Error('The thread workspace changed; delivery is blocked.');
    const prior = this.get(job.id);
    if (prior) {
      if (JSON.stringify(prior.target) !== JSON.stringify(target) || prior.receipt !== job.receipt.id) throw new Error('Immutable delivery target conflict.');
      try {
        const identity = await fileIdentity(prior.path);
        if (identity.bytes !== job.bytes || identity.sha256 !== job.sha256) throw new Error('Delivered original needs recovery.');
        if (prior.state === 'copying') { const ready: Delivery = { ...prior, state: 'ready' }; this.save(job.id, ready); return ready; }
        return prior;
      } catch (error) { if (!(prior.state === 'copying' && error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    const root = await realpath(target.workspace), folder = join(root, '.footage-originals');
    await privateDirectory(folder);
    if (await realpath(folder) !== folder || relative(root, folder).startsWith('..')) throw new Error('Workspace intake escapes the chosen thread.');
    try {
      const ignore = await open(join(folder, '.gitignore'), 'wx', 0o600);
      try { await ignore.writeFile('*\n'); await ignore.sync(); } finally { await ignore.close(); }
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const extension = extname(job.name).toLowerCase();
    const destination = join(folder, job.id + (/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '.original'));
    const message = `Footage original received and SHA-256 verified.\nFile: ${destination}\nOriginal name: ${job.name}\nBytes: ${job.bytes}\nSHA-256: ${job.sha256}\nReceipt: ${job.receipt.id}\n\nUse this original for my requested edit. Inspect it with $cardboard before making changes. Do not generate media or spend credits without asking.`;
    const record: Delivery = prior ?? { target, receipt: job.receipt.id, path: destination, bytes: job.bytes, sha256: job.sha256, credential: this.client.credentialIdentity, requestId: randomUUID(), message, state: 'copying', messageId: null };
    this.save(job.id, record); // Pin target, original, message and retry identity BEFORE filesystem/network effects.
    const temporary = join(folder, `${job.id}.${randomUUID()}.part`);
    const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256'); let bytes = 0;
    try {
      for await (const chunk of createReadStream(originalPath(this.directory, job))) { bytes += chunk.length; if (bytes > job.bytes) throw new Error('Original length changed.'); hash.update(chunk); await output.writeFile(chunk); }
      if (bytes !== job.bytes || hash.digest('hex') !== job.sha256) throw new Error('Original hash mismatch.');
      await output.sync(); await output.close();
      try { await lstat(destination); throw new Error('Destination already exists without a delivery record.'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      await rename(temporary, destination); await syncDirectory(folder);
    } finally { await output.close(); await rm(temporary, { force: true }); }
    const ready: Delivery = { ...record, state: 'ready' };
    this.save(job.id, ready); await chmod(join(this.directory, 'delivery.sqlite'), 0o600); return ready;
  }
  /** ONLY call following explicit operator consent. Ordinary T3 send starts an agent. */
  dispatch(job: StoredJob, target: ThreadTarget): Promise<string> { return this.exclusive(job.id, () => this.dispatchLocked(job, target)); }
  private async dispatchLocked(job: StoredJob, target: ThreadTarget): Promise<string> {
    const record = await this.materializeLocked(job, target);
    if (record.state === 'sent' && record.messageId) return record.messageId;
    if (record.credential !== this.client.credentialIdentity) throw new Error('T3 credential namespace changed. Reconcile the old send before retrying.');
    this.save(job.id, { ...record, state: 'unknown' });
    const result = z.object({ threadId: id, messageId: id }).parse(await this.client.call('t3_thread_send', { threadId: target.thread, message: record.message, mode: 'queue', clientRequestId: `footage:${record.requestId}` }));
    if (result.threadId !== target.thread) throw new Error('T3 returned a different thread. Delivery remains uncertain.');
    this.save(job.id, { ...record, state: 'sent', messageId: result.messageId }); return result.messageId;
  }
  close(): void { this.db.close(); }
}

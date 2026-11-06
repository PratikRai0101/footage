import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { HttpError, receiptSchema, storedJobSchema, type JobId, type Receipt, type Registration, type StoredJob } from './contracts.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function secureDatabase(path: string): void {
  const descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error('Database must be a private regular file.');
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) fchmodSync(descriptor, 0o600);
  } finally { closeSync(descriptor); }
}

export class Jobs {
  private readonly db: DatabaseSync;
  private readonly writer: DatabaseSync;
  private readonly tails = new Map<JobId, Promise<void>>();

  constructor(path: string) {
    // A separate SQLite rollback-journal lock is held for this owner's lifetime.
    // OS file locks release on process death, unlike a stale PID/lock-directory protocol.
    secureDatabase(`${path}.writer`);
    this.writer = new DatabaseSync(`${path}.writer`);
    let database: DatabaseSync | undefined;
    try {
      this.writer.exec('PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS writer (id INTEGER)');
      secureDatabase(path);
      database = new DatabaseSync(path);
      this.db = database;
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cancellations (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS original_events (job_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, kind TEXT NOT NULL)');
      if (this.db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' || this.db.prepare('PRAGMA synchronous').get()?.synchronous !== 2) throw new Error('Durable SQLite configuration unavailable.');
    } catch (error) { database?.close(); this.writer.close(); throw error; }
  }

  async exclusive<T>(id: JobId, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(id, current);
    await previous;
    try { return await action(); }
    finally { release(); if (this.tails.get(id) === current) this.tails.delete(id); }
  }

  all(): StoredJob[] {
    return this.db.prepare('SELECT document FROM jobs').all().map((row) => {
      if (typeof row.document !== 'string') throw new Error('Invalid stored job.');
      const decoded: unknown = JSON.parse(row.document);
      return storedJobSchema.parse(decoded);
    });
  }

  insertSealed(job: StoredJob): void {
    if (this.db.prepare('SELECT id FROM cancellations WHERE id = ?').get(job.id)) throw new HttpError(410, 'Cancelled identity.');
    this.reserve(job.bytes * 2 + 64 * 1024 ** 2);
    this.db.prepare('INSERT INTO jobs (id, document) VALUES (?, ?)').run(job.id, JSON.stringify(storedJobSchema.parse(job)));
  }

  reservedBytes(): number {
    return this.all().filter(job => job.status !== 'cancelled' || job.cleanupPending || (job.transport === 'sealed-v1' && job.sealed?.cleanup !== 2)).reduce((sum, job) => sum + (job.transport === 'sealed-v1' ? job.bytes * 2 + 64 * 1024 ** 2 : job.bytes * 2), 0);
  }

  private reserve(bytes: number): void {
    if (this.all().length >= 20 || this.reservedBytes() + bytes > 8 * 1024 ** 3) throw new HttpError(507, 'Receiver storage or tombstone budget reached.');
  }

  get(id: JobId): StoredJob {
    const row = this.db.prepare('SELECT document FROM jobs WHERE id = ?').get(id);
    if (!row || typeof row.document !== 'string') throw new HttpError(404, 'Upload not found.');
    const decoded: unknown = JSON.parse(row.document);
    return storedJobSchema.parse(decoded);
  }

  register(input: Registration, token: string): StoredJob {
    const cancelled = this.db.prepare('SELECT token_hash FROM cancellations WHERE id = ?').get(input.id);
    if (cancelled) throw new HttpError(410, 'This upload identity was cancelled before registration.');
    const row = this.db.prepare('SELECT document FROM jobs WHERE id = ?').get(input.id);
    if (row) {
      const existing = this.authorize(input.id, token);
      if (existing.bytes !== input.bytes || existing.sha256 !== input.sha256 || existing.name !== input.name) {
        throw new HttpError(409, 'This upload identity already belongs to another file.');
      }
      return existing;
    }
    this.reserve(input.bytes * 2);
    const job: StoredJob = { ...input, tokenHash: hashToken(token), status: 'uploading', receipt: null, transport: 'tus' };
    this.db.prepare('INSERT INTO jobs (id, document) VALUES (?, ?)').run(job.id, JSON.stringify(job));
    return job;
  }

  cancelBeforeRegistration(id: JobId, token: string): boolean {
    if (this.db.prepare('SELECT id FROM jobs WHERE id = ?').get(id)) return false;
    const existing = this.db.prepare('SELECT token_hash FROM cancellations WHERE id = ?').get(id);
    if (existing) {
      if (existing.token_hash !== hashToken(token)) throw new HttpError(403, 'This capability does not authorize cancellation.');
      return true;
    }
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM cancellations').get();
    if (typeof count?.count !== 'number' || count.count >= 100) throw new HttpError(507, 'Demo cancellation budget reached.');
    this.db.prepare('INSERT INTO cancellations (id, token_hash) VALUES (?, ?)').run(id, hashToken(token));
    return true;
  }

  authorize(id: JobId, token: string): StoredJob {
    const job = this.get(id);
    if (job.transport !== 'tus' || !timingSafeEqual(Buffer.from(job.tokenHash, 'hex'), Buffer.from(hashToken(token), 'hex'))) {
      throw new HttpError(403, 'This capability does not authorize the upload.');
    }
    return job;
  }

  save(job: StoredJob): void {
    this.db.prepare('UPDATE jobs SET document = ? WHERE id = ?').run(JSON.stringify(storedJobSchema.parse(job)), job.id);
  }

  newReceipt(job: StoredJob, seconds = BigInt(Math.floor(Date.now() / 1000))): Receipt {
    if (seconds < 0n || seconds > 253402300799n) throw new Error('Receipt time outside shared profile.');
    return receiptSchema.parse({ id: randomUUID(), jobId: job.id, bytes: job.bytes, sha256: job.sha256, verifiedAt: new Date(Number(seconds) * 1000).toISOString() });
  }

  // Call only after sync + rename + parent sync of the verified original, under exclusive().
  publish(job: StoredJob, receipt: Receipt): Receipt {
    if (job.status === 'received' && job.receipt) return job.receipt;
    if (job.status !== 'uploading') throw new HttpError(409, `Upload is ${job.status}.`);
    const validated = receiptSchema.parse(receipt);
    if (validated.jobId !== job.id || validated.bytes !== job.bytes || validated.sha256 !== job.sha256) throw new Error('Receipt identity mismatch.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.save({ ...job, contentReference: 'original', status: 'received', receipt: validated });
      this.db.prepare('INSERT INTO original_events VALUES (?, ?, ?)').run(job.id, receipt.id, 'original-received');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return validated;
  }

  close(): void {
    this.db.close();
    this.writer.close();
  }
}

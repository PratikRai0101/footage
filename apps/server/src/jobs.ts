import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HttpError, storedJobSchema, type JobId, type Receipt, type Registration, type StoredJob } from './contracts.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class Jobs {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cancellations (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL)');
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
    const rows = this.db.prepare('SELECT document FROM jobs').all();
    const jobs = rows.map((row) => {
      if (typeof row.document !== 'string') throw new Error('Invalid stored job.');
      const decoded: unknown = JSON.parse(row.document);
      return storedJobSchema.parse(decoded);
    });
    const reserved = jobs.filter((job) => job.status !== 'cancelled').reduce((sum, job) => sum + job.bytes, 0);
    if (jobs.length >= 20 || reserved + input.bytes > 8 * 1024 ** 3) {
      throw new HttpError(507, 'Demo storage budget reached. Remove local demo data before creating more uploads.');
    }
    const job: StoredJob = { ...input, tokenHash: hashToken(token), status: 'uploading', receipt: null };
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
    if (!timingSafeEqual(Buffer.from(job.tokenHash, 'hex'), Buffer.from(hashToken(token), 'hex'))) {
      throw new HttpError(403, 'This capability does not authorize the upload.');
    }
    return job;
  }

  save(job: StoredJob): void {
    this.db.prepare('UPDATE jobs SET document = ? WHERE id = ?').run(JSON.stringify(job), job.id);
  }

  receive(job: StoredJob): Receipt {
    if (job.status === 'received' && job.receipt) return job.receipt;
    if (job.status !== 'uploading') throw new HttpError(409, `Upload is ${job.status}.`);
    const receipt: Receipt = {
      id: randomUUID(), jobId: job.id, bytes: job.bytes, sha256: job.sha256, verifiedAt: new Date().toISOString(),
    };
    this.save({ ...job, status: 'received', receipt });
    return receipt;
  }

  close(): void {
    this.db.close();
  }
}

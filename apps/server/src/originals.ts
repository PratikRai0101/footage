import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { HttpError, type StoredJob } from './contracts.js';

export async function privateDirectory(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('Storage must be a private real directory.');
  if (firstCreated !== undefined) {
    for (let current = resolve(path); ; current = dirname(current)) {
      await syncDirectory(current);
      if (current === resolve(firstCreated)) { await syncDirectory(dirname(current)); break; }
    }
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, 'r');
  try { await file.sync(); } finally { await file.close(); }
}

export async function privateFile(path: string): Promise<FileHandle> {
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}

export async function fileIdentity(path: string): Promise<{ bytes: number; sha256: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Not a regular original.');
    let bytes = 0;
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({ autoClose: false })) { bytes += chunk.length; hash.update(chunk); }
    return { bytes, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}

export function originalPath(directory: string, job: StoredJob): string {
  return join(directory, job.contentReference === 'original' ? 'originals' : 'uploads', job.id);
}

export type PublicationBoundary = 'original-sync' | 'original-rename' | 'original-directory-sync';

// Both transports use this exact durable publication path. The caller must still
// recheck terminal state under Jobs.exclusive before publishing the receipt row.
export async function prepareOriginal(directory: string, job: StoredJob, chunks: AsyncIterable<Uint8Array>, boundary: (point: PublicationBoundary) => void = () => {}): Promise<void> {
  const originals = join(directory, 'originals');
  await privateDirectory(originals);
  const temporary = join(originals, `${job.id}.${randomUUID()}.tmp`);
  const file = await privateFile(temporary);
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    for await (const chunk of chunks) {
      bytes += chunk.length;
      if (bytes > job.bytes) throw new HttpError(422, 'Original length mismatch.');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (bytes !== job.bytes || hash.digest('hex') !== job.sha256) throw new HttpError(422, 'Original hash or length mismatch.');
    await file.sync(); boundary('original-sync');
    await file.close();
    await rename(temporary, join(originals, job.id)); boundary('original-rename');
    await syncDirectory(originals); boundary('original-directory-sync');
  } finally { await file.close(); await rm(temporary, { force: true }); }
}

export async function repairOriginalOrphans(directory: string, jobs: StoredJob[]): Promise<void> {
  const originals = join(directory, 'originals');
  await privateDirectory(originals);
  const retained = new Set(jobs.filter(job => job.contentReference === 'original').map(job => job.id.toString()));
  for (const entry of await readdir(originals)) if (!retained.has(entry)) await rm(join(originals, entry), { force: true });
  await syncDirectory(originals);
}

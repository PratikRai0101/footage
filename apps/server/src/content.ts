import { open, type FileHandle } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, type StoredJob } from './contracts.js';

type ContentType = 'video/mp4' | 'video/webm' | 'video/ogg' | 'application/octet-stream';
type ByteRange = { start: number; end: number };

export function requireReceived(job: StoredJob): void {
  if (job.status !== 'received' || !job.receipt) throw new HttpError(409, 'The file has not been verified.');
}

async function sniff(file: FileHandle): Promise<ContentType> {
  const prefix = Buffer.alloc(4096);
  const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
  const bytes = prefix.subarray(0, bytesRead);
  if (bytes.length >= 16 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    const size = Math.min(bytes.readUInt32BE(0), bytes.length);
    for (let offset = 8; offset + 4 <= size; offset += 4) {
      if (offset === 12) continue; // Minor version, not a compatible brand.
      if (/^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V )$/.test(bytes.toString('latin1', offset, offset + 4))) return 'video/mp4';
    }
  }
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && bytes.includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))) return 'video/webm';
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 4) === 'OggS' && bytes[4] === 0) return 'video/ogg';
  return 'application/octet-stream';
}

export async function contentType(path: string): Promise<ContentType> {
  const file = await open(path, 'r');
  try { return await sniff(file); }
  finally { await file.close(); }
}

function parseRange(header: string, bytes: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) throw new HttpError(416, 'One valid byte range is required.');
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) throw new HttpError(416, 'Invalid byte range.');
  if (first === undefined) {
    if (last === undefined || last === 0) throw new HttpError(416, 'Invalid suffix range.');
    return { start: Math.max(0, bytes - last), end: bytes - 1 };
  }
  if (first >= bytes || (last !== undefined && last < first)) throw new HttpError(416, 'Byte range is outside the original.');
  return { start: first, end: Math.min(last ?? bytes - 1, bytes - 1) };
}

function disposition(name: string, download: boolean): string {
  // UTF-8 replacement also makes lone JSON surrogates safe for encodeURIComponent.
  const encoded = encodeURIComponent(Buffer.from(name, 'utf8').toString('utf8')).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download ? 'attachment' : 'inline'}; filename="received-original"; filename*=UTF-8''${encoded}`;
}

// Received files are immutable. Never keep an upload/mutation lock while a reader drains.
export async function streamContent({ req, res, job, path, download }: {
  req: IncomingMessage;
  res: ServerResponse;
  job: StoredJob;
  path: string;
  download: boolean;
}): Promise<void> {
  requireReceived(job);
  let range: ByteRange | undefined;
  if (req.headers.range !== undefined) {
    try { range = parseRange(req.headers.range, job.bytes); }
    catch (error) {
      res.setHeader('content-range', `bytes */${job.bytes}`);
      res.setHeader('accept-ranges', 'bytes');
      throw error;
    }
  }
  const file = await open(path, 'r');
  let streaming = false;
  try {
    const type = await sniff(file);
    if (res.destroyed) return;
    res.writeHead(range ? 206 : 200, {
      'content-type': type,
      'content-length': range ? range.end - range.start + 1 : job.bytes,
      'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${job.bytes}` } : {}),
      'content-disposition': disposition(job.name, download || type === 'application/octet-stream'),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = file.createReadStream({ start: range?.start ?? 0, end: range?.end ?? job.bytes - 1 });
    streaming = true; // The stream now owns (and closes) the file descriptor.
    stream.once('error', () => res.destroy());
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  } finally {
    if (!streaming) await file.close();
  }
}

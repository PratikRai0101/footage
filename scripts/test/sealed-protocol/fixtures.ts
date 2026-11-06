/** TEST ONLY. Synthetic data and deterministic AEAD invocation for differential vectors.
 * Never imported by production code. Master/identities are generated per run, not fixtures. */
import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Manifest, GenerationKeys, Binding, groupHeader, frameAAD, limits, sha256, type GroupSource, type GroupQuarantine } from '../../../apps/server/src/sealed-protocol.js';
export const hex = (size: number): string => size === 16 ? randomUUID().replaceAll('-', '') : randomBytes(size).toString('hex');
export function fixture(size = 37, t3 = false, origin = 'https://receiver.example:443') {
  const block = Buffer.alloc(Math.min(size, limits.frame), 0xa7), hashes: string[] = [], whole = createHash('sha256');
  for (let offset = 0; offset < size; offset += limits.frame) {
    const part = block.subarray(0, Math.min(limits.frame, size - offset));
    hashes.push(sha256(part));
    whole.update(part);
  }
  const fields = {
    receiver: hex(32), origin, job: hex(16), generation: hex(16), device: hex(16), enrollmentEpoch: 3n, destination: t3 ? { kind: 't3', environment: '環境', project: 'project', thread: 'thread', workspace: 'workspace', consent: hex(16) } : { kind: 'standalone', intake: hex(16) }, originalBytes: BigInt(size), originalSHA256: whole.digest('hex'), safeName: 'café.mov', expiresAt: 1800000000n, frameBytes: limits.frame, framesPerGroup: 8, frameHashes: hashes
  };
  const manifest = Manifest.create(fields), master = randomBytes(32), keys = GenerationKeys.fromSetup(master, manifest), binding = Binding.match(manifest, fields);
  return { manifest, master, keys, binding, block, fields };
}
export function deterministicFrame(keys: GenerationKeys, frame = 0, plaintext?: Buffer, override?: {
  sealID?: Buffer;
  nonce?: Buffer;
  header?: Buffer;
}): Buffer {
  const length = keys.manifest.frameLength(frame), bytes = plaintext ?? Buffer.alloc(length, 0xa7);
  const sealID = override?.sealID ?? createHash('sha256').update(`TEST ONLY seal ${frame}`).digest().subarray(0, 16), nonce = override?.nonce ?? Buffer.alloc(12, 0x33), header = override?.header ?? groupHeader(keys.manifest, Math.floor(frame / 8));
  const cipher = createCipheriv('aes-256-gcm', keys.derive('body', { index: frame, sealID }), nonce);
  cipher.setAAD(frameAAD(header, frame, bytes.length, sealID));
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(frame);
  prefix.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([prefix, sealID, nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}
export class MemorySource implements GroupSource {
  private cursor = 0;
  constructor(private readonly bytes: Buffer) {
  }
  async readExactly(length: number): Promise<Buffer> {
    const b = this.bytes.subarray(this.cursor, this.cursor + length);
    this.cursor += length;
    return b;
  }
  async atEnd(): Promise<boolean> {
    return this.cursor === this.bytes.length;
  }
}
export class PrivateQuarantine implements GroupQuarantine {
  writes = 0;
  bytes = 0;
  discarded = false;
  readonly hasher = createHash('sha256');
  async write(_frame: number, plaintext: Buffer): Promise<void> {
    this.writes++;
    this.bytes += plaintext.length;
    this.hasher.update(plaintext);
  }
  async discard(): Promise<void> {
    this.discarded = true;
    this.bytes = 0;
  }
}
export function remac(bytes: Buffer, keys: GenerationKeys, domain: 'ack' | 'receipt' | 'status'): Buffer {
  const payload = bytes.subarray(0, -32);
  return Buffer.concat([payload, createHmac('sha256', keys.derive(domain)).update(payload).digest()]);
}

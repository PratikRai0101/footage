import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';

export const PAIRING_LIMIT = 16 * 1024;
export const sha256 = (bytes: Uint8Array): Buffer => createHash('sha256').update(bytes).digest();
export function requirePairing(ok: unknown): asserts ok {
  if (!ok) throw new Error('Pairing rejected.');
}
export function permission(mask: number): number {
  requirePairing(Number.isInteger(mask) && mask > 0 && mask <= 31 && (mask & ~31) === 0);
  return mask;
}
export function origin(text: string): string {
  requirePairing(Buffer.byteLength(text) <= 512 && /^[\x21-\x7e]+$/.test(text));
  const match = /^https:\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+):([1-9][0-9]{0,4})$/.exec(text);
  requirePairing(match && Number(match[2]) <= 65535);
  const host = match[1];
  requirePairing(host);
  if (host.startsWith('[')) {
    requirePairing(isIP(host.slice(1, -1)) === 6 && new URL(text).hostname === host);
  } else if (/^[0-9.]+$/.test(host)) {
    requirePairing(isIP(host) === 4);
  } else {
    requirePairing(host.length <= 253 && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)));
  }
  return text;
}
// Only the canonical 91-byte named-curve, uncompressed P-256 SPKI is accepted.
const P256_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d03010703420004', 'hex');
export function p256(bytes: Uint8Array): KeyObject {
  const der = Buffer.from(bytes);
  requirePairing(der.length === 91 && der.subarray(0, P256_PREFIX.length).equals(P256_PREFIX));
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  requirePairing(key.asymmetricKeyDetails?.namedCurve === 'prime256v1' && key.export({ format: 'der', type: 'spki' }).equals(der));
  return key;
}
export const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
export const u64 = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64BE(n); return b; };
export function fixed(bytes: Uint8Array, length: number): Buffer { requirePairing(bytes.length === length); return Buffer.from(bytes); }
export function lp16(bytes: Uint8Array | string): Buffer {
  const b = Buffer.from(bytes); requirePairing(b.length <= 65535);
  const size = Buffer.alloc(2); size.writeUInt16BE(b.length); return Buffer.concat([size, b]);
}
export function lp32(bytes: Uint8Array): Buffer { return Buffer.concat([u32(bytes.length), bytes]); }
export class PairingReader {
  private offset = 0;
  readonly bytes: Buffer;
  constructor(bytes: Uint8Array, magic: string, limit = PAIRING_LIMIT) {
    this.bytes = Buffer.from(bytes); requirePairing(bytes.length <= limit);
    requirePairing(this.take(8).equals(Buffer.from(magic)));
  }
  take(n: number): Buffer {
    requirePairing(n >= 0 && this.offset + n <= this.bytes.length);
    const b = this.bytes.subarray(this.offset, this.offset + n); this.offset += n; return b;
  }
  u32(): number { return this.take(4).readUInt32BE(); }
  u64(): bigint { return this.take(8).readBigUInt64BE(); }
  lp16(max: number): Buffer { const n = this.take(2).readUInt16BE(); requirePairing(n <= max); return this.take(n); }
  lp32(max: number): Buffer { const n = this.u32(); requirePairing(n <= max); return this.take(n); }
  prefix(): Buffer { return this.bytes.subarray(0, this.offset); }
  end(): void { requirePairing(this.offset === this.bytes.length); }
}
export function verifySignature(key: KeyObject, bytes: Uint8Array, signature: Buffer): void {
  requirePairing(signature.length >= 8 && signature.length <= 72 && signature[0] === 0x30 && signature[1] === signature.length - 2);
  let offset = 2;
  for (let i = 0; i < 2; i++) {
    requirePairing(signature[offset++] === 2);
    const length = signature[offset++];
    requirePairing(length && length <= 33 && offset + length <= signature.length);
    const first = signature[offset], second = signature[offset + 1];
    requirePairing(first !== undefined && first < 128 && (length === 1 ? first > 0 : first !== 0 || (second !== undefined && second >= 128)));
    offset += length;
  }
  requirePairing(offset === signature.length && verify('sha256', bytes, key, signature));
}
export function signed(bytes: Buffer, key: KeyObject): Buffer { return Buffer.concat([bytes, lp16(sign('sha256', bytes, key))]); }
export function enrollment(bytes: Uint8Array, receiver: Buffer, serviceOrigin: string) {
  const r = new PairingReader(bytes, 'FTENRL01');
  const offer = r.take(16), secret = r.take(32), device = r.take(16), spki = r.lp16(128), nonce = r.take(32), mask = permission(r.u32());
  const prefix = r.prefix(), signature = r.lp16(72); r.end();
  verifySignature(p256(spki), Buffer.concat([prefix, receiver, lp16(serviceOrigin)]), signature);
  return { offer, secret, device, spki, nonce, mask };
}
export function qr(input: { spki: Buffer; ca: Buffer; pin: Buffer; origin: string; offer: Buffer; secret: Buffer; expires: bigint; mask: number }): Buffer {
  p256(input.spki); requirePairing(input.ca.length > 0 && input.ca.length <= 1024);
  const bytes = Buffer.concat([Buffer.from('FTQR0001'), lp16(input.spki), lp16(input.ca), fixed(input.pin, 32), lp16(origin(input.origin)), fixed(input.offer, 16), fixed(input.secret, 32), u64(input.expires), u32(permission(input.mask))]);
  requirePairing(bytes.length <= 2048); return bytes;
}
export function pairingRecord(input: { receiver: Buffer; origin: string; device: Buffer; spki: Buffer; mask: number; epoch: bigint; expires: bigint; credentialHash: Buffer; nonce: Buffer }, key: KeyObject): Buffer {
  return signed(Buffer.concat([Buffer.from('FTPAIR01'), input.receiver, lp16(input.origin), input.device, lp16(input.spki), u32(input.mask), u64(input.epoch), u64(input.expires), input.credentialHash, input.nonce]), key);
}
export function rotationRecord(input: { receiver: Buffer; spki: Buffer; pin: Buffer; ca: Buffer; origin: string; epoch: bigint; expires: bigint; nonce: Buffer }, key: KeyObject): Buffer {
  p256(input.spki); requirePairing(input.ca.length > 0 && input.ca.length <= 1024);
  return signed(Buffer.concat([Buffer.from('FTROT001'), input.receiver, lp16(input.spki), fixed(input.pin, 32), lp16(input.ca), lp16(origin(input.origin)), u64(input.epoch), u64(input.expires), fixed(input.nonce, 32)]), key);
}

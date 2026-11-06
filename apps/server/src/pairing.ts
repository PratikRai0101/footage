import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { enrollment, fixed, lp16, lp32, origin, p256, pairingRecord, PairingReader, permission, qr, requirePairing, rotationRecord, sha256, u64, verifySignature } from './pairing-wire.js';

/** Implement ONLY with an OS credential-store-held wrapping key. No default backend.
 * wrap/unwrap must authenticate context, fail on missing key, and never recreate it.
 * This module is intentionally not routed or instantiated by the receiver. */
export interface PairingKeyStore {
  wrap(plaintext: Buffer, context: string): Buffer;
  unwrap(ciphertext: Buffer, context: string): Buffer;
}
const opaqueScope = z.string().min(1).refine(text => Buffer.byteLength(text) <= 128 && Buffer.from(text).toString('utf8') === text && text.normalize('NFC') === text);
const scopesSchema = z.object({
  intakes: z.array(z.uuid()).max(100),
  projects: z.array(z.object({ environment: opaqueScope, project: opaqueScope })).max(100),
});
export type PairingScopes = z.infer<typeof scopesSchema>;
const hex16 = z.string().regex(/^[0-9a-f]{32}$/);
const deviceSchema = z.object({
  device: hex16, offer: hex16, spki: z.string(), mask: z.number().int().min(0).max(31),
  epoch: z.string().regex(/^[1-9][0-9]*$/), expires: z.string().regex(/^[0-9]+$/), revoked: z.boolean(), scopes: scopesSchema,
  wrapped: z.string(), credentialHash: z.string().regex(/^[0-9a-f]{64}$/),
});
type Device = z.infer<typeof deviceSchema>;
type Offer = { secret: Buffer; expires: bigint; mask: number; scopes: PairingScopes; approved: Buffer | null };
type PairingConfig = { path: string; keyStore: PairingKeyStore; origin: string; ca: Buffer; pin: Buffer; now?: () => bigint };
export type PairingDestination = { kind: 'intake'; intake: string } | { kind: 't3'; environment: string; project: string };

export class PairingAuthority {
  private readonly db: DatabaseSync;
  private readonly offers = new Map<string, Offer>();
  private readonly key: KeyObject;
  readonly identity: Buffer;
  readonly identitySPKI: Buffer;
  readonly serviceOrigin: string;
  private constructor(private readonly config: PairingConfig) {
    this.serviceOrigin = origin(config.origin);
    const directory = lstatSync(dirname(config.path));
    requirePairing(directory.isDirectory() && (directory.mode & 0o077) === 0);
    const descriptor = openSync(config.path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { const file = fstatSync(descriptor); requirePairing(file.isFile() && (file.mode & 0o077) === 0); }
    finally { closeSync(descriptor); }
    this.db = new DatabaseSync(config.path);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS pairing_meta (id TEXT PRIMARY KEY, value BLOB NOT NULL); CREATE TABLE IF NOT EXISTS pairing_devices (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pairing_challenges (id TEXT PRIMARY KEY, nonce BLOB NOT NULL, challenge BLOB NOT NULL, expires TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pairing_rate (id TEXT PRIMARY KEY, window TEXT NOT NULL, count INTEGER NOT NULL)');
      this.key = this.transaction(() => {
        const saved = this.db.prepare('SELECT value FROM pairing_meta WHERE id = ?').get('identity');
        if (saved) {
          requirePairing(saved.value instanceof Uint8Array);
          return createPrivateKey({ key: config.keyStore.unwrap(Buffer.from(saved.value), 'pairing/identity/v1'), format: 'der', type: 'pkcs8' });
        }
        // An existing DB with missing identity must never turn into a new receiver.
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM pairing_devices').get();
        requirePairing(count?.n === 0);
        const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
        const wrapped = config.keyStore.wrap(key.export({ format: 'der', type: 'pkcs8' }), 'pairing/identity/v1');
        this.db.prepare('INSERT INTO pairing_meta VALUES (?, ?)').run('identity', wrapped);
        this.db.prepare('INSERT INTO pairing_meta VALUES (?, ?)').run('binding', Buffer.from(this.serviceOrigin));
        this.db.prepare('INSERT INTO pairing_meta VALUES (?, ?)').run('rotationEpoch', Buffer.from('1'));
        return key;
      });
      this.identitySPKI = createPublicKey(this.key).export({ format: 'der', type: 'spki' }); p256(this.identitySPKI);
      this.identity = sha256(this.identitySPKI);
      const binding = this.db.prepare('SELECT value FROM pairing_meta WHERE id = ?').get('binding');
      requirePairing(binding?.value instanceof Uint8Array && Buffer.from(binding.value).toString() === this.serviceOrigin);
      // Probe all wrapped enrolled credentials on startup: missing/replaced backend blocks open.
      for (const row of this.db.prepare('SELECT value FROM pairing_devices').all()) {
        requirePairing(typeof row.value === 'string'); const device = deviceSchema.parse(JSON.parse(row.value));
        const credential = config.keyStore.unwrap(Buffer.from(device.wrapped, 'base64'), `pairing/device/${device.device}`);
        requirePairing(credential.length === 32 && sha256(credential).toString('hex') === device.credentialHash);
      }
    } catch (error) { this.db.close(); throw error; }
  }
  /** The local controller must be held by trusted desktop code, never an HTTP router. */
  static open(config: PairingConfig) {
    const authority = new PairingAuthority(config);
    return { authority, local: {
      createOffer: (input: { mask: number; scopes: PairingScopes }) => authority.createOffer(input),
      approve: (body: Uint8Array, scopes: PairingScopes) => authority.approve(body, scopes),
      revoke: (device: Buffer) => authority.revoke(device),
      rotation: (input: { spki: Buffer; pin: Buffer; ca: Buffer; origin: string; epoch: bigint; expires: bigint; nonce: Buffer }) => authority.rotation(input),
    } };
  }
  private now(): bigint { return this.config.now?.() ?? BigInt(Math.floor(Date.now() / 1000)); }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private createOffer(input: { mask: number; scopes: PairingScopes }): Buffer {
    const mask = permission(input.mask), scopes = scopesSchema.parse(input.scopes);
    for (const [id, offer] of this.offers) if (offer.expires <= this.now()) this.offers.delete(id);
    requirePairing(this.offers.size < 32);
    const id = randomBytes(16), secret = randomBytes(32), expires = this.now() + 120n;
    const bytes = qr({ spki: this.identitySPKI, ca: this.config.ca, pin: this.config.pin, origin: this.serviceOrigin, offer: id, secret, expires, mask });
    this.offers.set(id.toString('hex'), { secret, expires, mask, scopes, approved: null }); return bytes;
  }
  /** Safe display data ONLY after PoP; do not log the body. Approval is a separate local action. */
  inspectEnrollment(body: Uint8Array) {
    const e = enrollment(body, this.identity, this.serviceOrigin); this.offer(e);
    return { deviceFingerprint: sha256(e.spki), device: Buffer.from(e.device), permissions: e.mask };
  }
  private offer(e: ReturnType<typeof enrollment>): Offer {
    const offer = this.offers.get(e.offer.toString('hex'));
    requirePairing(offer && this.now() < offer.expires && timingSafeEqual(offer.secret, e.secret) && (e.mask & offer.mask) === e.mask);
    return offer;
  }
  private approve(body: Uint8Array, input: PairingScopes): void {
    const e = enrollment(body, this.identity, this.serviceOrigin), offer = this.offer(e), scopes = scopesSchema.parse(input);
    requirePairing(scopes.intakes.every(id => offer.scopes.intakes.includes(id)) && scopes.projects.every(p => offer.scopes.projects.some(q => q.environment === p.environment && q.project === p.project)));
    offer.scopes = scopes; offer.approved = sha256(body);
  }
  enroll(body: Uint8Array): Buffer {
    const e = enrollment(body, this.identity, this.serviceOrigin), offer = this.offer(e);
    requirePairing(offer.approved && timingSafeEqual(offer.approved, sha256(body)));
    const reply = this.transaction(() => {
      requirePairing(!this.db.prepare('SELECT id FROM pairing_devices WHERE id = ? OR json_extract(value, \'$.offer\') = ?').get(e.device.toString('hex'), e.offer.toString('hex')));
      const credential = randomBytes(32);
      const device: Device = { device: e.device.toString('hex'), offer: e.offer.toString('hex'), spki: e.spki.toString('base64'), mask: e.mask, epoch: '1', expires: (this.now() + 7n * 86400n).toString(), revoked: false, scopes: offer.scopes, wrapped: this.config.keyStore.wrap(credential, `pairing/device/${e.device.toString('hex')}`).toString('base64'), credentialHash: sha256(credential).toString('hex') };
      this.db.prepare('INSERT INTO pairing_devices VALUES (?, ?)').run(device.device, JSON.stringify(device));
      return this.reply(device, credential, e.nonce);
    });
    this.offers.delete(e.offer.toString('hex')); return reply;
  }
  private storedDevice(id: Buffer): Device {
    fixed(id, 16); const row = this.db.prepare('SELECT value FROM pairing_devices WHERE id = ?').get(id.toString('hex'));
    requirePairing(row && typeof row.value === 'string'); return deviceSchema.parse(JSON.parse(row.value));
  }
  private device(id: Buffer, offer?: Buffer): Device {
    const device = this.storedDevice(id);
    requirePairing(!device.revoked && this.now() < BigInt(device.expires) && (!offer || device.offer === offer.toString('hex'))); return device;
  }
  private reply(device: Device, credential: Buffer, nonce: Buffer): Buffer {
    const record = pairingRecord({ receiver: this.identity, origin: this.serviceOrigin, device: Buffer.from(device.device, 'hex'), spki: Buffer.from(device.spki, 'base64'), mask: device.mask, epoch: BigInt(device.epoch), expires: BigInt(device.expires), credentialHash: sha256(credential), nonce }, this.key);
    return Buffer.concat([Buffer.from('FTENRO01'), credential, lp32(record)]);
  }
  private rate(device: Device): void {
    const window = (this.now() / 60n).toString();
    this.db.prepare('INSERT INTO pairing_rate VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET count = CASE WHEN window = excluded.window THEN count + 1 ELSE 1 END, window = excluded.window').run(device.device, window);
    const row = this.db.prepare('SELECT count FROM pairing_rate WHERE id = ?').get(device.device); requirePairing(typeof row?.count === 'number' && row.count <= 10);
  }
  challenge(body: Uint8Array): Buffer {
    const r = new PairingReader(body, 'FTCHAL01'), offer = r.take(16), id = r.take(16), nonce = r.take(32); r.end();
    const device = this.device(id, offer); this.rate(device);
    const challenge = randomBytes(32), expires = this.now() + 60n;
    this.db.prepare('INSERT OR REPLACE INTO pairing_challenges VALUES (?, ?, ?, ?)').run(device.device, nonce, challenge, expires.toString());
    return Buffer.concat([Buffer.from('FTCHLO01'), nonce, challenge, u64(expires)]);
  }
  recover(body: Uint8Array): Buffer {
    const r = new PairingReader(body, 'FTRECV01'), offer = r.take(16), id = r.take(16), nonce = r.take(32), challenge = r.take(32), prefix = r.prefix(), signature = r.lp16(72); r.end();
    const device = this.device(id, offer); this.rate(device);
    verifySignature(p256(Buffer.from(device.spki, 'base64')), Buffer.concat([prefix, this.identity, lp16(this.serviceOrigin)]), signature);
    return this.transaction(() => {
      const saved = this.db.prepare('SELECT * FROM pairing_challenges WHERE id = ?').get(device.device);
      requirePairing(saved && saved.nonce instanceof Uint8Array && saved.challenge instanceof Uint8Array && typeof saved.expires === 'string' && BigInt(saved.expires) > this.now() && timingSafeEqual(Buffer.from(saved.nonce), nonce) && timingSafeEqual(Buffer.from(saved.challenge), challenge));
      this.db.prepare('DELETE FROM pairing_challenges WHERE id = ?').run(device.device);
      const credential = this.config.keyStore.unwrap(Buffer.from(device.wrapped, 'base64'), `pairing/device/${device.device}`);
      requirePairing(credential.length === 32 && sha256(credential).toString('hex') === device.credentialHash);
      return this.reply(device, credential, nonce);
    });
  }
  /** Receiver job-lock owner rechecks this immediately before uncommitted ingest.
   * This check alone does not cancel generations or replace the common Jobs lock. */
  assertActiveEpoch(device: Buffer, epoch: bigint): void {
    requirePairing(BigInt(this.device(device).epoch) === epoch);
  }
  authorize(input: { device: Buffer; credential: Buffer; epoch: bigint; permission: number; destination: PairingDestination; owner: Buffer }): PairingScopes {
    const device = this.device(input.device); permission(input.permission); requirePairing(input.permission > 0); fixed(input.credential, 32);
    requirePairing(input.owner.equals(input.device) && input.epoch === BigInt(device.epoch) && (input.permission & device.mask) === input.permission && timingSafeEqual(sha256(input.credential), Buffer.from(device.credentialHash, 'hex')));
    const dest = input.destination;
    requirePairing(dest.kind === 'intake' ? device.scopes.intakes.includes(dest.intake) : device.scopes.projects.some(p => p.environment === dest.environment && p.project === dest.project));
    return device.scopes;
  }
  private revoke(id: Buffer): { device: Buffer; epoch: bigint } {
    return this.transaction(() => {
      const device = this.storedDevice(id);
      if (device.revoked) return { device: Buffer.from(id), epoch: BigInt(device.epoch) };
      device.revoked = true; device.epoch = (BigInt(device.epoch) + 1n).toString();
      this.db.prepare('UPDATE pairing_devices SET value = ? WHERE id = ?').run(JSON.stringify(device), device.device);
      this.db.prepare('DELETE FROM pairing_challenges WHERE id = ?').run(device.device);
      return { device: Buffer.from(id), epoch: BigInt(device.epoch) };
    });
  }
  private rotation(input: Omit<Parameters<typeof rotationRecord>[0], 'receiver'>): Buffer {
    requirePairing(input.expires > this.now() && input.expires <= this.now() + 120n);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT value FROM pairing_meta WHERE id = ?').get('rotationEpoch');
      requirePairing(row?.value instanceof Uint8Array && input.epoch > BigInt(Buffer.from(row.value).toString()));
      const bytes = rotationRecord({ ...input, receiver: this.identity }, this.key);
      this.db.prepare('UPDATE pairing_meta SET value = ? WHERE id = ?').run(Buffer.from(input.epoch.toString()), 'rotationEpoch'); return bytes;
    });
  }
  close(): void { this.db.close(); this.offers.clear(); }
}

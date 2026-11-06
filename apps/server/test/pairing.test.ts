import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { PairingAuthority, type PairingKeyStore } from '../src/pairing.js';
import { lp16, origin, PairingReader, p256, permission, qr, sha256, u32, verifySignature } from '../src/pairing-wire.js';

// Test-only memory backend. Deliberately NOT a production OS wrapping implementation.
function backend(key = randomBytes(32)): PairingKeyStore {
  return {
    wrap(plain, context) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(context)); return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]); },
    unwrap(bytes, context) { const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]); },
  };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pairing-test-')); let now = 2000000000n;
  const keyStore = backend(), config = { path: join(dir, 'pair.db'), keyStore, origin: 'https://localhost:443', ca: randomBytes(300), pin: randomBytes(32), now: () => now };
  let opened = PairingAuthority.open(config);
  const scopes = { intakes: ['6b7e0334-148d-496c-8724-e8f01f03a9c1'], projects: [{ environment: 'env', project: 'project' }] };
  const offer = (mask = 31) => { const bytes = opened.local.createOffer({ mask, scopes }); const r = new PairingReader(bytes, 'FTQR0001', 2048); r.lp16(128); r.lp16(1024); r.take(32); r.lp16(512); return { bytes, id: r.take(16), secret: r.take(32) }; };
  const device = () => ({ id: randomBytes(16), key: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
  function enroll(o = offer(), d = device(), mask = 3) {
    const nonce = randomBytes(32), spki = createPublicKey(d.key).export({ format: 'der', type: 'spki' });
    const prefix = Buffer.concat([Buffer.from('FTENRL01'), o.id, o.secret, d.id, lp16(spki), nonce, u32(mask)]);
    const body = Buffer.concat([prefix, lp16(sign('sha256', Buffer.concat([prefix, opened.authority.identity, lp16(config.origin)]), d.key))]);
    return { body, d, o, nonce, spki };
  }
  return {
    get a() { return opened.authority; }, get local() { return opened.local; }, config, dir, scopes, offer, device, enroll,
    advance: (n: bigint) => { now += n; },
    restart: () => { opened.authority.close(); opened = PairingAuthority.open(config); },
    close: () => { opened.authority.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
function record(reply: Buffer, f: ReturnType<typeof fixture>, e: ReturnType<ReturnType<typeof fixture>['enroll']>, nonce = e.nonce) {
  const r = new PairingReader(reply, 'FTENRO01'), credential = r.take(32), bytes = r.lp32(16384); r.end();
  const p = new PairingReader(bytes, 'FTPAIR01'); assert.deepEqual(p.take(32), f.a.identity); assert.equal(p.lp16(512).toString(), f.config.origin);
  assert.deepEqual(p.take(16), e.d.id); assert.deepEqual(p.lp16(128), e.spki); const mask = p.u32(), epoch = p.u64(), expires = p.u64();
  assert.deepEqual(p.take(32), sha256(credential)); assert.deepEqual(p.take(32), nonce);
  const prefix = p.prefix(), sig = p.lp16(72); p.end(); verifySignature(p256(f.a.identitySPKI), prefix, sig);
  return { credential, mask, epoch, expires };
}
function recovery(f: ReturnType<typeof fixture>, e: ReturnType<ReturnType<typeof fixture>['enroll']>) {
  const nonce = randomBytes(32), bytes = f.a.challenge(Buffer.concat([Buffer.from('FTCHAL01'), e.o.id, e.d.id, nonce]));
  const r = new PairingReader(bytes, 'FTCHLO01'); assert.deepEqual(r.take(32), nonce); const challenge = r.take(32); r.u64(); r.end();
  const prefix = Buffer.concat([Buffer.from('FTRECV01'), e.o.id, e.d.id, nonce, challenge]);
  return { nonce, body: Buffer.concat([prefix, lp16(sign('sha256', Buffer.concat([prefix, f.a.identity, lp16(f.config.origin)]), e.d.key))]) };
}

test('canonical QR and proof: bounds, origin, reserved permissions, trailing/truncated bodies', () => {
  const f = fixture(); try {
    const e = f.enroll(); assert.ok(e.o.bytes.length <= 2048); f.a.inspectEnrollment(e.body);
    for (let i = 0; i < e.body.length; i++) assert.throws(() => f.a.enroll(e.body.subarray(0, i)));
    assert.throws(() => f.a.inspectEnrollment(Buffer.concat([e.body, Buffer.from([0])])));
    for (const text of ['http://localhost:443', 'https://LOCALHOST:443', 'https://localhost', 'https://localhost:0443', 'https://localhost.:443', 'https://localhost:443/', 'https://127.01.0.1:443', 'https://[0:0:0:0:0:0:0:1]:443']) assert.throws(() => origin(text));
    for (const text of ['https://localhost:443', 'https://127.0.0.1:443', 'https://[::]:443', 'https://[2001:db8::1]:443', 'https://[::ffff:c000:201]:443']) assert.equal(origin(text), text);
    for (const mask of [0, 32, -1, 1.5, 4294967297]) assert.throws(() => permission(mask));
    assert.throws(() => qr({ spki: f.a.identitySPKI, ca: randomBytes(1025), pin: randomBytes(32), origin: f.config.origin, offer: randomBytes(16), secret: randomBytes(32), expires: 3n, mask: 1 }));
    assert.throws(() => f.a.enroll(e.body)); // no trusted local approval
    const tampered = Buffer.from(e.body); tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    assert.throws(() => f.local.approve(tampered, f.scopes));
    f.local.approve(e.body, f.scopes); record(f.a.enroll(e.body), f, e); // invalid PoP did not consume
  } finally { f.close(); }
});

test('concurrent consumption: exactly one enrolled device, no response replay/replacement', async () => {
  const f = fixture(); try {
    const e = f.enroll(), other = f.enroll(e.o); f.local.approve(e.body, f.scopes);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => Promise.resolve().then(() => f.a.enroll(i === 1 ? other.body : e.body))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.throws(() => f.a.enroll(e.body)); assert.throws(() => f.a.enroll(other.body));
  } finally { f.close(); }
});

test('two-minute expiry, exact trusted approval, scope/permission subset and own-device authority', () => {
  const f = fixture(); try {
    const restricted = f.offer(3); assert.throws(() => f.a.inspectEnrollment(f.enroll(restricted, f.device(), 4).body));
    const e = f.enroll(); assert.throws(() => f.local.approve(e.body, { intakes: [], projects: [{ environment: 'env', project: 'other' }] }));
    f.local.approve(e.body, f.scopes); const changed = f.enroll(e.o, e.d, 1); assert.throws(() => f.a.enroll(changed.body));
    const r = record(f.a.enroll(e.body), f, e);
    const args = { device: e.d.id, owner: e.d.id, epoch: 1n, credential: r.credential, permission: 1, destination: { kind: 'intake', intake: f.scopes.intakes[0] ?? '' } } satisfies Parameters<typeof f.a.authorize>[0];
    f.a.authorize(args); f.a.assertActiveEpoch(e.d.id, 1n); assert.throws(() => f.a.assertActiveEpoch(e.d.id, 2n));
    for (const overrides of [{ permission: 4 }, { epoch: 2n }, { owner: randomBytes(16) }, { credential: randomBytes(32) }, { destination: { kind: 'intake', intake: 'other' } satisfies typeof args.destination }]) assert.throws(() => f.a.authorize({ ...args, ...overrides }));
    f.a.authorize({ ...args, destination: { kind: 't3', environment: 'env', project: 'project' } });
    assert.throws(() => f.a.authorize({ ...args, destination: { kind: 't3', environment: 'env', project: 'other' } }));
    const expiring = f.enroll(); f.local.approve(expiring.body, f.scopes); f.advance(120n); assert.throws(() => f.a.enroll(expiring.body));
  } finally { f.close(); }
});

test('lost reply recovery survives restart, same device proof, challenge replay/expiry, no replaced key', () => {
  const f = fixture(); try {
    const e = f.enroll(); f.local.approve(e.body, f.scopes); const first = record(f.a.enroll(e.body), f, e);
    f.restart(); const recovery1 = recovery(f, e); f.restart();
    const second = record(f.a.recover(recovery1.body), f, e, recovery1.nonce); assert.deepEqual(second.credential, first.credential);
    assert.throws(() => f.a.recover(recovery1.body));
    const bad = recovery(f, e); const otherKey = f.device().key;
    const r = new PairingReader(bad.body, 'FTRECV01'); r.take(96); const prefix = r.prefix();
    const replaced = Buffer.concat([prefix, lp16(sign('sha256', Buffer.concat([prefix, f.a.identity, lp16(f.config.origin)]), otherKey))]);
    assert.throws(() => f.a.recover(replaced)); record(f.a.recover(bad.body), f, e, bad.nonce);
    const expired = recovery(f, e); f.advance(60n); assert.throws(() => f.a.recover(expired.body));
    const pending = f.enroll(); f.local.approve(pending.body, f.scopes); f.restart(); assert.throws(() => f.a.enroll(pending.body));
  } finally { f.close(); }
});

test('durable revocation/epoch, rate limit, old-key signed strictly increasing rotation', () => {
  const f = fixture(); try {
    const e = f.enroll(); f.local.approve(e.body, f.scopes); const r = record(f.a.enroll(e.body), f, e);
    for (let n = 0; n < 10; n++) recovery(f, e); assert.throws(() => recovery(f, e)); f.advance(60n); const pending = recovery(f, e);
    assert.equal(f.local.revoke(e.d.id).epoch, 2n); f.restart(); assert.equal(f.local.revoke(e.d.id).epoch, 2n); assert.throws(() => f.a.recover(pending.body)); assert.throws(() => f.a.assertActiveEpoch(e.d.id, 1n));
    assert.throws(() => f.a.authorize({ device: e.d.id, owner: e.d.id, credential: r.credential, epoch: 1n, permission: 1, destination: { kind: 't3', environment: 'env', project: 'project' } }));
    const next = { spki: createPublicKey(f.device().key).export({ format: 'der', type: 'spki' }), ca: randomBytes(300), pin: randomBytes(32), origin: 'https://new.localhost:444', epoch: 2n, expires: f.config.now() + 120n, nonce: randomBytes(32) };
    const bytes = f.local.rotation(next), p = new PairingReader(bytes, 'FTROT001'); assert.deepEqual(p.take(32), f.a.identity); assert.deepEqual(p.lp16(128), next.spki); p.take(32); p.lp16(1024); p.lp16(512); assert.equal(p.u64(), 2n); p.u64(); p.take(32); const prefix = p.prefix(), sig = p.lp16(72); p.end(); verifySignature(p256(f.a.identitySPKI), prefix, sig);
    f.restart(); assert.throws(() => f.local.rotation(next)); f.local.rotation({ ...next, epoch: 3n });
  } finally { f.close(); }
});

test('missing/replaced wrapping key blocks startup; durable DB never stores clear credential/private key', () => {
  const f = fixture(); try {
    const e = f.enroll(); f.local.approve(e.body, f.scopes); const result = record(f.a.enroll(e.body), f, e); f.restart();
    assert.throws(() => PairingAuthority.open({ ...f.config, keyStore: backend() }));
    assert.throws(() => PairingAuthority.open({ ...f.config, keyStore: { wrap() { throw Error('locked'); }, unwrap() { throw Error('locked'); } } }));
    assert.equal(readFileSync(f.config.path).includes(result.credential), false);
    chmodSync(f.dir, 0o755); assert.throws(() => PairingAuthority.open(f.config)); chmodSync(f.dir, 0o700);
    chmodSync(f.config.path, 0o644); assert.throws(() => PairingAuthority.open(f.config)); chmodSync(f.config.path, 0o600);
    const same = recovery(f, e); assert.deepEqual(record(f.a.recover(same.body), f, e, same.nonce).credential, result.credential);
  } finally { f.close(); }
});

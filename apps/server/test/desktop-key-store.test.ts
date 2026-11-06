import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DesktopKeyStore } from '../src/desktop-key-store.js';
import { PairingAuthority } from '../src/pairing.js';
import { PairingReader, lp16, u32 } from '../src/pairing-wire.js';
import { Jobs } from '../src/jobs.js';
import { SealedIngest } from '../src/sealed-ingest.js';
import { Manifest, sha256 } from '../src/sealed-protocol.js';

// Explicit opt-in. Only this run's NEW UUID account is touched; never existing keys.
test('macOS Keychain wraps actual PairingAuthority and G3 across restart, fails closed on replacement/loss', { skip: process.env.FOOTAGE_TEST_KEYCHAIN !== '1' }, async () => {
  const helper = resolve('src/../../../artifacts/desktop-key-store/helper');
  const config = { helper, namespace: `test.${randomUUID()}`, allowTestKeychain: true } satisfies Parameters<typeof DesktopKeyStore.initialize>[0];
  const directory = mkdtempSync(join(tmpdir(), 'footage-os-wrap-')); chmodSync(directory, 0o700);
  let store: DesktopKeyStore | undefined;
  let ownsItem = false;
  const origin = 'https://localhost:443', now = () => 2_000_000_000n;
  const authorityConfig = { path: join(directory, 'pair.sqlite'), origin, ca: randomBytes(64), pin: randomBytes(32), now };
  try {
    assert.throws(() => DesktopKeyStore.load(config));
    store = DesktopKeyStore.initialize(config); ownsItem = true;
    assert.throws(() => DesktopKeyStore.initialize(config));
    const plain = randomBytes(32), wrapped = store.wrap(plain, 'own/context');
    assert.deepEqual(store.unwrap(wrapped, 'own/context'), plain);
    assert.throws(() => store?.unwrap(wrapped, 'other/context'));
    const corrupt = Buffer.from(wrapped); corrupt[0] = (corrupt[0] ?? 0) ^ 1;
    assert.throws(() => store?.unwrap(corrupt, 'own/context'));
    assert.throws(() => store?.wrap(Buffer.alloc(65537), 'own/context'));
    assert.throws(() => store?.wrap(plain, 'x'.repeat(1025)));
    for (const input of [Buffer.alloc(131073), Buffer.from('bad')]) {
      const result = spawnSync(helper, [], { input, timeout: 5000, maxBuffer: 1024, env: {} });
      assert.equal(result.status, 1); assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0);
    }
    const link = join(directory, 'helper-link'); symlinkSync(helper, link);
    assert.throws(() => DesktopKeyStore.load({ ...config, helper: link }));
    const privateCopy = join(directory, 'unsafe-helper');
    copyFileSync(helper, privateCopy); chmodSync(privateCopy, 0o777); assert.throws(() => DesktopKeyStore.load({ ...config, helper: privateCopy }));
    let pairing = PairingAuthority.open({ ...authorityConfig, keyStore: store });
    const identity = pairing.authority.identity;
    const pairDatabase = new DatabaseSync(authorityConfig.path);
    let identityPrivate: Buffer;
    try {
      const row = pairDatabase.prepare('SELECT value FROM pairing_meta WHERE id = ?').get('identity');
      assert.ok(row?.value instanceof Uint8Array);
      identityPrivate = store.unwrap(Buffer.from(row.value), 'pairing/identity/v1');
    } finally { pairDatabase.close(); }
    const intake = randomUUID(), device = randomBytes(16), key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const qr = new PairingReader(pairing.local.createOffer({ mask: 31, scopes: { intakes: [intake], projects: [] } }), 'FTQR0001');
    qr.lp16(128); qr.lp16(1024); qr.take(32); qr.lp16(512);
    const prefix = Buffer.concat([Buffer.from('FTENRL01'), qr.take(16), qr.take(32), device, lp16(createPublicKey(key).export({ type: 'spki', format: 'der' })), randomBytes(32), u32(31)]);
    const enrollment = Buffer.concat([prefix, lp16(sign('sha256', Buffer.concat([prefix, identity, lp16(origin)]), key))]);
    pairing.local.approve(enrollment, { intakes: [intake], projects: [] });
    const reply = new PairingReader(pairing.authority.enroll(enrollment), 'FTENRO01'), credential = reply.take(32);
    const manifest = Manifest.create({ receiver: identity.toString('hex'), origin, job: randomUUID().replaceAll('-', ''), generation: randomBytes(16).toString('hex'), device: device.toString('hex'), enrollmentEpoch: 1n, destination: { kind: 'standalone', intake: intake.replaceAll('-', '') }, originalBytes: 1n, originalSHA256: sha256(Buffer.from([17])), safeName: 'synthetic.bin', expiresAt: now() + 3600n, frameBytes: 8388608, framesPerGroup: 8, frameHashes: [sha256(Buffer.from([17]))] });
    let jobs = new Jobs(join(directory, 'jobs.sqlite'));
    let ingest = await SealedIngest.open({ directory, jobs, authority: pairing.authority, wrappingStore: store, assertDestinationAccess() {}, now });
    const setup = await ingest.setup(manifest.bytes, credential), master = setup.subarray(40, 72);
    jobs.close(); pairing.authority.close();
    store = DesktopKeyStore.load(config);
    pairing = PairingAuthority.open({ ...authorityConfig, keyStore: store }); assert.deepEqual(pairing.authority.identity, identity);
    jobs = new Jobs(join(directory, 'jobs.sqlite'));
    ingest = await SealedIngest.open({ directory, jobs, authority: pairing.authority, wrappingStore: store, assertDestinationAccess() {}, now });
    assert.deepEqual(await ingest.setup(manifest.bytes, credential), setup);
    jobs.close();
    for (const name of ['pair.sqlite', 'jobs.sqlite']) {
      const database = readFileSync(join(directory, name));
      assert.equal(database.includes(credential), false); assert.equal(database.includes(master), false);
      assert.equal(database.includes(identityPrivate), false);
      assert.equal(database.includes(key.export({ type: 'pkcs8', format: 'der' })), false);
    }
    // Unsafe exact-item replacement is explicit in this test ONLY. Existing DB is
    // never reset or rebound; both owners reject a wrong OS wrapping key.
    const originalStore = store;
    store.deleteTestItem(); ownsItem = false;
    assert.throws(() => DesktopKeyStore.load(config));
    assert.throws(() => PairingAuthority.open({ ...authorityConfig, keyStore: originalStore }));
    jobs = new Jobs(join(directory, 'jobs.sqlite'));
    try {
      await assert.rejects(SealedIngest.open({ directory, jobs, authority: pairing.authority, wrappingStore: store, assertDestinationAccess() {}, now }));
    } finally { jobs.close(); }
    store = DesktopKeyStore.initialize(config); ownsItem = true;
    assert.throws(() => PairingAuthority.open({ ...authorityConfig, keyStore: DesktopKeyStore.load(config) }));
    assert.throws(() => store?.unwrap(wrapped, 'own/context'));
    // G3 replacement check independently, using the original verified authority.
    jobs = new Jobs(join(directory, 'jobs.sqlite'));
    try {
      await assert.rejects(SealedIngest.open({ directory, jobs, authority: pairing.authority, wrappingStore: store, assertDestinationAccess() {}, now }));
    } finally { jobs.close(); pairing.authority.close(); }
    assert.equal(readFileSync(join(directory, 'jobs.sqlite')).includes(master), false);
  } finally {
    if (ownsItem) store?.deleteTestItem();
    rmSync(directory, { recursive: true, force: true });
  }
});

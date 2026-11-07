import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, createHmac, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as reservePort } from 'node:net';
import { request } from 'node:https';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopKeyStore } from '../../apps/server/src/desktop-key-store.js';
import { PairingAuthority } from '../../apps/server/src/pairing.js';
import { lp16, PairingReader, sha256, u32, u64 } from '../../apps/server/src/pairing-wire.js';
import { Jobs } from '../../apps/server/src/jobs.js';
import { PairedService } from '../../apps/server/src/paired-service.js';
import { Manifest, SealSession, decodeSetup, encodeQuery, freshQuery, groupHeader, limits, VerifiedStatus } from '../../apps/server/src/sealed-protocol.js';
import { jobIdSchema } from '../../apps/server/src/contracts.js';
import { schemaUuid, type IngestBoundary } from '../../apps/server/src/sealed-ingest.js';

async function until<T>(f: () => T | undefined): Promise<T> {
  for (let i = 0; i < 400; i++) { const v = f(); if (v !== undefined) return v; await delay(25); }
  throw new Error('Test deadline');
}
const optedIn = process.env.FOOTAGE_TEST_KEYCHAIN === '1' && process.platform === 'darwin';

test('explicit OS-backed paired HTTPS service lifecycle and authority', { skip: !optedIn }, async t => {
  const base = resolve('artifacts/paired-background-service-tests'); await mkdir(base, { recursive: true, mode: 0o700 });
  const out = await mkdtemp(join(base, 'run-'));
  const run = (program: string, ...args: string[]) => execFileSync(program, args, { cwd: out, stdio: 'pipe' });
  run('xcrun', 'swiftc', '-swift-version', '6', '-warnings-as-errors', resolve('apps/server/src/desktop-key-store-helper.swift'), '-o', join(out, 'helper'));
  run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Owned Service Test CA', '-keyout', 'root.key', '-out', 'root.pem', '-days', '1');
  run('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'leaf.key', '-out', 'leaf.csr');
  await writeFile(join(out, 'leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
  run('openssl', 'x509', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '1', '-extfile', 'leaf.ext');
  run('openssl', 'x509', '-in', 'root.pem', '-outform', 'DER', '-out', 'root.der');
  const tls = { key: await readFile(join(out, 'leaf.key')), cert: await readFile(join(out, 'leaf.pem')), ca: await readFile(join(out, 'root.der')) };
  const ca = await readFile(join(out, 'root.pem'));
  // Retain only cleanup-account metadata if a fixture fails before initialization.
  t.after(() => rm(out, { recursive: true, force: true }));

  async function fixture(t: TestContext, boundary?: (point: IngestBoundary) => void, permissions = 7, phone = false) {
    const directory = await mkdtemp(join(out, 'storage-'));
    const namespace = `test.${randomUUID()}`;
    await writeFile(join(base, namespace + '.cleanup.json'), JSON.stringify({ namespace, helper: join(out, 'helper') }), { mode: 0o600 });
    const keyStore = DesktopKeyStore.initialize({ helper: join(out, 'helper'), namespace, allowTestKeychain: true });
    // Register exact-item cleanup BEFORE any later constructor can fail.
    let closeService = async () => {};
    t.after(async () => {
      try { await closeService(); }
      finally {
        keyStore.deleteTestItem();
        await rm(join(base, namespace + '.cleanup.json'));
      }
    });
    const reserve = reservePort(); await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
    const address = reserve.address(); assert(address && typeof address !== 'string');
    await new Promise<void>(r => reserve.close(() => r()));
    const origin = `https://localhost:${address.port}`, intake = randomUUID(), scopes = { intakes: [intake], projects: [] };
    let clock = BigInt(Math.floor(Date.now() / 1000));
    const authority = PairingAuthority.open({ path: join(directory, 'pairing.sqlite'), keyStore, origin, ca: tls.ca,
      pin: sha256(new X509Certificate(tls.cert).publicKey.export({ format: 'der', type: 'spki' })), now: () => clock });
    const jobs = new Jobs(join(directory, 'jobs.sqlite'));
    const allowed = new Set([intake]);
    const effects: string[] = [];
    const phoneConfig: NonNullable<Parameters<typeof PairedService.open>[0]['phone']> = {
      destinations: () => [{ id: intake, title: 'Owned thread', kind: 'thread' }, { id: randomUUID(), title: 'Not granted', kind: 'thread' }],
      handoff: async (_job, operation) => { effects.push(operation); return { kind: 'ready', title: 'Owned thread' }; },
    };
    const opened = await PairedService.open({ ...authority, jobs, keyStore, directory, origin, listenHost: '127.0.0.1', tls,
      ...(phone ? { phone: phoneConfig } : {}),
      allowedIntakes: allowed, bodyTimeoutMs: 500, supervisionMs: 100, ...(boundary ? { boundary } : {}) });
    let closed = false;
    const close = async () => { await opened.service.close(); closed = true; };
    closeService = async () => { if (!closed) await close(); };
    await opened.service.listen();
    function send(path: string, bytes: Buffer, auth?: Buffer, extra: Record<string, string> = {}) {
      const client = request(origin + path, { method: 'POST', ca, servername: 'localhost', agent: false, headers: { 'Content-Type': 'application/octet-stream', ...(auth ? { Authorization: 'Bearer ' + auth.toString('hex') } : {}), ...extra } });
      const reply = new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
        client.on('error', reject);
        client.on('response', res => { const chunks: Buffer[] = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) })); res.on('error', reject); });
      });
      void reply.catch(() => {});
      client.end(bytes); return reply;
    }
    // Authentic synthetic device PoP. Approval is local and cannot be triggered by HTTP.
    const qr = new PairingReader(opened.local.createOffer({ mask: permissions, scopes }), 'FTQR0001');
    qr.lp16(128); qr.lp16(1024); qr.take(32); qr.lp16(512);
    const offer = qr.take(16), secret = qr.take(32), device = randomBytes(16);
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const prefix = Buffer.concat([Buffer.from('FTENRL01'), offer, secret, device, lp16(createPublicKey(key).export({ format: 'der', type: 'spki' })), randomBytes(32), u32(permissions)]);
    const enrollment = Buffer.concat([prefix, lp16(sign('sha256', Buffer.concat([prefix, authority.authority.identity, lp16(origin)]), key))]);
    const enrolling = send('/pair/v1/enroll', enrollment);
    const pending = await until(() => opened.local.pendingEnrollments()[0]);
    assert.equal(jobs.all().length, 0);
    assert.equal((await send('/pair/v1/approve', Buffer.alloc(0))).status, 404);
    opened.local.approveEnrollment(pending.id, scopes);
    const enrolled = await enrolling; assert.equal(enrolled.status, 200);
    const credential = new PairingReader(enrolled.bytes, 'FTENRO01').take(32);
    const plain = Buffer.alloc(173, 17);
    function manifest(changes: Partial<Parameters<typeof Manifest.create>[0]> = {}) {
      return Manifest.create({ receiver: authority.authority.identity.toString('hex'), origin, job: randomUUID().replaceAll('-', ''),
        generation: randomBytes(16).toString('hex'), device: device.toString('hex'), enrollmentEpoch: 1n,
        destination: { kind: 'standalone', intake: intake.replaceAll('-', '') }, originalBytes: BigInt(plain.length), originalSHA256: sha256(plain).toString('hex'),
        safeName: 'generated.bin', expiresAt: BigInt(Math.floor(Date.now() / 1000)) + 3600n, frameBytes: limits.frame, framesPerGroup: 8, frameHashes: [sha256(plain).toString('hex')], ...changes });
    }
    async function prepared(m = manifest()) {
      const reply = await send('/sealed/v1/setup', m.bytes, credential); assert.equal(reply.status, 200);
      const keys = decodeSetup(reply.bytes, m), session = new SealSession(keys);
      const intent = await session.consume(0, async () => {});
      return { m, keys, packet: Buffer.concat([groupHeader(m, 0), intent.seal(plain)]), id: jobIdSchema.parse(schemaUuid(m.fields.job)) };
    }
    async function status(p: Awaited<ReturnType<typeof prepared>>, revoke = false) {
      const q = freshQuery(randomBytes(16).toString('hex'));
      const reply = await send(revoke ? '/sealed/v1/revoke' : '/sealed/v1/status', encodeQuery(p.m, q), credential);
      assert.equal(reply.status, 200); return VerifiedStatus.verify(reply.bytes, p.keys, q, 0n);
    }
    return { ...opened, origin, directory, jobs, allowed, effects, intake, send, credential, device, manifest, prepared, status, close,
      expire: () => { clock += 8n * 86400n; } };
  }

  await t.test('fixed routes, no remote approval/list, binding and streaming caps', async t => {
    const f = await fixture(t);
    for (const path of ['/unknown', '/sealed/v1/status?x=1', '/pair/v1/offer', '/sealed/v1/complete']) assert.equal((await f.send(path, Buffer.alloc(0))).status, 404);
    assert.equal((await f.send('/pair/v1/destinations', Buffer.alloc(0))).status, 503);
    assert.equal((await f.send('/sealed/v1/view', Buffer.alloc(0))).status, 403);
    assert.equal((await f.send('/sealed/v1/setup', Buffer.alloc(0), f.credential, { Host: 'forged.invalid:443' })).status, 400);
    assert.equal((await f.send('/sealed/v1/setup', Buffer.alloc(0), f.credential, { 'X-Forwarded-Host': 'forged.invalid' })).status, 400);
    for (const [path, cap] of [['/pair/v1/enroll', 16384], ['/sealed/v1/setup', 65536], ['/sealed/v1/status', 4096]] satisfies [string, number][]) {
      // No Content-Length: enforce the streaming limit, not just header admission.
      const client = request(f.origin + path, { method: 'POST', ca, agent: false, headers: { 'Content-Type': 'application/octet-stream', ...(path.startsWith('/sealed/') ? { Authorization: 'Bearer ' + f.credential.toString('hex') } : {}), 'Transfer-Encoding': 'chunked' } });
      const outcome = new Promise<number>(resolve => { client.on('error', () => resolve(0)); client.on('response', r => { r.resume(); r.on('end', () => resolve(r.statusCode ?? 0)); }); });
      client.write(Buffer.alloc(cap)); client.end(Buffer.alloc(1)); assert.notEqual(await outcome, 200);
    }
    assert.equal(f.jobs.all().length, 0);
    assert.equal(PairedService.advertisedMaxOriginalBytes, 1024 ** 3);
  });
  await t.test('wrong device/credential/scope, expired and revoked enrollments cannot control', async t => {
    const f = await fixture(t), p = await f.prepared();
    for (const m of [f.manifest({ device: randomBytes(16).toString('hex') }), f.manifest({ destination: { kind: 'standalone', intake: randomUUID().replaceAll('-', '') } })]) assert.notEqual((await f.send('/sealed/v1/setup', m.bytes, f.credential)).status, 200);
    assert.notEqual((await f.send('/sealed/v1/setup', f.manifest().bytes, randomBytes(32))).status, 200);
    f.expire();
    assert.notEqual((await f.send('/sealed/v1/status', encodeQuery(p.m, freshQuery(randomBytes(16).toString('hex'))), f.credential)).status, 200);
    await until(() => f.jobs.get(p.id).sealed?.state === 'cancelled' ? true : undefined);
    assert.notEqual((await f.send('/sealed/v1/ingest', p.packet)).status, 200);
  });
  await t.test('receiver supervision retries transient finalization WITHOUT phone retry/restart', async t => {
    let failures = 0;
    const f = await fixture(t, point => { if (point === 'original-sync' && failures++ === 0) throw new Error('Test transient failure'); });
    const p = await f.prepared();
    assert.notEqual((await f.send('/sealed/v1/ingest', p.packet)).status, 200);
    const receipt = await until(() => f.jobs.get(p.id).receipt ?? undefined);
    assert.equal((await f.status(p)).receipt?.toOriginalReceipt().id, receipt.id);
    assert.equal((await f.status(p, true)).receipt?.toOriginalReceipt().id, receipt.id);
  });
  await t.test('revocation/access sweep tombstones and cleanup; late packets never resurrect', async t => {
    const f = await fixture(t), p = await f.prepared();
    f.local.revoke(f.device);
    await until(() => f.jobs.get(p.id).sealed?.cleanup === 2 ? true : undefined);
    assert.equal(f.jobs.get(p.id).sealed?.state, 'cancelled');
    assert.notEqual((await f.send('/sealed/v1/ingest', p.packet)).status, 200);
    assert.notEqual((await f.send('/sealed/v1/setup', p.m.bytes, f.credential)).status, 200);
    assert.equal(f.jobs.get(p.id).receipt, null);
    const g = await fixture(t), q = await g.prepared(); g.allowed.clear();
    await until(() => g.jobs.get(q.id).sealed?.cleanup === 2 ? true : undefined);
    assert.equal(g.jobs.get(q.id).sealed?.state, 'cancelled');
  });
  await t.test('phone destination scopes and purpose-bound handoff require a matching received original', async t => {
    const f = await fixture(t, undefined, 31, true), p = await f.prepared();
    const list = Buffer.concat([Buffer.from('FTLIST01'), f.device, u64(1n), randomBytes(32)]);
    const response = await f.send('/pair/v1/destinations', list, f.credential); assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.bytes.toString()).destinations.map((d: { id: string }) => d.id), [f.intake]);
    assert.notEqual((await f.send('/pair/v1/destinations', list, randomBytes(32))).status, 200);
    const handoff = (purpose: number) => {
      const prefix = Buffer.concat([Buffer.from('FTHAND01'), Buffer.from([purpose]), Buffer.from(p.m.fields.job, 'hex'), Buffer.from(p.m.fields.generation, 'hex'), Buffer.from(p.m.digest, 'hex'), randomBytes(16)]);
      return Buffer.concat([prefix, createHmac('sha256', p.keys.derive('status')).update('footage/handoff-request/v1').update(prefix).digest()]);
    };
    assert.notEqual((await f.send('/sealed/v1/handoff/send', handoff(2), f.credential)).status, 200);
    assert.equal(f.effects.length, 0);
    assert.equal((await f.send('/sealed/v1/ingest', p.packet)).status, 200);
    assert.notEqual((await f.send('/sealed/v1/handoff/send', handoff(0), f.credential)).status, 200);
    assert.notEqual((await f.send('/sealed/v1/handoff/send', encodeQuery(p.m, freshQuery(randomBytes(16).toString('hex'))), f.credential)).status, 200);
    const forged = handoff(2); forged[90] = (forged[90] ?? 0) ^ 1;
    assert.notEqual((await f.send('/sealed/v1/handoff/send', forged, f.credential)).status, 200);
    assert.equal(f.effects.length, 0);
    assert.equal((await f.send('/sealed/v1/handoff/status', handoff(0), f.credential)).status, 200);
    assert.deepEqual(f.effects, ['status']);
    assert.equal((await f.send('/sealed/v1/handoff/send', handoff(2), f.credential)).status, 200);
    assert.deepEqual(f.effects, ['status', 'send']);
    f.local.revoke(f.device);
    assert.notEqual((await f.send('/sealed/v1/handoff/send', handoff(2), f.credential)).status, 200);
    assert.notEqual((await f.send('/pair/v1/destinations', list, f.credential)).status, 200);
    assert.deepEqual(f.effects, ['status', 'send']);
  });
  await t.test('paired view grants are receipt-gated, one-use, secure-cookie and read-only', async t => {
    const f = await fixture(t, undefined, 15), p = await f.prepared();
    const query = () => encodeQuery(p.m, freshQuery(randomBytes(16).toString('hex')));
    assert.notEqual((await f.send('/sealed/v1/view', query(), f.credential)).status, 200);
    assert.equal((await f.send('/sealed/v1/ingest', p.packet)).status, 200);
    const grant = await f.send('/sealed/v1/view', query(), f.credential); assert.equal(grant.status, 200);
    const path = z.object({ path: z.string().regex(/^\/receive#[a-f0-9]{64}$/) }).parse(JSON.parse(grant.bytes.toString())).path;
    async function browser(path: string, method = 'GET', data?: Buffer, cookie?: string) {
      const client = request(f.origin + path, { method, ca, agent: false, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: f.origin } : {}), ...(cookie ? { Cookie: cookie } : {}) } });
      const result = new Promise<{ status: number; bytes: Buffer; cookie: string[] }>((resolve, reject) => {
        client.on('error', reject); client.on('response', response => { const chunks: Buffer[] = []; response.on('data', b => chunks.push(b)); response.on('error', reject); response.on('end', () => resolve({ status: response.statusCode ?? 0, bytes: Buffer.concat(chunks), cookie: response.headers['set-cookie'] ?? [] })); });
      }); client.end(data); return result;
    }
    assert.equal((await browser('/viewer/content')).status, 401);
    const exchange = await browser('/viewer/session', 'POST', Buffer.from(JSON.stringify({ code: path.split('#')[1] })));
    assert.equal(exchange.status, 204); assert(exchange.cookie[0]?.includes('HttpOnly')); assert(exchange.cookie[0]?.includes('Secure'));
    assert.equal((await browser('/viewer/session', 'POST', Buffer.from(JSON.stringify({ code: path.split('#')[1] })))).status, 401);
    const cookie = exchange.cookie[0]?.split(';')[0]; assert(cookie);
    const content = await browser('/viewer/content', 'GET', undefined, cookie); assert.equal(content.status, 200);
    assert.equal(content.bytes.length, 173); assert(content.bytes.every(byte => byte === 17));
    assert.equal((await browser('/viewer/content', 'DELETE', undefined, cookie)).status, 405);
    assert.equal(f.jobs.get(p.id).status, 'received');
  });
  await t.test('shutdown during finalization drains storage BEFORE Jobs.close', async t => {
    let closing: Promise<void> | undefined, f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture(t, point => { if (point === 'original-sync') closing ??= f.close(); });
    const p = await f.prepared(); await f.send('/sealed/v1/ingest', p.packet);
    assert.ok(closing); await closing;
    const reopened = new Jobs(join(f.directory, 'jobs.sqlite'));
    try { assert.ok(reopened.get(p.id).receipt); } finally { reopened.close(); }
  });
  await t.test('shutdown while a body is active bounds socket wait and drains quarantine', async t => {
    const f = await fixture(t), p = await f.prepared();
    const client = request(f.origin + '/sealed/v1/ingest', { method: 'POST', ca, agent: false, headers: { 'Content-Type': 'application/octet-stream' } });
    client.on('error', () => {}); client.write(p.packet.subarray(0, 130));
    await delay(100); await f.close(); client.destroy();
    const reopened = new Jobs(join(f.directory, 'jobs.sqlite'));
    try { assert.equal(reopened.get(p.id).receipt, null); assert.equal(reopened.get(p.id).sealed?.groups.length, 0); } finally { reopened.close(); }
  });
});

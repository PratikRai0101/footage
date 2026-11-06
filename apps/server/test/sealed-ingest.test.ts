import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { jobIdSchema, receiptSchema, viewerCodeSchema, storedJobSchema } from '../src/contracts.js';
import { fileIdentity, originalPath } from '../src/originals.js';
import { createReceiver } from '../src/server.js';
import { Manifest, VerifiedStatus, decodeSetup, encodeQuery, freshQuery, limits, verifyOutcome } from '../src/sealed-protocol.js';
import { SealedIngest, schemaUuid, type IngestBoundary } from '../src/sealed-ingest.js';
import { control, generateDirectory, manifest, openFixture, rawRequest, savePackets, type Fixture } from '../../../scripts/test/sealed-ingest/fixture.js';

async function fixture(t: TestContext, options: Parameters<typeof openFixture>[1] = {}, permissionMask = 31) {
  const directory = await generateDirectory(permissionMask);
  let current = await openFixture(directory, options);
  t.after(async () => { await current.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get f() { return current; }, directory,
    async restart(next = options) { await current.close(); current = await openFixture(directory, next); },
  };
}
function id(m: Manifest) { return jobIdSchema.parse(schemaUuid(m.fields.job)); }
async function setup(f: Fixture, m: Manifest) {
  const reply = await control(f, 'setup', m.bytes);
  assert.equal(reply.status, 200);
  return { reply: reply.bytes, keys: decodeSetup(reply.bytes, m) };
}
async function upload(f: Pick<Fixture, 'base'>, path: string, headers: Record<string, string> = {}) {
  const request = rawRequest(f, headers), stream = createReadStream(path);
  stream.on('error', error => request.client.destroy(error));
  request.client.on('close', () => stream.destroy());
  stream.pipe(request.client);
  return request.reply;
}
async function query(f: Fixture, m: Manifest, keys: ReturnType<typeof decodeSetup>, revoke = false, high = 0n) {
  const q = freshQuery(randomUUID().replaceAll('-', ''));
  const reply = await control(f, revoke ? 'revoke' : 'status', encodeQuery(m, q));
  assert.equal(reply.status, 200);
  return { query: q, bytes: reply.bytes, value: VerifiedStatus.verify(reply.bytes, keys, q, high) };
}
function packetAt(packets: Awaited<ReturnType<typeof savePackets>>, index: number) {
  const packet = packets[index]; if (!packet) throw new Error('Missing test packet'); return packet;
}

test('authorized immutable setup: exact retry, random wrapped master, profile and scope reconciliation', async t => {
  const h = await fixture(t), f = h.f, m = manifest(f), first = await setup(f, m);
  const retry = await control(f, 'setup', m.bytes); assert.deepEqual(retry.bytes, first.reply);
  const other = await setup(f, manifest(f)); assert.notDeepEqual(other.reply.subarray(40, 72), first.reply.subarray(40, 72));
  for (const changed of [
    { generation: randomBytes(16).toString('hex') }, { device: randomBytes(16).toString('hex') },
    { receiver: randomBytes(32).toString('hex') }, { origin: 'https://localhost:444' },
    { destination: { kind: 'standalone', intake: randomUUID().replaceAll('-', '') } },
    { destination: { kind: 't3', environment: 'env', project: 'Project', thread: 'thread', workspace: 'workspace', consent: randomBytes(16).toString('hex') } },
  ]) {
    const reply = await control(f, 'setup', Manifest.create({ ...m.fields, ...changed }).bytes); assert.notEqual(reply.status, 200);
  }
  for (const change of [{ job: '1'.repeat(32) }, { expiresAt: 2_000_000_000n }, { expiresAt: 2_000_000_000n + 7n * 86400n + 1n }]) {
    const reply = await control(f, 'setup', manifest(f, 17, change).bytes); assert.notEqual(reply.status, 200);
  }
  const denied = await control(f, 'setup', m.bytes, randomBytes(32)); assert.notEqual(denied.status, 200);
  for (const name of ['jobs.sqlite', 'jobs.sqlite-wal']) {
    const bytes = await readFile(join(f.directory, name)); assert.equal(bytes.includes(first.reply.subarray(40, 72)), false);
    assert.equal(bytes.includes(f.credential), false);
  }
  assert.equal(f.jobs.get(id(m)).transport, 'sealed-v1');
  assert.throws(() => f.jobs.authorize(id(m), f.credential.toString('hex')));
  await assert.rejects(createReceiver(f.directory), /locked/);
});

test('setup/status/revoke enforce their own permission bits; local revocation sweeps only unreceived jobs', async t => {
  const h = await fixture(t, {}, 1), m = manifest(h.f), prepared = await setup(h.f, m);
  const q = encodeQuery(m, freshQuery(randomUUID().replaceAll('-', '')));
  assert.notEqual((await control(h.f, 'status', q)).status, 200);
  assert.notEqual((await control(h.f, 'revoke', q)).status, 200);
  h.f.authority.local.revoke(Buffer.from(h.f.credentials.device, 'hex'));
  await h.f.ingest.reconcileAuthority();
  assert.equal(h.f.jobs.get(id(m)).status, 'cancelled');
  assert.equal((await control(h.f, 'setup', m.bytes)).status === 200, false);
  const queryOnly = await fixture(t, {}, 2);
  assert.notEqual((await control(queryOnly.f, 'setup', manifest(queryOnly.f).bytes)).status, 200);
  assert.equal(prepared.keys.manifest.digest, m.digest);
  const received = await fixture(t), original = manifest(received.f), ready = await setup(received.f, original);
  const packet = packetAt(await savePackets(received.f, original, ready.keys), 0);
  assert.equal((await upload(received.f, packet.path)).status, 200);
  const receipt = received.f.jobs.get(id(original)).receipt;
  received.f.authority.local.revoke(Buffer.from(received.f.credentials.device, 'hex'));
  await received.f.ingest.reconcileAuthority();
  assert.deepEqual(received.f.jobs.get(id(original)).receipt, receipt);
  assert.equal(received.f.jobs.get(id(original)).status, 'received');
});

test('bounded permanent job tombstones and amplification reservation cannot be bypassed by retries', async t => {
  const h = await fixture(t), f = h.f;
  const huge = Manifest.create({ ...manifest(f).fields, originalBytes: limits.original, frameHashes: Array.from({ length: 512 }, () => '0'.repeat(64)) });
  assert.equal((await control(f, 'setup', huge.bytes)).status, 507);
  let first: Manifest | undefined;
  for (let index = 0; index < 20; index++) {
    const m = manifest(f, 1); first ??= m;
    const prepared = await setup(f, m); await query(f, m, prepared.keys, true);
  }
  assert.equal((await control(f, 'setup', manifest(f, 1).bytes)).status, 507);
  if (!first) throw new Error('Missing tombstone');
  assert.equal((await control(f, 'setup', first.bytes)).status, 410);
  await h.restart(); assert.equal(h.f.jobs.all().length, 20);
});

test('real >64MiB multi-group original: holes, persisted exact acks, automatic common finality, viewer and restart', async t => {
  const h = await fixture(t), m = manifest(h.f, 64 * 1024 ** 2 + 173), prepared = await setup(h.f, m);
  const packets = await savePackets(h.f, m, prepared.keys);
  const last = packetAt(packets, 1), first = packetAt(packets, 0);
  const sparse = await upload(h.f, last.path);
  assert.equal(sparse.status, 200);
  const accepted = verifyOutcome(sparse.bytes, 200, prepared.keys, { group: 1, wireSHA256: last.wireHash });
  assert.equal(accepted.receipt, null);
  const hole = await query(h.f, m, prepared.keys);
  assert.equal(hole.value.groupBitmap, 2n); assert.equal(hole.value.contiguousOriginalBytes, 0n);
  await h.restart();
  const replay = await upload(h.f, last.path); assert.deepEqual(replay.bytes, sparse.bytes);
  assert.equal((await query(h.f, m, prepared.keys, false, hole.value.revision)).value.revision, hole.value.revision);
  // The cap applies to a real chunked body, not only a declared length.
  const tooLong = await open(first.path, 'a'); await tooLong.writeFile(Buffer.from([0])); await tooLong.close();
  assert.equal((await upload(h.f, first.path)).status, 413);
  assert.equal((await query(h.f, m, prepared.keys)).value.groupBitmap, 2n);
  const restore = await open(first.path, 'r+'); await restore.truncate(limits.groupWire); await restore.close();
  const completed = await upload(h.f, first.path, { 'content-length': String((await stat(first.path)).size) });
  assert.equal(completed.status, 200);
  const outcome = verifyOutcome(completed.bytes, 200, prepared.keys, { group: 0, wireSHA256: first.wireHash });
  assert.ok(outcome.receipt);
  const job = h.f.jobs.get(id(m)), receipt = receiptSchema.parse(job.receipt);
  assert.equal(receipt.id, outcome.receipt.toOriginalReceipt().id); assert.ok(receipt.binding);
  assert.equal(job.contentReference, 'original'); assert.equal(job.status, 'received');
  const independent = await fileIdentity(originalPath(h.f.directory, job));
  assert.equal(independent.bytes, Number(m.fields.originalBytes)); assert.equal(independent.sha256, m.fields.originalSHA256);
  if (process.platform !== 'win32') assert.equal((await stat(originalPath(h.f.directory, job))).mode & 0o077, 0);
  const received = await query(h.f, m, prepared.keys); assert.equal(received.value.contiguousOriginalBytes, m.fields.originalBytes);
  const path = h.f.viewer.issue(job.id), cookie = h.f.viewer.exchange(viewerCodeSchema.parse(path.slice('/receive#'.length)));
  const view = await fetch(`${h.f.base}/viewer/content`, { headers: { cookie: `footage_viewer=${cookie}`, range: 'bytes=8388607-8388610' } });
  assert.equal(view.status, 206); assert.equal((await view.arrayBuffer()).byteLength, 4);
  const readOnly = await control(h.f, 'revoke', encodeQuery(m, freshQuery(randomUUID().replaceAll('-', ''))), Buffer.from(cookie, 'hex'));
  assert.notEqual(readOnly.status, 200);
  await h.restart();
  assert.deepEqual(h.f.jobs.get(id(m)).receipt, receipt);
  const lateCancel = await query(h.f, m, prepared.keys, true); assert.equal(lateCancel.value.state, 3);
  assert.equal(lateCancel.value.receipt?.toOriginalReceipt().id, receipt.id);
  const db = new DatabaseSync(join(h.f.directory, 'jobs.sqlite'));
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM original_events WHERE job_id = ?').get(job.id)?.n, 1); } finally { db.close(); }
});

test('late frame tamper, truncation and trailing wire publish no valid prefix; conflicting ciphertext is not a retry', async t => {
  const h = await fixture(t), f = h.f, m = manifest(f, limits.frame + 37), prepared = await setup(f, m);
  const packet = packetAt(await savePackets(f, m, prepared.keys), 0);
  const file = await open(packet.path, 'r+'), size = (await file.stat()).size;
  const tag = Buffer.alloc(1); await file.read(tag, 0, 1, size - 1); const original = Buffer.from(tag); tag[0] = (tag[0] ?? 0) ^ 1;
  await file.write(tag, 0, 1, size - 1); await file.close();
  assert.notEqual((await upload(f, packet.path)).status, 200);
  assert.equal((await query(f, m, prepared.keys)).value.groupBitmap, 0n);
  assert.deepEqual(await readdir(join(f.directory, 'sealed-groups')), []);
  assert.deepEqual(await readdir(join(f.directory, 'sealed-quarantine')), []);
  const restore = await open(packet.path, 'r+'); await restore.write(original, 0, 1, size - 1); await restore.close();
  const truncated = rawRequest(f); const source = createReadStream(packet.path, { end: size - 2 }); source.pipe(truncated.client);
  assert.notEqual((await truncated.reply).status, 200);
  const extra = await open(packet.path, 'a'); await extra.writeFile(Buffer.from([0])); await extra.close();
  assert.notEqual((await upload(f, packet.path)).status, 200);
  const trim = await open(packet.path, 'r+'); await trim.truncate(size); await trim.close();
  const accepted = await upload(f, packet.path); assert.equal(accepted.status, 200);
  const exact = await upload(f, packet.path); assert.deepEqual(exact.bytes, accepted.bytes);
  const alternative = packetAt(await savePackets(f, m, prepared.keys, '-alternative'), 0);
  assert.equal((await upload(f, alternative.path)).status, 409);
  for (const fake of [Buffer.alloc(accepted.bytes.length), Buffer.from(accepted.bytes)]) {
    fake[fake.length - 1] = (fake.at(-1) ?? 0) ^ 1;
    assert.throws(() => verifyOutcome(fake, 200, prepared.keys, { group: 0, wireSHA256: packet.wireHash }));
  }
  assert.throws(() => verifyOutcome(accepted.bytes, 204, prepared.keys, { group: 0, wireSHA256: packet.wireHash }));
});

test('whole original hash mismatch cannot publish even when every frame authenticates', async t => {
  const h = await fixture(t), m = manifest(h.f, 173, { originalSHA256: '0'.repeat(64) }), prepared = await setup(h.f, m);
  const packet = packetAt(await savePackets(h.f, m, prepared.keys), 0);
  assert.equal((await upload(h.f, packet.path)).status, 422);
  const status = await query(h.f, m, prepared.keys); assert.equal(status.value.state, 6); assert.equal(status.value.receipt, null);
  assert.equal(h.f.jobs.get(id(m)).receipt, null);
  await h.restart(); assert.equal((await query(h.f, m, prepared.keys)).value.state, 6);
});

test('slow/disconnected encrypted input never owns the job lock; cancel tombstone wins and cleanup is truthful', async t => {
  const h = await fixture(t), f = h.f, m = manifest(f), prepared = await setup(f, m), packet = packetAt(await savePackets(f, m, prepared.keys), 0);
  const bytes = await readFile(packet.path), active = rawRequest(f);
  active.client.write(bytes.subarray(0, 145)); await delay(30);
  const cancelled = await query(f, m, prepared.keys, true);
  assert.equal(cancelled.value.state, 4); assert.equal(cancelled.value.cleanup, 1);
  active.client.end(bytes.subarray(145)); assert.equal((await active.reply).status, 410);
  const clean = await query(f, m, prepared.keys); assert.equal(clean.value.cleanup, 2);
  await h.restart();
  assert.equal((await upload(h.f, packet.path)).status, 410);
  assert.equal((await control(h.f, 'setup', m.bytes)).status, 410);
  const state = await query(h.f, m, prepared.keys);
  assert.equal(state.value.state, 4); assert.equal(state.value.receipt, null);
  assert.throws(() => VerifiedStatus.verify(cancelled.bytes, prepared.keys, state.query, 0n));
  assert.throws(() => VerifiedStatus.verify(cancelled.bytes, prepared.keys, cancelled.query, state.value.revision));
});

for (const reason of ['expiry', 'epoch', 'destination']) {
  test(`commit rechecks ${reason} after an authenticated body was quarantined`, async t => {
    let now = 2_000_000_000n, allowed = true;
    const h = await fixture(t, { now: () => now, access: () => { if (!allowed) throw new Error('Destination removed'); } });
    const f = h.f, m = manifest(f), prepared = await setup(f, m), packet = packetAt(await savePackets(f, m, prepared.keys), 0), bytes = await readFile(packet.path);
    const request = rawRequest(f); request.client.write(bytes.subarray(0, 145)); await delay(25);
    if (reason === 'expiry') now = m.fields.expiresAt;
    else if (reason === 'epoch') f.authority.local.revoke(Buffer.from(f.credentials.device, 'hex'));
    else allowed = false;
    request.client.end(bytes.subarray(145)); assert.notEqual((await request.reply).status, 200);
    const job = f.jobs.get(id(m)); assert.equal(job.receipt, null); assert.equal(job.sealed?.groups.length, 0); assert.equal(job.status, 'cancelled');
  });
}

test('header/body admission, chunked wire cap, timeout and disconnect release the quarantine slot', async t => {
  const h = await fixture(t, { bodyTimeoutMs: 120 }), f = h.f, m = manifest(f), prepared = await setup(f, m), packet = packetAt(await savePackets(f, m, prepared.keys), 0), bytes = await readFile(packet.path);
  for (const headers of [{ authorization: `Bearer ${f.credential.toString('hex')}` }, { cookie: 'credential=x' }, { 'content-encoding': 'gzip' }, { 'content-length': String(limits.groupWire + 1) }]) {
    const request = rawRequest(f, headers); request.client.end(); assert.notEqual((await request.reply).status, 200);
  }
  const slow = rawRequest(f); slow.client.write(bytes.subarray(0, 129)); await delay(25);
  const excess = rawRequest(f); excess.client.end(bytes); assert.equal((await excess.reply).status, 503);
  await assert.rejects(slow.reply); await delay(20);
  const disconnect = rawRequest(f); disconnect.client.write(bytes.subarray(0, 129)); await delay(20); disconnect.client.destroy(); await delay(20);
  assert.equal((await upload(f, packet.path)).status, 200);
  const unknown = Buffer.from(bytes); randomBytes(16).copy(unknown, 40); const noJob = rawRequest(f); noJob.client.end(unknown); assert.notEqual((await noJob.reply).status, 200);
  assert.equal(f.jobs.all().length, 1);
});

for (const corruption of ['missing-group', 'corrupt-group', 'missing-original', 'corrupt-ack']) {
  test(`startup freezes ${corruption} without lowering acknowledged ranges or creating a replacement`, async t => {
    const h = await fixture(t), m = manifest(h.f), prepared = await setup(h.f, m), packet = packetAt(await savePackets(h.f, m, prepared.keys), 0);
    assert.equal((await upload(h.f, packet.path)).status, 200);
    const job = h.f.jobs.get(id(m)), before = job.sealed?.revision;
    if (corruption === 'missing-original') await rm(originalPath(h.f.directory, job));
    else if (corruption === 'corrupt-ack') {
      if (!job.sealed) throw new Error('Missing sealed state');
      h.f.jobs.save({ ...job, sealed: { ...job.sealed, groups: job.sealed.groups.map(group => ({ ...group, ack: Buffer.alloc(192).toString('base64') })) } });
    } else {
      const names = await readdir(join(h.f.directory, 'sealed-groups')), name = names[0]; assert.ok(name);
      const path = join(h.f.directory, 'sealed-groups', name);
      if (corruption === 'missing-group') await rm(path); else await writeFile(path, Buffer.from('corrupt'));
    }
    await h.restart();
    const frozen = h.f.jobs.get(id(m)); assert.equal(frozen.storageFault, true); assert.deepEqual(frozen.receipt, job.receipt);
    assert.equal(frozen.sealed?.groups.length, 1); assert.ok(BigInt(frozen.sealed?.revision ?? '0') > BigInt(before ?? '0'));
    const q = freshQuery(randomUUID().replaceAll('-', ''));
    assert.equal((await control(h.f, 'status', encodeQuery(m, q))).status, 503);
    assert.equal((await upload(h.f, packet.path)).status, 503);
  });
}

test('a lost response does not stop receiver-owned finalization or retain the mutation lock', async t => {
  let disconnect = () => {};
  const h = await fixture(t, { boundary(point) { if (point === 'original-sync') disconnect(); } });
  const m = manifest(h.f), prepared = await setup(h.f, m), packet = packetAt(await savePackets(h.f, m, prepared.keys), 0);
  const request = rawRequest(h.f);
  disconnect = () => request.client.destroy(new Error('Test response lost'));
  createReadStream(packet.path).pipe(request.client);
  await assert.rejects(request.reply);
  const deadline = Date.now() + 2000;
  while (h.f.jobs.get(id(m)).status !== 'received' && Date.now() < deadline) await delay(5);
  const received = await query(h.f, m, prepared.keys); assert.equal(received.value.state, 3);
  assert.ok(received.value.receipt);
  await h.restart(); assert.equal((await query(h.f, m, prepared.keys)).value.receipt?.toOriginalReceipt().id, received.value.receipt.toOriginalReceipt().id);
});

test('actual rename and SQLite failures issue no ack; restart collects unreferenced objects', async t => {
  const h = await fixture(t), m = manifest(h.f), prepared = await setup(h.f, m), packet = packetAt(await savePackets(h.f, m, prepared.keys), 0);
  await rm(join(h.directory, 'sealed-groups'), { recursive: true });
  assert.equal((await upload(h.f, packet.path)).status, 500);
  assert.equal((await query(h.f, m, prepared.keys)).value.groupBitmap, 0n);
  await h.restart();
  const db = new DatabaseSync(join(h.directory, 'jobs.sqlite'));
  db.exec("CREATE TRIGGER injected_failure BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT, 'test database fault'); END");
  assert.equal((await upload(h.f, packet.path)).status, 500);
  assert.equal((await query(h.f, m, prepared.keys)).value.groupBitmap, 0n);
  assert.equal((await readdir(join(h.directory, 'sealed-groups'))).length, 1);
  db.exec('DROP TRIGGER injected_failure'); db.close();
  await h.restart(); assert.deepEqual(await readdir(join(h.directory, 'sealed-groups')), []);
  assert.equal((await upload(h.f, packet.path)).status, 200);
});

test('publication SQLite failure atomically rolls back receipt, content reference, revision and intake event', async t => {
  const h = await fixture(t), m = manifest(h.f), prepared = await setup(h.f, m), packet = packetAt(await savePackets(h.f, m, prepared.keys), 0);
  const db = new DatabaseSync(join(h.directory, 'jobs.sqlite'));
  try {
    db.exec("CREATE TRIGGER refuse_event BEFORE INSERT ON original_events BEGIN SELECT RAISE(ABORT, 'test outbox fault'); END");
    assert.equal((await upload(h.f, packet.path)).status, 500);
    const job = h.f.jobs.get(id(m)); assert.equal(job.receipt, null); assert.equal(job.contentReference, undefined);
    assert.equal(job.sealed?.revision, '1'); assert.equal(job.sealed?.receiptEnvelope, null); assert.equal(job.sealed?.state, 'verifying');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM original_events').get()?.n, 0);
    db.exec('DROP TRIGGER refuse_event');
  } finally { db.close(); }
  await h.restart();
  assert.equal((await query(h.f, m, prepared.keys)).value.state, 3);
  assert.equal(h.f.jobs.get(id(m)).contentReference, 'original');
});

test('failed cleanup is durable pending, then idempotently finishes without lowering the old prefix', async t => {
  let broken = true;
  const h = await fixture(t, { boundary(point) { if (point === 'cleanup' && broken) throw new Error('Test storage unavailable'); } });
  const m = manifest(h.f, 64 * 1024 ** 2 + 1), prepared = await setup(h.f, m), packets = await savePackets(h.f, m, prepared.keys), last = packetAt(packets, 1);
  assert.equal((await upload(h.f, last.path)).status, 200);
  const cancel = await query(h.f, m, prepared.keys, true); assert.equal(cancel.value.state, 4); assert.equal(cancel.value.cleanup, 1);
  broken = false;
  const clean = await query(h.f, m, prepared.keys); assert.equal(clean.value.cleanup, 2); assert.equal(clean.value.groupBitmap, 2n); assert.ok(clean.value.revision > cancel.value.revision);
  await h.restart(); assert.equal((await upload(h.f, last.path)).status, 410);
});

for (const wins of ['cancel', 'receipt']) {
  test(`${wins} wins finalization race under the common lock with one durable outcome`, async t => {
    let f: Fixture | undefined, m: Manifest | undefined, cancellation: Promise<Buffer> | undefined;
    const q = freshQuery(randomUUID().replaceAll('-', ''));
    const h = await fixture(t, { boundary(point) {
      if (point === (wins === 'cancel' ? 'original-directory-sync' : 'publication-db')) {
        if (!f || !m) throw new Error('Race fixture not installed');
        cancellation = f.ingest.status(id(m), encodeQuery(m, q), f.credential, true);
      }
    } });
    f = h.f; m = manifest(f); const prepared = await setup(f, m), packet = packetAt(await savePackets(f, m, prepared.keys), 0);
    assert.equal((await upload(f, packet.path)).status, 200);
    assert.ok(cancellation);
    const result = VerifiedStatus.verify(await cancellation, prepared.keys, q, 0n);
    assert.equal(result.state, wins === 'cancel' ? 4 : 3);
    await h.restart({});
    const job = h.f.jobs.get(id(m)); assert.equal(job.status, wins === 'cancel' ? 'cancelled' : 'received');
    assert.equal(job.receipt !== null, wins === 'receipt');
    if (wins === 'cancel') assert.equal((await upload(h.f, packet.path)).status, 410);
    else assert.equal((await query(h.f, m, prepared.keys, true)).value.receipt?.toOriginalReceipt().id, job.receipt?.id);
  });
}

test('receipt timestamp profile is checked before any original publication', async t => {
  let now = 2_000_000_000n;
  const h = await fixture(t, { now: () => now, boundary(point) { if (point === 'group-db') now = 253402300800n; } });
  const m = manifest(h.f, 173);
  const prepared = await setup(h.f, m);
  const packet = packetAt(await savePackets(h.f, m, prepared.keys), 0);
  assert.notEqual((await upload(h.f, packet.path)).status, 200);
  assert.equal(h.f.jobs.get(id(m)).receipt, null);
  assert.deepEqual(await readdir(join(h.directory, 'originals')), []);
});

const crashBoundaries: IngestBoundary[] = ['group-sync', 'group-rename', 'group-directory-sync', 'group-db', 'original-sync', 'original-rename', 'original-directory-sync', 'publication-db', 'before-response'];
for (const boundary of crashBoundaries) {
  test(`SIGKILL at ${boundary}: reopen repairs/resumes with one authoritative receipt`, { timeout: 15000 }, async t => {
    const h = await fixture(t), m = manifest(h.f), prepared = await setup(h.f, m), packet = packetAt(await savePackets(h.f, m, prepared.keys), 0);
    await h.f.close();
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/test/sealed-ingest/crash-worker.mts', h.directory, boundary], { cwd: new URL('../../../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const exited = once(child, 'exit');
    let diagnostics = '';
    child.stderr.on('data', (chunk: unknown) => { if (Buffer.isBuffer(chunk)) diagnostics += chunk.toString(); });
    const lines = createInterface({ input: child.stdout });
    const ready = await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error(`Crash worker exited before ready: ${diagnostics}`); })]); lines.close();
    const decoded: unknown = JSON.parse(z.string().parse(ready[0]));
    const address = z.object({ base: z.string().url() }).parse(decoded);
    await assert.rejects(upload(address, packet.path));
    const result = await exited; assert.equal(result[1], 'SIGKILL');
    const db = new DatabaseSync(join(h.directory, 'jobs.sqlite'));
    let before: ReturnType<typeof storedJobSchema.parse>;
    try {
      const row = db.prepare('SELECT document FROM jobs WHERE id = ?').get(id(m));
      const document: unknown = JSON.parse(z.string().parse(row?.document));
      before = storedJobSchema.parse(document);
    } finally { db.close(); }
    const committedGroup = !['group-sync', 'group-rename', 'group-directory-sync'].includes(boundary);
    assert.equal(before.sealed?.groups.length, committedGroup ? 1 : 0);
    const committedReceipt = boundary === 'publication-db' || boundary === 'before-response';
    assert.equal(before.receipt !== null, committedReceipt);
    await h.restart();
    assert.deepEqual(await readdir(join(h.directory, 'sealed-quarantine')), []);
    if (!committedGroup) {
      assert.deepEqual(await readdir(join(h.directory, 'sealed-groups')), []);
      assert.equal((await query(h.f, m, prepared.keys)).value.groupBitmap, 0n);
    }
    const retry = await upload(h.f, packet.path); assert.equal(retry.status, 200);
    const outcome = verifyOutcome(retry.bytes, 200, prepared.keys, { group: 0, wireSHA256: packet.wireHash });
    assert.ok(outcome.receipt);
    if (before.receipt) assert.equal(outcome.receipt.toOriginalReceipt().id, before.receipt.id);
    const receipt = h.f.jobs.get(id(m)).receipt;
    await h.restart(); assert.deepEqual(h.f.jobs.get(id(m)).receipt, receipt);
    const identity = await fileIdentity(originalPath(h.directory, h.f.jobs.get(id(m))));
    assert.equal(identity.sha256, m.fields.originalSHA256);
  });
}

test('wrapping-key loss blocks reopen; ordinary startup cannot bypass the isolated owner', async t => {
  const h = await fixture(t), m = manifest(h.f); await setup(h.f, m);
  // Probe the real provider boundary without releasing the current writer.
  await assert.rejects(SealedIngest.open({ directory: h.directory, jobs: h.f.jobs, authority: h.f.authority.authority, wrappingStore: { wrap() { throw new Error('Locked OS store'); }, unwrap() { throw new Error('Locked OS store'); } }, assertDestinationAccess() {} }), /Locked OS store/);
  await h.f.close();
  await assert.rejects(openFixture(h.directory, { wrongKey: true }));
  await assert.rejects(createReceiver(h.directory), /explicit authenticated ingest/);
  // Restore for fixture cleanup and prove the original authority has not been reset.
  const restored = await openFixture(h.directory); assert.equal(restored.jobs.get(id(m)).sealed?.revision, '0');
  await restored.close();
});

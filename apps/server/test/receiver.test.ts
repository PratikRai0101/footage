import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { z } from 'zod';
import { createReceiver } from '../src/server.js';
import { receiptSchema } from '../src/contracts.js';
import { Jobs } from '../src/jobs.js';

const snapshotSchema = z.object({ status: z.string(), confirmedBytes: z.number(), receipt: receiptSchema.nullable() });
const tusHeaders = { 'Tus-Resumable': '1.0.0' };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'footage-test-'));
  let receiver = await createReceiver(directory);
  let base = await receiver.listen();
  t.after(async () => { await receiver.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    url: (path: string) => `${base}${path}`,
    storedFile: (id: string) => join(directory, 'uploads', id),
    originalFile: (id: string) => join(directory, 'originals', id),
    directory,
    get server() { return receiver.server; },
    async restart() { await receiver.close(); receiver = await createReceiver(directory); base = await receiver.listen(); },
  };
}

function sample() {
  const bytes = randomBytes(256 * 1024 + 17);
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const metadata = { id, name: 'protocol-fixture.bin', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const authorization = { Authorization: `Bearer ${token}` };
  return { bytes, id, metadata, authorization };
}

async function register(f: Awaited<ReturnType<typeof fixture>>, s: ReturnType<typeof sample>) {
  const response = await fetch(f.url('/jobs'), { method: 'POST', headers: { ...s.authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(s.metadata) });
  assert.equal(response.status, 200, await response.text());
}

async function patch(f: Awaited<ReturnType<typeof fixture>>, s: ReturnType<typeof sample>, start: number, end = s.bytes.length) {
  return fetch(f.url(`/files/${s.id}`), { method: 'PATCH', headers: { ...s.authorization, ...tusHeaders, 'Upload-Offset': String(start), 'Content-Type': 'application/offset+octet-stream' }, body: s.bytes.subarray(start, end) });
}

async function complete(f: Awaited<ReturnType<typeof fixture>>, s: ReturnType<typeof sample>) {
  return fetch(f.url(`/jobs/${s.id}/complete`), { method: 'POST', headers: s.authorization });
}

function streamingPatch(f: Awaited<ReturnType<typeof fixture>>, s: ReturnType<typeof sample>, length: number | undefined) {
  const client = request(f.url(`/files/${s.id}`), {
    method: 'PATCH',
    headers: { ...s.authorization, ...tusHeaders, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream', ...(length === undefined ? {} : { 'Content-Length': String(length) }) },
  });
  const reply = new Promise<number | undefined>((resolve, reject) => {
    client.once('response', (response) => { response.resume(); response.once('end', () => resolve(response.statusCode)); });
    client.once('error', reject);
  });
  void reply.catch(() => {}); // An intentionally disconnected client has no response to await.
  return { client, reply };
}

async function waitForPrefix(f: Awaited<ReturnType<typeof fixture>>, s: ReturnType<typeof sample>, bytes: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await stat(f.storedFile(s.id))).size >= bytes) return;
    await delay(10);
  }
  assert.fail('The server never persisted the test prefix before interruption.');
}

for (const framing of ['content-length', 'chunked']) {
 test(`aborted PATCH (${framing}) releases the job so the same upload can resume`, async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const { client } = streamingPatch(f, s, framing === 'chunked' ? undefined : s.bytes.length);
  t.after(() => client.destroy());
  client.write(s.bytes.subarray(0, 8_192));
  await waitForPrefix(f, s, 8_192);
  const closed = new Promise<void>((resolve) => client.once('close', resolve));
  client.destroy(); await closed;
  const head = await fetch(f.url(`/files/${s.id}`), { method: 'HEAD', headers: { ...s.authorization, ...tusHeaders }, signal: AbortSignal.timeout(2_000) });
  assert.equal(head.status, 200);
  const offset = Number(head.headers.get('Upload-Offset'));
  assert.equal(offset, 8_192);
  const resumed = await patch(f, s, offset); assert.equal(resumed.status, 204); await resumed.text();
  const result = await complete(f, s); assert.equal(result.status, 200);
  assert.equal(receiptSchema.parse(await result.json()).sha256, s.metadata.sha256);
 });
}

test('abandoned HEAD queued behind a PATCH cannot deadlock later resume', async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const { client, reply } = streamingPatch(f, s, 65_536);
  t.after(() => client.destroy());
  client.write(s.bytes.subarray(0, 8_192));
  await waitForPrefix(f, s, 8_192);
  let arrived = () => {};
  let disconnected = () => {};
  const headArrived = new Promise<void>((resolve) => { arrived = resolve; });
  const headDisconnected = new Promise<void>((resolve) => { disconnected = resolve; });
  f.server.once('request', (_req, response) => { response.once('close', () => disconnected()); arrived(); });
  const controller = new AbortController();
  const abandoned = fetch(f.url(`/files/${s.id}`), { method: 'HEAD', headers: { ...s.authorization, ...tusHeaders }, signal: controller.signal });
  void abandoned.catch(() => {});
  await headArrived;
  controller.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });
  await headDisconnected;
  client.end(s.bytes.subarray(8_192, 65_536));
  assert.equal(await reply, 204);
  const head = await fetch(f.url(`/files/${s.id}`), { method: 'HEAD', headers: { ...s.authorization, ...tusHeaders }, signal: AbortSignal.timeout(2_000) });
  assert.equal(head.status, 200); assert.equal(head.headers.get('Upload-Offset'), '65536');
  const resumed = await patch(f, s, 65_536); assert.equal(resumed.status, 204); await resumed.text();
  const result = await complete(f, s); assert.equal(result.status, 200); await result.text();
});

test('real tus HTTP upload, streaming integrity receipt, and authorized original download', async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const uploaded = await patch(f, s, 0); assert.equal(uploaded.status, 204, await uploaded.text());
  const response = await complete(f, s); assert.equal(response.status, 200, await response.clone().text());
  const receipt = receiptSchema.parse(await response.json());
  assert.equal(receipt.bytes, s.bytes.length); assert.equal(receipt.sha256, s.metadata.sha256);
  const repeat = await complete(f, s); assert.deepEqual(receiptSchema.parse(await repeat.json()), receipt);
  const download = await fetch(f.url(`/jobs/${s.id}/content`), { headers: s.authorization });
  assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), s.bytes);
});

test('partial transfer resumes from server HEAD offset after receiver restart', async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const first = await patch(f, s, 0, 32_768); assert.equal(first.status, 204); await first.text();
  await f.restart();
  const head = await fetch(f.url(`/files/${s.id}`), { method: 'HEAD', headers: { ...s.authorization, ...tusHeaders } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('Upload-Offset'), '32768');
  const stale = await patch(f, s, 0, 20); assert.equal(stale.status, 409); await stale.text();
  const resumed = await patch(f, s, 32_768); assert.equal(resumed.status, 204); await resumed.text();
  const result = await complete(f, s); assert.equal(result.status, 200);
  assert.equal(receiptSchema.parse(await result.json()).sha256, s.metadata.sha256);
});

test('repeat registration never truncates an existing partial upload', async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const uploaded = await patch(f, s, 0, 111); assert.equal(uploaded.status, 204); await uploaded.text();
  await Promise.all([register(f, s), register(f, s)]);
  const response = await fetch(f.url(`/jobs/${s.id}`), { headers: s.authorization });
  assert.equal(snapshotSchema.parse(await response.json()).confirmedBytes, 111);
});

test('receipt remains identical after restart, including a retried completion request', async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const uploaded = await patch(f, s, 0); await uploaded.text();
  const first = receiptSchema.parse(await (await complete(f, s)).json());
  await f.restart();
  const retry = receiptSchema.parse(await (await complete(f, s)).json());
  assert.deepEqual(retry, first);
});

test('incomplete and mismatched files cannot produce a receipt or download', async (t) => {
  const f = await fixture(t); const s = sample(); s.metadata.sha256 = '0'.repeat(64); await register(f, s);
  const early = await complete(f, s); assert.equal(early.status, 409); await early.text();
  const uploaded = await patch(f, s, 0); await uploaded.text();
  const mismatch = await complete(f, s); assert.equal(mismatch.status, 422); await mismatch.text();
  const download = await fetch(f.url(`/jobs/${s.id}/content`), { headers: s.authorization }); assert.equal(download.status, 409); await download.text();
  const response = await fetch(f.url(`/jobs/${s.id}`), { headers: s.authorization });
  const state = snapshotSchema.parse(await response.json()); assert.equal(state.status, 'failed'); assert.equal(state.receipt, null);
});

test('cancellation is durable and no late completion or PATCH resurrects the job', async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const uploaded = await patch(f, s, 0); await uploaded.text();
  const cancelled = await fetch(f.url(`/jobs/${s.id}`), { method: 'DELETE', headers: s.authorization });
  assert.equal(cancelled.status, 200); await cancelled.text();
  await f.restart();
  const late = await complete(f, s); assert.equal(late.status, 409); await late.text();
  const write = await patch(f, s, 0); assert.equal(write.status, 409); await write.text();
  const repeat = await fetch(f.url(`/jobs/${s.id}`), { method: 'DELETE', headers: s.authorization }); assert.equal(repeat.status, 200); await repeat.text();
});

test('a cancel/complete race has one durable outcome', async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const uploaded = await patch(f, s, 0); await uploaded.text();
  const responses = await Promise.all([complete(f, s), fetch(f.url(`/jobs/${s.id}`), { method: 'DELETE', headers: s.authorization })]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  for (const response of responses) await response.text();
  await f.restart();
  const state = snapshotSchema.parse(await (await fetch(f.url(`/jobs/${s.id}`), { headers: s.authorization })).json());
  assert.ok(state.status === 'received' || state.status === 'cancelled');
  assert.equal(state.receipt !== null, state.status === 'received');
});

test('an already committed receipt cannot be contradicted by cancellation', async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const uploaded = await patch(f, s, 0); await uploaded.text();
  const receipt = receiptSchema.parse(await (await complete(f, s)).json());
  const cancelled = await fetch(f.url(`/jobs/${s.id}`), { method: 'DELETE', headers: s.authorization }); assert.equal(cancelled.status, 409); await cancelled.text();
  assert.deepEqual(receiptSchema.parse(await (await complete(f, s)).json()), receipt);
});

test('missing or wrong capabilities cannot read, write, cancel, or download', async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const missing = await fetch(f.url(`/jobs/${s.id}`)); assert.equal(missing.status, 401); await missing.text();
  for (const [path, method] of [[`/jobs/${s.id}`, 'GET'], [`/jobs/${s.id}`, 'DELETE'], [`/jobs/${s.id}/content`, 'GET'], [`/files/${s.id}`, 'PATCH']]) {
    const response = await fetch(f.url(path ?? ''), { method: method ?? 'GET', headers: { Authorization: `Bearer ${'f'.repeat(64)}` } });
    assert.equal(response.status, 403); await response.text();
  }
});

test('cancellation before an ambiguous registration prevents a delayed create', async (t) => {
  const f = await fixture(t); const s = sample();
  const cancel = await fetch(f.url(`/jobs/${s.id}`), { method: 'DELETE', headers: s.authorization });
  assert.equal(cancel.status, 200); await cancel.text();
  await f.restart();
  const delayed = await fetch(f.url('/jobs'), { method: 'POST', headers: s.authorization, body: JSON.stringify(s.metadata) });
  assert.equal(delayed.status, 410); await delayed.text();
});

test('tus Java HTTP method override uploads through the same protocol handler', async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const upload = await fetch(f.url(`/files/${s.id}`), { method: 'POST', headers: { ...s.authorization, ...tusHeaders, 'X-HTTP-Method-Override': 'PATCH', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: s.bytes });
  assert.equal(upload.status, 204); await upload.text();
  const receipt = await complete(f, s); assert.equal(receipt.status, 200); await receipt.text();
});

test('exclusive storage writer blocks a second owner and releases on close', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'footage-writer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new Jobs(join(directory, 'jobs.sqlite'));
  try { assert.throws(() => new Jobs(join(directory, 'jobs.sqlite')), /locked/); }
  finally { first.close(); }
  const next = new Jobs(join(directory, 'jobs.sqlite')); next.close();
});

test('tus publishes a private common original; corruption after restart blocks content', async (t) => {
  const f = await fixture(t); const s = sample(); await register(f, s);
  const uploaded = await patch(f, s, 0); await uploaded.text();
  const receipt = receiptSchema.parse(await (await complete(f, s)).json());
  if (process.platform !== 'win32') assert.equal((await stat(f.originalFile(s.id))).mode & 0o077, 0);
  await writeFile(f.originalFile(s.id), Buffer.from('storage corruption'));
  await f.restart();
  const download = await fetch(f.url(`/jobs/${s.id}/content`), { headers: s.authorization });
  assert.equal(download.status, 503); await download.text();
  const retry = await complete(f, s); assert.equal(retry.status, 503); await retry.text();
  // A storage incident never rewrites the authoritative issued receipt.
  const snapshot = snapshotSchema.parse(await (await fetch(f.url(`/jobs/${s.id}`), { headers: s.authorization })).json());
  assert.deepEqual(snapshot.receipt, receipt);
});

test('malformed metadata and oversized files are rejected at registration', async (t) => {
  const f = await fixture(t); const s = sample();
  for (const metadata of [{ ...s.metadata, bytes: 4 * 1024 ** 3 + 1 }, { ...s.metadata, id: '../outside' }, { ...s.metadata, name: 'x'.repeat(5000) }]) {
    const response = await fetch(f.url('/jobs'), { method: 'POST', headers: s.authorization, body: JSON.stringify(metadata) });
    assert.ok(response.status === 400 || response.status === 413); await response.text();
  }
});

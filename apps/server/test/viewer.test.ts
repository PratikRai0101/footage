import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { createReceiver } from '../src/server.js';
import { receiptSchema } from '../src/contracts.js';

const jobSchema = z.object({
  id: z.uuid(), name: z.string(), bytes: z.number(), sha256: z.string(), status: z.literal('received'),
  receipt: receiptSchema, contentType: z.string(), previewSupported: z.boolean(),
  contentPath: z.literal('/viewer/content'), downloadPath: z.literal('/viewer/content?download=1'),
}).strict();

async function fixture(t: TestContext, options: Parameters<typeof createReceiver>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'footage-viewer-test-'));
  let receiver = await createReceiver(directory, options);
  let base = await receiver.listen();
  t.after(async () => { await receiver.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    url: (path: string) => `${base}${path}`,
    async restart() { await receiver.close(); receiver = await createReceiver(directory, options); base = await receiver.listen(); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function original(bytes = Buffer.concat([Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'), randomBytes(128 * 1024)]), name = 'Evening take 04.mp4') {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  return {
    id, token, bytes, authorization: { Authorization: `Bearer ${token}` },
    metadata: { id, name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
}
type Original = ReturnType<typeof original>;

async function register(f: Fixture, s: Original) {
  const response = await fetch(f.url('/jobs'), { method: 'POST', headers: s.authorization, body: JSON.stringify(s.metadata) });
  assert.equal(response.status, 200, await response.text());
}
async function upload(f: Fixture, s: Original) {
  await register(f, s);
  const response = await fetch(f.url(`/files/${s.id}`), { method: 'PATCH', headers: { ...s.authorization, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: s.bytes });
  assert.equal(response.status, 204, await response.text());
  const completed = await fetch(f.url(`/jobs/${s.id}/complete`), { method: 'POST', headers: s.authorization });
  assert.equal(completed.status, 200);
  return receiptSchema.parse(await completed.json());
}
async function viewCode(f: Fixture, s: Original) {
  const response = await fetch(f.url(`/jobs/${s.id}/view`), { method: 'POST', headers: s.authorization });
  assert.equal(response.status, 200);
  const { path } = z.object({ path: z.string().regex(/^\/receive#[a-f0-9]{64}$/) }).strict().parse(await response.json());
  const code = path.slice('/receive#'.length);
  assert.notEqual(code, s.token);
  return { path, code };
}
function exchange(f: Fixture, code: string) {
  return fetch(f.url('/viewer/session'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
}
async function session(f: Fixture, s: Original) {
  const { code } = await viewCode(f, s);
  const response = await exchange(f, code);
  assert.equal(response.status, 204, await response.text());
  const header = response.headers.get('set-cookie');
  assert.ok(header);
  const cookie = header.split(';')[0];
  assert.ok(cookie);
  return { code, cookie, header, token: cookie.slice('footage_viewer='.length) };
}
function security(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
}

test('authorized original GET/HEAD streams full bytes and single bounded, suffix, open-ended ranges', async (t) => {
  const f = await fixture(t); const s = original(); await upload(f, s);
  const path = f.url(`/jobs/${s.id}/content`);
  const full = await fetch(path, { headers: s.authorization });
  assert.equal(full.status, 200); security(full);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.match(full.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), s.bytes);
  const head = await fetch(path, { method: 'HEAD', headers: s.authorization });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(s.bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [range, start, end] of [
    ['bytes=9-29', 9, 29], ['bytes=100-', 100, s.bytes.length - 1],
    ['bytes=-17', s.bytes.length - 17, s.bytes.length - 1],
    [`bytes=${s.bytes.length - 8}-${s.bytes.length + 100}`, s.bytes.length - 8, s.bytes.length - 1],
    [`bytes=-${s.bytes.length + 100}`, 0, s.bytes.length - 1],
  ] satisfies [string, number, number][]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(path, { method, headers: { ...s.authorization, Range: range } });
      assert.equal(response.status, 206, range); security(response);
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${s.bytes.length}`);
      assert.equal(response.headers.get('content-length'), String(end - start + 1));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), method === 'HEAD' ? Buffer.alloc(0) : s.bytes.subarray(start, end + 1));
    }
  }
  for (const range of ['bytes=', 'bytes=-', 'bytes=0-1,4-5', 'bytes=-0', `bytes=${s.bytes.length}-`, 'bytes=9-1', 'items=0-1', 'bytes=x-y', 'bytes=99999999999999999999-', 'bytes=0-99999999999999999999']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(path, { method, headers: { ...s.authorization, Range: range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get('content-range'), `bytes */${s.bytes.length}`);
      await response.arrayBuffer();
    }
  }
});

test('content and viewing links reject missing/wrong auth and incomplete, failed, or cancelled jobs', async (t) => {
  const f = await fixture(t);
  for (const state of ['incomplete', 'failed', 'cancelled']) {
    const s = original();
    if (state === 'failed') s.metadata.sha256 = '0'.repeat(64);
    await register(f, s);
    if (state === 'failed') {
      const write = await fetch(f.url(`/files/${s.id}`), { method: 'PATCH', headers: { ...s.authorization, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: s.bytes });
      await write.text();
      const failed = await fetch(f.url(`/jobs/${s.id}/complete`), { method: 'POST', headers: s.authorization });
      assert.equal(failed.status, 422); await failed.text();
    }
    if (state === 'cancelled') {
      const cancelled = await fetch(f.url(`/jobs/${s.id}`), { method: 'DELETE', headers: s.authorization });
      assert.equal(cancelled.status, 200); await cancelled.text();
    }
    for (const [method, suffix] of [['GET', 'content'], ['HEAD', 'content'], ['POST', 'view']] satisfies [string, string][]) {
      const path = f.url(`/jobs/${s.id}/${suffix}`);
      for (const [headers, expected] of [[{}, 401], [{ Authorization: `Bearer ${'f'.repeat(64)}` }, 403], [s.authorization, 409]] satisfies [Record<string, string>, number][]) {
        const response = await fetch(path, { method, headers });
        assert.equal(response.status, expected, `${state} ${method} ${suffix}`); await response.text();
      }
    }
  }
});

test('one-use exchange creates only a scoped HttpOnly cookie and read-only cookie-authenticated playback', async (t) => {
  const f = await fixture(t); const s = original(); const receipt = await upload(f, s);
  const access = await session(f, s);
  assert.match(access.header, /Path=\/viewer\//); assert.match(access.header, /HttpOnly/);
  assert.match(access.header, /SameSite=Strict/); assert.match(access.header, /Max-Age=600/);
  assert.doesNotMatch(access.header, /Secure/); // Real local HTTP, not a forwarded-proto fiction.
  assert.notEqual(access.token, access.code); assert.notEqual(access.token, s.token);
  const used = await exchange(f, access.code); assert.equal(used.status, 401); await used.text();
  const headers = { Cookie: access.cookie };
  const response = await fetch(f.url('/viewer/job'), { headers }); security(response);
  assert.equal(response.status, 200);
  const job = jobSchema.parse(await response.json());
  assert.equal(job.id, s.id); assert.equal(job.name, s.metadata.name);
  assert.equal(job.bytes, s.bytes.length); assert.deepEqual(job.receipt, receipt);
  assert.equal(job.sha256, s.metadata.sha256); assert.equal(job.previewSupported, true);
  const serialized = JSON.stringify(job);
  for (const secret of [s.token, access.code, access.token, 'tokenHash', 'uploadPath']) assert.ok(!serialized.includes(secret));
  for (const method of ['GET', 'HEAD']) {
    const preview = await fetch(f.url('/viewer/content'), { method, headers: { ...headers, Range: 'bytes=11-39' } });
    assert.equal(preview.status, 206); security(preview);
    assert.match(preview.headers.get('content-disposition') ?? '', /^inline;/);
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), method === 'HEAD' ? Buffer.alloc(0) : s.bytes.subarray(11, 40));
  }
  const download = await fetch(f.url(job.downloadPath), { headers });
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.match(download.headers.get('content-disposition') ?? '', /filename\*=UTF-8''Evening%20take%2004.mp4/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), s.bytes);
  const invalidRange = await fetch(f.url('/viewer/content'), { headers: { ...headers, Range: 'bytes=0-1,3-4' } });
  assert.equal(invalidRange.status, 416); await invalidRange.text();
  for (const path of ['/viewer/job', '/viewer/content', `/viewer/content?token=${access.token}`, `/viewer/job?code=${access.code}`]) {
    for (const deniedHeaders of [{}, s.authorization, { Cookie: 'footage_viewer=invalid' }, { Cookie: `footage_viewer=${'0'.repeat(64)}` }, { Cookie: `${access.cookie}; ${access.cookie}` }]) {
      const denied = await fetch(f.url(path), { headers: deniedHeaders });
      assert.equal(denied.status, 401); security(denied); await denied.text();
    }
  }
  for (const token of [access.token, access.code]) {
    for (const [method, path] of [['DELETE', `/jobs/${s.id}`], ['POST', `/jobs/${s.id}/complete`], ['POST', `/jobs/${s.id}/view`], ['PATCH', `/files/${s.id}`]] satisfies [string, string][]) {
      const denied = await fetch(f.url(path), { method, headers: { ...headers, Authorization: `Bearer ${token}` } });
      assert.equal(denied.status, 403); await denied.text();
    }
    const registration = await fetch(f.url('/jobs'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(s.metadata) });
    assert.equal(registration.status, 403); await registration.text();
  }
  const noOriginal = await fetch(f.url(`/jobs/${s.id}`), { method: 'DELETE', headers });
  assert.equal(noOriginal.status, 401); await noOriginal.text();
  for (const method of ['DELETE', 'PATCH', 'POST']) {
    const denied = await fetch(f.url('/viewer/content'), { method, headers }); assert.equal(denied.status, 405); await denied.text();
  }
  const listing = await fetch(f.url('/jobs'), { headers }); assert.equal(listing.status, 404); await listing.text();
  const unchanged = await fetch(f.url(`/jobs/${s.id}/complete`), { method: 'POST', headers: s.authorization });
  assert.deepEqual(receiptSchema.parse(await unchanged.json()), receipt);
});

test('exchange validates JSON and origin and never accepts original capabilities or guessed codes', async (t) => {
  const f = await fixture(t); const s = original(); await upload(f, s);
  for (const code of [s.token, '0'.repeat(64)]) {
    const denied = await exchange(f, code); assert.equal(denied.status, 401); await denied.text();
  }
  for (const value of [{}, { code: 'invalid' }, { code: '0'.repeat(64), extra: true }, null]) {
    const denied = await fetch(f.url('/viewer/session'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(denied.status, 400); await denied.text();
  }
  const malformed = await fetch(f.url('/viewer/session'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400); await malformed.text();
  const huge = await fetch(f.url('/viewer/session'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'x'.repeat(5000) }) });
  assert.equal(huge.status, 413); await huge.text();
  const { code } = await viewCode(f, s);
  const crossOrigin = await fetch(f.url('/viewer/session'), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://elsewhere.invalid' }, body: JSON.stringify({ code }) });
  assert.equal(crossOrigin.status, 403); await crossOrigin.text();
  const wrongType = await fetch(f.url('/viewer/session'), { method: 'POST', body: JSON.stringify({ code }) });
  assert.equal(wrongType.status, 415); await wrongType.text();
  const results = await Promise.all([exchange(f, code), exchange(f, code)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [204, 401]);
  for (const result of results) await result.text();
});

for (const lifetime of ['code', 'session']) {
  test(`zero ${lifetime} lifetime rejects expired credentials through normal receiver configuration`, async (t) => {
    const f = await fixture(t, lifetime === 'code' ? { viewerCodeTtlMs: 0 } : { viewerSessionTtlMs: 0 });
    const s = original(); await upload(f, s);
    if (lifetime === 'code') {
      const { code } = await viewCode(f, s); const denied = await exchange(f, code);
      assert.equal(denied.status, 401); await denied.text();
    } else {
      const access = await session(f, s);
      assert.match(access.header, /Max-Age=0/);
      for (const path of ['/viewer/job', '/viewer/content']) {
        const denied = await fetch(f.url(path), { headers: { Cookie: access.cookie } });
        assert.equal(denied.status, 401); await denied.text();
      }
    }
  });
}

test('receiver restart invalidates both ephemeral exchange codes and sessions, not the received original', async (t) => {
  const f = await fixture(t); const s = original(); const receipt = await upload(f, s);
  const access = await session(f, s); const pending = await viewCode(f, s);
  await f.restart();
  const oldCode = await exchange(f, pending.code); assert.equal(oldCode.status, 401); await oldCode.text();
  const oldSession = await fetch(f.url('/viewer/job'), { headers: { Cookie: access.cookie } });
  assert.equal(oldSession.status, 401); await oldSession.text();
  const fresh = await session(f, s);
  const response = await fetch(f.url('/viewer/job'), { headers: { Cookie: fresh.cookie } });
  assert.deepEqual(jobSchema.parse(await response.json()).receipt, receipt);
});

test('exchange and session maps enforce bounded budgets without evicting active grants', async (t) => {
  const f = await fixture(t); const s = original(); await upload(f, s);
  let firstCode = '';
  for (let index = 0; index < 256; index++) {
    const { code } = await viewCode(f, s); if (index === 0) firstCode = code;
  }
  const full = await fetch(f.url(`/jobs/${s.id}/view`), { method: 'POST', headers: s.authorization });
  assert.equal(full.status, 503); await full.text();
  const retained = await exchange(f, firstCode); assert.equal(retained.status, 204); await retained.text();
  await f.restart();
  let firstCookie = '';
  for (let index = 0; index < 256; index++) {
    const access = await session(f, s); if (index === 0) firstCookie = access.cookie;
  }
  const { code } = await viewCode(f, s); const over = await exchange(f, code);
  assert.equal(over.status, 503); await over.text();
  const retainedSession = await fetch(f.url('/viewer/job'), { headers: { Cookie: firstCookie } });
  assert.equal(retainedSession.status, 200); await retainedSession.text();
});

test('content type comes from MP4/WebM/Ogg magic, never an untrusted extension', async (t) => {
  const f = await fixture(t);
  for (const [bytes, expected] of [
    [Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex'), 'video/mp4'],
    [Buffer.from('1a45dfa3874282847765626d', 'hex'), 'video/webm'],
    [Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40)]), 'video/ogg'],
    [Buffer.from('not a video, despite its filename'), 'application/octet-stream'],
    [Buffer.from('000000186674797061766966000000006176696661766966', 'hex'), 'application/octet-stream'],
  ] satisfies [Buffer, string][]) {
    const s = original(bytes, 'untrusted.mp4'); await upload(f, s); const access = await session(f, s);
    const headers = { Cookie: access.cookie };
    const metadata = await fetch(f.url('/viewer/job'), { headers });
    const job = jobSchema.parse(await metadata.json());
    assert.equal(job.contentType, expected); assert.equal(job.previewSupported, expected !== 'application/octet-stream');
    const content = await fetch(f.url('/viewer/content'), { headers });
    assert.equal(content.headers.get('content-type'), expected);
    if (expected === 'application/octet-stream') assert.match(content.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
  }
});

test('a stalled content reader does not hold the job lock or obstruct receipt requests', async (t) => {
  const f = await fixture(t); const s = original(randomBytes(16 * 1024 * 1024)); const receipt = await upload(f, s);
  const client = request(f.url(`/jobs/${s.id}/content`), { headers: s.authorization });
  t.after(() => client.destroy());
  const opened = new Promise<void>((resolve, reject) => {
    client.once('response', (response) => { response.pause(); resolve(); });
    client.once('error', reject);
  });
  client.end(); await opened;
  try {
    const repeated = await fetch(f.url(`/jobs/${s.id}/complete`), { method: 'POST', headers: s.authorization, signal: AbortSignal.timeout(2000) });
    assert.equal(repeated.status, 200); assert.deepEqual(receiptSchema.parse(await repeated.json()), receipt);
    const cancel = await fetch(f.url(`/jobs/${s.id}`), { method: 'DELETE', headers: s.authorization, signal: AbortSignal.timeout(2000) });
    assert.equal(cancel.status, 409); await cancel.text();
  } finally { client.destroy(); }
});

test('served screening room strips the fragment before exchange and inserts a hostile filename only as text', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const hostile = '<img src=x onerror="globalThis.pwned=true"></script><script>globalThis.pwned=true</script>& \'take.mp4';
  const s = original(undefined, hostile); await upload(f, s); const { code } = await viewCode(f, s);
  const page = await fetch(f.url('/receive')); assert.equal(page.status, 200); security(page);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  const html = await page.text();
  assert.ok(!html.includes(hostile)); assert.ok(!html.includes(code)); assert.ok(!html.includes(s.token));
  assert.match(html, /Preview is not supported for this file format/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|innerHTML|https?:\/\//);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  assert.ok(script); assert.ok(style);
  const csp = page.headers.get('content-security-policy') ?? '';
  for (const content of [script, style]) assert.ok(csp.includes(`'sha256-${createHash('sha256').update(content).digest('base64')}'`));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  let fragmentRemoved = false;
  let cookie = '';
  let finish = () => {};
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const elements = new Map<string, { textContent: string; hidden: boolean; setAttribute: () => void; addEventListener: () => void }>();
  const sandbox = {
    location: { hash: `#${code}`, pathname: '/receive' },
    history: { replaceState(_state: unknown, _title: string, path: string) { assert.equal(path, '/receive'); fragmentRemoved = true; } },
    document: {
      title: '',
      getElementById(id: string) {
        let element = elements.get(id);
        if (!element) {
          element = { textContent: '', hidden: false, setAttribute() { if (id === 'screening') finish(); }, addEventListener() {} };
          Object.defineProperty(element, 'innerHTML', { set() { assert.fail('Filename must never enter an HTML parsing sink.'); } });
          elements.set(id, element);
        }
        return element;
      },
    },
    async fetch(path: string, options: RequestInit = {}) {
      assert.equal(fragmentRemoved, true, 'Fragment must be gone before any request.');
      assert.ok(!path.includes(code)); assert.ok(!path.includes(s.token));
      const response = await fetch(f.url(path), { ...options, headers: { ...options.headers, ...(cookie ? { Cookie: cookie } : {}) } });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return response;
    },
  };
  runInNewContext(script, sandbox);
  await finished;
  assert.equal(elements.get('filename')?.textContent, hostile);
  assert.equal(sandbox.document.title, `${hostile} — Footage`);
  assert.ok(!('pwned' in sandbox));
  assert.equal(elements.get('state')?.textContent, 'Received & verified');
  assert.equal(elements.get('screening')?.hidden, false);
});

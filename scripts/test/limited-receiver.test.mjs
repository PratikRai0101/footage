import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import test from 'node:test';

async function fixture(t, handler) {
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const child = spawn(process.execPath, ['scripts/limited-receiver.mjs', '127.0.0.1', '0', '131072', String(upstream.address().port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', value => { errors += value; });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  const lines = createInterface({ input: child.stdout });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const [line] = await once(lines, 'line', { signal: controller.signal });
    const ready = JSON.parse(line);
    assert.equal(ready.event, 'test_proxy_ready', errors);
    return `http://127.0.0.1:${ready.port}`;
  } finally { clearTimeout(timeout); }
}

test('limiter preserves override PATCH bytes, authorization and tus HEAD control responses', { timeout: 10_000 }, async t => {
  const payload = Buffer.alloc(128 * 1024, 137);
  let uploaded;
  const origin = await fixture(t, async (req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Upload-Offset': String(payload.length), 'Tus-Resumable': '1.0.0' }).end();
      return;
    }
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['x-http-method-override'], 'PATCH');
    assert.equal(req.headers.authorization, 'Bearer synthetic-local-test');
    const pieces = [];
    for await (const piece of req) pieces.push(piece);
    uploaded = Buffer.concat(pieces);
    res.writeHead(204, { 'Upload-Offset': String(uploaded.length) }).end();
  });
  const write = await fetch(origin + '/files/generated-test', { method: 'POST', headers: { Authorization: 'Bearer synthetic-local-test', 'X-HTTP-Method-Override': 'PATCH', 'Content-Type': 'application/offset+octet-stream' }, body: payload });
  assert.equal(write.status, 204);
  assert.deepEqual(uploaded, payload);
  assert.equal(write.headers.get('upload-offset'), String(payload.length));
  const head = await fetch(origin + '/files/generated-test', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('upload-offset'), String(payload.length));
  assert.equal(head.headers.get('tus-resumable'), '1.0.0');
});

test('aborting a limited upload aborts the upstream body and leaves control requests usable', { timeout: 10_000 }, async t => {
  let prefixReached;
  let upstreamAborted;
  const prefix = new Promise(resolve => { prefixReached = resolve; });
  const aborted = new Promise(resolve => { upstreamAborted = resolve; });
  const origin = await fixture(t, (req, res) => {
    if (req.method === 'GET') { res.writeHead(200).end('healthy'); return; }
    req.on('data', () => prefixReached());
    req.on('aborted', () => upstreamAborted());
    req.on('error', () => {});
  });
  const upload = http.request(origin + '/files/generated-test', { method: 'PATCH' });
  upload.on('error', () => {});
  upload.write(Buffer.alloc(64 * 1024, 42));
  await prefix;
  upload.destroy();
  await aborted;
  const health = await fetch(origin + '/health');
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'healthy');
});

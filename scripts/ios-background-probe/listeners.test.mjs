// Boundary checks of the actual research listener, not a production protocol test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const derive = (key, job, label) => Buffer.from(hkdfSync('sha256', key, Buffer.from(job), Buffer.from(`probe-v1/${label}`), 32));

function envelope(job, key, plain) {
  const header = { v: 1, job, offset: 0, length: plain.length, sha256: hash(plain) };
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(key, job, 'body'), nonce);
  cipher.setAAD(Buffer.from(`probe-v1|${job}|0|${plain.length}|${header.sha256}`));
  const sealed = Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const metadata = Buffer.from(JSON.stringify(header));
  const size = Buffer.alloc(4); size.writeUInt32BE(metadata.length);
  return Buffer.concat([size, metadata, sealed]);
}
function changeHeader(wire, change) {
  const n = wire.readUInt32BE(0);
  const metadata = Buffer.from(JSON.stringify(change(JSON.parse(wire.subarray(4, 4 + n)))));
  const size = Buffer.alloc(4); size.writeUInt32BE(metadata.length);
  return Buffer.concat([size, metadata, wire.subarray(4 + n)]);
}
function validAck(value, job, key, plain, wire) {
  const expected = `probe-v1/ack|${job}|0|${plain.length}|${hash(plain)}|${hash(wire)}`;
  const wanted = createHmac('sha256', derive(key, job, 'ack')).update(expected).digest();
  const actual = Buffer.from(value.mac, 'base64');
  return value.ack === expected && actual.length === wanted.length && timingSafeEqual(wanted, actual);
}

test('sealed probe boundaries: mutation, scoped replay, forged outcome and relay', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'footage-sealed-review-'));
  let listener;
  try {
    // New disposable material only. No machine trust edits or existing credentials.
    for (const leaf of ['leaf', 'other']) {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout', join(dir, `${leaf}.key`), '-out', join(dir, `${leaf}.pem`)], { stdio: 'ignore' });
    }
    listener = spawn(process.execPath, [new URL('./listeners.mjs', import.meta.url).pathname, dir], { stdio: 'ignore' });
    let ports;
    for (let i = 0; i < 100; i++) {
      try { ports = JSON.parse(await readFile(join(dir, 'ports.json'), 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (listener.exitCode !== null) throw Error('Research listener exited before readiness.');
      await delay(25);
    }
    assert.ok(ports, 'Research listener became ready');
    const ca = await readFile(join(dir, 'leaf.pem'));
    async function send(path, bytes = Buffer.alloc(0)) {
      return new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: ports.receiver, path, method: 'POST', ca,
          headers: { 'Content-Length': bytes.length } }, res => {
          const chunks = []; let count = 0;
          res.on('data', chunk => { count += chunk.length; if (count > 65536) res.destroy(Error('Response limit')); else chunks.push(chunk); });
          res.on('error', reject);
          res.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString();
              resolve({ status: res.statusCode, value: body ? JSON.parse(body) : null });
            } catch (error) { reject(error); }
          });
        });
        req.setTimeout(3000, () => req.destroy(Error('Listener request timeout')));
        req.on('error', reject); req.end(bytes);
      });
    }
    const setup = (await send('/setup')).value;
    const other = (await send('/setup')).value;
    const key = Buffer.from(setup.key, 'base64');
    const plain = randomBytes(65536);
    const wire = envelope(setup.job, key, plain);
    await t.test('mutations and cross-job replay cannot publish a plaintext file', async () => {
      const tampered = Buffer.from(wire); tampered[tampered.length - 17] ^= 1;
      const shortHeader = Buffer.alloc(4); shortHeader.writeUInt32BE(4097);
      for (const altered of [tampered, wire.subarray(0, -1), shortHeader,
        changeHeader(wire, h => ({ ...h, offset: 1 })),
        changeHeader(wire, h => ({ ...h, length: h.length + 1 })),
        changeHeader(wire, h => ({ ...h, sha256: '0'.repeat(64) })),
        changeHeader(wire, h => ({ ...h, job: other.job }))]) {
        assert.equal((await send('/sealed', altered)).status, 400);
        for (const job of [setup.job, other.job]) {
          await assert.rejects(readFile(join(dir, `receiver-${job}.bin`)), { code: 'ENOENT' });
        }
      }
    });
    await t.test('authenticated exact replay is idempotent, not general write authority', async () => {
      const first = await send('/sealed', wire);
      assert.equal(first.status, 200);
      assert.ok(validAck(first.value, setup.job, key, plain, wire));
      const repeat = await send('/sealed', wire);
      assert.deepEqual(repeat.value, first.value);
      assert.deepEqual(await readFile(join(dir, `receiver-${setup.job}.bin`)), plain);
      // Even the legitimate key-holder cannot replace an accepted range with another envelope.
      assert.equal((await send('/sealed', envelope(setup.job, key, randomBytes(plain.length)))).status, 400);
      assert.deepEqual(await readFile(join(dir, `receiver-${setup.job}.bin`)), plain);
      assert.equal(validAck(first.value, other.job, Buffer.from(other.key, 'base64'), plain, wire), false);
    });
    await t.test('public-context fake ack fails; relay succeeds only after real receiver commit', async () => {
      const fresh = (await send('/setup')).value;
      const freshKey = Buffer.from(fresh.key, 'base64');
      const packet = envelope(fresh.job, freshKey, plain);
      const corrupted = Buffer.from(packet); corrupted[corrupted.length - 17] ^= 1;
      await send('/sealed-sink', corrupted);
      assert.equal((await send('/verify-captured')).status, 400);
      await assert.rejects(readFile(join(dir, `receiver-${fresh.job}.bin`)), { code: 'ENOENT' });
      const forged = await send('/sealed-sink', packet);
      assert.equal(forged.status, 200);
      assert.equal(forged.value.ack, `probe-v1/ack|${fresh.job}|0|${plain.length}|${hash(plain)}|${hash(packet)}`);
      assert.equal(validAck(forged.value, fresh.job, freshKey, plain, packet), false);
      await assert.rejects(readFile(join(dir, `receiver-${fresh.job}.bin`)), { code: 'ENOENT' });
      const captured = await readFile(join(dir, 'captured-sealed.bin'));
      assert.deepEqual(captured, packet);
      const relayed = await send('/sealed', captured);
      assert.ok(validAck(relayed.value, fresh.job, freshKey, plain, packet));
      assert.deepEqual(await readFile(join(dir, `receiver-${fresh.job}.bin`)), plain);
    });
  } finally {
    if (listener && listener.exitCode === null) {
      const exited = once(listener, 'exit'); listener.kill('SIGTERM'); await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

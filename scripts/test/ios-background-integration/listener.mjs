// PRIVATE TEST ADAPTER ONLY. No production import/route/provider. Generated credentials only.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:https';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { Jobs } from '../../../apps/server/src/jobs.ts';
import { SealedIngest, schemaUuid } from '../../../apps/server/src/sealed-ingest.ts';
import { Manifest } from '../../../apps/server/src/sealed-protocol.ts';
import { originalPath } from '../../../apps/server/src/originals.ts';
import { HttpError, jobIdSchema } from '../../../apps/server/src/contracts.ts';

const [out, docs] = process.argv.slice(2);
assert(out && docs);
const exists = p => access(p).then(() => true, () => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async (p, value) => writeFile(p, JSON.stringify(value), { mode: 0o600 });
const privatePath = join(out, 'synthetic-authority.json');
let config = await exists(privatePath) ? JSON.parse(await readFile(privatePath, 'utf8')) : null;
const state = { groups: 0, bodyBytes: 0, authHeaders: 0, cookieHeaders: 0, errors: 0,
  wireMatches: [], wholeHashMatched: false, fakeOutcomeSent: false, lostFinalResponse: false, rejectedRequests: [] };
let ingest, jobs, serial = Promise.resolve();
const active = new Set();
const server = createServer({ key: await readFile(join(out, 'leaf.key')), cert: await readFile(join(out, 'leaf.pem')) }, (req, res) => {
  // No status/setup/revoke over arbitrary paths or query strings; these use a private mailbox.
  state.authHeaders += req.headers.authorization ? 1 : 0;
  state.cookieHeaders += req.headers.cookie ? 1 : 0;
  if (req.method !== 'POST' || req.url !== '/sealed/v1/ingest' || req.headers.authorization || req.headers.cookie) {
    res.writeHead(404); res.end(); req.resume(); return;
  }
  req.pause();
  const operation = serial.then(async () => {
    while (!await exists(join(out, 'release'))) await sleep(50);
    const hash = createHash('sha256'); let header = Buffer.alloc(0), count = 0;
    req.on('data', bytes => { hash.update(bytes); count += bytes.length; if (header.length < 128) header = Buffer.concat([header, bytes]).subarray(0, 128); });
    try {
      // ACTUAL G3 parser/decryption/quarantine/durable groups/whole hash/Jobs publication.
      const reply = await ingest.ingest(req);
      const group = header.readUInt32BE(104), wire = hash.digest('hex');
      const saved = await hashFile(join(docs, `runtime/group-${group}.sealed`));
      state.wireMatches.push(saved.sha256 === wire);
      state.bodyBytes += count; state.groups++;
      const job = jobs.all()[0];
      if (job.receipt) {
        const independent = await hashFile(originalPath(join(out, 'receiver'), job));
        state.wholeHashMatched = independent.bytes === job.receipt.bytes && independent.sha256 === job.receipt.sha256;
        await json(join(out, 'actual-receipt.json'), { receipt: job.receipt, independent, jobCount: jobs.all().length });
        // Lose the final response AFTER real automatic publication; native must reconcile.
        if (await exists(join(out, 'respond-final'))) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(reply); }
        else { state.lostFinalResponse = true; res.destroy(); }
      } else if (!state.fakeOutcomeSent) {
        const forged = Buffer.from(reply); forged[203] ^= 1; // canonical framing, invalid ack HMAC
        state.fakeOutcomeSent = true; res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(forged);
      } else { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(reply); }
      await json(join(out, 'listener-state.json'), state);
    } catch (error) {
      state.errors++; state.rejectedRequests.push({ code: error?.code, message: String(error) });
      await json(join(out, 'listener-state.json'), state);
      if (!res.destroyed) { res.writeHead(error instanceof HttpError ? error.status : 500); res.end(); }
      req.resume();
    }
  });
  serial = operation.catch(() => {}); active.add(operation); void operation.finally(() => active.delete(operation));
});
server.maxConnections = 8; server.headersTimeout = 10000; server.requestTimeout = 240000;
server.listen(config?.port ?? 0, '127.0.0.1'); await once(server, 'listening');
const port = server.address().port;
if (!config) {
  config = { port, receiver: randomBytes(32).toString('hex'), device: randomBytes(16).toString('hex'),
    intake: randomUUID().replaceAll('-', ''), credential: randomBytes(32).toString('hex'), key: randomBytes(32).toString('hex'), origin: `https://localhost:${port}` };
  await json(privatePath, config);
}
const wrapping = {
  wrap(plain, context) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(config.key, 'hex'), nonce);
    cipher.setAAD(Buffer.from(context)); return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  },
  unwrap(bytes, context) {
    const cipher = createDecipheriv('aes-256-gcm', Buffer.from(config.key, 'hex'), bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
  },
};
// Explicit synthetic authentication mapping, not pairing-complete or permissive authorization.
const authority = {
  identity: Buffer.from(config.receiver, 'hex'), serviceOrigin: config.origin,
  assertActiveEpoch(device, epoch) { assert.equal(device.toString('hex'), config.device); assert.equal(epoch, 1n); },
  authorize(input) {
    this.assertActiveEpoch(input.device, input.epoch); assert(input.owner.equals(input.device));
    assert([1, 2, 4].includes(input.permission));
    assert.equal(input.credential.length, 32); assert(timingSafeEqual(input.credential, Buffer.from(config.credential, 'hex')));
    assert.deepEqual(input.destination, { kind: 'intake', intake: schemaUuid(config.intake) });
    return { intakes: [schemaUuid(config.intake)], projects: [] };
  },
};
const directory = join(out, 'receiver'); await mkdir(directory, { recursive: true, mode: 0o700 });
jobs = new Jobs(join(directory, 'jobs.sqlite'));
ingest = await SealedIngest.open({ directory, jobs, authority, wrappingStore: wrapping, assertDestinationAccess: m => {
  assert.equal(m.fields.destination.kind, 'standalone'); assert.equal(m.fields.destination.intake, config.intake);
} });
await json(join(docs, 'binding.json'), { receiver: config.receiver, device: config.device, intake: config.intake, origin: config.origin, port });
await json(join(out, 'startup-receipts.json'), jobs.all().map(j => ({ id: j.id, receipt: j.receipt })));
await json(join(out, 'listener-ready.json'), { port });
async function hashFile(path) {
  let bytes = 0; const hash = createHash('sha256');
  for await (const b of createReadStream(path)) { hash.update(b); bytes += b.length; }
  return { bytes, sha256: hash.digest('hex') };
}
// No data/key crosses JS in the app: this is private test-controller provisioning only.
let quitting = false;
process.on('SIGTERM', () => { quitting = true; });
while (!quitting) {
  for (const name of await readdir(docs)) {
    const match = /^control-(setup|status|revoke)-[0-9A-F-]{36}\.request$/.exec(name);
    if (!match || await exists(join(docs, name + '.reply'))) continue;
    const body = await readFile(join(docs, name));
    try {
      let reply;
      if (match[1] === 'setup') {
        Manifest.decode(body); // G3 repeats validation; adapter never rewrites the manifest.
        reply = await ingest.setup(body, Buffer.from(config.credential, 'hex'));
      } else {
        assert.equal(body.length, 120); assert.equal(body.subarray(0, 8).toString(), 'FTQUERY1');
        reply = await ingest.status(jobIdSchema.parse(schemaUuid(body.subarray(8, 24).toString('hex'))), body,
          Buffer.from(config.credential, 'hex'), match[1] === 'revoke');
      }
      await writeFile(join(docs, name + '.reply'), reply, { mode: 0o600 });
    } catch (error) { await json(join(out, 'control-error.json'), { message: String(error) }); throw error; }
  }
  await sleep(50);
}
server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
await Promise.allSettled(active); jobs.close();

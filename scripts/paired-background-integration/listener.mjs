// TEST-ONLY local operator/fault controller. All HTTP parsing/auth/storage are production.
import assert from 'node:assert/strict';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Jobs } from '../../apps/server/src/jobs.ts';
import { PairingAuthority } from '../../apps/server/src/pairing.ts';
import { DesktopKeyStore } from '../../apps/server/src/desktop-key-store.ts';
import { PairedService } from '../../apps/server/src/paired-service.ts';
import { originalPath } from '../../apps/server/src/originals.ts';

const [out, docs] = process.argv.slice(2); assert(out && docs);
const exists = p => access(p).then(() => true, () => false);
const json = (p, value) => writeFile(p, JSON.stringify(value), { mode: 0o600 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const config = JSON.parse(await readFile(join(out, 'receiver-config.json'), 'utf8'));
const keyStore = DesktopKeyStore.load({ helper: join(out, 'key-helper'), namespace: config.namespace, allowTestKeychain: true });
const directory = join(out, 'receiver'); await mkdir(directory, { recursive: true, mode: 0o700 });
const tls = { key: await readFile(join(out, 'leaf.key')), cert: await readFile(join(out, 'leaf.pem')), ca: await readFile(join(out, 'root.der')) };
const opened = PairingAuthority.open({ path: join(directory, 'pairing.sqlite'), keyStore, origin: config.origin,
  ca: tls.ca, pin: createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({ format: 'der', type: 'spki' })).digest() });
const jobs = new Jobs(join(directory, 'jobs.sqlite'));
const state = { groups: 0, bodyBytes: 0, authHeaders: 0, cookieHeaders: 0, wireMatches: [], errors: 0,
  fakeOutcomeSent: false, lostFinalResponse: false, rejectedRequests: [], wholeHashMatched: false, transientFinalizationFailures: 0, localApprovals: 0,
  reusableCredentialInBody: false, generationMasterInBody: false };
let enrolledCredential;
const actualEnroll = opened.authority.enroll.bind(opened.authority);
opened.authority.enroll = bytes => { const reply = actualEnroll(bytes); enrolledCredential = Buffer.from(reply.subarray(8, 40)); return reply; };
const { service, local } = await PairedService.open({ ...opened, local: opened.local, jobs, keyStore, directory,
  origin: config.origin, listenHost: '127.0.0.1', tls, allowedIntakes: new Set([config.intake]),
  bodyTimeoutMs: 240000, supervisionMs: 200,
  boundary(point) {
    // Actual storage-pipeline error ONCE. The receiver supervisor, not a packet retry,
    // must resume the persisted verifying job while the phone remains stopped.
    if (point === 'original-sync' && !state.transientFinalizationFailures && !config.restarted && !config.validOutcomes) {
      state.transientFinalizationFailures++; throw new Error('Test-only transient finalization failure');
    }
  } });
let generationMaster;
const actualSetup = service.ingest.setup.bind(service.ingest);
service.ingest.setup = async (...args) => { const reply = await actualSetup(...args); generationMaster = Buffer.from(reply.subarray(40, 72)); return reply; };
// Explicit slow-control fault gate only. Authenticate and compute the REAL G3
// response first, then keep its TLS response socket open until the local runner releases it.
const actualStatus = service.ingest.status.bind(service.ingest);
service.ingest.status = async (...args) => {
  const reply = await actualStatus(...args);
  if (config.holdControl && !await exists(join(out, 'control-release'))) {
    const pending = { started: Date.now() / 1000, revoke: args[3] === true };
    await json(join(out, 'control-socket-pending.json'), pending);
    await json(join(docs, 'control-socket-pending.json'), pending);
    while (!await exists(join(out, 'control-release'))) await sleep(20);
    await json(join(out, 'control-released.json'), { ...pending, released: Date.now() / 1000 });
    await unlink(join(docs, 'control-socket-pending.json')).catch(() => {});
  }
  return reply;
};
const actualIngest = service.ingest.ingest.bind(service.ingest);
let serial = Promise.resolve();
service.ingest.ingest = req => {
  req.pause();
  const operation = serial.then(async () => {
    while (!await exists(join(out, 'release'))) await sleep(50);
    if (config.twoWakes && state.groups >= 1) {
      while (!await exists(join(out, 'second-release'))) await sleep(50);
    }
    const hash = createHash('sha256'); let header = Buffer.alloc(0), count = 0;
    let tail = Buffer.alloc(0);
    req.on('data', b => {
      hash.update(b); count += b.length;
      if (header.length < 128) header = Buffer.concat([header, b]).subarray(0, 128);
      const scan = Buffer.concat([tail, b]);
      if (enrolledCredential && (scan.includes(enrolledCredential) || scan.includes(Buffer.from(enrolledCredential.toString('hex'))))) state.reusableCredentialInBody = true;
      if (generationMaster && (scan.includes(generationMaster) || scan.includes(Buffer.from(generationMaster.toString('hex'))))) state.generationMasterInBody = true;
      tail = scan.subarray(Math.max(0, scan.length - 63));
    });
    state.authHeaders += req.headers.authorization ? 1 : 0; state.cookieHeaders += req.headers.cookie ? 1 : 0;
    try {
      const reply = await actualIngest(req);
      const wire = hash.digest('hex'), group = header.readUInt32BE(104);
      const saved = await hashFile(join(docs, `runtime/group-${group}.sealed`));
      state.wireMatches.push(saved.sha256 === wire); state.groups++; state.bodyBytes += count;
      if (jobs.all().some(j => j.receipt) && !await exists(join(out, 'respond-final'))) {
        state.lostFinalResponse = true; req.socket.destroy(); return reply;
      }
      if (!config.restarted && !config.validOutcomes) {
        state.fakeOutcomeSent = true; const forged = Buffer.from(reply); forged[203] ^= 1; return forged;
      }
      return reply;
    } catch (e) {
      if (state.transientFinalizationFailures && jobs.all().some(j => j.sealed?.state === 'verifying')) {
        const group = header.readUInt32BE(104), wire = hash.digest('hex');
        state.wireMatches.push((await hashFile(join(docs, `runtime/group-${group}.sealed`))).sha256 === wire);
        state.groups++; state.bodyBytes += count; state.lostFinalResponse = true; req.socket.destroy();
      } else { state.errors++; state.rejectedRequests.push({ code: e?.code, message: String(e) }); }
      throw e;
    } finally { await json(join(out, 'listener-state.json'), state); }
  });
  serial = operation.catch(() => {}); return operation;
};
await service.listen();
await json(join(docs, 'binding.json'), { intake: config.intake.replaceAll('-', '') });
await json(join(out, 'startup-receipts.json'), jobs.all().map(j => ({ id: j.id, receipt: j.receipt })));
if (!config.restarted) {
  // Independent trusted local display channel, never fetched from the TLS listener.
  await writeFile(join(docs, 'independent-local.qr'), local.createOffer({ mask: 7, scopes: { intakes: [config.intake], projects: [] } }), { mode: 0o600 });
}
await json(join(out, 'listener-ready.json'), { port: config.port });
async function hashFile(path) {
  let bytes = 0; const hash = createHash('sha256');
  for await (const b of createReadStream(path)) { hash.update(b); bytes += b.length; }
  return { bytes, sha256: hash.digest('hex') };
}
let quitting = false;
process.on('SIGTERM', () => { quitting = true; });
while (!quitting) {
  const pending = local.pendingEnrollments();
  if (pending.length) {
    await json(join(out, 'awaiting-local-approval.json'), { count: pending.length });
    // Clearly test-only independent operator action. No request approves itself.
    if (await exists(join(out, 'operator-approve'))) {
      for (const p of pending) local.approveEnrollment(p.id, { intakes: [config.intake], projects: [] });
      state.localApprovals += pending.length;
    }
  }
  const job = jobs.all()[0];
  if (job?.receipt) {
    const independent = await hashFile(originalPath(directory, job));
    state.wholeHashMatched = independent.bytes === job.receipt.bytes && independent.sha256 === job.receipt.sha256;
    await json(join(out, 'actual-receipt.json'), { receipt: job.receipt, independent, jobCount: jobs.all().length });
    await json(join(out, 'listener-state.json'), state);
  }
  await sleep(50);
}
await service.close();
await json(join(out, 'drained.json'), { closedAfterStorageDrain: true });

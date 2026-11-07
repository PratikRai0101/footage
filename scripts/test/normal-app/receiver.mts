// Acceptance fixture for the UNMODIFIED ordinary app. Only generated identities,
// exact tracked test Keychain items and explicit local test-controller approval.
import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { Server as HttpsServer } from 'node:https';
import { join, resolve } from 'node:path';
import { DesktopKeyStore } from '../../../apps/server/src/desktop-key-store.js';
import { PairingAuthority } from '../../../apps/server/src/pairing.js';
import { PairedService } from '../../../apps/server/src/paired-service.js';
import { Jobs } from '../../../apps/server/src/jobs.js';
import { sha256 } from '../../../apps/server/src/pairing-wire.js';

if (process.env.FOOTAGE_TEST_KEYCHAIN !== '1') throw new Error('Explicit own-item Keychain test opt-in required.');
const out = resolve('artifacts/app-finish/receiver'); await mkdir(out, { recursive: true, mode: 0o700 });
if (existsSync(join(out, 'cleanup.json')) || existsSync(join(out, 'state'))) throw new Error('Retain existing exact-item cleanup metadata; choose a clean acceptance artifact directory before another run.');
const run = (...args: string[]) => execFileSync('openssl', args, { cwd: out, stdio: 'pipe' });
run('req', '-sha256', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-subj', '/CN=Owned app acceptance CA', '-keyout', 'root.key', '-out', 'root.pem', '-days', '1', '-addext', 'basicConstraints=critical,CA:TRUE');
run('req', '-sha256', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-subj', '/CN=localhost', '-keyout', 'leaf.key', '-out', 'leaf.csr');
await writeFile(join(out, 'leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n', { mode: 0o600 });
run('x509', '-sha256', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '1', '-extfile', 'leaf.ext', '-out', 'leaf.pem');
run('x509', '-in', 'root.pem', '-outform', 'DER', '-out', 'root.der');
const reserve = createServer(); await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r));
const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('Missing own port.');
const port = address.port; await new Promise<void>(r => reserve.close(() => r()));
const origin = `https://localhost:${port}`, namespace = `test.${randomUUID()}`, intake = randomUUID();
const helper = resolve('artifacts/desktop-key-store/helper');
await writeFile(join(out, 'cleanup.json'), JSON.stringify({ namespace, helper }), { mode: 0o600 });
const keyStore = DesktopKeyStore.initialize({ helper, namespace, allowTestKeychain: true });
let opened: Awaited<ReturnType<typeof PairedService.open>> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let closing = false;
async function close() {
  if (closing) return; closing = true; clearInterval(timer);
  try { await opened?.service.close(); }
  finally { keyStore.deleteTestItem(); await writeFile(join(out, 'cleanup-complete.json'), JSON.stringify({ exactItemDeleted: true })); await rm(join(out, 'cleanup.json')); }
}
process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
try {
  const tls = { key: await readFile(join(out, 'leaf.key')), cert: await readFile(join(out, 'leaf.pem')), ca: await readFile(join(out, 'root.der')) };
  const state = join(out, 'state'); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
  const authority = PairingAuthority.open({ path: join(state, 'pairing.sqlite'), keyStore, origin, ca: tls.ca, pin: sha256(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })) });
  const jobs = new Jobs(join(state, 'jobs.sqlite'));
  opened = await PairedService.open({ ...authority, jobs, keyStore, directory: state, origin, listenHost: '127.0.0.1', tls, allowedIntakes: new Set([intake]) });
  const observed = Reflect.get(opened.service, 'server');
  if (observed instanceof HttpsServer) {
    observed.on('request', request => { process.stdout.write(`Observed ${request.method} ${request.url?.split('?')[0]}\n`); });
    observed.on('tlsClientError', () => { process.stdout.write('Observed rejected TLS handshake\n'); });
  }
  await opened.service.listen();
  await writeFile(join(out, 'ready.json'), JSON.stringify({ origin, state }), { mode: 0o600 });
  let busy = false;
  timer = setInterval(() => {
    if (busy || !opened) return; busy = true;
    void (async () => {
      if (existsSync(join(out, 'make-offer'))) {
        const offer = opened!.local.createOffer({ mask: 31, scopes: { intakes: [intake], projects: [] } });
        await writeFile(join(out, 'Connect.footage'), JSON.stringify({ format: 'footage-connection-v1', offer: offer.toString('base64'), destinations: [{ id: intake, title: 'Acceptance inbox' }] }), { mode: 0o600 });
        await rm(join(out, 'make-offer'));
      }
      for (const request of opened!.local.pendingEnrollments()) opened!.local.approveEnrollment(request.id, { intakes: [intake], projects: [] });
      await writeFile(join(out, 'outcomes.json'), JSON.stringify(jobs.all().map(j => ({ id: j.id, status: j.status, bytes: j.bytes, sha256: j.sha256, receipt: j.receipt, contentReference: j.contentReference }))), { mode: 0o600 });
    })().catch(() => {}).finally(() => { busy = false; });
  }, 150);
} catch (error) { await close(); throw error; }

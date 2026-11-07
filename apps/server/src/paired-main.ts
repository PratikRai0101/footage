import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DesktopKeyStore } from './desktop-key-store.js';
import { Jobs } from './jobs.js';
import { PairingAuthority } from './pairing.js';
import { sha256, origin as canonicalOrigin } from './pairing-wire.js';
import { PairedService } from './paired-service.js';
import { privateDirectory, syncDirectory } from './originals.js';
import { Manifest } from './sealed-protocol.js';
import { schemaUuid } from './sealed-ingest.js';
import { T3Client, T3Delivery, targetSchema } from './t3-delivery.js';

const args = process.argv.slice(2);
function option(name: string): string | undefined { const i = args.indexOf(name); if (i < 0) return undefined; const value = args[i + 1]; if (!value || value.startsWith('--')) throw new Error(`Missing ${name}.`); return value; }
const directory = resolve(option('--dir') ?? 'apps/server/data/paired');
const host = (option('--host') ?? 'localhost').toLowerCase();
const port = z.coerce.number().int().min(1).max(65535).parse(option('--port') ?? '1090');
const origin = canonicalOrigin(`https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`);
async function savePrivate(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.pending`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path); await syncDirectory(dirname(path));
}
const tlsDirectory = join(directory, 'tls');
await privateDirectory(directory); await privateDirectory(tlsDirectory);
const helper = join(directory, 'key-store');
if (!existsSync(helper)) {
  execFileSync('xcrun', ['swiftc', '-swift-version', '6', '-warnings-as-errors', join(dirname(fileURLToPath(import.meta.url)), 'desktop-key-store-helper.swift'), '-o', helper], { stdio: 'pipe' });
  await chmod(helper, 0o700);
}
const keyStore = args.includes('--init') ? DesktopKeyStore.initialize({ helper, namespace: 'production' }) : DesktopKeyStore.load({ helper, namespace: 'production' });
if (!existsSync(join(tlsDirectory, 'leaf.pem'))) {
  if (!args.includes('--init')) throw new Error('Use --init once to provision this computer explicitly.');
  const run = (...parameters: string[]) => execFileSync('openssl', parameters, { cwd: tlsDirectory, stdio: 'pipe' });
  run('req', '-sha256', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-subj', '/CN=Footage private receiver', '-keyout', 'root.key', '-out', 'root.pem', '-days', '365', '-addext', 'basicConstraints=critical,CA:TRUE');
  run('req', '-sha256', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-subj', '/CN=Footage receiver', '-keyout', 'leaf.key', '-out', 'leaf.csr');
  const plainHost = host.replace(/^\[|\]$/g, '');
  const { isIP } = await import('node:net');
  await writeFile(join(tlsDirectory, 'leaf.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${isIP(plainHost) ? 'IP' : 'DNS'}:${plainHost}\n`, { mode: 0o600 });
  run('x509', '-sha256', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '365', '-extfile', 'leaf.ext', '-out', 'leaf.pem');
  run('x509', '-in', 'root.pem', '-outform', 'DER', '-out', 'root.der');
  await syncDirectory(tlsDirectory);
}
const tls = { key: await readFile(join(tlsDirectory, 'leaf.key')), cert: await readFile(join(tlsDirectory, 'leaf.pem')), ca: await readFile(join(tlsDirectory, 'root.der')) };
const entrySchema = z.object({ id: z.uuid(), title: z.string().min(1).max(120), target: targetSchema.nullable() }).strict();
const catalogPath = join(directory, 'destinations.json');
const catalog = existsSync(catalogPath) ? z.array(entrySchema).max(16).parse(JSON.parse(await readFile(catalogPath, 'utf8'))) : [];
let delivery: T3Delivery | null = null;
if (option('--mcp')) {
  const client = await T3Client.fromFile(option('--mcp') ?? '', option('--token-file') ?? '');
  const environment = option('--environment'), project = option('--project'), thread = option('--thread');
  if (!environment || !project || !thread) throw new Error('T3 requires explicit --environment, --project and --thread.');
  const previous = catalog.find(entry => entry.target?.environment === environment && entry.target.project === project && entry.target.thread === thread);
  const target = await client.target(environment, project, thread, previous?.id ?? randomUUID());
  if (previous && previous.target?.workspace !== target.workspace) throw new Error('Thread workspace changed. Use a new explicit destination configuration; existing uploads will not be redirected.');
  if (!previous) catalog.push({ id: target.intake, title: target.title, target });
  delivery = new T3Delivery(directory, client);
} else if (catalog.length === 0) catalog.push({ id: randomUUID(), title: 'Footage inbox', target: null });
await savePrivate(catalogPath, catalog);
const authority = PairingAuthority.open({ path: join(directory, 'pairing.sqlite'), keyStore, origin, ca: tls.ca, pin: sha256(new X509Certificate(tls.cert).publicKey.export({ format: 'der', type: 'spki' })) });
const jobs = new Jobs(join(directory, 'jobs.sqlite'));
const opened = await PairedService.open({ ...authority, jobs, keyStore, directory, origin, listenHost: option('--bind') ?? '0.0.0.0', tls, bodyTimeoutMs: 300000, allowedIntakes: new Set(catalog.map(entry => entry.id)) });
await opened.service.listen();
const terminal = createInterface({ input: process.stdin, output: process.stdout });
process.stdout.write(`Footage receiver ready at ${origin}.\nCommands: pair, approve <request>, jobs, deliver <job>, send <job>, quit\nSending to T3 starts or queues agent work. Uploading alone does not.\n`);
const shown = new Set<string>();
const monitor = setInterval(() => {
  for (const request of opened.local.pendingEnrollments()) if (!shown.has(request.id)) {
    shown.add(request.id);
    process.stdout.write(`Connection request ${request.id}\nDevice fingerprint: ${request.deviceFingerprint.toString('hex')}\nType approve ${request.id} only if you just connected your phone.\n`);
  }
}, 250);
let shuttingDown = false;
async function close() { if (shuttingDown) return; shuttingDown = true; clearInterval(monitor); terminal.close(); await opened.service.close(); delivery?.close(); }
process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
let commandTail = Promise.resolve();
terminal.on('line', line => {
  commandTail = commandTail.then(async () => {
    const [command, value] = line.trim().split(/\s+/);
    if (command === 'quit') { await close(); return; }
    if (command === 'pair') {
      const scopes = { intakes: catalog.map(entry => entry.id), projects: [] };
      const offer = opened.local.createOffer({ mask: 31, scopes });
      const path = join(directory, 'Connect.footage');
      await savePrivate(path, { format: 'footage-connection-v1', offer: offer.toString('base64'), destinations: catalog.map(({ id, title }) => ({ id, title })) });
      process.stdout.write(`Connection file: ${path}\nExpires in two minutes. Transfer it directly to your phone, then open it from Footage Settings. Do not post it publicly.\n`);
    } else if (command === 'approve' && value) {
      opened.local.approveEnrollment(value, { intakes: catalog.map(entry => entry.id), projects: [] }); process.stdout.write('Connection approved.\n');
    } else if (command === 'jobs') {
      for (const job of jobs.all()) process.stdout.write(`${job.id}  ${job.status}  ${job.bytes} bytes\n`);
    } else if ((command === 'deliver' || command === 'send') && value) {
      if (!delivery) throw new Error('Start the receiver with an explicitly configured T3 MCP destination first.');
      const job = jobs.all().find(item => item.id === value);
      if (!job?.sealed) throw new Error('Choose a received paired upload.');
      const manifest = Manifest.decode(Buffer.from(job.sealed.manifest, 'base64'));
      const destination = manifest.fields.destination;
      const target = destination.kind === 'standalone' ? catalog.find(entry => entry.id === schemaUuid(destination.intake))?.target : null;
      if (!target) throw new Error('This upload has no T3 target. Its original destination cannot be changed.');
      if (command === 'send') { await delivery.dispatch(job, target); process.stdout.write('Reference sent to the chosen thread; agent work may start.\n'); }
      else { await delivery.materialize(job, target); process.stdout.write('Original verified in the chosen thread workspace. No agent was started.\n'); }
    } else if (command) process.stdout.write('Use pair, approve <request>, jobs, deliver <job>, send <job>, or quit.\n');
  }).catch(() => { process.stderr.write('Command could not finish. No destination was changed. For a T3 send, retry the same job to reconcile an uncertain response.\n'); });
});
terminal.on('close', () => { void close(); });

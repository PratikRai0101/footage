import { execFileSync } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { DesktopKeyStore } from '../../../apps/server/src/desktop-key-store.js';
import { Jobs } from '../../../apps/server/src/jobs.js';
import { PairingAuthority } from '../../../apps/server/src/pairing.js';
import { sha256 } from '../../../apps/server/src/pairing-wire.js';
import { PairedService } from '../../../apps/server/src/paired-service.js';
import { Manifest } from '../../../apps/server/src/sealed-protocol.js';
import { schemaUuid } from '../../../apps/server/src/sealed-ingest.js';
import { T3Client, T3Delivery } from '../../../apps/server/src/t3-delivery.js';

if (process.env.FOOTAGE_TEST_KEYCHAIN !== '1') throw new Error('Explicit fresh-item Keychain test opt-in required.');
const out = resolve(process.argv[2] ?? 'artifacts/mobile-parity/session'); await mkdir(out, { recursive: true, mode: 0o700 });
if (existsSync(join(out, 'cleanup.json')) || existsSync(join(out, 'state'))) throw new Error('Use fresh owned fixture storage; do not overwrite cleanup metadata.');
const run = (...args: string[]) => execFileSync('openssl', args, { cwd: out, stdio: 'pipe' });
run('req', '-sha256', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-subj', '/CN=Owned parity fixture CA', '-keyout', 'root.key', '-out', 'root.pem', '-days', '1', '-addext', 'basicConstraints=critical,CA:TRUE');
run('req', '-sha256', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-nodes', '-subj', '/CN=localhost', '-keyout', 'leaf.key', '-out', 'leaf.csr');
await writeFile(join(out, 'leaf.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n');
run('x509', '-sha256', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '1', '-extfile', 'leaf.ext', '-out', 'leaf.pem');
run('x509', '-in', 'root.pem', '-outform', 'DER', '-out', 'root.der');
const token = randomUUID(), messages = new Map<string, { id: string; thread: string; message: string }>(); let requests = 0;
await mkdir(join(out, 'workspaces/a'), { recursive: true, mode: 0o700 }); await mkdir(join(out, 'workspaces/b'), { mode: 0o700 });
const rpc = z.object({ id: z.string().optional(), method: z.string(), params: z.unknown() });
const tool = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) });
const mcp = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    const chunks: Buffer[] = []; let count = 0; for await (const part of req) { const bytes = Buffer.from(part); count += bytes.length; if (count > 16384) throw new Error('Fixture bound.'); chunks.push(bytes); }
    const input = rpc.parse(JSON.parse(Buffer.concat(chunks).toString()));
    if (!input.id) { res.writeHead(202).end(); return; }
    let result: unknown = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'owned-local-fixture', version: '1' } };
    if (input.method === 'tools/call') {
      const call = tool.parse(input.params); let value: unknown;
      if (call.name === 't3_environment_read') value = { environmentId: 'fixture-environment' };
      else if (call.name === 't3_project_read') value = { id: 'fixture-project', workspaceRoot: join(out, 'workspaces') };
      else if (call.name === 't3_thread_read') {
        const { threadId } = z.object({ threadId: z.enum(['fixture-thread-a', 'fixture-thread-b']) }).parse(call.arguments);
        value = { thread: { threadId, projectId: 'fixture-project', title: threadId.endsWith('a') ? 'Editing room A' : 'Editing room B', archived: false, worktreePath: join(out, 'workspaces', threadId.endsWith('a') ? 'a' : 'b') } };
      } else if (call.name === 't3_thread_send') {
        const send = z.object({ threadId: z.string(), clientRequestId: z.string(), message: z.string(), mode: z.literal('queue') }).parse(call.arguments); requests++;
        if (!messages.has(send.clientRequestId)) messages.set(send.clientRequestId, { id: randomUUID(), thread: send.threadId, message: send.message });
        await writeFile(join(out, 'mcp-messages.json'), JSON.stringify({ requests, messages: [...messages.values()] }), { mode: 0o600 });
        if (existsSync(join(out, 'lose-next-send'))) { await rm(join(out, 'lose-next-send')); req.socket.destroy(); return; }
        value = { threadId: send.threadId, messageId: messages.get(send.clientRequestId)?.id };
      } else throw new Error('Unexpected owned fixture operation.');
      result = { structuredContent: value, content: [] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  } catch { if (!res.destroyed) res.writeHead(400).end(); }
});
await new Promise<void>(r => mcp.listen(0, '127.0.0.1', r)); const mcpAddress = mcp.address(); if (!mcpAddress || typeof mcpAddress === 'string') throw new Error('Own MCP address unavailable.');
const credential = join(out, 'fixture-mcp-credential'); await writeFile(credential, token, { mode: 0o600 });
const client = await T3Client.fromFile(`http://127.0.0.1:${mcpAddress.port}/mcp`, credential);
const reserve = createServer(); await new Promise<void>(r => reserve.listen(0, '127.0.0.1', r)); const addr = reserve.address(); if (!addr || typeof addr === 'string') throw new Error('Own receiver address unavailable.'); await new Promise<void>(r => reserve.close(() => r()));
const origin = `https://localhost:${addr.port}`, state = join(out, 'state'); await mkdir(state, { mode: 0o700 }); await chmod(state, 0o700);
const helper = resolve('artifacts/desktop-key-store/helper'), namespace = `test.${randomUUID()}`;
await writeFile(join(out, 'cleanup.json'), JSON.stringify({ namespace, helper }), { mode: 0o600 });
const keyStore = DesktopKeyStore.initialize({ helper, namespace, allowTestKeychain: true });
let opened: Awaited<ReturnType<typeof PairedService.open>> | undefined, timer: ReturnType<typeof setInterval> | undefined, delivery: T3Delivery | undefined;
let closing = false;
async function close() {
  if (closing) return; closing = true; clearInterval(timer);
  try { await opened?.service.close(); delivery?.close(); await new Promise<void>(r => mcp.close(() => r())); }
  finally { keyStore.deleteTestItem(); await writeFile(join(out, 'cleanup-complete.json'), JSON.stringify({ exactItemDeleted: true })); await rm(join(out, 'cleanup.json')); }
}
process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
try {
  const targets = await Promise.all(['fixture-thread-a', 'fixture-thread-b'].map(thread => client.target('fixture-environment', 'fixture-project', thread, randomUUID())));
  const tls = { key: await readFile(join(out, 'leaf.key')), cert: await readFile(join(out, 'leaf.pem')), ca: await readFile(join(out, 'root.der')) };
  const authority = PairingAuthority.open({ path: join(state, 'pairing.sqlite'), keyStore, origin, ca: tls.ca, pin: sha256(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })) });
  const jobs = new Jobs(join(state, 'jobs.sqlite')); delivery = new T3Delivery(state, client); const outbox = delivery;
  opened = await PairedService.open({ ...authority, jobs, keyStore, directory: state, origin, listenHost: '127.0.0.1', tls, bodyTimeoutMs: 300000, allowedIntakes: new Set(targets.map(t => t.intake)), phone: {
    destinations: () => targets.map(t => ({ id: t.intake, title: t.title, kind: 'thread' })),
    handoff: async (job, operation) => {
      if (!job.sealed) throw new Error('Paired job required.'); const destination = Manifest.decode(Buffer.from(job.sealed.manifest, 'base64')).fields.destination;
      const target = destination.kind === 'standalone' ? targets.find(t => t.intake === schemaUuid(destination.intake)) : undefined;
      if (!target) throw new Error('Unknown frozen intake.');
      if (operation === 'deliver') await outbox.materialize(job, target);
      if (operation === 'send') await outbox.dispatch(job, target);
      return outbox.status(job, target);
    },
  } });
  const server = Reflect.get(opened.service, 'server');
  if (server && 'on' in server && typeof server.on === 'function') server.on('request', (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    process.stdout.write(`Observed ${req.method} ${req.url?.split('?')[0]}\n`);
    if (req.url === '/sealed/v1/setup' && existsSync(join(out, 'pause-after-setup'))) res.once('finish', () => { process.kill(process.pid, 'SIGSTOP'); });
  });
  await opened.service.listen(); const scopes = { intakes: targets.map(t => t.intake), projects: [] };
  function offer() { return { format: 'footage-connection-v1', offer: opened?.local.createOffer({ mask: 31, scopes }).toString('base64'), destinations: targets.map(t => ({ id: t.intake, title: t.title })) }; }
  await writeFile(join(out, 'ready.json'), JSON.stringify({ origin, state, port: addr.port }), { mode: 0o600 });
  let busy = false;
  timer = setInterval(() => {
    const current = opened; if (busy || !current) return; busy = true;
    void (async () => {
      if (existsSync(join(out, 'make-offer'))) { await writeFile(join(out, 'Connect.footage'), JSON.stringify(offer()), { mode: 0o600 }); await rm(join(out, 'make-offer')); }
      for (const pending of current.local.pendingEnrollments()) current.local.approveEnrollment(pending.id, scopes);
      await writeFile(join(out, 'outcomes.json'), JSON.stringify(jobs.all().map(j => ({ id: j.id, name: j.name, status: j.status, bytes: j.bytes, sha256: j.sha256, receipt: j.receipt, contentReference: j.contentReference }))), { mode: 0o600 });
    })().catch(() => {}).finally(() => { busy = false; });
  }, 150);
} catch (error) { await close(); throw error; }

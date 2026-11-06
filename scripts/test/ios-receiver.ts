// Owned loopback-only receiver and fault proxy for Simulator verification. No authority is logged.
import { createServer, request } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createReceiver } from '../../apps/server/src/server';

async function main() {
const out = resolve(process.argv[2] ?? 'artifacts/ios-foreground');
mkdirSync(out, { recursive: true });
const receiver = await createReceiver(resolve(out, 'receiver'));
const upstream = await receiver.listen();
const events: object[] = [];
let sinkBytes = 0;
let sinkRequests = 0;
let patches = 0;
let lastMode = '';
function record(value: object) {
  events.push(value);
  writeFileSync(resolve(out, 'transport.json'), JSON.stringify({ sinkBytes, sinkRequests, events }, null, 2));
}
const sink = createServer((req, res) => {
  sinkRequests++;
  req.on('data', (chunk: Buffer) => { sinkBytes += chunk.length; });
  req.on('end', () => { record({ event: 'sink-request', method: req.method }); res.writeHead(204); res.end(); });
});
await new Promise<void>(r => sink.listen(0, '127.0.0.1', r));
const sinkAddress = sink.address();
if (!sinkAddress || typeof sinkAddress === 'string') throw new Error('Missing sink port');
const sinkOrigin = `http://127.0.0.1:${sinkAddress.port}`;
const proxy = createServer((req, res) => {
  let mode = 'pass';
  try { mode = readFileSync(resolve(out, 'mode'), 'utf8').trim(); } catch {}
  if (mode !== lastMode) { patches = 0; lastMode = mode; }
  if (mode === 'offline') { req.resume(); req.on('end', () => res.destroy()); return; }
  if ((mode === 'redirect-patch' && req.method === 'PATCH') || (mode === 'redirect-metadata' && req.url === '/jobs')) {
    req.resume();
    req.on('end', () => { record({ event: 'redirect-rejected-or-pending', method: req.method }); res.writeHead(307, { location: `${sinkOrigin}/sink` }); res.end(); });
    return;
  }
  if (mode === 'oversized' && req.url === '/jobs') {
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-length': 70000 }); res.end('x'.repeat(70000)); }); return;
  }
  const isPatch = req.method === 'PATCH';
  const patch = isPatch ? ++patches : 0;
  if (isPatch) record({ event: 'patch-start', offset: req.headers['upload-offset'] });
  const remote = request(upstream + req.url, { method: req.method, headers: { ...req.headers, host: new URL(upstream).host } }, incoming => {
    if (isPatch) record({ event: 'patch-accepted', offset: incoming.headers['upload-offset'] });
    if (mode === 'lose-response' && isPatch && patch % 2 === 0) {
      incoming.resume(); incoming.on('end', () => { record({ event: 'response-lost' }); res.destroy(); }); return;
    }
    if (mode === 'wrong-receipt' && req.url?.endsWith('/complete')) {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        const receipt: unknown = JSON.parse(Buffer.concat(chunks).toString());
        const payload = JSON.stringify({ ...Object(receipt), sha256: 'c'.repeat(64) });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }); res.end(payload);
      }); return;
    }
    // Even successful responses must not make a foreign Location authoritative.
    res.writeHead(incoming.statusCode ?? 500, { ...incoming.headers, location: `${sinkOrigin}/not-authoritative` });
    incoming.pipe(res);
  });
  remote.on('error', () => res.destroy());
  req.on('aborted', () => remote.destroy());
  if (mode === 'slow' && isPatch) {
    req.on('data', chunk => {
      req.pause(); remote.write(chunk);
      setTimeout(() => req.resume(), 80);
    });
    req.on('end', () => remote.end());
  } else { req.pipe(remote); }
});
await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
const address = proxy.address();
if (!address || typeof address === 'string') throw new Error('Missing proxy port');
writeFileSync(resolve(out, 'ports.json'), JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, sinkOrigin, upstream }));
record({ event: 'ready' });
console.log('Owned loopback receiver ready. No credentials or selected URIs logged.');
process.on('SIGTERM', () => { proxy.closeAllConnections(); sink.closeAllConnections(); proxy.close(); sink.close(); void receiver.close().then(() => process.exit(0)); });
}
void main();

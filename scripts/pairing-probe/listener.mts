// Synthetic harness only. Ephemeral memory wrapping key; NOT an OS backend.
import { createServer } from 'node:https';
import { createServer as createHTTP } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, createPublicKey, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { PairingAuthority, type PairingKeyStore } from '../../apps/server/src/pairing.js';
import { lp16, PairingReader, sha256 } from '../../apps/server/src/pairing-wire.js';

const dir = process.argv[2]; if (!dir) throw Error('Missing private output directory');
const wrapping = randomBytes(32);
const keyStore: PairingKeyStore = {
  wrap(plain, context) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', wrapping, iv); c.setAAD(Buffer.from(context)); return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]); },
  unwrap(bytes, context) { const c = createDecipheriv('aes-256-gcm', wrapping, bytes.subarray(0, 12)); c.setAAD(Buffer.from(context)); c.setAuthTag(bytes.subarray(-16)); return Buffer.concat([c.update(bytes.subarray(12, -16)), c.final()]); },
};
const roles = ['positive', 'lost', 'http-auth', 'forged-reply', 'oversized-reply', 'wrong-key', 'wrong-host', 'expired', 'future', 'expired-anchor', 'wrong-chain', 'missing-eku', 'missing-san', 'redirect-same', 'redirect-port', 'redirect-http', 'http'];
const state: Record<string, { receiverBytes: number; sinkBytes: number; enrollments: number; recoveries: number; localApprovals: number; cookieRequests: number; authorizationRequests: number }> = {};
const servers: Array<ReturnType<typeof createServer> | ReturnType<typeof createHTTP>> = [];
const authorities: PairingAuthority[] = [];
const status = () => writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
async function listen(server: ReturnType<typeof createServer> | ReturnType<typeof createHTTP>): Promise<number> {
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw Error('No listener'); return address.port;
}
for (const name of roles) {
  const counts = { receiverBytes: 0, sinkBytes: 0, enrollments: 0, recoveries: 0, localApprovals: 0, cookieRequests: 0, authorizationRequests: 0 }; state[name] = counts;
  const certName = ['wrong-host', 'expired', 'future', 'missing-eku', 'missing-san'].includes(name) ? name : 'leaf';
  const tls = { cert: readFileSync(join(dir, certName + '.pem')), key: readFileSync(join(dir, certName + '.key')), minVersion: 'TLSv1.2' as const };
  const observe = (req: import('node:http').IncomingMessage) => {
    if (req.headers.cookie) counts.cookieRequests++;
    if (req.headers.authorization) counts.authorizationRequests++;
    status();
  };
  const sink = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    observe(req);
    req.on('data', (b: Buffer) => { counts.sinkBytes += b.length; status(); }); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(); });
  };
  const httpPort = await listen(createHTTP(sink)); const otherPort = await listen(createServer(tls, sink));
  let opened: ReturnType<typeof PairingAuthority.open>;
  const server = createServer(tls, async (req, res) => {
    if (req.url === '/sink') { sink(req, res); return; }
    observe(req);
    res.setHeader('Set-Cookie', 'synthetic=not-a-real-secret; Path=/; Secure; HttpOnly');
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const b of req) { length += b.length; if (length > 16384) throw Error('Limit'); chunks.push(b); }
      const body = Buffer.concat(chunks); counts.receiverBytes += length; status();
      if (name === 'http-auth') { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Synthetic"' }); res.end(); return; }
      if (name.startsWith('redirect-')) {
        const location = name === 'redirect-same' ? '/sink' : name === 'redirect-port' ? `https://localhost:${otherPort}/sink` : `http://localhost:${httpPort}/sink`;
        res.writeHead(307, { Location: location }); res.end(); return;
      }
      let reply: Buffer;
      if (req.url === '/pair/v1/enroll') {
        opened.authority.inspectEnrollment(body);
        writeFileSync(join(dir, name + '.awaiting'), 'native-request-ready');
        // Local runner must explicitly approve this synthetic case. No network route
        // or URL can perform approval. Captured body never leaves this process.
        await new Promise<void>((resolve, reject) => {
          let attempts = 0;
          const timer = setInterval(() => {
            if (existsSync(join(dir, name + '.approve'))) { clearInterval(timer); resolve(); }
            else if (++attempts > 200) { clearInterval(timer); reject(Error('No local approval')); }
          }, 25);
        });
        opened.local.approve(body, { intakes: ['6b7e0334-148d-496c-8724-e8f01f03a9c1'], projects: [] }); counts.localApprovals++;
        reply = opened.authority.enroll(body); counts.enrollments++; status();
        if (name === 'lost') { res.destroy(); return; }
        if (name === 'forged-reply') { reply = Buffer.from(reply); reply[reply.length - 1] = (reply.at(-1) ?? 0) ^ 1; }
        if (name === 'oversized-reply') reply = Buffer.alloc(16385);
      } else if (req.url === '/pair/v1/challenge') reply = opened.authority.challenge(body);
      else if (req.url === '/pair/v1/recover') { reply = opened.authority.recover(body); counts.recoveries++; status(); }
      else throw Error('Route');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(reply);
    } catch { res.writeHead(403); res.end(); }
  });
  const port = await listen(server), serviceOrigin = `https://localhost:${port}`;
  opened = PairingAuthority.open({ path: join(dir, name + '.db'), origin: serviceOrigin, keyStore, ca: readFileSync(join(dir, name === 'wrong-chain' ? 'other-root.der' : name === 'expired-anchor' ? 'expired-anchor.der' : 'root.der')), pin: name === 'wrong-key' ? randomBytes(32) : sha256(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })) });
  authorities.push(opened.authority);
  let bytes = opened.local.createOffer({ mask: 3, scopes: { intakes: ['6b7e0334-148d-496c-8724-e8f01f03a9c1'], projects: [] } });
  if (name === 'http') {
    const r = new PairingReader(bytes, 'FTQR0001'); r.lp16(128); r.lp16(1024); r.take(32);
    const prefix = r.prefix(); r.lp16(512);
    bytes = Buffer.concat([prefix, lp16(`http://localhost:${httpPort}`), bytes.subarray(r.prefix().length)]);
  }
  writeFileSync(join(dir, name + '.qr'), bytes);
  if (name === 'positive') {
    const nonce = randomBytes(32), spki = createPublicKey(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey).export({ type: 'spki', format: 'der' });
    writeFileSync(join(dir, 'rotation.nonce'), nonce);
    writeFileSync(join(dir, 'rotation.bin'), opened.local.rotation({ spki, pin: randomBytes(32), ca: readFileSync(join(dir, 'root.der')), origin: 'https://rotated.invalid:443', epoch: 2n, expires: BigInt(Math.floor(Date.now() / 1000)) + 120n, nonce }));
  }
}
status(); writeFileSync(join(dir, 'ready.json'), JSON.stringify({ cases: roles }));
function stop() { for (const server of servers) server.close(); for (const a of authorities) a.close(); }
process.on('SIGTERM', () => { stop(); process.exit(0); });

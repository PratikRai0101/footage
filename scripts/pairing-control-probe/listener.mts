// Synthetic native-control test adapter ONLY. No production routes/auto-approval.
import { createServer } from 'node:https';
import { createServer as http } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, X509Certificate } from 'node:crypto';
import { PairingAuthority, type PairingKeyStore } from '../../apps/server/src/pairing.js';
import { PairingReader, sha256 } from '../../apps/server/src/pairing-wire.js';
import { Manifest } from '../../apps/server/src/sealed-protocol.js';
const argument = process.argv[2]; if (!argument) throw Error('Private directory required');
const directory: string = argument;
const key = randomBytes(32);
const keyStore: PairingKeyStore = {
  wrap(p, c) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(c)); return Buffer.concat([iv, cipher.update(p), cipher.final(), cipher.getAuthTag()]); },
  unwrap(b, c) { const cipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); cipher.setAAD(Buffer.from(c)); cipher.setAuthTag(b.subarray(-16)); return Buffer.concat([cipher.update(b.subarray(12, -16)), cipher.final()]); },
};
const roles = ['positive', 'future-pairing', 'rotation-not-applied', 'missing-confirmation', 'missing-installed', 'oversized-control', 'wrong-query', 'oversized-body', 'wrong-body', 'wrong-port', 'permission', 'scope', 'revoked', 'expired-pairing', 'unconfirmed', 'stale', 'changed-confirmation', 'http', 'wrong-key', 'wrong-host', 'wrong-chain', 'expired', 'future', 'redirect-same', 'redirect-port', 'redirect-http', 'oversized', 'http-auth'];
const state: Record<string, { enrolled: number; controls: number; authorized: number; sinkBytes: number; sinkCredentials: number; cookieRequests: number; sharedAuthRequests: number; paths: string[] }> = {};
const servers: Array<ReturnType<typeof createServer> | ReturnType<typeof http>> = [];
const authorities: PairingAuthority[] = [];
function status() { writeFileSync(join(directory, 'state.json'), JSON.stringify(state)); }
async function listen(server: ReturnType<typeof createServer> | ReturnType<typeof http>) { servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const a = server.address(); if (!a || typeof a === 'string') throw Error('Listener'); return a.port; }
const cert = (name = 'leaf') => ({ cert: readFileSync(join(directory, name + '.pem')), key: readFileSync(join(directory, name + '.key')), minVersion: 'TLSv1.2' as const });
for (const role of roles) {
  const c = { enrolled: 0, controls: 0, authorized: 0, sinkBytes: 0, sinkCredentials: 0, cookieRequests: 0, sharedAuthRequests: 0, paths: [] as string[] }; state[role] = c;
  const sink = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    if (req.headers.authorization) c.sinkCredentials++;
    req.on('data', (b: Buffer) => { c.sinkBytes += b.length; status(); }); req.on('end', () => { status(); res.end(); });
  };
  const hp = await listen(http(sink)), sp = await listen(createServer(cert(), sink));
  let opened: ReturnType<typeof PairingAuthority.open>, device: Buffer, epoch = 1n, m: Manifest | undefined;
  let clock = BigInt(Math.floor(Date.now() / 1000));
  const server = createServer(cert(), async (req, res) => {
    if (req.url === '/sink') { sink(req, res); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const b of req) { size += b.length; if (size > 65536) throw Error('Limit'); chunks.push(b); }
      const body = Buffer.concat(chunks);
      if (req.headers.cookie) c.cookieRequests++;
      if (req.headers.authorization?.startsWith('Basic ')) c.sharedAuthRequests++;
      let reply: Buffer;
      if (req.url === '/pair/v1/enroll') {
        device = opened.authority.inspectEnrollment(body).device;
        const approvalName = role + (c.enrolled === 0 ? '' : '.future');
        writeFileSync(join(directory, approvalName + '.awaiting'), 'ready');
        await new Promise<void>((resolve, reject) => {
          let count = 0; const timer = setInterval(() => { if (existsSync(join(directory, approvalName + '.approve'))) { clearInterval(timer); resolve(); } else if (++count > 400) { clearInterval(timer); reject(Error('Local approval')); } }, 25);
        });
        opened.local.approve(body, { intakes: ['6b7e0334-148d-496c-8724-e8f01f03a9c1'], projects: [] });
        if (role === 'expired-pairing') clock -= 7n * 86400n - 3n;
        reply = opened.authority.enroll(body); c.enrolled++;
        // Each control request uses a NEW ephemeral native session/handshake.
        if (['wrong-host', 'expired', 'future'].includes(role)) server.setSecureContext(cert(role));
        if (role === 'wrong-key') server.setSecureContext(cert('alternate'));
        if (role === 'wrong-chain') server.setSecureContext(cert('untrusted'));
        if (role === 'revoked') { opened.local.revoke(device); epoch = 2n; }
      } else if (req.url === '/pair/v1/challenge') reply = opened.authority.challenge(body);
      else if (req.url === '/pair/v1/recover') reply = opened.authority.recover(body);
      else {
        c.controls++; c.paths.push(req.url ?? ''); status();
        if (role.startsWith('redirect-')) {
          res.writeHead(307, { Location: role === 'redirect-same' ? '/sink' : role === 'redirect-port' ? `https://localhost:${sp}/sink` : `http://localhost:${hp}/sink` }); res.end(); return;
        }
        if (role === 'http-auth') { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Synthetic"' }); res.end(); return; }
        const auth = req.headers.authorization; if (!auth?.match(/^Bearer [0-9a-f]{64}$/)) throw Error('Credential');
        const credential = Buffer.from(auth.slice(7), 'hex');
        let requestDevice = device;
        const permission = req.url === '/sealed/v1/setup' ? 1 : req.url === '/sealed/v1/status' ? 2 : req.url === '/sealed/v1/revoke' ? 4 : req.url === '/sealed/v1/view' ? 8 : req.url === '/pair/v1/destinations' ? 16 : 0;
        if (permission === 1) m = Manifest.decode(body);
        if (permission === 16) {
          const r = new PairingReader(body, 'FTLIST01'); requestDevice = r.take(16); if (r.u64() !== epoch) throw Error('Binding'); r.take(32); r.end();
        } else if (permission !== 1) {
          const r = new PairingReader(body, 'FTQUERY1'); if (!m || r.take(16).toString('hex') !== m.fields.job || r.take(16).toString('hex') !== m.fields.generation || r.take(32).toString('hex') !== m.digest) throw Error('Binding'); r.take(16); r.take(32); r.end();
        }
        if (permission !== 16 && m) requestDevice = Buffer.from(m.fields.device, 'hex');
        opened.authority.authorize({ device: requestDevice, owner: requestDevice, epoch, credential, permission, destination: { kind: 'intake', intake: role === 'scope' ? '67c0494d-fc66-4eb6-a710-a059c81267aa' : '6b7e0334-148d-496c-8724-e8f01f03a9c1' } }); c.authorized++;
        // HTTP bytes deliberately are NOT cryptographic outcomes; test must not
        // call this a receipt or accept progress. G2 remains sole verifier.
        reply = Buffer.from('native-only-bounded-response');
        if (role === 'oversized' || role === 'oversized-control') {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          // No Content-Length: exercise streaming outcome limit, not header check.
          const part = role === 'oversized-control' ? 32768 : 2048;
          res.write(Buffer.alloc(part)); res.end(Buffer.alloc(part + 1)); status(); return;
        }
      }
      status(); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Set-Cookie': 'test=synthetic; Secure; Path=/' }); res.end(reply);
    } catch { status(); res.writeHead(403); res.end(); }
  });
  const port = await listen(server);
  opened = PairingAuthority.open({ path: join(directory, role + '.db'), origin: `https://localhost:${port}`, ca: readFileSync(join(directory, 'root.der')), pin: sha256(new X509Certificate(cert().cert).publicKey.export({ type: 'spki', format: 'der' })), keyStore, now: () => clock });
  authorities.push(opened.authority);
  if (role === 'future-pairing') writeFileSync(join(directory, 'future-installation.qr'), opened.local.createOffer({ mask: 31, scopes: { intakes: ['6b7e0334-148d-496c-8724-e8f01f03a9c1'], projects: [] } }));
  if (role === 'rotation-not-applied') {
    const nonce = randomBytes(32);
    writeFileSync(join(directory, 'rotation.nonce'), nonce);
    writeFileSync(join(directory, 'rotation.bin'), opened.local.rotation({ spki: new X509Certificate(cert('alternate').cert).publicKey.export({ type: 'spki', format: 'der' }), pin: randomBytes(32), ca: readFileSync(join(directory, 'root.der')), origin: 'https://rotated.invalid:443', epoch: 2n, expires: clock + 120n, nonce }));
  }
  writeFileSync(join(directory, role + '.qr'), opened.local.createOffer({ mask: role === 'permission' ? 1 : 31, scopes: { intakes: ['6b7e0334-148d-496c-8724-e8f01f03a9c1'], projects: [] } }));
}
status(); writeFileSync(join(directory, 'ready.json'), JSON.stringify({ cases: roles }));
process.on('SIGTERM', () => { for (const s of servers) s.close(); for (const a of authorities) a.close(); process.exit(0); });

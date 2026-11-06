// Research-only loopback listeners. All raw material stays in ignored artifacts.
import http from 'node:http';
import https from 'node:https';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes, randomUUID, createHash, createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
const dir = process.argv[2];
const hash = b => createHash('sha256').update(b).digest('hex');
const jobs = new Map();
const records = [];
const active = new Map();
const log = o => { records.push(o); appendFileSync(`${dir}/server.jsonl`, JSON.stringify(o) + '\n'); };
let ports;
function receive(req, done, slow = false) {
  const chunks = []; let bytes = 0;
  const id = randomUUID();
  active.set(id, { url: req.url, bytes: 0, socketBytes: 0, started: Date.now() });
  req.on('data', b => {
    chunks.push(b); bytes += b.length;
    active.set(id, { url: req.url, bytes, socketBytes: req.socket.bytesRead, at: Date.now() });
    if (slow) { req.pause(); setTimeout(() => req.resume(), 15); }
  });
  req.on('end', () => { active.delete(id); done(Buffer.concat(chunks)); });
  req.on('error', e => { log({ kind: 'readError', code: e.code }); active.delete(id); });
}
function authenticate(wire) {
  if (wire.length < 4) throw Error('short');
  const n = wire.readUInt32BE(0);
  if (n > 4096 || n + 32 > wire.length) throw Error('header');
  const h = JSON.parse(wire.subarray(4, 4 + n));
  if (h.v !== 1 || !Number.isSafeInteger(h.offset) || h.offset < 0 || !Number.isSafeInteger(h.length) || h.length < 1 || h.length > 64 * 1024 * 1024) throw Error('limits');
  const j = jobs.get(h.job); if (!j) throw Error('job');
  const b = wire.subarray(4 + n);
  const aad = Buffer.from(`probe-v1|${h.job}|${h.offset}|${h.length}|${h.sha256}`);
  const d = createDecipheriv('aes-256-gcm', j.bodyKey, b.subarray(0, 12));
  d.setAAD(aad); d.setAuthTag(b.subarray(-16));
  const plain = Buffer.concat([d.update(b.subarray(12, -16)), d.final()]);
  if (plain.length !== h.length || hash(plain) !== h.sha256) throw Error('hash');
  if (h.offset !== 0) throw Error('offset'); // single immutable chunk per probe job
  return { j, h, plain };
}
function accept(wire) {
  const { j, h, plain } = authenticate(wire);
  const wireHash = hash(wire);
  if (j.wireHash && j.wireHash !== wireHash) throw Error('conflicting replay');
  if (!j.wireHash) {
    // Never publish/write decipher.update() output before decipher.final() authenticates it.
    const file = `${dir}/receiver-${h.job}.bin`;
    writeFileSync(file, plain);
    if (hash(readFileSync(file)) !== h.sha256) throw Error('disk hash');
  }
  j.wireHash = wireHash; j.confirmed = h.length;
  const ack = `probe-v1/ack|${h.job}|0|${h.length}|${h.sha256}|${wireHash}`;
  const mac = createHmac('sha256', j.ackKey).update(ack).digest('base64');
  return { ack, mac, length: plain.length, sha256: hash(plain), job: h.job };
}
function adversarialChecks(wire) {
  const before = [...jobs.values()].map(j => j.confirmed ?? 0);
  const n = wire.readUInt32BE(0); const header = JSON.parse(wire.subarray(4, 4 + n));
  const altered = h => { const b = Buffer.from(JSON.stringify(h)); const p = Buffer.alloc(4); p.writeUInt32BE(b.length); return Buffer.concat([p, b, wire.subarray(4 + n)]); };
  const tampered = Buffer.from(wire); tampered[tampered.length - 17] ^= 1;
  // A second existing job tests a valid-but-different job key, not merely an unknown ID.
  const other = randomUUID(), k = randomBytes(32);
  jobs.set(other, { bodyKey: Buffer.from(hkdfSync('sha256', k, Buffer.from(other), Buffer.from('probe-v1/body'), 32)), ackKey: randomBytes(32) });
  const tests = { tampered, wrongOffset: altered({ ...header, offset: 1 }), wrongLength: altered({ ...header, length: header.length + 1 }), crossJob: altered({ ...header, job: other }) };
  const rejected = {};
  for (const [name, b] of Object.entries(tests)) { try { accept(b); rejected[name] = false; } catch { rejected[name] = true; } }
  const after = [...jobs.values()].slice(0, before.length).map(j => j.confirmed ?? 0);
  return { ...rejected, noProgressAdvance: JSON.stringify(before) === JSON.stringify(after), crossJobProgress: jobs.get(other).confirmed ?? 0 };
}
function handler(role) {
  return (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/control') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ records, active: [...active.values()] })); return; }
    if (u.pathname === '/setup') {
      if (role !== 'receiver') { res.writeHead(403).end(); return; }
      const job = randomUUID(), key = randomBytes(32);
      jobs.set(job, { bodyKey: Buffer.from(hkdfSync('sha256', key, Buffer.from(job), Buffer.from('probe-v1/body'), 32)), ackKey: Buffer.from(hkdfSync('sha256', key, Buffer.from(job), Buffer.from('probe-v1/ack'), 32)) });
      log({ kind: 'setup', role }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ job, key: key.toString('base64') })); return;
    }
    const to = u.searchParams.get('to');
    if (u.pathname === '/redirect') {
      // Explicitly drain original upload then issue a 307; no assertion relies on failing baseline I/O.
      receive(req, b => {
        log({ kind: 'redirect', role, bytes: b.length, sha256: hash(b), auth: !!req.headers.authorization });
        const targets = { different: `https://localhost:${ports.different}/sink`, same: `https://localhost:${ports.same}/sink`, httpIP: `http://127.0.0.1:${ports.http}/sink`, httpHost: `http://localhost:${ports.http}/sink`, sealed: `http://127.0.0.1:${ports.http}/sealed-sink` };
        res.writeHead(307, { Location: targets[to] }).end();
      }); return;
    }
    if (u.pathname === '/sink' || u.pathname === '/plain') {
      receive(req, b => { log({ kind: 'plain', role, path: u.pathname, method: req.method, bytes: b.length, sha256: hash(b), auth: !!req.headers.authorization }); res.writeHead(204, { 'Upload-Offset': '65536' }).end(); }); return;
    }
    if (u.pathname === '/sealed-sink') {
      receive(req, b => {
        writeFileSync(`${dir}/captured-sealed.bin`, b);
        log({ kind: 'sealedSink', bytes: b.length, sha256: hash(b), auth: !!req.headers.authorization, cookie: !!req.headers.cookie, urlHasSecret: u.search !== '' });
        // Everything needed to construct the correct public context is visible to a redirect sink.
        // Forge that exact context, but without the secret the sink cannot produce a valid MAC.
        const n = b.readUInt32BE(0), h = JSON.parse(b.subarray(4, 4 + n));
        const ack = `probe-v1/ack|${h.job}|0|${h.length}|${h.sha256}|${hash(b)}`;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Upload-Offset': '999999999' }).end(JSON.stringify({ ack, mac: randomBytes(32).toString('base64') }));
      }); return;
    }
    if (u.pathname === '/sealed' || u.pathname === '/slow-sealed' || u.pathname === '/replay') {
      receive(req, b => {
        try {
          const checks = adversarialChecks(b), ack = accept(b), replay = accept(b);
          log({ kind: 'sealedAccepted', bytes: ack.length, sha256: ack.sha256, wireBytes: b.length, checks, idempotentReplay: ack.ack === replay.ack, plaintextFileVerified: true, auth: !!req.headers.authorization });
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ack: ack.ack, mac: ack.mac }));
        } catch (e) { log({ kind: 'sealedRejected', reason: e.message }); res.writeHead(400).end(); }
      }, u.pathname === '/slow-sealed'); return;
    }
    if (u.pathname === '/verify-captured') {
      try {
        const wire = readFileSync(`${dir}/captured-sealed.bin`);
        const checks = adversarialChecks(wire), ack = accept(wire);
        log({ kind: 'capturedAcceptedByReceiver', bytes: ack.length, sha256: ack.sha256, checks });
        res.end(JSON.stringify(ack));
      } catch { res.writeHead(400).end(); } return;
    }
    res.writeHead(404).end();
  };
}
const tls = name => ({ key: readFileSync(`${dir}/${name}.key`), cert: readFileSync(`${dir}/${name}.pem`), minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] });
const servers = { receiver: https.createServer(tls('leaf'), handler('receiver')), same: https.createServer(tls('leaf'), handler('same')), different: https.createServer(tls('other'), handler('different')), http: http.createServer(handler('http')) };
ports = {};
for (const [name, server] of Object.entries(servers)) {
  server.on('clientError', e => log({ kind: 'clientError', role: name, code: e.code }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); ports[name] = server.address().port;
}
writeFileSync(`${dir}/ports.json`, JSON.stringify(ports));
process.on('SIGTERM', () => { for (const s of Object.values(servers)) s.close(); setTimeout(() => process.exit(), 100).unref(); });

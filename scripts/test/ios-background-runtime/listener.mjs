// Synthetic local chunk listener, not G3 durability/finality. No production endpoints activated.
import https from 'node:https';
import { readFile, writeFile, open, mkdir, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Manifest, GenerationKeys, Binding, VerifiedGroup, encodeAck, encodeOutcome, limits } from '../../../apps/server/src/sealed-protocol.ts';
const [out, docs] = process.argv.slice(2);
await mkdir(path.join(out, 'quarantine'), { mode: 0o700 });
const summary = { groups: 0, bodyBytes: 0, socketBytesAtStart: 0, authHeaders: 0, cookieHeaders: 0, wholeHashMatched: false, errors: 0, wireMatches: [] };
const accepted = new Map();
async function snapshot() { await writeFile(path.join(out, 'listener-state.json'), JSON.stringify(summary)); }
const server = https.createServer({ key: await readFile(path.join(out, 'leaf.key')), cert: await readFile(path.join(out, 'leaf.pem')) }, async (req, res) => {
  let wire, plain;
  const id = Math.random().toString(16).slice(2);
  const wirePath = path.join(out, 'quarantine', `${id}.wire`), plainPath = path.join(out, 'quarantine', `${id}.plain`);
  try {
    if (req.url !== '/sealed/v1/ingest' || req.method !== 'POST') throw Error('route');
    if (req.headers.authorization) summary.authHeaders++;
    if (req.headers.cookie) summary.cookieHeaders++;
    summary.socketBytesAtStart += req.socket.bytesRead;
    await snapshot();
    // Python releases ONLY after native didEnterBackground and process SIGSTOP.
    while (true) { try { await stat(path.join(out, 'release')); break; } catch { await delay(50); } }
    const manifest = Manifest.decode(await readFile(path.join(docs, 'listener.manifest')));
    const keys = GenerationKeys.fromSetup(await readFile(path.join(docs, 'listener.master')), manifest);
    const binding = Binding.match(manifest, { receiver: manifest.fields.receiver, origin: manifest.fields.origin });
    wire = await open(wirePath, 'wx+', 0o600);
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > limits.groupWire) throw Error('wire bound');
      await wire.write(chunk); summary.bodyBytes += chunk.length;
      await delay(5);
    }
    await wire.sync();
    let offset = 0;
    const source = {
      async readExactly(n) {
        const buffer = Buffer.alloc(n); let done = 0;
        while (done < n) { const result = await wire.read(buffer, done, n - done, offset + done); if (!result.bytesRead) throw Error('truncated'); done += result.bytesRead; }
        offset += n; return buffer;
      },
      async atEnd() { return offset === length; }
    };
    plain = await open(plainPath, 'wx', 0o600);
    const group = await VerifiedGroup.authenticate(source, {
      async write(_index, bytes) { await plain.write(bytes); },
      async discard() { await plain.truncate(0); }
    }, binding, keys);
    await plain.sync(); await plain.close(); plain = undefined;
    const localWire = await readFile(path.join(docs, 'runtime', `group-${group.partition.group}.sealed`));
    summary.wireMatches.push(createHash('sha256').update(localWire).digest('hex') === group.wireSHA256);
    accepted.set(group.partition.group, plainPath);
    summary.groups = accepted.size;
    if (accepted.size === manifest.groupCount) {
      const whole = createHash('sha256'); let originalBytes = 0;
      for (let i = 0; i < manifest.groupCount; i++) {
        const f = await open(accepted.get(i));
        try {
          let at = 0; const buf = Buffer.alloc(65536);
          while (true) { const { bytesRead } = await f.read(buf, 0, buf.length, at); if (!bytesRead) break; at += bytesRead; originalBytes += bytesRead; whole.update(buf.subarray(0, bytesRead)); }
        } finally { await f.close(); }
      }
      summary.wholeHashMatched = whole.digest('hex') === manifest.fields.originalSHA256 && BigInt(originalBytes) === manifest.fields.originalBytes;
    }
    // Explicitly chunk-only synthetic ACK. No final receipt and no received claim.
    const ack = encodeAck(keys, { group: group.partition.group, wireSHA256: group.wireSHA256, revision: BigInt(summary.groups) });
    const body = encodeOutcome(ack);
    await snapshot();
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }); res.end(body);
  } catch (error) { summary.errors++; await snapshot(); res.writeHead(400); res.end(); console.error(error); }
  finally { await plain?.close(); await wire?.close(); await rm(wirePath, { force: true }); }
});
await new Promise(resolve => server.listen(0, '::', resolve));
await writeFile(path.join(out, 'listener-ready.json'), JSON.stringify({ port: server.address().port }));

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Manifest, GenerationKeys, Binding, VerifiedGroup, limits, sha256, decodeQuery, encodeStatus, encodeReceipt, encodeAck, encodeOutcome } from '../../../apps/server/src/sealed-protocol.js';
import { verifyHandoffRequest } from '../../../apps/server/src/phone-intake.js';
const [out, java, classpath] = process.argv.slice(2);
assert(out && java && classpath);
for (const size of [173, 64 * 1024 * 1024 + 17]) {
  const directory = join(out, `case-${size}`); await mkdir(directory, { mode: 0o700 });
  const original = Buffer.alloc(size, 17), master = randomBytes(32), frames: string[] = [];
  for (let offset = 0; offset < original.length; offset += limits.frame) frames.push(sha256(original.subarray(offset, offset + limits.frame)));
  const m = Manifest.create({ receiver: 'ab'.repeat(32), origin: 'https://localhost:9443', job: randomUUID().replaceAll('-', ''), generation: randomBytes(16).toString('hex'), device: randomBytes(16).toString('hex'), enrollmentEpoch: 1n, destination: { kind: 'standalone', intake: randomUUID().replaceAll('-', '') }, originalBytes: BigInt(size), originalSHA256: sha256(original), safeName: 'generated.bin', expiresAt: BigInt(Math.floor(Date.now() / 1000)) + 3600n, frameBytes: limits.frame, framesPerGroup: 8, frameHashes: frames });
  const keys = GenerationKeys.fromSetup(master, m);
  await Promise.all([writeFile(join(directory, 'manifest'), m.bytes), writeFile(join(directory, 'master'), master, { mode: 0o600 }), writeFile(join(directory, 'original'), original)]);
  execFileSync(java, ['-cp', classpath, 'expo.modules.footagetransfer.ProbeKt', directory, 'seal'], { stdio: 'pipe' });
  let received = 0, lastWire = '';
  for (let group = 0; group < m.groupCount; group++) {
    const file = await open(join(directory, `group-${group}`), 'r'); let offset = 0;
    try {
      const verified = await VerifiedGroup.authenticate({
        async readExactly(length) { const bytes = Buffer.alloc(length); let count = 0; while (count < length) { const chunk = await file.read(bytes, count, length - count, offset); assert(chunk.bytesRead > 0); count += chunk.bytesRead; offset += chunk.bytesRead; } return bytes; },
        async atEnd() { return offset === (await file.stat()).size; },
      }, { async write(_frame, plaintext) { assert.deepEqual(plaintext, original.subarray(received, received + plaintext.length)); received += plaintext.length; }, async discard() { throw new Error('Generated ciphertext failed authentication.'); } }, Binding.match(m, { receiver: m.fields.receiver, origin: m.fields.origin }), keys);
      lastWire = verified.wireSHA256;
    } finally { await file.close(); }
  }
  assert.equal(received, size);
  const query = decodeQuery(await readFile(join(directory, 'query')), m);
  const handoff = await readFile(join(directory, 'handoff')); verifyHandoffRequest(handoff, keys, 'send'); assert.throws(() => verifyHandoffRequest(handoff, keys, 'status'));
  const receipt = encodeReceipt(keys, { id: randomUUID().replaceAll('-', ''), verifiedAt: BigInt(Math.floor(Date.now() / 1000)), revision: 3n });
  const status = encodeStatus(keys, query, { revision: 3n, state: 3, cleanup: 0, groupBitmap: (1n << BigInt(m.groupCount)) - 1n }, receipt);
  const outcome = encodeOutcome(encodeAck(keys, { group: m.groupCount - 1, wireSHA256: lastWire, revision: 2n }), receipt);
  await Promise.all([writeFile(join(directory, 'status'), status), writeFile(join(directory, 'outcome'), outcome), writeFile(join(directory, 'wire'), Buffer.from(lastWire, 'hex'))]);
  execFileSync(java, ['-cp', classpath, 'expo.modules.footagetransfer.ProbeKt', directory, 'verify'], { stdio: 'pipe' });
  process.stdout.write(`PASS Kotlin→production Node authenticated groups and Node→Kotlin receipts/status, ${size} original bytes; tamper/replay-purpose/high-water rejected.\n`);
}

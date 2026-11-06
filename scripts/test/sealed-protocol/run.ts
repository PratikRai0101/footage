/** Offline Node <-> actual Swift CryptoKit differential harness. No networking or app activation. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { Manifest, GenerationKeys, Binding, SealSession, VerifiedGroup, VerifiedAck, VerifiedReceipt, VerifiedStatus, groupHeader, frameAAD, sha256, encodeDestination, encodeAck, encodeReceipt, encodeOutcome, verifyOutcome, freshQuery, encodeQuery, decodeQuery, encodeStatus, encodeSetup, decodeSetup } from '../../../apps/server/src/sealed-protocol.js';
import { fixture, hex, deterministicFrame, MemorySource, PrivateQuarantine } from './fixtures.js';
const hexBytes = z.string().regex(/^(?:[0-9a-f]{2})*$/);
const vectorSchema = z.object({
  nodeRandomPacket: hexBytes, manifest: hexBytes, digest: hexBytes, master: hexBytes, destination: hexBytes, destinationDigest: hexBytes, header: hexBytes, packet: hexBytes, aad: hexBytes, bodyKey: hexBytes, ackKey: hexBytes, receiptKey: hexBytes, statusKey: hexBytes, ack: hexBytes, receipt: hexBytes, outcome: hexBytes, query: hexBytes, statuses: z.array(hexBytes), setup: hexBytes
}).strict();
const resultSchema = z.array(z.object({ vector: vectorSchema, randomPacket: hexBytes }).strict());
async function vector(size: number, t3: boolean, origin?: string) {
  const f = fixture(size, t3, origin), m = f.manifest, packet = deterministicFrame(f.keys), header = groupHeader(m, 0), wireSHA256 = sha256(Buffer.concat([header, packet])), sealID = packet.subarray(8, 24), aad = frameAAD(header, 0, size, sealID);
  const ack = encodeAck(f.keys, { group: 0, wireSHA256, revision: 7n }), receipt = encodeReceipt(f.keys, { id: hex(16), verifiedAt: 1800000000n, revision: 9n }), query = freshQuery(hex(16));
  const statuses: Buffer[] = [
    encodeStatus(f.keys, query, { revision: 7n, state: 1, cleanup: 0, groupBitmap: 0n }),
    encodeStatus(f.keys, query, { revision: 8n, state: 2, cleanup: 0, groupBitmap: 1n }),
    encodeStatus(f.keys, query, { revision: 9n, state: 3, cleanup: 0, groupBitmap: 1n }, receipt),
  ];
  for (const state of [4, 5, 6])
    for (const cleanup of [1, 2])
      statuses.push(encodeStatus(f.keys, query, { revision: 10n, state, cleanup, groupBitmap: 0n }));
  const intent = await new SealSession(f.keys).consume(0, async () => {
  });
  const nodeRandomPacket = intent.seal(f.block).toString('hex');
  return vectorSchema.parse({
    nodeRandomPacket, manifest: m.bytes.toString('hex'), digest: m.digest, master: f.master.toString('hex'), destination: encodeDestination(m.fields.destination).toString('hex'), destinationDigest: m.destinationDigest, header: header.toString('hex'), packet: packet.toString('hex'), aad: aad.toString('hex'), bodyKey: f.keys.derive('body', { index: 0, sealID }).toString('hex'), ackKey: f.keys.derive('ack').toString('hex'), receiptKey: f.keys.derive('receipt').toString('hex'), statusKey: f.keys.derive('status').toString('hex'), ack: ack.toString('hex'), receipt: receipt.toString('hex'), outcome: encodeOutcome(ack, receipt).toString('hex'), query: encodeQuery(m, query).toString('hex'), statuses: statuses.map(s => s.toString('hex')), setup: encodeSetup(f.keys, f.master).toString('hex')
  });
}
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: resolve('.'), stdio: 'inherit' });
  if (result.error)
    throw result.error;
  assert.equal(result.status, 0, `${command} failed`);
}
async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), 'footage-sealed-vectors-'));
  try {
    const input = await Promise.all([vector(1, false), vector(37, true, 'https://[2001:db8::1]:65535'), vector(4097, true, 'https://127.0.0.1:443'), vector(37, true, 'https://xn--caf-dma.example:443')]), inputPath = join(temp, 'input.json'), outputPath = join(temp, 'output.json'), binary = join(temp, 'harness');
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    // Precreate output privately before Swift writes the ephemeral keys/vector results.
    await writeFile(outputPath, '', { mode: 0o600 });
    run('swiftc', ['-swift-version', '6', '-warnings-as-errors', '-parse-as-library', 'apps/mobile/modules/footage-transfer/ios/SealedProtocol.swift', 'scripts/test/sealed-protocol/Harness.swift', '-o', binary]);
    run(binary, [inputPath, outputPath]);
    const results = resultSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')));
    assert.equal(results.length, input.length);
    for (let i = 0; i < input.length; i++) {
      const result = results[i], expected = input[i];
      assert.ok(result && expected);
      assert.ok(isDeepStrictEqual(result.vector, expected), 'Swift/Node vector bytes differ; secret bytes deliberately omitted');
      const v = result.vector, m = Manifest.decode(Buffer.from(v.manifest, 'hex')), keys = GenerationKeys.fromSetup(Buffer.from(v.master, 'hex'), m), binding = Binding.match(m, m.fields);
      const body = Buffer.concat([Buffer.from(v.header, 'hex'), Buffer.from(v.packet, 'hex')]);
      const group = await VerifiedGroup.authenticate(new MemorySource(body), new PrivateQuarantine(), binding, keys);
      const expectedAck = { group: 0, wireSHA256: group.wireSHA256 };
      assert.equal(VerifiedAck.verify(Buffer.from(v.ack, 'hex'), keys, expectedAck).originalLength, Number(m.fields.originalBytes));
      assert.equal(VerifiedReceipt.verify(Buffer.from(v.receipt, 'hex'), keys).sha256, m.fields.originalSHA256);
      assert.ok(verifyOutcome(Buffer.from(v.outcome, 'hex'), 200, keys, expectedAck).receipt);
      const query = decodeQuery(Buffer.from(v.query, 'hex'), m);
      for (const s of v.statuses)
        VerifiedStatus.verify(Buffer.from(s, 'hex'), keys, query, 0n);
      assert.ok(decodeSetup(Buffer.from(v.setup, 'hex'), m).derive('ack').equals(keys.derive('ack')), 'Setup key mismatch');
      const random = Buffer.concat([groupHeader(m, 0), Buffer.from(result.randomPacket, 'hex')]);
      const q = new PrivateQuarantine();
      await VerifiedGroup.authenticate(new MemorySource(random), q, binding, keys);
      assert.equal(q.hasher.digest('hex'), m.fields.originalSHA256);
    }
    process.stdout.write('Node <-> Swift CryptoKit: 4 manifests/digests, AAD/HKDF/AEAD, setup/query, ack/receipt/outcome, 36 status/revoke vectors byte-identical; random production seals opened in both directions.\n');
  }
  finally {
    await rm(temp, { recursive: true, force: true });
  }
}
void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Harness failed'}\n`);
  process.exitCode = 1;
});

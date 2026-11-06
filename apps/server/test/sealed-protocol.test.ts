import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { Binding, Manifest, OutcomeContext, GenerationKeys, SealSession, VerifiedGroup, VerifiedAck, VerifiedReceipt, VerifiedStatus, canonicalOrigin, encodeDestination, decodeDestination, groupHeader, parseGroupHeader, limits, encodeAck, encodeReceipt, encodeOutcome, verifyOutcome, freshQuery, encodeQuery, decodeQuery, encodeStatus, encodeSetup, decodeSetup, sha256, type GroupSource } from '../src/sealed-protocol.js';
import { fixture, hex, deterministicFrame, MemorySource, PrivateQuarantine, remac } from '../../../scripts/test/sealed-protocol/fixtures.js';
function mutate(bytes: Buffer, at: number): Buffer {
  const b = Buffer.from(bytes);
  b[at] = (b[at] ?? 0) ^ 1;
  return b;
}
function packet(f = fixture()): Buffer {
  return Buffer.concat([groupHeader(f.manifest, 0), deterministicFrame(f.keys)]);
}
async function rejectsGroup(bytes: Buffer, f = fixture()): Promise<PrivateQuarantine> {
  const q = new PrivateQuarantine();
  await assert.rejects(VerifiedGroup.authenticate(new MemorySource(bytes), q, f.binding, f.keys));
  assert.equal(q.discarded, true);
  assert.equal(q.bytes, 0);
  return q;
}
test('canonical origins, bounded NFC destinations and private manifest round trips', () => {
  for (const s of ['https://receiver.example:443', 'https://127.0.0.1:1', 'https://[2001:db8::1]:65535', 'https://[::]:443', 'https://xn--caf-dma.example:443', 'https://receiver.0xyz:443', 'https://[::ffff:c000:201]:443'])
    assert.equal(canonicalOrigin(s), s);
  for (const s of ['http://receiver.example:443', 'https://Receiver.example:443', 'https://receiver.example:0443', 'https://receiver.example:0', 'https://receiver.example:65536', 'https://receiver.example.:443', 'https://receiver.example:443/', 'https://a@receiver.example:443', 'https://receiver.example:443?x', 'https://127.1:443', 'https://0177.0.0.1:443', 'https://[2001:0db8::1]:443', 'https://[::ffff:192.0.2.1]:443', 'https://[fe80::1%25en0]:443', 'https://é.example:443', 'https://a_b:443', 'https://a:00001', 'https://xn--a:443', 'https://xn--abc:443'])
    assert.throws(() => canonicalOrigin(s), s);
  for (const t3 of [false, true]) {
    const f = fixture(37, t3);
    assert.deepEqual(Manifest.decode(f.manifest.bytes).bytes, f.manifest.bytes);
    assert.deepEqual(decodeDestination(encodeDestination(f.fields.destination)), f.fields.destination);
    assert.equal(sha256(f.manifest.bytes), f.manifest.digest);
  }
  const f = fixture();
  for (const safeName of ['', '../file', 'file\\name', 'e\u0301.mov', 'bad\u0000', 'a'.repeat(241), '\ud800'])
    assert.throws(() => Manifest.create({ ...f.fields, safeName }));
  const d = { kind: 't3', environment: 'x', project: 'p', thread: 't', workspace: 'w', consent: hex(16) };
  for (const environment of ['', 'e\u0301', 'é'.repeat(65), '\ud800'])
    assert.throws(() => encodeDestination({ ...d, environment }));
  for (const b of [Buffer.from([0]), Buffer.from([3]), Buffer.concat([encodeDestination(d), Buffer.from([0])]), Buffer.from([2, 0, 1, 0xff])])
    assert.throws(() => decodeDestination(b));
  assert.throws(() => Binding.match(f.manifest, { receiver: hex(32), origin: f.fields.origin }));
  assert.throws(() => Binding.match(f.manifest, { receiver: f.fields.receiver, origin: 'https://other.example:443' }));
  const copy = f.manifest.bytes;
  copy.fill(0);
  const fields = f.manifest.fields;
  fields.frameHashes.fill(hex(32));
  assert.equal(Manifest.decode(f.manifest.bytes).digest, f.manifest.digest);
});
test('all manifest truncations, excessive lengths, trailing, partition and UInt64 bounds', () => {
  const f = fixture(), bytes = f.manifest.bytes;
  for (let i = 0; i < bytes.length; i++)
    assert.throws(() => Manifest.decode(bytes.subarray(0, i)), `truncated ${i}`);
  assert.throws(() => Manifest.decode(Buffer.concat([bytes, Buffer.from([0])])));
  assert.throws(() => Manifest.decode(Buffer.alloc(65537)));
  const originalOffset = 8 + 32 + 2 + Buffer.byteLength(f.fields.origin) + 48 + 8 + 2 + encodeDestination(f.fields.destination).length;
  const overflow = Buffer.from(bytes);
  overflow.writeBigUInt64BE((1n << 64n) - 1n, originalOffset);
  assert.throws(() => Manifest.decode(overflow));
  const oversizedCount = Buffer.from(bytes);
  oversizedCount.writeUInt32BE(0xffffffff, bytes.length - 36);
  assert.throws(() => Manifest.decode(oversizedCount));
  const oversizedLP = Buffer.from(bytes);
  oversizedLP.writeUInt16BE(65535, 40);
  assert.throws(() => Manifest.decode(oversizedLP));
  f.manifest.validateSetupTime(f.fields.expiresAt - 7n * 86400n);
  for (const now of [f.fields.expiresAt, f.fields.expiresAt - 7n * 86400n - 1n, -1n, 1n << 64n])
    assert.throws(() => f.manifest.validateSetupTime(now));
  for (const originalBytes of [0n, -1n, limits.original + 1n, 1n << 64n])
    assert.throws(() => Manifest.create({ ...f.fields, originalBytes }));
  assert.throws(() => Manifest.create({ ...f.fields, enrollmentEpoch: 1n << 64n }));
  assert.throws(() => Manifest.create({ ...f.fields, frameBytes: 1 }));
  assert.throws(() => Manifest.create({ ...f.fields, framesPerGroup: 9 }));
  assert.throws(() => Manifest.create({ ...f.fields, frameHashes: [] }));
  assert.throws(() => Manifest.create({ ...f.fields, frameHashes: Array(513).fill(hex(32)) }));
  assert.throws(() => Manifest.create({ ...f.fields, originalBytes: BigInt(limits.frame + 1) }));
  const max = Manifest.create({ ...f.fields, originalBytes: limits.original, frameHashes: Array(512).fill(hex(32)), enrollmentEpoch: (1n << 64n) - 1n });
  assert.equal(max.groupCount, 64);
  assert.equal(max.partition(63).offset, 63n * 64n * 1024n ** 2n);
  assert.equal(max.contiguous((1n << 64n) - 1n), limits.original);
  assert.equal(max.contiguous(2n), 0n);
  assert.equal(max.contiguous(5n), 64n * 1024n ** 2n);
  assert.throws(() => f.manifest.contiguous(2n));
  for (const group of [-1, 1, 0.5, 64, NaN])
    assert.throws(() => f.manifest.partition(group));
  const h = groupHeader(max, 63);
  assert.equal(h.length, 128);
  assert.equal(h.readBigUInt64BE(116), max.partition(63).offset);
});
test('minimal durable outcome context retains exact KDF and partition without private display metadata', () => {
  const f = fixture(37, true), context = OutcomeContext.fromManifest(f.manifest), authentication = context.authentication(f.master);
  const restored = OutcomeContext.restore(context.bytes, f.master, authentication), keys = GenerationKeys.forOutcomes(f.master, restored);
  assert.equal(restored.digest, f.manifest.digest);
  assert.equal(restored.destinationDigest, f.manifest.destinationDigest);
  assert(!('safeName' in restored.fields) && !('destination' in restored.fields) && !('frameHashes' in restored.fields));
  assert(!context.bytes.includes(Buffer.from(f.fields.safeName)));
  for (const domain of ['ack', 'receipt', 'status'] as const) assert.deepEqual(keys.derive(domain), f.keys.derive(domain));
  assert.throws(() => keys.derive('body', { index: 0, sealID: randomBytes(16) }));
  for (let i = 0; i < context.bytes.length; i++) {
    assert.throws(() => OutcomeContext.restore(mutate(context.bytes, i), f.master, authentication));
    assert.throws(() => OutcomeContext.restore(context.bytes.subarray(0, i), f.master, authentication));
  }
  assert.throws(() => OutcomeContext.restore(context.bytes, randomBytes(32), authentication));
  const query = freshQuery(hex(16)), receipt = encodeReceipt(f.keys, { id: hex(16), verifiedAt: 1800000000n, revision: 9n });
  assert.deepEqual(encodeQuery(restored, query), encodeQuery(f.manifest, query));
  assert.deepEqual(VerifiedReceipt.verify(receipt, keys).toOriginalReceipt(), VerifiedReceipt.verify(receipt, f.keys).toOriginalReceipt());
  const wireSHA256 = hex(32), ack = encodeAck(f.keys, { group: 0, wireSHA256, revision: 7n });
  assert.equal(VerifiedAck.verify(ack, keys, { group: 0, wireSHA256 }).originalLength, 37);
  assert.equal(VerifiedStatus.verify(encodeStatus(f.keys, query, { state: 3, cleanup: 0, groupBitmap: 1n, revision: 9n }, receipt), keys, query, 9n).receipt?.bytes, 37);
  for (const originalBytes of [1n, 67108865n, limits.original]) {
    const m = Manifest.create({ ...f.fields, originalBytes, frameHashes: Array(Number((originalBytes + 8388607n) / 8388608n)).fill(hex(32)) });
    const c = OutcomeContext.fromManifest(m);
    for (let group = 0; group < c.groupCount; group++) assert.deepEqual(c.partition(group), m.partition(group));
    for (const bitmap of [0n, 1n, (1n << BigInt(c.groupCount)) - 1n]) assert.equal(c.contiguous(bitmap), m.contiguous(bitmap));
    assert.throws(() => c.contiguous(1n << BigInt(c.groupCount)));
  }
  if (false) {
    // @ts-expect-error No public arbitrary-field context constructor.
    new OutcomeContext();
    // @ts-expect-error A field bag cannot replace the validated immutable context.
    const forged: OutcomeContext = { ...context.fields };
    void forged;
  }
});
test('headers and complete group authentication never expose a verified prefix', async () => {
  const f = fixture(), bytes = packet(f), q = new PrivateQuarantine();
  const result = await VerifiedGroup.authenticate(new MemorySource(bytes), q, f.binding, f.keys);
  assert.equal(result.partition.length, 37);
  assert.equal(result.wireSHA256, sha256(bytes));
  assert.equal(q.hasher.digest('hex'), f.fields.originalSHA256);
  for (const at of [0, 8, 40, 56, 72, 104, 108, 112, 114, 116, 124, 128, 132, 136, 152, 164, bytes.length - 1])
    await rejectsGroup(mutate(bytes, at), f);
  for (let i = 0; i < bytes.length; i++)
    await rejectsGroup(bytes.subarray(0, i), f);
  await rejectsGroup(Buffer.concat([bytes, Buffer.from([0])]), f);
  assert.throws(() => parseGroupHeader(groupHeader(f.manifest, 0).subarray(1), f.binding));
  const wrongKeys = GenerationKeys.fromSetup(randomBytes(32), f.manifest);
  await assert.rejects(VerifiedGroup.authenticate(new MemorySource(bytes), new PrivateQuarantine(), f.binding, wrongKeys));
  for (const change of [{ receiver: hex(32) }, { origin: 'https://other.example:443' }, { job: hex(16) }, { generation: hex(16) }, { destination: { kind: 'standalone', intake: hex(16) } }]) {
    const m = Manifest.create({ ...f.fields, ...change }), b = Binding.match(m, m.fields), k = GenerationKeys.fromSetup(f.master, m);
    await assert.rejects(VerifiedGroup.authenticate(new MemorySource(bytes), new PrivateQuarantine(), b, k));
  }
  // Correct AEAD but different staged frame hash still fails.
  await rejectsGroup(Buffer.concat([groupHeader(f.manifest, 0), deterministicFrame(f.keys, 0, Buffer.alloc(37))]), f);
  const two = fixture(limits.frame + 1), twoBytes = Buffer.concat([groupHeader(two.manifest, 0), deterministicFrame(two.keys, 0), deterministicFrame(two.keys, 1)]);
  const failed = await rejectsGroup(mutate(twoBytes, twoBytes.length - 1), two);
  assert.equal(failed.writes, 1, 'a verified frame remains only private quarantine until the last frame passes');
  const reusedID = randomBytes(16), duplicateIDs = Buffer.concat([groupHeader(two.manifest, 0), deterministicFrame(two.keys, 0, undefined, { sealID: reusedID }), deterministicFrame(two.keys, 1, undefined, { sealID: reusedID })]);
  await rejectsGroup(duplicateIDs, two);
});
test('full eight-frame wire boundary is 64 MiB + 544 with bounded read/write interfaces', async () => {
  const f = fixture(limits.frame * 8), header = groupHeader(f.manifest, 0);
  let cursor = -1, wire = header.length;
  const source: GroupSource = {
    async readExactly(length) {
      if (cursor === -1) {
        cursor++;
        assert.equal(length, 128);
        return header;
      }
      assert.equal(length, limits.frame + 52);
      const b = deterministicFrame(f.keys, cursor++);
      wire += b.length;
      return b;
    },
    async atEnd() {
      return cursor === 8;
    },
  };
  const q = new PrivateQuarantine(), verified = await VerifiedGroup.authenticate(source, q, f.binding, f.keys);
  assert.equal(wire, limits.groupWire);
  assert.equal(verified.partition.length, 64 * 1024 * 1024);
  assert.equal(q.writes, 8);
  assert.equal(q.hasher.digest('hex'), f.fields.originalSHA256);
});
test('one seal per consumed intent, durable callback failure burns frame, exact ciphertext retry only', async () => {
  const f = fixture(), session = new SealSession(f.keys);
  let persisted = false;
  const intent = await session.consume(0, async (record) => {
    assert.equal(record.manifestDigest, f.manifest.digest);
    assert.equal(record.sealID.length, 32);
    persisted = true;
  });
  assert.equal(persisted, true);
  const sealed = intent.seal(f.block);
  assert.throws(() => intent.seal(f.block));
  await assert.rejects(session.consume(0, async () => {
  }));
  const bytes = Buffer.concat([groupHeader(f.manifest, 0), sealed]);
  for (let retry = 0; retry < 2; retry++) {
    const g = await VerifiedGroup.authenticate(new MemorySource(bytes), new PrivateQuarantine(), f.binding, f.keys);
    assert.equal(g.wireSHA256, sha256(bytes));
  }
  const failed = new SealSession(f.keys);
  await assert.rejects(failed.consume(0, async () => {
    throw new Error('disk failure');
  }));
  await assert.rejects(failed.consume(0, async () => {
  }));
  const failedHash = await new SealSession(f.keys).consume(0, async () => {
  });
  assert.throws(() => failedHash.seal(Buffer.alloc(37)));
  assert.throws(() => failedHash.seal(f.block));
});
test('ack relay requires exact saved wire and context; ack is not receipt or a transport success', () => {
  const f = fixture(), wireSHA256 = sha256(packet(f)), expected = { group: 0, wireSHA256 }, ack = encodeAck(f.keys, { ...expected, revision: 7n });
  assert.equal(ack.length, 192);
  const v = VerifiedAck.verify(ack, f.keys, expected);
  assert.equal(v.originalLength, 37);
  assert.equal(v.revision, 7n);
  assert.throws(() => VerifiedAck.verify(ack, f.keys, { ...expected, wireSHA256: hex(32) }));
  assert.throws(() => VerifiedAck.verify(ack, f.keys, { ...expected, group: 1 }));
  for (let i = 0; i < ack.length; i++)
    assert.throws(() => VerifiedAck.verify(mutate(ack, i), f.keys, expected));
  assert.throws(() => VerifiedAck.verify(remac(ack, f.keys, 'status'), f.keys, expected));
  assert.throws(() => VerifiedAck.verify(remac(mutate(ack, 140), f.keys, 'ack'), f.keys, expected));
  assert.throws(() => VerifiedReceipt.verify(ack, f.keys));
  const envelope = encodeOutcome(ack);
  assert.equal(verifyOutcome(envelope, 200, f.keys, expected).receipt, null);
  for (const status of [201, 204, 302, 500])
    assert.throws(() => verifyOutcome(envelope, status, f.keys, expected));
  for (let i = 0; i < envelope.length; i++)
    assert.throws(() => verifyOutcome(envelope.subarray(0, i), 200, f.keys, expected));
  assert.throws(() => verifyOutcome(Buffer.concat([envelope, Buffer.from([0])]), 200, f.keys, expected));
});
test('receipt materializes only the bound original and destination; all outcome domains differ', () => {
  const f = fixture(19, true), rb = encodeReceipt(f.keys, { id: hex(16), verifiedAt: 1800000000n, revision: 9n }), v = VerifiedReceipt.verify(rb, f.keys);
  assert.equal(rb.length, 200);
  assert.equal(v.bytes, 19);
  assert.equal(v.sha256, f.fields.originalSHA256);
  assert.equal(v.destinationDigest, f.manifest.destinationDigest);
  assert.deepEqual(v.toOriginalReceipt(), {
    id: `${v.id.slice(0, 8)}-${v.id.slice(8, 12)}-${v.id.slice(12, 16)}-${v.id.slice(16, 20)}-${v.id.slice(20)}`, jobId: `${v.jobId.slice(0, 8)}-${v.jobId.slice(8, 12)}-${v.jobId.slice(12, 16)}-${v.jobId.slice(16, 20)}-${v.jobId.slice(20)}`, bytes: 19, sha256: f.fields.originalSHA256, verifiedAt: '2027-01-15T08:00:00.000Z'
  });
  assert.throws(() => VerifiedReceipt.verify(encodeReceipt(f.keys, { id: hex(16), verifiedAt: (1n << 64n) - 1n, revision: 9n }), f.keys).toOriginalReceipt());
  for (const d of ['ack', 'receipt', 'status'] satisfies ('ack' | 'receipt' | 'status')[])
    for (const e of ['ack', 'receipt', 'status'] satisfies ('ack' | 'receipt' | 'status')[])
      if (d !== e)
        assert.notDeepEqual(f.keys.derive(d), f.keys.derive(e));
  for (let i = 0; i < rb.length; i++) {
    assert.throws(() => VerifiedReceipt.verify(rb.subarray(0, i), f.keys));
    assert.throws(() => VerifiedReceipt.verify(mutate(rb, i), f.keys));
  }
  assert.throws(() => VerifiedReceipt.verify(remac(mutate(rb, 104), f.keys, 'receipt'), f.keys));
  const ack = encodeAck(f.keys, { group: 0, wireSHA256: hex(32), revision: 8n });
  assert.equal(verifyOutcome(encodeOutcome(ack, rb), 200, f.keys, { group: 0, wireSHA256: ack.subarray(108, 140).toString('hex') }).receipt?.bytes, 19);
});
test('status/revoke share authenticated codec, fresh challenges, monotonic revisions and original bitmap prefix', () => {
  const f = fixture(), query = freshQuery(hex(16)), received = encodeReceipt(f.keys, { id: hex(16), verifiedAt: 1800000000n, revision: 9n });
  assert.deepEqual(decodeQuery(encodeQuery(f.manifest, query), f.manifest), query);
  const fields = { revision: 10n, state: 3, cleanup: 0, groupBitmap: 1n }, bytes = encodeStatus(f.keys, query, fields, received);
  const v = VerifiedStatus.verify(bytes, f.keys, query, 10n);
  assert.equal(v.contiguousOriginalBytes, 37n);
  assert.equal(v.receipt?.bytes, 37);
  assert.throws(() => VerifiedStatus.verify(bytes, f.keys, freshQuery(query.operation), 0n));
  assert.throws(() => VerifiedStatus.verify(bytes, f.keys, { ...query, operation: hex(16) }, 0n));
  assert.throws(() => VerifiedStatus.verify(bytes, f.keys, query, 11n));
  for (let i = 0; i < bytes.length; i++)
    assert.throws(() => VerifiedStatus.verify(bytes.subarray(0, i), f.keys, query, 0n));
  for (const at of [0, 8, 40, 56, 72, 104, 120, 152, 160, 161, 162, 170, 178, 186, bytes.length - 1])
    assert.throws(() => VerifiedStatus.verify(mutate(bytes, at), f.keys, query, 0n));
  for (const at of [160, 161, 162, 170, 178])
    assert.throws(() => VerifiedStatus.verify(remac(mutate(bytes, at), f.keys, 'status'), f.keys, query, 0n));
  assert.throws(() => VerifiedStatus.verify(remac(bytes, f.keys, 'ack'), f.keys, query, 0n));
  for (const [state, cleanup] of [[0, 0], [3, 0], [4, 0], [1, 1], [7, 0]])
    assert.throws(() => encodeStatus(f.keys, query, { ...fields, state, cleanup }));
  assert.throws(() => encodeStatus(f.keys, query, { ...fields, groupBitmap: 2n }, received));
  assert.throws(() => encodeStatus(f.keys, query, { ...fields, state: 1 }, received));
  for (const state of [4, 5, 6])
    for (const cleanup of [1, 2])
      assert.equal(VerifiedStatus.verify(encodeStatus(f.keys, query, { revision: 10n, state, cleanup, groupBitmap: 0n }), f.keys, query, 10n).cleanup, cleanup);
  const sparse = Manifest.create({ ...f.fields, originalBytes: 2n * 64n * 1024n ** 2n + 1n, frameHashes: Array(17).fill(hex(32)) }), keys = GenerationKeys.fromSetup(f.master, sparse);
  for (const [groupBitmap, prefix] of [[2n, 0n], [5n, 64n * 1024n ** 2n], [7n, sparse.fields.originalBytes]])
    assert.equal(VerifiedStatus.verify(encodeStatus(keys, query, { revision: 1n, state: 1, cleanup: 0, groupBitmap }), keys, query, 0n).contiguousOriginalBytes, prefix);
});
test('fresh master creation and verified result types preserve trust boundaries', () => {
  const m = fixture().manifest, a = GenerationKeys.fresh(m), b = GenerationKeys.fresh(m);
  assert.equal(a.master.length, 32);
  assert.notDeepEqual(a.master, b.master);
  assert.notDeepEqual(a.keys.derive('ack'), b.keys.derive('ack'));
  const before = a.keys.derive('ack');
  a.master.fill(0);
  assert.deepEqual(a.keys.derive('ack'), before);
  if (false) {
    // @ts-expect-error A public field bag is not an authenticated domain value.
    const forged: VerifiedAck = { group: 0, originalOffset: 0n, originalLength: 1, revision: 1n };
    // @ts-expect-error Verified values have no public constructor.
    new VerifiedReceipt();
    void forged;
  }
});
test('setup exact context and bounded records reject arbitrary mutations and length prefixes', () => {
  const f = fixture(), setup = encodeSetup(f.keys, f.master);
  assert.deepEqual(decodeSetup(setup, f.manifest).derive('ack'), f.keys.derive('ack'));
  for (let i = 0; i < setup.length; i++)
    assert.throws(() => decodeSetup(setup.subarray(0, i), f.manifest));
  assert.throws(() => decodeSetup(Buffer.concat([setup, Buffer.from([0])]), f.manifest));
  assert.throws(() => decodeSetup(mutate(setup, 8), f.manifest));
  assert.throws(() => decodeSetup(mutate(setup, 79), f.manifest));
  const q = freshQuery(hex(16)), qb = encodeQuery(f.manifest, q);
  for (let i = 0; i < qb.length; i++)
    assert.throws(() => decodeQuery(qb.subarray(0, i), f.manifest));
  assert.throws(() => decodeQuery(Buffer.concat([qb, Buffer.from([0])]), f.manifest));
  for (let i = 0; i < 200; i++) {
    const noise = randomBytes(i * 7);
    assert.throws(() => Manifest.decode(noise));
    assert.throws(() => VerifiedStatus.verify(noise, f.keys, q, 0n));
  }
  const outcome = encodeOutcome(encodeAck(f.keys, { group: 0, wireSHA256: hex(32), revision: 0n }));
  outcome.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => verifyOutcome(outcome, 200, f.keys, { group: 0, wireSHA256: hex(32) }));
  assert.throws(() => verifyOutcome(Buffer.alloc(4097), 200, f.keys, { group: 0, wireSHA256: hex(32) }));
});

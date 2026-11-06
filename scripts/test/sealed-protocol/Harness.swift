import CryptoKit
// TEST ONLY. Deterministic nonce/seal IDs and direct AES invocations never enter the app module.
import Foundation

typealias P = SealedProtocol
struct Vector: Codable {
  let context: String, contextAuthentication: String
  let nodeRandomPacket: String, manifest: String, digest: String, master: String,
    destination: String, destinationDigest: String
  let header: String, packet: String, aad: String, bodyKey: String, ackKey: String,
    receiptKey: String, statusKey: String
  let ack: String, receipt: String, outcome: String, query: String, statuses: [String],
    setup: String
}
struct Result: Codable { let vector: Vector, randomPacket: String }
func data(_ s: String) throws -> Data {
  try P.check(s.count % 2 == 0)
  var b = Data()
  var i = s.startIndex
  while i != s.endIndex {
    let next = s.index(i, offsetBy: 2)
    guard let byte = UInt8(s[i..<next], radix: 16) else { throw P.Failure.invalid }
    b.append(byte)
    i = next
  }
  return b
}
func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
func expectFailure(_ action: () throws -> Void) throws {
  var failed = false
  do { try action() } catch { failed = true }
  try P.check(failed)
}
func flip(_ d: Data, _ offset: Int) -> Data {
  var b = d
  b[offset] ^= 1
  return b
}
func remac(_ d: Data, _ keys: P.Keys, _ domain: P.Domain) throws -> Data {
  let payload = Data(d.dropLast(32))
  return try payload
    + Data(
      HMAC<SHA256>.authenticationCode(for: payload, using: SymmetricKey(data: keys.derive(domain))))
}
final class Source: P.GroupSource {
  let bytes: Data
  var cursor = 0
  init(_ bytes: Data) { self.bytes = bytes }
  func readExactly(_ count: Int) -> Data {
    let end = min(bytes.count, cursor + count)
    defer { cursor = end }
    return Data(bytes[cursor..<end])
  }
  func atEnd() -> Bool { cursor == bytes.count }
}
final class Quarantine: P.GroupQuarantine {
  var writes = 0, bytes = 0
  var discarded = false
  var hasher = SHA256()
  func write(frame: Int, plaintext: Data) {
    writes += 1
    bytes += plaintext.count
    hasher.update(data: plaintext)
  }
  func discard() {
    discarded = true
    bytes = 0
  }
}
func authenticate(_ bytes: Data, _ m: P.Manifest, _ keys: P.Keys) throws -> P.VerifiedGroup {
  try P.VerifiedGroup.authenticate(
    source: Source(bytes), quarantine: Quarantine(),
    binding: P.Binding(manifest: m, receiver: m.receiver, origin: m.origin), keys: keys)
}
func rejectGroup(_ bytes: Data, _ m: P.Manifest, _ keys: P.Keys) throws {
  let q = Quarantine()
  try expectFailure {
    _ = try P.VerifiedGroup.authenticate(
      source: Source(bytes), quarantine: q,
      binding: P.Binding(manifest: m, receiver: m.receiver, origin: m.origin), keys: keys)
  }
  try P.check(q.discarded && q.bytes == 0)
}
func deterministic(
  _ m: P.Manifest, _ keys: P.Keys, frame: Int, sealID: Data, nonce: Data, plaintext: Data? = nil,
  header: Data? = nil
) throws -> Data {
  let length = try m.frameLength(frame)
  let bytes = plaintext ?? Data(repeating: 0xa7, count: length)
  let h = try header ?? P.groupHeader(m, frame / 8)
  let sealed = try AES.GCM.seal(
    bytes, using: SymmetricKey(data: keys.derive(.body, frame: frame, sealID: sealID)),
    nonce: AES.GCM.Nonce(data: nonce),
    authenticating: P.aad(h, frame: frame, length: bytes.count, sealID: sealID))
  var w = P.Writer()
  try w.n(UInt64(frame), 4)
  try w.n(UInt64(bytes.count), 4)
  w.bytes(sealID)
  w.bytes(nonce)
  w.bytes(sealed.ciphertext)
  w.bytes(sealed.tag)
  return w.data
}
func clone(
  _ m: P.Manifest, receiver: Data? = nil, origin: String? = nil, job: Data? = nil,
  generation: Data? = nil, destination: P.Destination? = nil, size: UInt64? = nil,
  hashes: [Data]? = nil, name: String? = nil
) throws -> P.Manifest {
  try P.Manifest(
    receiver: receiver ?? m.receiver, origin: origin ?? m.origin, job: job ?? m.job,
    generation: generation ?? m.generation, device: m.device, enrollmentEpoch: m.enrollmentEpoch,
    destination: destination ?? m.destination, originalBytes: size ?? m.originalBytes,
    originalSHA256: m.originalSHA256, safeName: name ?? m.safeName, expiresAt: m.expiresAt,
    frameHashes: hashes ?? m.frameHashes)
}
func runVector(_ input: Vector) throws -> Result {
  let manifestBytes = try data(input.manifest)
  let m = try P.Manifest.decode(manifestBytes)
  let master = try data(input.master)
  let keys = try P.Keys(master: master, manifest: m)
  let context = try P.OutcomeContext.fromManifest(m)
  let authentication = try context.authentication(master: master)
  try P.check(context.bytes == data(input.context) && authentication == data(input.contextAuthentication))
  let restoredContext = try P.OutcomeContext.restore(context.bytes, master: master, authentication: authentication)
  let minimal = try P.Keys(master: master, outcome: restoredContext)
  for domain in [P.Domain.ack, .receipt, .status] { try P.check(minimal.derive(domain) == keys.derive(domain)) }
  try expectFailure { _ = try minimal.derive(.body, frame: 0, sealID: Data(repeating: 0, count: 16)) }
  for i in context.bytes.indices {
    try expectFailure { _ = try P.OutcomeContext.restore(flip(context.bytes, i), master: master, authentication: authentication) }
  }
  func restoreRemac(_ bytes: Data) throws -> P.OutcomeContext {
    let mac = Data(HMAC<SHA256>.authenticationCode(for: Data("footage/sealed-v1/context-storage".utf8) + bytes,
      using: SymmetricKey(data: master)))
    return try P.OutcomeContext.restore(bytes, master: master, authentication: mac)
  }
  for n in 0..<context.bytes.count { try expectFailure { _ = try restoreRemac(Data(context.bytes.prefix(n))) } }
  try expectFailure { _ = try restoreRemac(context.bytes + Data([0])) }
  for offset in [context.bytes.count - 10, context.bytes.count - 6, context.bytes.count - 1] {
    try expectFailure { _ = try restoreRemac(flip(context.bytes, offset)) }
  }
  var badExpiry = context.bytes
  badExpiry.replaceSubrange((badExpiry.count - 18)..<(badExpiry.count - 10), with: Data(repeating: 255, count: 8))
  let changedExpiryKeys = try P.Keys(master: master, outcome: restoreRemac(badExpiry))
  try expectFailure {
    _ = try P.VerifiedStatus.verify(data(input.statuses[0]), keys: changedExpiryKeys,
      query: P.Query.decode(data(input.query), outcome: context), highWater: 0)
  }
  let digestOffset = 98 + m.origin.utf8.count
  let rebound = try P.Keys(master: master, outcome: restoreRemac(flip(context.bytes, digestOffset)))
  try expectFailure { _ = try P.VerifiedReceipt.verify(data(input.receipt), keys: rebound) }
  let wrongDestination = try P.Keys(master: master, outcome: restoreRemac(flip(context.bytes, digestOffset + 32)))
  try expectFailure { _ = try P.VerifiedReceipt.verify(data(input.receipt), keys: wrongDestination) }
  var badOrigin = context.bytes; badOrigin[42] = 72
  try expectFailure { _ = try restoreRemac(badOrigin) }
  for byte: UInt8 in [0, 255] {
    var badLength = context.bytes
    badLength.replaceSubrange((digestOffset + 64)..<(digestOffset + 72), with: Data(repeating: byte, count: 8))
    try expectFailure { _ = try restoreRemac(badLength) }
  }
  var invalidJob = context.bytes
  invalidJob.replaceSubrange((42 + m.origin.utf8.count)..<(58 + m.origin.utf8.count), with: Data(repeating: 0x11, count: 16))
  let invalidKeys = try P.Keys(master: master, outcome: restoreRemac(invalidJob))
  let goodID = Data((try data(input.receipt))[136..<152])
  try expectFailure {
    let receipt = try P.encodeReceipt(keys: invalidKeys, id: goodID, verifiedAt: 1800000000, revision: 9)
    _ = try P.VerifiedReceipt.verify(receipt, keys: invalidKeys).toOriginalReceipt()
  }
  try expectFailure {
    let receipt = try P.encodeReceipt(keys: minimal, id: goodID, verifiedAt: 253_402_300_800, revision: 9)
    _ = try P.VerifiedReceipt.verify(receipt, keys: minimal).toOriginalReceipt()
  }
  for s in input.statuses {
    _ = try P.VerifiedStatus.verify(data(s), keys: minimal, query: P.Query.decode(data(input.query), outcome: context), highWater: 0)
  }
  _ = try P.VerifiedReceipt.verify(data(input.receipt), keys: minimal).toOriginalReceipt()
  let inputPacket = try data(input.packet)
  let header = try P.groupHeader(m, 0)
  let id = Data(inputPacket[8..<24])
  let nonce = Data(inputPacket[24..<36])
  let bodyKey = try keys.derive(.body, frame: 0, sealID: id)
  let packet = try deterministic(m, keys, frame: 0, sealID: id, nonce: nonce)
  try P.check(inputPacket == packet)
  let wire = P.hash(header + packet)
  _ = try authenticate(try data(input.header) + inputPacket, m, keys)
  _ = try authenticate(header + data(input.nodeRandomPacket), m, keys)
  let ackInput = try P.VerifiedAck.verify(data(input.ack), keys: keys, group: 0, wireSHA256: wire)
  let ack = try P.encodeAck(keys: keys, group: 0, wireSHA256: wire, revision: ackInput.revision)
  _ = try P.VerifiedAck.verify(ack, keys: minimal, group: 0, wireSHA256: wire)
  try P.check(P.encodeAck(keys: minimal, group: 0, wireSHA256: wire, revision: ackInput.revision) == ack)
  let receiptInput = try P.VerifiedReceipt.verify(data(input.receipt), keys: keys)
  try P.check(receiptInput.bytes == m.originalBytes && receiptInput.sha256 == m.originalSHA256)
  let shared = try receiptInput.toOriginalReceipt()
  try P.check(shared.bytes == m.originalBytes && shared.verifiedAt == "2027-01-15T08:00:00.000Z")
  let receipt = try P.encodeReceipt(
    keys: keys, id: receiptInput.id, verifiedAt: receiptInput.verifiedAt,
    revision: receiptInput.revision)
  _ = try P.verifyOutcome(
    data(input.outcome), httpStatus: 200, keys: keys, group: 0, wireSHA256: wire)
  let query = try P.Query.decode(data(input.query), manifest: m)
  var statuses: [String] = []
  for s in input.statuses {
    let v = try P.VerifiedStatus.verify(data(s), keys: keys, query: query, highWater: 0)
    let fields = try P.StatusFields(
      revision: v.revision, state: v.state, cleanup: v.cleanup, groupBitmap: v.groupBitmap)
    statuses.append(
      hex(
        try P.encodeStatus(
          keys: keys, query: query, fields: fields, receipt: v.receipt == nil ? Data() : receipt)))
  }
  let restored = try P.decodeSetup(data(input.setup), manifest: m)
  try P.check(restored.derive(.ack) == keys.derive(.ack))
  let vector = try Vector(
    context: hex(context.bytes), contextAuthentication: hex(authentication),
    nodeRandomPacket: input.nodeRandomPacket, manifest: hex(clone(m).bytes), digest: hex(m.digest),
    master: hex(master), destination: hex(m.destination.encode()),
    destinationDigest: hex(m.destinationDigest), header: hex(header), packet: hex(packet),
    aad: hex(P.aad(header, frame: 0, length: m.frameLength(0), sealID: id)), bodyKey: hex(bodyKey),
    ackKey: hex(keys.derive(.ack)), receiptKey: hex(keys.derive(.receipt)),
    statusKey: hex(keys.derive(.status)), ack: hex(ack), receipt: hex(receipt),
    outcome: hex(P.encodeOutcome(ack: ack, receipt: receipt)), query: hex(query.encode(m)),
    statuses: statuses, setup: hex(P.encodeSetup(keys: keys, master: master)))
  let session = P.SealSession(keys: keys)
  var persisted = false
  let intent = try session.consume(frame: 0) { record in
    try P.check(record.manifestDigest == m.digest && record.sealID.count == 16)
    persisted = true
  }
  try P.check(persisted)
  let randomPacket = try intent.seal(Data(repeating: 0xa7, count: m.frameLength(0)))
  try expectFailure { _ = try intent.seal(Data(repeating: 0xa7, count: m.frameLength(0))) }
  try expectFailure { _ = try session.consume(frame: 0) { _ in } }
  _ = try authenticate(header + randomPacket, m, keys)
  _ = try authenticate(header + randomPacket, m, keys)  // Retry the exact saved bytes.
  let failed = P.SealSession(keys: keys)
  try expectFailure { _ = try failed.consume(frame: 0) { _ in throw P.Failure.invalid } }
  try expectFailure { _ = try failed.consume(frame: 0) { _ in } }
  let failedHash = try P.SealSession(keys: keys).consume(frame: 0) { _ in }
  try expectFailure { _ = try failedHash.seal(Data(repeating: 0, count: m.frameLength(0))) }
  try expectFailure { _ = try failedHash.seal(Data(repeating: 0xa7, count: m.frameLength(0))) }
  return Result(vector: vector, randomPacket: hex(randomPacket))
}
func adversarial(_ v: Vector) throws {
  let mb = try data(v.manifest)
  let m = try P.Manifest.decode(mb)
  let master = try data(v.master)
  let keys = try P.Keys(master: master, manifest: m)
  let h = try P.groupHeader(m, 0)
  let packet = try data(v.packet)
  let body = h + packet
  let wire = P.hash(body)
  for i in 0..<mb.count { try expectFailure { _ = try P.Manifest.decode(Data(mb.prefix(i))) } }
  try expectFailure { _ = try P.Manifest.decode(mb + Data([0])) }
  try expectFailure { _ = try P.Manifest.decode(Data(count: 65537)) }
  for i in 0..<body.count { try rejectGroup(Data(body.prefix(i)), m, keys) }
  for at in [
    0, 8, 40, 56, 72, 104, 108, 112, 114, 116, 124, 128, 132, 136, 152, 164, body.count - 1,
  ] { try rejectGroup(flip(body, at), m, keys) }
  try rejectGroup(body + Data([0]), m, keys)
  let variants = try [
    clone(m, receiver: P.random(32)), clone(m, origin: "https://other.example:443"),
    clone(m, job: P.random(16)), clone(m, generation: P.random(16)),
    clone(m, destination: .standalone(intake: P.random(16))),
  ]
  for wrong in variants { try rejectGroup(body, wrong, P.Keys(master: master, manifest: wrong)) }
  try rejectGroup(body, m, P.Keys(master: P.random(32), manifest: m))
  try expectFailure { _ = try P.Binding(manifest: m, receiver: P.random(32), origin: m.origin) }
  try expectFailure {
    _ = try P.Binding(manifest: m, receiver: m.receiver, origin: "https://other.example:443")
  }
  let id = Data(packet[8..<24])
  let nonce = Data(packet[24..<36])
  try rejectGroup(
    h
      + deterministic(
        m, keys, frame: 0, sealID: id, nonce: nonce,
        plaintext: Data(repeating: 0, count: m.frameLength(0))), m, keys)
  for name in [
    "", "../file", "file\\name", "e\u{301}.mov", "bad\u{0}", String(repeating: "a", count: 241),
  ] { try expectFailure { _ = try clone(m, name: name) } }
  for origin in [
    "http://receiver.example:443", "https://Receiver.example:443", "https://receiver.example:0443",
    "https://receiver.example:0", "https://receiver.example:65536", "https://receiver.example.:443",
    "https://receiver.example:443/", "https://a@receiver.example:443",
    "https://receiver.example:443?x", "https://127.1:443", "https://0177.0.0.1:443",
    "https://[2001:0db8::1]:443", "https://[::ffff:192.0.2.1]:443", "https://[fe80::1%25en0]:443",
    "https://é.example:443", "https://a_b:443", "https://xn--a:443", "https://xn--abc:443",
  ] { try expectFailure { _ = try P.origin(origin) } }
  for origin in [
    "https://receiver.example:443", "https://127.0.0.1:1", "https://[2001:db8::1]:65535",
    "https://[::]:443", "https://xn--caf-dma.example:443", "https://receiver.0xyz:443", "https://[::ffff:c000:201]:443",
  ] { try P.check(P.origin(origin) == origin) }
  for s in ["", "e\u{301}", String(repeating: "é", count: 65)] {
    try expectFailure {
      _ = try P.Destination.t3(
        environment: s, project: "p", thread: "t", workspace: "w", consent: Data(count: 16)
      ).encode()
    }
  }
  let destination = try m.destination.encode()
  for i in 0..<destination.count {
    try expectFailure { _ = try P.Destination.decode(Data(destination.prefix(i))) }
  }
  for bytes in [Data([0]), Data([3]), destination + Data([0]), Data([2, 0, 1, 0xff])] {
    try expectFailure { _ = try P.Destination.decode(bytes) }
  }
  try m.validateSetupTime(now: m.expiresAt - 7 * 86400)
  try expectFailure { try m.validateSetupTime(now: m.expiresAt) }
  try expectFailure { try m.validateSetupTime(now: m.expiresAt - 7 * 86400 - 1) }
  let destinationSize = try m.destination.encode().count
  let originalOffset = 8 + 32 + 2 + m.origin.utf8.count + 48 + 8 + 2 + destinationSize
  var overflow = mb
  overflow.replaceSubrange(
    originalOffset..<(originalOffset + 8), with: Data(repeating: 255, count: 8))
  try expectFailure { _ = try P.Manifest.decode(overflow) }
  var badCount = mb
  badCount.replaceSubrange((mb.count - 36)..<(mb.count - 32), with: Data(repeating: 255, count: 4))
  try expectFailure { _ = try P.Manifest.decode(badCount) }
  var badLP = mb
  badLP[40] = 255
  badLP[41] = 255
  try expectFailure { _ = try P.Manifest.decode(badLP) }
  let unrenderable = try P.encodeReceipt(
    keys: keys, id: P.random(16), verifiedAt: UInt64.max, revision: 9)
  try expectFailure {
    _ = try P.VerifiedReceipt.verify(unrenderable, keys: keys).toOriginalReceipt()
  }
  try expectFailure { _ = try clone(m, size: 0) }
  try expectFailure { _ = try clone(m, size: UInt64.max) }
  try expectFailure { _ = try clone(m, size: P.maxOriginal + 1) }
  try expectFailure { _ = try clone(m, hashes: []) }
  try expectFailure { _ = try clone(m, hashes: Array(repeating: Data(count: 32), count: 513)) }
  let max = try clone(m, size: P.maxOriginal, hashes: Array(repeating: Data(count: 32), count: 512))
  try P.check(
    max.groupCount == 64 && max.contiguous(UInt64.max) == P.maxOriginal && max.contiguous(2) == 0
      && max.contiguous(5) == 64 * 1024 * 1024)
  try expectFailure { _ = try m.contiguous(2) }
  try expectFailure { _ = try max.partition(64) }
  try expectFailure { _ = try max.frameLength(512) }
  let ack = try data(v.ack)
  let receipt = try data(v.receipt)
  let query = try P.Query.decode(data(v.query), manifest: m)
  for bytes in [ack, receipt] {
    for i in 0..<bytes.count {
      try expectFailure {
        if bytes.count == 192 {
          _ = try P.VerifiedAck.verify(
            Data(bytes.prefix(i)), keys: keys, group: 0, wireSHA256: wire)
        } else {
          _ = try P.VerifiedReceipt.verify(Data(bytes.prefix(i)), keys: keys)
        }
      }
      try expectFailure {
        if bytes.count == 192 {
          _ = try P.VerifiedAck.verify(flip(bytes, i), keys: keys, group: 0, wireSHA256: wire)
        } else {
          _ = try P.VerifiedReceipt.verify(flip(bytes, i), keys: keys)
        }
      }
    }
  }
  try expectFailure {
    _ = try P.VerifiedAck.verify(ack, keys: keys, group: 0, wireSHA256: P.random(32))
  }
  try expectFailure { _ = try P.VerifiedAck.verify(ack, keys: keys, group: 1, wireSHA256: wire) }
  try expectFailure {
    _ = try P.VerifiedAck.verify(remac(ack, keys, .status), keys: keys, group: 0, wireSHA256: wire)
  }
  try expectFailure {
    _ = try P.VerifiedAck.verify(
      remac(flip(ack, 140), keys, .ack), keys: keys, group: 0, wireSHA256: wire)
  }
  try expectFailure { _ = try P.VerifiedReceipt.verify(ack, keys: keys) }
  try expectFailure {
    _ = try P.VerifiedReceipt.verify(remac(flip(receipt, 104), keys, .receipt), keys: keys)
  }
  let outcome = try data(v.outcome)
  for status in [201, 204, 302, 500] {
    try expectFailure {
      _ = try P.verifyOutcome(outcome, httpStatus: status, keys: keys, group: 0, wireSHA256: wire)
    }
  }
  for i in 0..<outcome.count {
    try expectFailure {
      _ = try P.verifyOutcome(
        Data(outcome.prefix(i)), httpStatus: 200, keys: keys, group: 0, wireSHA256: wire)
    }
  }
  try expectFailure {
    _ = try P.verifyOutcome(
      outcome + Data([0]), httpStatus: 200, keys: keys, group: 0, wireSHA256: wire)
  }
  try expectFailure {
    _ = try P.verifyOutcome(
      Data(count: 4097), httpStatus: 200, keys: keys, group: 0, wireSHA256: wire)
  }
  let received = try data(v.statuses[2])
  for i in 0..<received.count {
    try expectFailure {
      _ = try P.VerifiedStatus.verify(
        Data(received.prefix(i)), keys: keys, query: query, highWater: 0)
    }
  }
  try expectFailure {
    _ = try P.VerifiedStatus.verify(
      received, keys: keys, query: P.Query.fresh(operation: query.operation), highWater: 0)
  }
  try expectFailure {
    _ = try P.VerifiedStatus.verify(
      received, keys: keys, query: P.Query.fresh(operation: P.random(16)), highWater: 0)
  }
  try expectFailure {
    _ = try P.VerifiedStatus.verify(received, keys: keys, query: query, highWater: 100)
  }
  for at in [0, 8, 40, 56, 72, 104, 120, 152, 160, 161, 162, 170, 178, 186, received.count - 1] {
    try expectFailure {
      _ = try P.VerifiedStatus.verify(flip(received, at), keys: keys, query: query, highWater: 0)
    }
  }
  for at in [160, 161, 162, 170, 178] {
    try expectFailure {
      _ = try P.VerifiedStatus.verify(
        remac(flip(received, at), keys, .status), keys: keys, query: query, highWater: 0)
    }
  }
  try expectFailure {
    _ = try P.VerifiedStatus.verify(
      remac(received, keys, .ack), keys: keys, query: query, highWater: 0)
  }
  for (state, cleanup) in [(UInt8(0), UInt8(0)), (3, 0), (4, 0), (1, 1), (7, 0)] {
    try expectFailure {
      _ = try P.encodeStatus(
        keys: keys, query: query,
        fields: P.StatusFields(revision: 10, state: state, cleanup: cleanup, groupBitmap: 1))
    }
  }
  let sparse = try clone(
    m, size: 2 * 64 * 1024 * 1024 + 1, hashes: Array(repeating: Data(count: 32), count: 17))
  let sk = try P.Keys(master: master, manifest: sparse)
  for (bitmap, prefix) in [
    (UInt64(2), UInt64(0)), (5, 64 * 1024 * 1024), (7, sparse.originalBytes),
  ] {
    let fields = try P.StatusFields(revision: 1, state: 1, cleanup: 0, groupBitmap: bitmap)
    let bytes = try P.encodeStatus(keys: sk, query: query, fields: fields)
    try P.check(
      P.VerifiedStatus.verify(bytes, keys: sk, query: query, highWater: 0).contiguousOriginalBytes
        == prefix)
  }
  for bytes in [try data(v.setup), try data(v.query)] {
    for i in 0..<bytes.count {
      try expectFailure {
        if bytes.count == 80 {
          _ = try P.decodeSetup(Data(bytes.prefix(i)), manifest: m)
        } else {
          _ = try P.Query.decode(Data(bytes.prefix(i)), manifest: m)
        }
      }
    }
    try expectFailure {
      if bytes.count == 80 {
        _ = try P.decodeSetup(bytes + Data([0]), manifest: m)
      } else {
        _ = try P.Query.decode(bytes + Data([0]), manifest: m)
      }
    }
  }
  for i in 0..<200 {
    let noise = try P.random(i * 7)
    try expectFailure { _ = try P.Manifest.decode(noise) }
    try expectFailure {
      _ = try P.VerifiedStatus.verify(noise, keys: keys, query: query, highWater: 0)
    }
  }
}
final class EightFrameSource: P.GroupSource {
  let manifest: P.Manifest, keys: P.Keys, session: P.SealSession
  var cursor = -1, wire = 0
  init(_ manifest: P.Manifest, _ keys: P.Keys) {
    self.manifest = manifest
    self.keys = keys
    session = P.SealSession(keys: keys)
  }
  func readExactly(_ count: Int) throws -> Data {
    if cursor == -1 {
      cursor = 0
      let h = try P.groupHeader(manifest, 0)
      try P.check(count == 128)
      wire += h.count
      return h
    }
    try P.check(cursor < 8 && count == P.frameBytes + 52)
    let intent = try session.consume(frame: cursor) { _ in }
    cursor += 1
    let packet = try intent.seal(Data(repeating: 0xa7, count: P.frameBytes))
    wire += packet.count
    return packet
  }
  func atEnd() -> Bool { cursor == 8 }
}
func fullBoundary(_ v: Vector) throws {
  let base = try P.Manifest.decode(data(v.manifest))
  let block = Data(repeating: 0xa7, count: P.frameBytes)
  let frameHash = P.hash(block)
  var hash = SHA256()
  for _ in 0..<8 { hash.update(data: block) }
  let m = try P.Manifest(
    receiver: base.receiver, origin: base.origin, job: base.job, generation: base.generation,
    device: base.device, enrollmentEpoch: UInt64.max, destination: base.destination,
    originalBytes: UInt64(P.frameBytes) * 8, originalSHA256: Data(hash.finalize()),
    safeName: base.safeName, expiresAt: base.expiresAt,
    frameHashes: Array(repeating: frameHash, count: 8))
  let keys = try P.Keys(master: data(v.master), manifest: m)
  let source = EightFrameSource(m, keys)
  let q = Quarantine()
  let verified = try P.VerifiedGroup.authenticate(
    source: source, quarantine: q,
    binding: P.Binding(manifest: m, receiver: m.receiver, origin: m.origin), keys: keys)
  try P.check(
    source.wire == P.maxGroupWire && q.writes == 8 && verified.partition.length == 64 * 1024 * 1024
      && Data(q.hasher.finalize()) == m.originalSHA256)
  // A valid first frame followed by a truncated/invalid last frame never yields a VerifiedGroup.
  let two = try clone(
    base, size: UInt64(P.frameBytes) + 1, hashes: [frameHash, P.hash(Data([0xa7]))])
  let tk = try P.Keys(master: data(v.master), manifest: two)
  let th = try P.groupHeader(two, 0)
  let first = try deterministic(two, tk, frame: 0, sealID: P.random(16), nonce: P.random(12))
  let last = try deterministic(two, tk, frame: 1, sealID: P.random(16), nonce: P.random(12))
  let invalid = th + first + flip(last, last.count - 1)
  let failed = Quarantine()
  try expectFailure {
    _ = try P.VerifiedGroup.authenticate(
      source: Source(invalid), quarantine: failed,
      binding: P.Binding(manifest: two, receiver: two.receiver, origin: two.origin), keys: tk)
  }
  try P.check(failed.writes == 1 && failed.discarded && failed.bytes == 0)
  let duplicateID = try P.random(16)
  let duplicateFirst = try deterministic(
    two, tk, frame: 0, sealID: duplicateID, nonce: P.random(12))
  let duplicateLast = try deterministic(two, tk, frame: 1, sealID: duplicateID, nonce: P.random(12))
  try rejectGroup(th + duplicateFirst + duplicateLast, two, tk)
}
@main struct Harness {
  static func main() throws {
    let input = try JSONDecoder().decode(
      [Vector].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    var results: [Result] = []
    for vector in input {
      results.append(try runVector(vector))
      try adversarial(vector)
    }
    guard let first = input.first else { throw P.Failure.invalid }
    try fullBoundary(first)
    let output = try JSONEncoder().encode(results)
    try output.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
    FileHandle.standardError.write(
      Data(
        "Swift CryptoKit: bidirectional vectors, adversarial boundaries and 8-frame 64 MiB + 544 passed\n"
          .utf8))
  }
}

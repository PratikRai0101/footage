import Foundation

struct PairingInstalledIdentity: Sendable {
  let receiver: Data, origin: String, device: Data, epoch: UInt64, expires: UInt64, permissions: UInt32
}

// Native-only minimal immutable authority context. Contains no filename, frame
// hashes, selected URI, credential, or signing key. Adapt OutcomeContext here,
// not by opening the .complete private display manifest during cancellation.
struct PairingControlBinding: Equatable, Sendable {
  let receiver: Data, origin: String, device: Data, epoch: UInt64
  let job: Data, generation: Data, manifestDigest: Data, intake: Data, expires: UInt64
  init(receiver: Data, origin: String, device: Data, epoch: UInt64, job: Data, generation: Data, manifestDigest: Data, intake: Data, expires: UInt64) throws {
    try pairingRequire(receiver.count == 32 && device.count == 16 && job.count == 16 && generation.count == 16 && manifestDigest.count == 32 && intake.count == 16 && epoch > 0)
    _ = try PairingOrigin(origin)
    self.receiver = receiver; self.origin = origin; self.device = device; self.epoch = epoch
    self.job = job; self.generation = generation; self.manifestDigest = manifestDigest; self.intake = intake; self.expires = expires
  }
  init(saved bytes: Data) throws {
    var r = try PairingReader(bytes, "FTCTL001")
    let receiver = try r.take(32)
    guard let origin = String(data: try r.lp32(512), encoding: .utf8) else { throw PairingFailure.rejected }
    let device = try r.take(16), epoch = try r.integer(8), job = try r.take(16), generation = try r.take(16)
    let digest = try r.take(32), intake = try r.take(16), expires = try r.integer(8); try r.end()
    try self.init(receiver: receiver, origin: origin, device: device, epoch: epoch, job: job, generation: generation, manifestDigest: digest, intake: intake, expires: expires)
  }
  var bytes: Data {
    // Origin constructor bounds it to LP16; no secret material in this record.
    var result = Data("FTCTL001".utf8)
    for part in [receiver, pairingU32(UInt32(origin.utf8.count)), Data(origin.utf8), device, pairingU64(epoch), job, generation, manifestDigest, intake, pairingU64(expires)] { result.append(part) }
    return result
  }
  func validate(offer: PairingOffer, device: Data, epoch: UInt64, expires: UInt64, requireFreshJob: Bool = true) throws {
    try pairingRequire(receiver == offer.receiver && origin == offer.origin.text && self.device == device && self.epoch == epoch)
    try pairingRequire(self.expires <= expires)
    if requireFreshJob { try pairingRequire(self.expires > UInt64(Date().timeIntervalSince1970)) }
  }
  func validateBody(_ body: Data, operation: PairingControlOperation) throws {
    try pairingRequire(body.count <= 65536)
    if operation == .setup {
      try pairingRequire(pairingHash(body) == manifestDigest)
      var r = try PairingReader(body, "FTMAN001", limit: 65536)
      try pairingRequire(try r.take(32) == receiver)
      try pairingRequire(try r.lp16(512) == Data(origin.utf8))
      try pairingRequire(try r.take(16) == job && r.take(16) == generation && r.take(16) == device && r.integer(8) == epoch)
      try pairingRequire(try r.lp16(17) == Data([1]) + intake)
      // Full canonical manifest validation is the native G2 constructor's job.
      // Independently check expiry too, so a binding cannot relabel its lifetime.
      _ = try r.integer(8); _ = try r.take(32); _ = try r.lp16(240)
      try pairingRequire(try r.integer(8) == expires)
    } else if let purpose = operation.handoffPurpose {
      var r = try PairingReader(body, "FTHAND01", limit: 121)
      try pairingRequire(try r.integer(1) == UInt64(purpose))
      try pairingRequire(try r.take(16) == job && r.take(16) == generation && r.take(32) == manifestDigest)
      _ = try r.take(16); _ = try r.take(32); try r.end()
    } else {
      var r = try PairingReader(body, "FTQUERY1", limit: 65536)
      try pairingRequire(try r.take(16) == job && r.take(16) == generation && r.take(32) == manifestDigest)
      _ = try r.take(16); _ = try r.take(32); try r.end()
    }
  }
}
// A job keeps its own installed authority. Reading current settings or pairing
// during a request would incorrectly make a future-job change affect this job.
struct PairingControlInstallation {
  let binding: PairingControlBinding, offer: PairingOffer, spki: Data, mask: UInt32
  let reply: Data, record: PairingVerifiedRecord
  init(binding: PairingControlBinding, offer: PairingOffer, spki: Data, mask: UInt32, reply: Data) throws {
    try pairingRequire(mask & ~offer.mask == 0)
    let record = try PairingVerifiedRecord(installedReply: reply, offer: offer, device: binding.device, spki: spki, mask: mask)
    try binding.validate(offer: offer, device: binding.device, epoch: record.epoch, expires: record.expires, requireFreshJob: false)
    self.binding = binding; self.offer = offer; self.spki = spki; self.mask = mask; self.reply = reply; self.record = record
  }
  init(_ bytes: Data) throws {
    var r = try PairingReader(bytes, "FTCTLA01", limit: 4096)
    let binding = try PairingControlBinding(saved: r.lp16(1024)), offer = try PairingOffer(r.lp16(2048), requireFresh: false)
    let spki = try r.lp16(128), mask = UInt32(try r.integer(4)), reply = try r.lp16(16384); try r.end()
    try self.init(binding: binding, offer: offer, spki: spki, mask: mask, reply: reply)
  }
  var bytes: Data { get throws {
    let result = try Data("FTCTLA01".utf8) + pairingLP(binding.bytes) + pairingLP(offer.bytes) + pairingLP(spki) + pairingU32(mask) + pairingLP(reply)
    try pairingRequire(result.count <= 4096); return result
  } }
  var authorityDigest: Data { get throws {
    let prefix = try pairingLP(offer.identitySPKI) + pairingLP(offer.ca) + offer.pin + pairingLP(Data(offer.origin.text.utf8))
    return pairingHash(prefix + binding.device + spki + pairingU32(mask) + pairingU64(record.epoch) + pairingU64(record.expires) + pairingHash(record.credential))
  } }
}
enum PairingControlOperation: Sendable {
  case setup, status, revoke, view, handoffStatus, deliver, send
  var permission: UInt32 { switch self { case .setup, .deliver, .send: return 0x01; case .status, .handoffStatus: return 0x02; case .revoke: return 0x04; case .view: return 0x08 } }
  var route: PairingRoute { switch self { case .setup: return .setup; case .status: return .status; case .revoke: return .revoke; case .view: return .view; case .handoffStatus: return .handoffStatus; case .deliver: return .deliver; case .send: return .send } }
  var handoffPurpose: UInt8? { switch self { case .handoffStatus: return 0; case .deliver: return 1; case .send: return 2; default: return nil } }
}

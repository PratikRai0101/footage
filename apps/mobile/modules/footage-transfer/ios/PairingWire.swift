import Foundation
import CryptoKit
import Security
import Darwin

enum PairingFailure: Error { case rejected, storage, transport }
func pairingRequire(_ value: Bool) throws { if !value { throw PairingFailure.rejected } }
func pairingHash(_ bytes: Data) -> Data { Data(SHA256.hash(data: bytes)) }
func pairingRandom(_ count: Int) throws -> Data {
  var bytes = Data(count: count)
  let status = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
  try pairingRequire(status == errSecSuccess); return bytes
}
func pairingU32(_ value: UInt32) -> Data { withUnsafeBytes(of: value.bigEndian) { Data($0) } }
func pairingU64(_ value: UInt64) -> Data { withUnsafeBytes(of: value.bigEndian) { Data($0) } }
func pairingLP(_ data: Data) throws -> Data {
  try pairingRequire(data.count <= 65535)
  return withUnsafeBytes(of: UInt16(data.count).bigEndian) { Data($0) } + data
}
struct PairingReader {
  let data: Data
  var offset = 0
  init(_ bytes: Data, _ magic: String, limit: Int = 16384) throws {
    try pairingRequire(bytes.count <= limit); data = bytes
    try pairingRequire(try take(8) == Data(magic.utf8))
  }
  mutating func take(_ count: Int) throws -> Data {
    try pairingRequire(count >= 0 && count <= data.count - offset)
    defer { offset += count }; return data.subdata(in: offset..<(offset + count))
  }
  mutating func integer(_ count: Int) throws -> UInt64 {
    try take(count).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
  }
  mutating func lp16(_ max: Int) throws -> Data { let n = Int(try integer(2)); try pairingRequire(n <= max); return try take(n) }
  mutating func lp32(_ max: Int) throws -> Data { let n = try integer(4); try pairingRequire(n <= max); return try take(Int(n)) }
  var prefix: Data { data.prefix(offset) }
  func end() throws { try pairingRequire(offset == data.count) }
}
struct PairingOrigin: Equatable {
  let text: String
  let host: String // unbracketed for SSL policy
  let port: Int
  init(_ text: String) throws {
    try pairingRequire(text.utf8.count <= 512 && text.hasPrefix("https://") && text.utf8.allSatisfy { $0 > 32 && $0 < 127 })
    let authority = String(text.dropFirst(8))
    guard let colon = authority.lastIndex(of: ":"), let port = Int(authority[authority.index(after: colon)...]) else { throw PairingFailure.rejected }
    let portText = String(authority[authority.index(after: colon)...]), hostText = String(authority[..<colon])
    try pairingRequire(port >= 1 && port <= 65535 && String(port) == portText)
    let host: String
    if hostText.hasPrefix("[") && hostText.hasSuffix("]") {
      host = String(hostText.dropFirst().dropLast()); var address = in6_addr()
      try pairingRequire(inet_pton(AF_INET6, host, &address) == 1)
      let bytes = withUnsafeBytes(of: &address) { Array($0) }
      let groups = (0..<8).map { Int(bytes[$0 * 2]) * 256 + Int(bytes[$0 * 2 + 1]) }
      var bestStart = -1, bestLength = 1, i = 0
      while i < 8 {
        if groups[i] != 0 { i += 1; continue }
        let start = i; while i < 8 && groups[i] == 0 { i += 1 }
        if i - start > bestLength { bestStart = start; bestLength = i - start }
      }
      let canonical: String
      if bestStart < 0 { canonical = groups.map { String($0, radix: 16) }.joined(separator: ":") }
      else { canonical = groups.prefix(bestStart).map { String($0, radix: 16) }.joined(separator: ":") + "::" + groups.dropFirst(bestStart + bestLength).map { String($0, radix: 16) }.joined(separator: ":") }
      try pairingRequire(canonical == host)
    } else {
      host = hostText
      try pairingRequire(host.count <= 253 && !host.isEmpty)
      if host.allSatisfy({ $0.isNumber || $0 == "." }) {
        var address = in_addr(); try pairingRequire(inet_pton(AF_INET, host, &address) == 1)
        var result = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        try pairingRequire(inet_ntop(AF_INET, &address, &result, socklen_t(result.count)) != nil)
        let canonical = String(decoding: result.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        try pairingRequire(canonical == host)
      } else {
        for label in host.split(separator: ".", omittingEmptySubsequences: false) {
          try pairingRequire(!label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-" && label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 })
        }
      }
    }
    self.text = text; self.host = host; self.port = port
  }
}
func pairingP256(_ bytes: Data) throws -> P256.Signing.PublicKey {
  let key = try P256.Signing.PublicKey(derRepresentation: bytes)
  try pairingRequire(bytes.count == 91 && key.derRepresentation == bytes); return key
}
struct PairingOffer {
  let bytes: Data, identitySPKI: Data, receiver: Data, ca: Data, pin: Data, origin: PairingOrigin, id: Data, secret: Data
  let expires: UInt64, mask: UInt32
  init(_ bytes: Data, now: UInt64 = UInt64(Date().timeIntervalSince1970), requireFresh: Bool = true) throws {
    var r = try PairingReader(bytes, "FTQR0001", limit: 2048)
    let spki = try r.lp16(128); _ = try pairingP256(spki)
    identitySPKI = spki; receiver = pairingHash(spki); ca = try r.lp16(1024); pin = try r.take(32)
    guard let text = String(data: try r.lp16(512), encoding: .utf8) else { throw PairingFailure.rejected }
    origin = try PairingOrigin(text); id = try r.take(16); secret = try r.take(32); expires = try r.integer(8)
    mask = UInt32(try r.integer(4)); try r.end()
    try pairingRequire(!ca.isEmpty && mask & ~31 == 0)
    if requireFresh { try pairingRequire(expires > now && expires - now <= 120) }
    self.bytes = bytes
  }
}
struct PairingVerifiedRecord {
  init(installedReply: Data, offer: PairingOffer, device: Data, spki: Data, mask: UInt32) throws {
    var reply = try PairingReader(installedReply, "FTENRO01"); _ = try reply.take(32)
    var record = try PairingReader(reply.lp32(16384), "FTPAIR01"); try reply.end()
    _ = try record.take(32); _ = try record.lp16(512); _ = try record.take(16); _ = try record.lp16(128)
    _ = try record.integer(4); _ = try record.integer(8); _ = try record.integer(8); _ = try record.take(32)
    let nonce = try record.take(32)
    try self.init(reply: installedReply, offer: offer, device: device, spki: spki, mask: mask, nonce: nonce)
  }
  let bytes: Data, credential: Data
  let epoch: UInt64, expires: UInt64
  init(reply: Data, offer: PairingOffer, device: Data, spki: Data, mask: UInt32, nonce: Data) throws {
    var r = try PairingReader(reply, "FTENRO01"); credential = try r.take(32); bytes = try r.lp32(16384); try r.end()
    var p = try PairingReader(bytes, "FTPAIR01")
    try pairingRequire(try p.take(32) == offer.receiver)
    try pairingRequire(try p.lp16(512) == Data(offer.origin.text.utf8))
    try pairingRequire(try p.take(16) == device)
    try pairingRequire(try p.lp16(128) == spki)
    try pairingRequire(try p.integer(4) == UInt64(mask))
    epoch = try p.integer(8); expires = try p.integer(8)
    try pairingRequire(epoch > 0 && expires > UInt64(Date().timeIntervalSince1970))
    try pairingRequire(try p.take(32) == pairingHash(credential)); try pairingRequire(try p.take(32) == nonce)
    let prefix = p.prefix, signature = try P256.Signing.ECDSASignature(derRepresentation: p.lp16(72)); try p.end()
    try pairingRequire(try pairingP256(offer.identitySPKI).isValidSignature(signature, for: prefix))
  }
}
// Returns a candidate only; callers must present old/new identity and origin in native UI.
// It never changes an installed pairing or an in-flight binding.
struct PairingRotation {
  let spki: Data, pin: Data, ca: Data, origin: PairingOrigin, epoch: UInt64
  init(_ bytes: Data, old: PairingOffer, previousEpoch: UInt64, nonce: Data) throws {
    var r = try PairingReader(bytes, "FTROT001")
    try pairingRequire(try r.take(32) == old.receiver); spki = try r.lp16(128); _ = try pairingP256(spki)
    pin = try r.take(32); ca = try r.lp16(1024)
    guard let text = String(data: try r.lp16(512), encoding: .utf8) else { throw PairingFailure.rejected }
    origin = try PairingOrigin(text); epoch = try r.integer(8); let expiry = try r.integer(8), now = UInt64(Date().timeIntervalSince1970)
    try pairingRequire(epoch > previousEpoch && expiry > now && expiry - now <= 120 && !ca.isEmpty)
    try pairingRequire(try r.take(32) == nonce); let prefix = r.prefix, signature = try P256.Signing.ECDSASignature(derRepresentation: r.lp16(72)); try r.end()
    try pairingRequire(try pairingP256(old.identitySPKI).isValidSignature(signature, for: prefix))
  }
}

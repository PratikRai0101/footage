import CryptoKit
import Darwin
import Foundation
import Security

/// Pure sealed-v1 codecs. Does not schedule uploads, publish ranges, or implement a crash ledger.
enum SealedProtocol {
  static let frameBytes = 8 * 1024 * 1024
  static let maxOriginal: UInt64 = 4 * 1024 * 1024 * 1024
  static let maxGroupWire = 64 * 1024 * 1024 + 544
  enum Failure: Error { case invalid, authentication, consumed }
  static func check(_ condition: Bool) throws { if !condition { throw Failure.invalid } }
  static func random(_ count: Int) throws -> Data {
    try check(count >= 0)
    if count == 0 { return Data() }
    var data = Data(count: count)
    let result = data.withUnsafeMutableBytes { buffer -> OSStatus in
      guard let address = buffer.baseAddress else { return errSecParam }
      return SecRandomCopyBytes(kSecRandomDefault, count, address)
    }
    try check(result == errSecSuccess)
    return data
  }
  static func hash(_ bytes: Data) -> Data { Data(SHA256.hash(data: bytes)) }
  static func text(_ value: String, max: Int, name: Bool = false) throws -> Data {
    try check(!value.isEmpty && value.utf8.count <= max)
    let data = Data(value.utf8)
    try check(Data(value.precomposedStringWithCanonicalMapping.utf8) == data)
    if name {
      try check(
        !value.unicodeScalars.contains {
          CharacterSet.controlCharacters.contains($0)
            || CharacterSet(charactersIn: "/\\").contains($0)
            || $0.properties.generalCategory == .format
        })
    }
    return data
  }
  static func origin(_ value: String) throws -> String {
    try check(
      value.utf8.count <= 512 && value.hasPrefix("https://")
        && !value.contains(where: { "/@?#%".contains($0) && $0 != "/" }))
    let rest = String(value.dropFirst(8))
    try check(!rest.contains("/"))
    guard let colon = rest.lastIndex(of: ":") else { throw Failure.invalid }
    let host = String(rest[..<colon])
    let portText = String(rest[rest.index(after: colon)...])
    guard let port = UInt16(portText), port > 0 else { throw Failure.invalid }
    try check(String(port) == portText && host == host.lowercased() && !host.hasSuffix("."))
    if host.hasPrefix("[") {
      try check(host.hasSuffix("]"))
      let address = String(host.dropFirst().dropLast())
      var raw = in6_addr()
      let valid = address.withCString { inet_pton(AF_INET6, $0, &raw) }
      try check(valid == 1)
      let bytes = withUnsafeBytes(of: raw) { Array($0) }
      var words: [UInt16] = []
      for i in stride(from: 0, to: 16, by: 2) {
        words.append(UInt16(bytes[i]) << 8 | UInt16(bytes[i + 1]))
      }
      var bestStart = -1
      var bestLength = 1
      var cursor = 0
      while cursor < 8 {
        if words[cursor] != 0 {
          cursor += 1
          continue
        }
        let start = cursor
        while cursor < 8 && words[cursor] == 0 { cursor += 1 }
        if cursor - start > bestLength {
          bestStart = start
          bestLength = cursor - start
        }
      }
      let canonical: String
      if bestStart >= 0 {
        let left = words[..<bestStart].map { String($0, radix: 16) }.joined(separator: ":")
        let right = words[(bestStart + bestLength)...].map { String($0, radix: 16) }.joined(
          separator: ":")
        canonical = left + "::" + right
      } else {
        canonical = words.map { String($0, radix: 16) }.joined(separator: ":")
      }
      try check(address == canonical)
    } else {
      try check(!host.isEmpty && host.utf8.count <= 253)
      let labels = host.split(separator: ".", omittingEmptySubsequences: false)
      for label in labels {
        try check(
          !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-"
            && label.utf8.allSatisfy {
              ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 45
            })
      }
      // URLComponents decodes A-labels; a second encode rejects malformed or noncanonical IDNA.
      var decoded = URLComponents()
      decoded.scheme = "https"; decoded.host = host; decoded.port = Int(port)
      guard let unicodeHost = decoded.host else { throw Failure.invalid }
      var encoded = URLComponents()
      encoded.scheme = "https"; encoded.host = unicodeHost; encoded.port = Int(port)
      try check(encoded.url?.host == host)
      // URL's numeric-host parser rejects shorthand, octal and hexadecimal IPv4 aliases.
      if let last = labels.last,
        last.allSatisfy({ $0.isNumber })
          || (last.hasPrefix("0x") && last.dropFirst(2).allSatisfy({ $0.isHexDigit }))
      {
        try check(labels.count == 4)
        for label in labels {
          guard let n = UInt8(label) else { throw Failure.invalid }
          try check(String(n) == label)
        }
      }
    }
    return value
  }
  struct Writer {
    var data = Data()
    mutating func bytes(_ value: Data) { data.append(value) }
    mutating func magic(_ value: String) { data.append(contentsOf: value.utf8) }
    mutating func n(_ value: UInt64, _ count: Int) throws {
      try check(count == 8 || value < (UInt64(1) << (count * 8)))
      for i in (0..<count).reversed() { data.append(UInt8(truncatingIfNeeded: value >> (i * 8))) }
    }
    mutating func lp(_ value: Data, _ count: Int = 2) throws {
      try n(UInt64(value.count), count)
      bytes(value)
    }
  }
  struct Reader {
    private let data: Data
    private var offset = 0
    init(_ data: Data, max: Int) throws {
      try check(data.count <= max)
      self.data = Data(data)
    }
    mutating func bytes(_ count: Int) throws -> Data {
      try check(count >= 0 && count <= data.count - offset)
      defer { offset += count }
      return Data(data[offset..<(offset + count)])
    }
    mutating func n(_ count: Int) throws -> UInt64 {
      var value: UInt64 = 0
      for byte in try bytes(count) { value = value << 8 | UInt64(byte) }
      return value
    }
    mutating func small(_ count: Int, _ max: Int) throws -> Int {
      let value = try n(count)
      try check(value <= UInt64(max))
      return Int(value)
    }
    mutating func magic(_ value: String) throws { try check(bytes(8) == Data(value.utf8)) }
    mutating func lp(_ max: Int, _ count: Int = 2) throws -> Data { try bytes(small(count, max)) }
    mutating func string(_ max: Int) throws -> String {
      guard let value = String(data: try lp(max), encoding: .utf8) else { throw Failure.invalid }
      return value
    }
    func end() throws { try check(offset == data.count) }
  }
  enum Destination {
    case standalone(intake: Data)
    case t3(environment: String, project: String, thread: String, workspace: String, consent: Data)
    func encode() throws -> Data {
      var w = Writer()
      switch self {
      case .standalone(let intake):
        try check(intake.count == 16)
        try w.n(1, 1)
        w.bytes(intake)
      case .t3(let environment, let project, let thread, let workspace, let consent):
        try check(consent.count == 16)
        try w.n(2, 1)
        for s in [environment, project, thread, workspace] { try w.lp(text(s, max: 128)) }
        w.bytes(consent)
      }
      return w.data
    }
    static func decode(_ bytes: Data) throws -> Destination {
      var r = try Reader(bytes, max: 537)
      let variant = try r.n(1)
      let d: Destination
      switch variant {
      case 1: d = .standalone(intake: try r.bytes(16))
      case 2:
        d = .t3(
          environment: try r.string(128), project: try r.string(128), thread: try r.string(128),
          workspace: try r.string(128), consent: try r.bytes(16))
      default: throw Failure.invalid
      }
      try r.end()
      try check(d.encode() == bytes)
      return d
    }
  }
  struct Manifest {
    let receiver: Data, origin: String, job: Data, generation: Data, device: Data
    let enrollmentEpoch: UInt64, destination: Destination, originalBytes: UInt64,
      originalSHA256: Data
    let safeName: String, expiresAt: UInt64, frameHashes: [Data], bytes: Data
    var digest: Data { hash(bytes) }
    var destinationDigest: Data { get throws { hash(try destination.encode()) } }
    var groupCount: Int { (frameHashes.count + 7) / 8 }
    func validateSetupTime(now: UInt64) throws {
      try check(expiresAt > now && expiresAt - now <= 7 * 86400)
    }
    init(
      receiver: Data, origin: String, job: Data, generation: Data, device: Data,
      enrollmentEpoch: UInt64, destination: Destination, originalBytes: UInt64,
      originalSHA256: Data, safeName: String, expiresAt: UInt64, frameHashes: [Data]
    ) throws {
      try check(
        receiver.count == 32 && job.count == 16 && generation.count == 16 && device.count == 16
          && originalSHA256.count == 32)
      try check(
        originalBytes > 0 && originalBytes <= maxOriginal && frameHashes.count >= 1
          && frameHashes.count <= 512
          && UInt64(frameHashes.count) == (originalBytes + UInt64(frameBytes) - 1)
            / UInt64(frameBytes)
          && frameHashes.allSatisfy { $0.count == 32 })
      self.receiver = receiver
      self.origin = try SealedProtocol.origin(origin)
      self.job = job
      self.generation = generation
      self.device = device
      self.enrollmentEpoch = enrollmentEpoch
      self.destination = destination
      self.originalBytes = originalBytes
      self.originalSHA256 = originalSHA256
      self.safeName = safeName
      self.expiresAt = expiresAt
      self.frameHashes = frameHashes
      var w = Writer()
      w.magic("FTMAN001")
      w.bytes(receiver)
      try w.lp(Data(origin.utf8))
      w.bytes(job)
      w.bytes(generation)
      w.bytes(device)
      try w.n(enrollmentEpoch, 8)
      try w.lp(destination.encode())
      try w.n(originalBytes, 8)
      w.bytes(originalSHA256)
      try w.lp(text(safeName, max: 240, name: true))
      try w.n(expiresAt, 8)
      try w.n(UInt64(frameBytes), 4)
      try w.n(8, 2)
      try w.n(UInt64(frameHashes.count), 4)
      for h in frameHashes { w.bytes(h) }
      try check(w.data.count <= 65536)
      bytes = w.data
    }
    static func decode(_ bytes: Data) throws -> Manifest {
      var r = try Reader(bytes, max: 65536)
      try r.magic("FTMAN001")
      let receiver = try r.bytes(32)
      let origin = try r.string(512)
      let job = try r.bytes(16)
      let generation = try r.bytes(16)
      let device = try r.bytes(16)
      let epoch = try r.n(8)
      let destination = try Destination.decode(r.lp(537))
      let originalBytes = try r.n(8)
      let originalHash = try r.bytes(32)
      let name = try r.string(240)
      let expiry = try r.n(8)
      try check(r.n(4) == UInt64(frameBytes))
      try check(r.n(2) == 8)
      let count = try r.small(4, 512)
      var hashes: [Data] = []
      for _ in 0..<count { hashes.append(try r.bytes(32)) }
      try r.end()
      let m = try Manifest(
        receiver: receiver, origin: origin, job: job, generation: generation, device: device,
        enrollmentEpoch: epoch, destination: destination, originalBytes: originalBytes,
        originalSHA256: originalHash, safeName: name, expiresAt: expiry, frameHashes: hashes)
      try check(m.bytes == bytes)
      return m
    }
    func frameLength(_ index: Int) throws -> Int {
      try check(index >= 0 && index < frameHashes.count)
      return Int(min(originalBytes - UInt64(index) * UInt64(frameBytes), UInt64(frameBytes)))
    }
    func partition(_ group: Int) throws -> Partition {
      try check(group >= 0 && group < groupCount)
      let first = group * 8
      let offset = UInt64(first) * UInt64(frameBytes)
      return Partition(
        group: group, firstFrame: first, frameCount: min(8, frameHashes.count - first),
        offset: offset, length: Int(min(originalBytes - offset, UInt64(frameBytes) * 8)))
    }
    func contiguous(_ bitmap: UInt64) throws -> UInt64 {
      if groupCount < 64 { try check(bitmap >> groupCount == 0) }
      var prefix: UInt64 = 0
      for i in 0..<groupCount {
        if bitmap & (UInt64(1) << i) == 0 { break }
        prefix += UInt64(try partition(i).length)
      }
      return prefix
    }
  }
  struct Partition { let group: Int, firstFrame: Int, frameCount: Int, offset: UInt64, length: Int }
  struct Binding {
    let manifest: Manifest
    init(manifest: Manifest, receiver: Data, origin: String) throws {
      try check(manifest.receiver == receiver && manifest.origin == SealedProtocol.origin(origin))
      self.manifest = manifest
    }
  }
  static func groupHeader(_ m: Manifest, _ group: Int) throws -> Data {
    let p = try m.partition(group)
    var w = Writer()
    w.magic("FTSEAL01")
    w.bytes(m.receiver)
    w.bytes(m.job)
    w.bytes(m.generation)
    w.bytes(m.digest)
    try w.n(UInt64(group), 4)
    try w.n(UInt64(p.firstFrame), 4)
    try w.n(UInt64(p.frameCount), 2)
    try w.n(0, 2)
    try w.n(p.offset, 8)
    try w.n(UInt64(p.length), 4)
    return w.data
  }
  static func parseHeader(_ bytes: Data, _ binding: Binding) throws -> Partition {
    try check(bytes.count == 128)
    var r = try Reader(bytes, max: 128)
    try r.magic("FTSEAL01")
    _ = try r.bytes(96)
    let group = try r.small(4, 63)
    try check(bytes == groupHeader(binding.manifest, group))
    return try binding.manifest.partition(group)
  }
  static func aad(_ header: Data, frame: Int, length: Int, sealID: Data) throws -> Data {
    try check(
      header.count == 128 && frame >= 0 && frame < 512 && length > 0 && length <= frameBytes
        && sealID.count == 16)
    var w = Writer()
    w.magic("FTBODY01")
    w.bytes(header)
    try w.n(UInt64(frame), 4)
    try w.n(UInt64(length), 4)
    w.bytes(sealID)
    return w.data
  }
  enum Domain: String { case body, ack, receipt, status }
  struct Keys {
    private let master: SymmetricKey
    let manifest: Manifest
    init(master: Data, manifest: Manifest) throws {
      try check(master.count == 32)
      self.master = SymmetricKey(data: master)
      self.manifest = manifest
    }
    static func fresh(_ manifest: Manifest) throws -> (keys: Keys, master: Data) {
      let master = try random(32)
      return (try Keys(master: master, manifest: manifest), master)
    }
    func derive(_ domain: Domain, frame: Int? = nil, sealID: Data? = nil) throws -> Data {
      var w = Writer()
      w.magic("footage/sealed-v1/" + domain.rawValue)
      if domain == .body {
        guard let frame, let sealID else { throw Failure.invalid }
        _ = try manifest.frameLength(frame)
        try check(sealID.count == 16)
        try w.n(UInt64(frame), 4)
        w.bytes(sealID)
      } else {
        try check(frame == nil && sealID == nil)
      }
      let key = HKDF<SHA256>.deriveKey(
        inputKeyMaterial: master, salt: manifest.digest, info: w.data, outputByteCount: 32)
      return key.withUnsafeBytes { Data($0) }
    }
  }
  struct SealRecord { let manifestDigest: Data, frame: Int, sealID: Data }
  final class SealSession {
    private let keys: Keys
    private var frames = Set<Int>(), ids = Set<Data>()
    private let lock = NSLock()
    init(keys: Keys) { self.keys = keys }
    /// persistConsumed must sync a consumed intent before returning. An error burns the frame in this session.
    func consume(frame: Int, persistConsumed: (SealRecord) throws -> Void) throws
      -> ConsumedSealIntent
    {
      lock.lock()
      defer { lock.unlock() }
      _ = try keys.manifest.frameLength(frame)
      try check(frames.insert(frame).inserted)
      let id = try random(16)
      try check(ids.insert(id).inserted)
      try persistConsumed(
        SealRecord(manifestDigest: keys.manifest.digest, frame: frame, sealID: id))
      return ConsumedSealIntent(keys: keys, frame: frame, id: id)
    }
  }
  final class ConsumedSealIntent {
    private let keys: Keys, frame: Int, id: Data
    private var used = false
    private let lock = NSLock()
    fileprivate init(keys: Keys, frame: Int, id: Data) {
      self.keys = keys
      self.frame = frame
      self.id = id
    }
    func seal(_ plaintext: Data) throws -> Data {
      lock.lock()
      defer { lock.unlock() }
      if used { throw Failure.consumed }
      used = true
      let m = keys.manifest
      let length = try m.frameLength(frame)
      try check(plaintext.count == length && hash(plaintext) == m.frameHashes[frame])
      let nonce = try AES.GCM.Nonce(data: random(12))
      let header = try groupHeader(m, frame / 8)
      let sealed = try AES.GCM.seal(
        plaintext, using: SymmetricKey(data: keys.derive(.body, frame: frame, sealID: id)),
        nonce: nonce, authenticating: aad(header, frame: frame, length: length, sealID: id))
      var w = Writer()
      try w.n(UInt64(frame), 4)
      try w.n(UInt64(length), 4)
      w.bytes(id)
      w.bytes(Data(nonce))
      w.bytes(sealed.ciphertext)
      w.bytes(sealed.tag)
      return w.data
    }
  }
  private static func openFrame(_ packet: Data, header: Data, frame: Int, keys: Keys) throws -> Data
  {
    let length = try keys.manifest.frameLength(frame)
    try check(packet.count == length + 52)
    var r = try Reader(packet, max: frameBytes + 52)
    try check(r.n(4) == UInt64(frame))
    try check(r.n(4) == UInt64(length))
    let id = try r.bytes(16)
    let nonce = try r.bytes(12)
    let ciphertext = try r.bytes(length)
    let tag = try r.bytes(16)
    try r.end()
    let box = try AES.GCM.SealedBox(
      nonce: AES.GCM.Nonce(data: nonce), ciphertext: ciphertext, tag: tag)
    let plaintext = try AES.GCM.open(
      box, using: SymmetricKey(data: keys.derive(.body, frame: frame, sealID: id)),
      authenticating: aad(header, frame: frame, length: length, sealID: id))
    try check(hash(plaintext) == keys.manifest.frameHashes[frame])
    return plaintext
  }
  /// All writes are private quarantine, never content or accepted original ranges. No whole-group plaintext buffer.
  protocol GroupSource {
    func readExactly(_ count: Int) throws -> Data
    func atEnd() throws -> Bool
  }
  protocol GroupQuarantine {
    func write(frame: Int, plaintext: Data) throws
    func discard() throws
  }
  struct VerifiedGroup {
    let partition: Partition, wireSHA256: Data, manifestDigest: Data
    private init(partition: Partition, wireSHA256: Data, manifestDigest: Data) {
      self.partition = partition
      self.wireSHA256 = wireSHA256
      self.manifestDigest = manifestDigest
    }
    static func authenticate(
      source: GroupSource, quarantine: GroupQuarantine, binding: Binding, keys: Keys
    ) throws -> VerifiedGroup {
      do {
        try check(keys.manifest.digest == binding.manifest.digest)
        let header = try source.readExactly(128)
        let p = try parseHeader(header, binding)
        var hasher = SHA256()
        hasher.update(data: header)
        var seals = Set<Data>()
        for frame in p.firstFrame..<(p.firstFrame + p.frameCount) {
          let length = try binding.manifest.frameLength(frame)
          let packet = try source.readExactly(length + 52)
          try check(packet.count == length + 52)
          try check(seals.insert(Data(packet[8..<24])).inserted)
          let plaintext = try openFrame(packet, header: header, frame: frame, keys: keys)
          hasher.update(data: packet)
          try quarantine.write(frame: frame, plaintext: plaintext)
        }
        try check(source.atEnd())
        return VerifiedGroup(
          partition: p, wireSHA256: Data(hasher.finalize()), manifestDigest: binding.manifest.digest
        )
      } catch {
        try quarantine.discard()
        throw error
      }
    }
  }
  private static func context(_ magic: String, _ m: Manifest) -> Writer {
    var w = Writer()
    w.magic(magic)
    w.bytes(m.receiver)
    w.bytes(m.job)
    w.bytes(m.generation)
    w.bytes(m.digest)
    return w
  }
  private static func readContext(_ r: inout Reader, _ magic: String, _ m: Manifest) throws {
    try r.magic(magic)
    try check(r.bytes(32) == m.receiver)
    try check(r.bytes(16) == m.job)
    try check(r.bytes(16) == m.generation)
    try check(r.bytes(32) == m.digest)
  }
  private static func signed(_ payload: Data, keys: Keys, domain: Domain) throws -> Data {
    try check(payload.count + 32 <= 4096)
    return try payload
      + Data(
        HMAC<SHA256>.authenticationCode(
          for: payload, using: SymmetricKey(data: keys.derive(domain))))
  }
  private static func authenticated(_ bytes: Data, keys: Keys, domain: Domain) throws -> Reader {
    try check(bytes.count >= 40 && bytes.count <= 4096)
    let payload = Data(bytes.dropLast(32))
    let mac = Data(bytes.suffix(32))
    guard
      try HMAC<SHA256>.isValidAuthenticationCode(
        mac, authenticating: payload, using: SymmetricKey(data: keys.derive(domain)))
    else { throw Failure.authentication }
    return try Reader(payload, max: 4096)
  }
  static func encodeAck(keys: Keys, group: Int, wireSHA256: Data, revision: UInt64) throws -> Data {
    let p = try keys.manifest.partition(group)
    try check(wireSHA256.count == 32)
    var w = context("FTACK001", keys.manifest)
    try w.n(UInt64(group), 4)
    w.bytes(wireSHA256)
    try w.n(p.offset, 8)
    try w.n(UInt64(p.length), 4)
    try w.n(revision, 8)
    return try signed(w.data, keys: keys, domain: .ack)
  }
  struct VerifiedAck {
    let group: Int, originalOffset: UInt64, originalLength: Int, revision: UInt64
    private init(group: Int, offset: UInt64, length: Int, revision: UInt64) {
      self.group = group
      originalOffset = offset
      originalLength = length
      self.revision = revision
    }
    static func verify(_ bytes: Data, keys: Keys, group expectedGroup: Int, wireSHA256: Data) throws
      -> VerifiedAck
    {
      try check(bytes.count == 192 && wireSHA256.count == 32)
      var r = try authenticated(bytes, keys: keys, domain: .ack)
      try readContext(&r, "FTACK001", keys.manifest)
      let group = try r.small(4, 63)
      let wire = try r.bytes(32)
      let offset = try r.n(8)
      let length = try r.small(4, 64 * 1024 * 1024)
      let revision = try r.n(8)
      try r.end()
      let p = try keys.manifest.partition(group)
      try check(
        group == expectedGroup && wire == wireSHA256 && offset == p.offset && length == p.length)
      return VerifiedAck(group: group, offset: offset, length: length, revision: revision)
    }
  }
  static func encodeReceipt(keys: Keys, id: Data, verifiedAt: UInt64, revision: UInt64) throws
    -> Data
  {
    try check(id.count == 16)
    var w = context("FTRCPT01", keys.manifest)
    w.bytes(try keys.manifest.destinationDigest)
    w.bytes(id)
    try w.n(verifiedAt, 8)
    try w.n(revision, 8)
    return try signed(w.data, keys: keys, domain: .receipt)
  }
  struct OriginalReceipt {
    let id: String, jobId: String, bytes: UInt64, sha256: String, verifiedAt: String
  }
  struct VerifiedReceipt {
    func toOriginalReceipt() throws -> OriginalReceipt {
      // u64 remains the wire domain. The existing shared ISO8601 shape has a narrower renderable domain.
      try check(verifiedAt <= 253_402_300_799)
      func uuid(_ data: Data) throws -> String {
        let raw = Array(data)
        try check(raw.count == 16)
        // Match the common schema's RFC UUID domain without silently changing the binary codec.
        let version = raw[6] >> 4
        try check(
          (version >= 1 && version <= 8 && raw[8] & 0xc0 == 0x80) || raw.allSatisfy { $0 == 0 }
            || raw.allSatisfy { $0 == 255 })
        return raw.enumerated().map { index, byte in
          ([4, 6, 8, 10].contains(index) ? "-" : "") + String(format: "%02x", byte)
        }.joined()
      }
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      formatter.timeZone = TimeZone(secondsFromGMT: 0)
      return try OriginalReceipt(
        id: uuid(id), jobId: uuid(jobID), bytes: bytes,
        sha256: sha256.map { String(format: "%02x", $0) }.joined(),
        verifiedAt: formatter.string(from: Date(timeIntervalSince1970: Double(verifiedAt))))
    }
    let id: Data, jobID: Data, bytes: UInt64, sha256: Data, verifiedAt: UInt64, revision: UInt64,
      manifestDigest: Data, destinationDigest: Data, generation: Data, receiver: Data
    private init(id: Data, verifiedAt: UInt64, revision: UInt64, manifest: Manifest) throws {
      self.id = id
      jobID = manifest.job
      bytes = manifest.originalBytes
      sha256 = manifest.originalSHA256
      self.verifiedAt = verifiedAt
      self.revision = revision
      manifestDigest = manifest.digest
      destinationDigest = try manifest.destinationDigest
      generation = manifest.generation
      receiver = manifest.receiver
    }
    static func verify(_ bytes: Data, keys: Keys) throws -> VerifiedReceipt {
      var r = try authenticated(bytes, keys: keys, domain: .receipt)
      try readContext(&r, "FTRCPT01", keys.manifest)
      try check(r.bytes(32) == keys.manifest.destinationDigest)
      let id = try r.bytes(16)
      let verifiedAt = try r.n(8)
      let revision = try r.n(8)
      try r.end()
      return try VerifiedReceipt(
        id: id, verifiedAt: verifiedAt, revision: revision, manifest: keys.manifest)
    }
  }
  static func encodeOutcome(ack: Data, receipt: Data = Data()) throws -> Data {
    try check(ack.count == 192 && (receipt.isEmpty || receipt.count == 200))
    var w = Writer()
    w.magic("FTOUT001")
    try w.lp(ack, 4)
    try w.lp(receipt, 4)
    try check(w.data.count <= 4096)
    return w.data
  }
  struct VerifiedOutcome { let ack: VerifiedAck, receipt: VerifiedReceipt? }
  static func verifyOutcome(
    _ bytes: Data, httpStatus: Int, keys: Keys, group: Int, wireSHA256: Data
  ) throws -> VerifiedOutcome {
    try check(httpStatus == 200)
    var r = try Reader(bytes, max: 4096)
    try r.magic("FTOUT001")
    let ack = try VerifiedAck.verify(r.lp(192, 4), keys: keys, group: group, wireSHA256: wireSHA256)
    let rb = try r.lp(200, 4)
    try r.end()
    let receipt = rb.isEmpty ? nil : try VerifiedReceipt.verify(rb, keys: keys)
    if let receipt { try check(receipt.revision >= ack.revision) }
    return VerifiedOutcome(ack: ack, receipt: receipt)
  }
  struct Query {
    let operation: Data, challenge: Data
    init(operation: Data, challenge: Data) throws {
      try check(operation.count == 16 && challenge.count == 32)
      self.operation = operation
      self.challenge = challenge
    }
    static func fresh(operation: Data) throws -> Query {
      try Query(operation: operation, challenge: random(32))
    }
    func encode(_ m: Manifest) -> Data {
      var w = Writer()
      w.magic("FTQUERY1")
      w.bytes(m.job)
      w.bytes(m.generation)
      w.bytes(m.digest)
      w.bytes(operation)
      w.bytes(challenge)
      return w.data
    }
    static func decode(_ bytes: Data, manifest m: Manifest) throws -> Query {
      var r = try Reader(bytes, max: 120)
      try r.magic("FTQUERY1")
      try check(r.bytes(16) == m.job)
      try check(r.bytes(16) == m.generation)
      try check(r.bytes(32) == m.digest)
      let q = try Query(operation: r.bytes(16), challenge: r.bytes(32))
      try r.end()
      return q
    }
  }
  struct StatusFields {
    let revision: UInt64, state: UInt8, cleanup: UInt8, groupBitmap: UInt64
    init(revision: UInt64, state: UInt8, cleanup: UInt8, groupBitmap: UInt64) throws {
      try check(state >= 1 && state <= 6 && cleanup <= 2)
      self.revision = revision
      self.state = state
      self.cleanup = cleanup
      self.groupBitmap = groupBitmap
    }
  }
  private static func statusRules(_ s: StatusFields, _ m: Manifest, _ receipt: VerifiedReceipt?)
    throws
  {
    try check(s.state >= 4 ? s.cleanup == 1 || s.cleanup == 2 : s.cleanup == 0)
    _ = try m.contiguous(s.groupBitmap)
    try check((s.state == 3) == (receipt != nil))
    if s.state == 2 || s.state == 3 {
      try check(
        s.groupBitmap == (m.groupCount == 64 ? UInt64.max : (UInt64(1) << m.groupCount) - 1))
    }
    if let receipt { try check(receipt.revision <= s.revision) }
  }
  static func encodeStatus(keys: Keys, query: Query, fields: StatusFields, receipt: Data = Data())
    throws -> Data
  {
    let m = keys.manifest
    try statusRules(fields, m, receipt.isEmpty ? nil : VerifiedReceipt.verify(receipt, keys: keys))
    var w = context("FTSTAT01", m)
    w.bytes(query.operation)
    w.bytes(query.challenge)
    try w.n(fields.revision, 8)
    try w.n(UInt64(fields.state), 1)
    try w.n(UInt64(fields.cleanup), 1)
    try w.n(m.expiresAt, 8)
    try w.n(fields.groupBitmap, 8)
    try w.n(m.contiguous(fields.groupBitmap), 8)
    try w.lp(receipt, 4)
    return try signed(w.data, keys: keys, domain: .status)
  }
  struct VerifiedStatus {
    let revision: UInt64, state: UInt8, cleanup: UInt8, groupBitmap: UInt64,
      contiguousOriginalBytes: UInt64, receipt: VerifiedReceipt?
    private init(fields: StatusFields, contiguous: UInt64, receipt: VerifiedReceipt?) {
      revision = fields.revision
      state = fields.state
      cleanup = fields.cleanup
      groupBitmap = fields.groupBitmap
      contiguousOriginalBytes = contiguous
      self.receipt = receipt
    }
    static func verify(_ bytes: Data, keys: Keys, query: Query, highWater: UInt64) throws
      -> VerifiedStatus
    {
      var r = try authenticated(bytes, keys: keys, domain: .status)
      let m = keys.manifest
      try readContext(&r, "FTSTAT01", m)
      try check(r.bytes(16) == query.operation)
      try check(r.bytes(32) == query.challenge)
      let revision = try r.n(8)
      let state = try r.small(1, 6)
      let cleanup = try r.small(1, 2)
      let expiry = try r.n(8)
      let bitmap = try r.n(8)
      let contiguous = try r.n(8)
      let rb = try r.lp(200, 4)
      try r.end()
      let fields = try StatusFields(
        revision: revision, state: UInt8(state), cleanup: UInt8(cleanup), groupBitmap: bitmap)
      let receipt = rb.isEmpty ? nil : try VerifiedReceipt.verify(rb, keys: keys)
      try statusRules(fields, m, receipt)
      try check(
        revision >= highWater && expiry == m.expiresAt && contiguous == m.contiguous(bitmap))
      return VerifiedStatus(fields: fields, contiguous: contiguous, receipt: receipt)
    }
  }
  static func encodeSetup(keys: Keys, master: Data) throws -> Data {
    let candidate = try Keys(master: master, manifest: keys.manifest)
    try check(candidate.derive(.ack) == keys.derive(.ack))
    var w = Writer()
    w.magic("FTSET001")
    w.bytes(keys.manifest.digest)
    w.bytes(master)
    try w.n(keys.manifest.expiresAt, 8)
    return w.data
  }
  static func decodeSetup(_ bytes: Data, manifest: Manifest) throws -> Keys {
    var r = try Reader(bytes, max: 80)
    try r.magic("FTSET001")
    try check(r.bytes(32) == manifest.digest)
    let master = try r.bytes(32)
    try check(r.n(8) == manifest.expiresAt)
    try r.end()
    return try Keys(master: master, manifest: manifest)
  }
}

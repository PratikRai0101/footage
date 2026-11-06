import Foundation
import Security
import CryptoKit

// No Expo/JS entrypoint. Native scanner/confirmation UI must own this interface.
// One Keychain item atomically holds pending or installed state, including private
// key material. It is not synchronized/backed up/migrated to a different device.
final class PairingVault {
  private let service: String
  private let account: String
  init(service: String, account: String = "pairing.v1") { self.service = service; self.account = account }
  func job(_ id: Data) -> PairingVault { PairingVault(service: service, account: "control.job." + id.map { String(format: "%02x", $0) }.joined()) }
  func addImmutable(_ bytes: Data) throws {
    if let existing = try read() { try pairingRequire(existing == bytes); return }
    var q = query; q[kSecValueData as String] = bytes; q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw PairingFailure.storage }
  }
  private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false] }
  func read() throws -> Data? {
    var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data, data.count <= 16384 else { throw PairingFailure.storage }; return data
  }
  func save(_ bytes: Data) throws {
    try pairingRequire(bytes.count <= 16384)
    let attrs: [String: Any] = [kSecValueData as String: bytes, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
    if status == errSecItemNotFound {
      var q = query; for (key, value) in attrs { q[key] = value }
      guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw PairingFailure.storage }
    } else if status != errSecSuccess { throw PairingFailure.storage }
  }
}
// Actor serialization prevents concurrent enrollment/recovery from replacing native state.
actor PairingClient {
  private let vault: PairingVault
  private var exchanging = false
  init(vault: PairingVault) { self.vault = vault }
  private struct Saved {
    let offer: PairingOffer, device: Data, key: P256.Signing.PrivateKey, mask: UInt32
    let installed: Data
    func encode(installed: Data) throws -> Data {
      try Data("FTNATV01".utf8) + pairingLP(offer.bytes) + device + key.rawRepresentation + pairingU32(mask) + pairingLP(installed)
    }
    init(offer: PairingOffer, device: Data, key: P256.Signing.PrivateKey, mask: UInt32, installed: Data) {
      self.offer = offer; self.device = device; self.key = key; self.mask = mask; self.installed = installed
    }
    init(_ bytes: Data) throws {
      var r = try PairingReader(bytes, "FTNATV01")
      offer = try PairingOffer(r.lp16(2048), requireFresh: false); device = try r.take(16)
      key = try P256.Signing.PrivateKey(rawRepresentation: r.take(32)); mask = UInt32(try r.integer(4)); installed = try r.lp16(16384); try r.end()
      try pairingRequire(mask & ~offer.mask == 0)
    }
  }
  private func saved() throws -> Saved { guard let bytes = try vault.read() else { throw PairingFailure.storage }; return try Saved(bytes) }
  // Explicitly named precondition, NOT a substitute for missing native scanner UX.
  // Caller may not supply a QR acquired from the network being authenticated.
  func prepareAfterNativeConfirmation(qr: Data, permissions: UInt32) throws {
    try pairingRequire(try vault.read() == nil) // replacing a device requires a separate explicit re-pair flow
    let offer = try PairingOffer(qr)
    try pairingRequire(permissions & ~offer.mask == 0)
    let s = Saved(offer: offer, device: try pairingRandom(16), key: P256.Signing.PrivateKey(), mask: permissions, installed: Data())
    try vault.save(s.encode(installed: Data()))
  }
  func enroll() async throws {
    try pairingRequire(!exchanging); exchanging = true; defer { exchanging = false }
    let s = try saved(); try pairingRequire(s.installed.isEmpty && s.offer.expires > UInt64(Date().timeIntervalSince1970))
    let nonce = try pairingRandom(32)
    let prefix = try Data("FTENRL01".utf8) + s.offer.id + s.offer.secret + s.device + pairingLP(s.key.publicKey.derRepresentation) + nonce + pairingU32(s.mask)
    let signature = try s.key.signature(for: prefix + s.offer.receiver + pairingLP(Data(s.offer.origin.text.utf8)))
    let reply = try await PairingHTTP(s.offer).send(.enroll, body: prefix + pairingLP(signature.derRepresentation))
    try install(reply, saved: s, nonce: nonce)
  }
  func recoverLostReply() async throws {
    try pairingRequire(!exchanging); exchanging = true; defer { exchanging = false }
    let s = try saved(); let nonce = try pairingRandom(32)
    let query = Data("FTCHAL01".utf8) + s.offer.id + s.device + nonce
    let challenge = try await PairingHTTP(s.offer).send(.challenge, body: query)
    var r = try PairingReader(challenge, "FTCHLO01"); try pairingRequire(try r.take(32) == nonce)
    let server = try r.take(32), expires = try r.integer(8), now = UInt64(Date().timeIntervalSince1970); try r.end()
    try pairingRequire(expires > now && expires - now <= 60)
    let prefix = Data("FTRECV01".utf8) + s.offer.id + s.device + nonce + server
    let signature = try s.key.signature(for: prefix + s.offer.receiver + pairingLP(Data(s.offer.origin.text.utf8)))
    let reply = try await PairingHTTP(s.offer).send(.recover, body: prefix + pairingLP(signature.derRepresentation))
    try install(reply, saved: s, nonce: nonce)
  }
  private func install(_ reply: Data, saved s: Saved, nonce: Data) throws {
    _ = try PairingVerifiedRecord(reply: reply, offer: s.offer, device: s.device, spki: s.key.publicKey.derRepresentation, mask: s.mask, nonce: nonce)
    // Credential + signed record + original native key commit in a single native item.
    try vault.save(s.encode(installed: reply))
  }
  func isInstalled() throws -> Bool { !(try saved()).installed.isEmpty }

  private func installed() throws -> (Saved, PairingVerifiedRecord) {
    let s = try saved()
    let verified = try PairingVerifiedRecord(installedReply: s.installed, offer: s.offer, device: s.device, spki: s.key.publicKey.derRepresentation, mask: s.mask)
    return (s, verified)
  }
  func nativeIdentity() throws -> PairingInstalledIdentity {
    let (s, record) = try installed()
    return PairingInstalledIdentity(receiver: s.offer.receiver, origin: s.offer.origin.text, device: s.device, epoch: record.epoch, expires: record.expires, permissions: s.mask)
  }
  // Native confirmation boundary only. No JS export. Caller must display the exact
  // standalone intake before this call; no active-target lookup or inferred scope.
  // Receiver scope enforcement remains authoritative: signed G1 records omit scopes.
  func confirmStandaloneAfterNativeConfirmation(_ binding: PairingControlBinding) throws {
    let (s, record) = try installed()
    try binding.validate(offer: s.offer, device: s.device, epoch: record.epoch, expires: record.expires)
    let item = try PairingControlInstallation(binding: binding, offer: s.offer, spki: s.key.publicKey.derRepresentation, mask: s.mask, reply: s.installed)
    let account = vault.job(binding.job)
    if let existing = try account.read() {
      // Fresh recovery nonces may change signed reply bytes, never authority.
      let saved = try PairingControlInstallation(existing)
      try pairingRequire(saved.binding == binding && saved.authorityDigest == item.authorityDigest)
    } else { try account.addImmutable(item.bytes) }
  }
  // Canonical bodies are produced by the native G2 wrapper, never JS. HTTP 200
  // merely makes bounded bytes eligible for that wrapper's cryptographic verifier.
  func control(_ operation: PairingControlOperation, binding: PairingControlBinding, canonicalBody: Data) async throws -> Data {
    guard let bytes = try vault.job(binding.job).read() else { throw PairingFailure.storage }
    let installed = try PairingControlInstallation(bytes)
    try pairingRequire(installed.binding == binding && installed.mask & operation.permission == operation.permission)
    try binding.validate(offer: installed.offer, device: binding.device, epoch: installed.record.epoch, expires: installed.record.expires, requireFreshJob: operation == .setup)
    try binding.validateBody(canonicalBody, operation: operation)
    return try await PairingHTTP(installed.offer).send(operation.route, body: canonicalBody, credential: installed.record.credential)
  }
  // Locked recovery needs only the native job ID + G2 query, not its full
  // .complete manifest. Confirmation and installed authority stay in Keychain.
  func control(_ operation: PairingControlOperation, job: Data, canonicalBody: Data) async throws -> Data {
    try pairingRequire(job.count == 16)
    guard let saved = try vault.job(job).read() else { throw PairingFailure.storage }
    let binding = try PairingControlInstallation(saved).binding
    try pairingRequire(binding.job == job)
    return try await control(operation, binding: binding, canonicalBody: canonicalBody)
  }
  // Minimal native integration accessors. No credential, private key or master escapes.
  // Job recovery uses the frozen snapshot, never the current installation.
  func confirmedJobBinding(_ job: Data) throws -> PairingControlBinding {
    try pairingRequire(job.count == 16)
    guard let bytes = try vault.job(job).read() else { throw PairingFailure.storage }
    let saved = try PairingControlInstallation(bytes)
    try pairingRequire(saved.binding.job == job)
    return saved.binding
  }
  func confirmedJobIdentity(_ job: Data) throws -> PairingInstalledIdentity {
    try pairingRequire(job.count == 16)
    guard let bytes = try vault.job(job).read() else { throw PairingFailure.storage }
    let saved = try PairingControlInstallation(bytes)
    try pairingRequire(saved.binding.job == job)
    return PairingInstalledIdentity(receiver: saved.binding.receiver, origin: saved.binding.origin,
      device: saved.binding.device, epoch: saved.record.epoch, expires: saved.record.expires, permissions: saved.mask)
  }
  func installedTrust() throws -> PairingPinnedTrust {
    let (s, _) = try installed()
    return PairingPinnedTrust(offer: s.offer)
  }
  func confirmedJobTrust(_ job: Data) throws -> PairingPinnedTrust {
    try pairingRequire(job.count == 16)
    guard let bytes = try vault.job(job).read() else { throw PairingFailure.storage }
    let saved = try PairingControlInstallation(bytes)
    try pairingRequire(saved.binding.job == job)
    return PairingPinnedTrust(offer: saved.offer)
  }
  func listDestinations() async throws -> Data {
    let (s, record) = try installed(); try pairingRequire(s.mask & 0x10 != 0)
    let body = try Data("FTLIST01".utf8) + s.device + pairingU64(record.epoch) + pairingRandom(32)
    return try await PairingHTTP(s.offer).send(.destinations, body: body, credential: record.credential)
  }
}

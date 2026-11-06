import Foundation
import Security
import CryptoKit

// No Expo/JS entrypoint. Native scanner/confirmation UI must own this interface.
// One Keychain item atomically holds pending or installed state, including private
// key material. It is not synchronized/backed up/migrated to a different device.
final class PairingVault {
  private let service: String
  init(service: String) { self.service = service }
  private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "pairing.v1", kSecAttrSynchronizable as String: false] }
  func read() throws -> Data? {
    var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else { throw PairingFailure.storage }; return data
  }
  func save(_ bytes: Data) throws {
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
}

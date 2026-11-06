import UIKit
import Foundation
import Security

@main final class ControlProbe: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds); window?.rootViewController = UIViewController(); window?.makeKeyAndVisible()
    Task { await run() }; return true
  }
  func run() async {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    var result: [String: Any] = [:]
    do {
      let role = try String(contentsOf: docs.appendingPathComponent("role.txt"), encoding: .utf8)
      let qr = try Data(contentsOf: docs.appendingPathComponent("offer.bin")), offer = try PairingOffer(qr)
      let service = "test.footage.pairedcontrol." + role
      let client = PairingClient(vault: PairingVault(service: service))
      try await client.prepareAfterNativeConfirmation(qr: qr, permissions: offer.mask); try await client.enroll()
      // Reconstruct the real installed Keychain owner before job confirmation.
      let owner = PairingClient(vault: PairingVault(service: service))
      let identity = try await owner.nativeIdentity()
      if role == "expired-pairing" { try await Task.sleep(for: .seconds(4)) }
      let job = try pairingRandom(16), generation = try pairingRandom(16)
      let intake = Data([0x6b,0x7e,0x03,0x34,0x14,0x8d,0x49,0x6c,0x87,0x24,0xe8,0xf0,0x1f,0x03,0xa9,0xc1])
      let expires = min(UInt64(Date().timeIntervalSince1970) + 3600, identity.expires)
      var manifest = Data("FTMAN001".utf8)
      for part in [identity.receiver, try pairingLP(Data(identity.origin.utf8)), job, generation, identity.device, pairingU64(identity.epoch), try pairingLP(Data([1]) + intake), pairingU64(1), pairingHash(Data([17])), try pairingLP(Data("synthetic.bin".utf8)), pairingU64(expires), pairingU32(8388608), Data([0,8]), pairingU32(1), pairingHash(Data([17]))] { manifest.append(part) }
      // Actual production G2 parsing, not a source assertion/caller JSON manifest.
      _ = try SealedProtocol.Manifest.decode(manifest)
      let binding = try PairingControlBinding(receiver: identity.receiver, origin: role == "http" ? identity.origin.replacingOccurrences(of: "https:", with: "http:") : role == "wrong-port" ? "https://localhost:1" : identity.origin, device: identity.device, epoch: role == "stale" ? identity.epoch + 1 : identity.epoch, job: job, generation: generation, manifestDigest: pairingHash(manifest), intake: intake, expires: expires)
      if let cookie = HTTPCookie(properties: [.domain: offer.origin.host, .path: "/", .name: "test", .value: "synthetic", .secure: "TRUE"]) { HTTPCookieStorage.shared.setCookie(cookie) }
      let space = URLProtectionSpace(host: offer.origin.host, port: offer.origin.port, protocol: "https", realm: "Synthetic", authenticationMethod: NSURLAuthenticationMethodHTTPBasic)
      URLCredentialStorage.shared.setDefaultCredential(URLCredential(user: "synthetic", password: "synthetic", persistence: .forSession), for: space)
      if role != "unconfirmed" { try await owner.confirmStandaloneAfterNativeConfirmation(binding) }
      if role == "changed-confirmation" {
        let changed = try PairingControlBinding(receiver: identity.receiver, origin: identity.origin, device: identity.device, epoch: identity.epoch, job: job, generation: generation, manifestDigest: pairingHash(manifest), intake: try pairingRandom(16), expires: expires)
        try await owner.confirmStandaloneAfterNativeConfirmation(changed)
      }
      if role == "missing-confirmation" || role == "missing-installed" {
        let account = role == "missing-installed" ? "pairing.v1" : "control.job." + job.map { String(format: "%02x", $0) }.joined()
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecAttrSynchronizable as String: false]
        try pairingRequire(SecItemDelete(query as CFDictionary) == errSecSuccess)
      }
      if role == "future-pairing" {
        let futureVault = PairingVault(service: service + ".future")
        let future = PairingClient(vault: futureVault)
        try await future.prepareAfterNativeConfirmation(qr: Data(contentsOf: docs.appendingPathComponent("future-installation.qr")), permissions: 31)
        try await future.enroll()
        let futureIdentity = try await future.nativeIdentity()
        try pairingRequire(futureIdentity.device != identity.device)
        guard let installed = try futureVault.read() else { throw PairingFailure.storage }
        // Test-only simulation of an explicitly confirmed future installation.
        // Production still has no re-pair activation UI. Old job must ignore it.
        try PairingVault(service: service).save(installed)
      }
      if role == "rotation-not-applied" {
        let candidate = try PairingRotation(Data(contentsOf: docs.appendingPathComponent("rotation.bin")), old: offer, previousEpoch: 1, nonce: Data(contentsOf: docs.appendingPathComponent("rotation.nonce")))
        let changed = try PairingControlBinding(receiver: pairingHash(candidate.spki), origin: candidate.origin.text, device: identity.device, epoch: identity.epoch, job: job, generation: generation, manifestDigest: pairingHash(manifest), intake: intake, expires: expires)
        var denied = false
        do { try await owner.confirmStandaloneAfterNativeConfirmation(changed) } catch { denied = true }
        try pairingRequire(denied); result["rotationNotApplied"] = true
      }
      // Same installed key/credential survives recovery and a new owner instance;
      // new signed nonce is NOT treated as authority to change an existing job.
      if role == "positive" { try await owner.recoverLostReply(); try await owner.confirmStandaloneAfterNativeConfirmation(binding) }
      let controller = PairingClient(vault: PairingVault(service: service))
      var body = manifest
      if role == "oversized-body" { body = Data(count: 65537) }
      if role == "wrong-body" { body[body.count - 1] ^= 1 }
      _ = try await controller.control(.setup, binding: binding, canonicalBody: body)
      result["setup"] = true
      var query = try Data("FTQUERY1".utf8) + job + generation + pairingHash(manifest) + pairingRandom(16) + pairingRandom(32)
      if role == "wrong-query" { query.append(0) }
      _ = try await controller.control(.status, job: job, canonicalBody: query)
      result["status"] = true
      _ = try await controller.control(.revoke, job: job, canonicalBody: query)
      result["revoke"] = true
      _ = try await controller.control(.view, job: job, canonicalBody: query)
      _ = try await controller.listDestinations()
      result["success"] = true
      // Deliberately no accepted progress/receipt: synthetic HTTP bytes must fail G2.
      result["received"] = false
    } catch { result["success"] = false }
    try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]).write(to: docs.appendingPathComponent("result.json"), options: .atomic)
  }
}

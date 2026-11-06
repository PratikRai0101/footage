import UIKit
import Foundation
import CryptoKit

@main final class ProbeApp: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds); window?.rootViewController = UIViewController(); window?.makeKeyAndVisible()
    Task { await run() }; return true
  }
  func run() async {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    var output: [String: Any] = [:]
    do {
      let config = try JSONSerialization.jsonObject(with: Data(contentsOf: docs.appendingPathComponent("config.json"))) as! [String: String]
      let name = config["name"]!, mode = config["mode"]!
      let bytes = try Data(contentsOf: docs.appendingPathComponent("offer.bin"))
      if name == "positive" {
        for value in ["https://localhost:443", "https://127.0.0.1:443", "https://[::]:443", "https://[2001:db8::1]:443", "https://[::ffff:c000:201]:443"] { _ = try PairingOrigin(value) }
        for value in ["http://localhost:443", "https://LOCALHOST:443", "https://localhost", "https://localhost:0443", "https://localhost.:443", "https://localhost:443/", "https://127.01.0.1:443", "https://[0:0:0:0:0:0:0:1]:443"] {
          var rejected = false; do { _ = try PairingOrigin(value) } catch { rejected = true }; try pairingRequire(rejected)
        }
        var zeroMask = bytes
        zeroMask.replaceSubrange((zeroMask.count - 4)..<zeroMask.count, with: pairingU32(0))
        try pairingRequire(try PairingOffer(zeroMask).mask == 0)
        for count in 0..<bytes.count {
          var rejected = false
          do { _ = try PairingOffer(bytes.prefix(count)) } catch { rejected = true }
          try pairingRequire(rejected)
        }
        var rejected = false
        do { _ = try PairingOffer(bytes + Data([0])) } catch { rejected = true }
        try pairingRequire(rejected); output["qrBoundsVerified"] = true
      }
      if let offer = try? PairingOffer(bytes) {
        let space = URLProtectionSpace(host: offer.origin.host, port: offer.origin.port, protocol: "https", realm: "Synthetic", authenticationMethod: NSURLAuthenticationMethodHTTPBasic)
        URLCredentialStorage.shared.setDefaultCredential(URLCredential(user: "synthetic", password: "not-a-real-secret", persistence: .forSession), for: space)
        if let cookie = HTTPCookie(properties: [.domain: offer.origin.host, .path: "/", .name: "synthetic", .value: "not-a-real-secret", .secure: "TRUE"]) { HTTPCookieStorage.shared.setCookie(cookie) }
      }
      let client = PairingClient(vault: PairingVault(service: "test.footage.pairing." + name))
      try await client.prepareAfterNativeConfirmation(qr: bytes, permissions: 3)
      if mode == "lost" {
        var replyLost = false
        do { try await client.enroll() } catch { replyLost = true }
        try pairingRequire(replyLost); output["enrollReplyLost"] = true
        // A new client instance reads the same native pending key, not a replacement.
        let restored = PairingClient(vault: PairingVault(service: "test.footage.pairing." + name))
        try await restored.recoverLostReply(); output["installed"] = try await restored.isInstalled()
      } else {
        try await client.enroll(); output["installed"] = try await client.isInstalled()
        try await client.recoverLostReply(); output["recovered"] = try await client.isInstalled()
      }
      if name == "positive" {
        let rotation = try Data(contentsOf: docs.appendingPathComponent("rotation.bin")), nonce = try Data(contentsOf: docs.appendingPathComponent("rotation.nonce"))
        let old = try PairingOffer(bytes, requireFresh: false)
        let candidate = try PairingRotation(rotation, old: old, previousEpoch: 1, nonce: nonce)
        try pairingRequire(candidate.epoch == 2)
        var rejectedReplay = false
        do { _ = try PairingRotation(rotation, old: old, previousEpoch: 2, nonce: nonce) } catch { rejectedReplay = true }
        try pairingRequire(rejectedReplay); output["rotationVerified"] = true
      }
      output["success"] = true
    } catch {
      let e = error as NSError; output["success"] = false; output["errorDomain"] = e.domain; output["errorCode"] = e.code
    }
    // Safe counters/status only: never QR, device key, credential, path or error descriptions.
    try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]).write(to: docs.appendingPathComponent("result.json"), options: .atomic)
  }
}

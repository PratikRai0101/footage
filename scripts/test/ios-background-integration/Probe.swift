import UIKit
import Foundation
import Security
import Darwin

/// Private filesystem mailbox: explicitly injected synthetic control, NOT paired transport.
/// Only the owned harness process can read/write this Simulator's generated Documents.
final class DurableTestControl: BackgroundControl {
  let docs: URL, offline: Bool
  init(_ docs: URL, offline: Bool = false) { self.docs = docs; self.offline = offline }
  private func exchange(_ bytes: Data, kind: String, id: String) throws -> Data {
    if offline { throw BackgroundFailure.uncertain }
    let request = docs.appendingPathComponent("control-\(kind)-\(id).request")
    let reply = request.appendingPathExtension("reply")
    try BackgroundFiles.save(bytes, to: request, complete: kind == "setup")
    for _ in 0..<600 {
      if FileManager.default.fileExists(atPath: reply.path) {
        let bytes = try Data(contentsOf: reply)
        try backgroundRequire(bytes.count <= 65536)
        return bytes
      }
      Thread.sleep(forTimeInterval: 0.1)
    }
    throw BackgroundFailure.uncertain
  }
  func setup(_ manifest: SealedProtocol.Manifest) throws -> Data {
    try exchange(manifest.bytes, kind: "setup", id: UUID().uuidString)
  }
  func status(_ context: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data {
    try exchange(query.encode(context), kind: "status", id: UUID().uuidString)
  }
  func revoke(_ context: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data {
    try exchange(query.encode(context), kind: "revoke", id: UUID().uuidString)
  }
}

// Same bounded app-scoped generated-CA policy as the standalone G4 proof; no global trust edits.
struct IntegrationTrust: BackgroundServerTrust {
  let ca: Data, leaf: Data, port: Int
  func credential(for challenge: URLAuthenticationChallenge) -> URLCredential? {
    let p = challenge.protectionSpace
    guard p.host == "localhost", p.port == port, p.protocol == "https", challenge.previousFailureCount == 0,
      let trust = p.serverTrust, let anchor = SecCertificateCreateWithData(nil, ca as CFData) else { return nil }
    guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, "localhost" as CFString)) == errSecSuccess,
      SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
      SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
      SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess, SecTrustEvaluateWithError(trust, nil),
      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let first = chain.first,
      SecCertificateCopyData(first) as Data == leaf else { return nil }
    return URLCredential(trust: trust)
  }
}

@main
final class Probe: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  nonisolated(unsafe) static var owner: BackgroundRuntime?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let w = UIWindow(frame: UIScreen.main.bounds), c = UIViewController()
    c.view.backgroundColor = .systemBackground; w.rootViewController = c; w.makeKeyAndVisible(); window = w
    DispatchQueue.global(qos: .utility).async { Self.run() }; return true
  }
  func applicationDidEnterBackground(_ application: UIApplication) {
    Self.result(["enteredBackground": true], "background.json")
  }
  nonisolated static var docs: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
  nonisolated static func result(_ value: [String: Any], _ name: String = "result.json") {
    do { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: docs.appendingPathComponent(name), options: .atomic) }
    catch { _exit(91) }
  }
  nonisolated static func observe(_ r: BackgroundRuntime, remaining: Int) {
    let s = r.snapshot()
    if s.phase == "blocked" || s.phase == "received" || remaining == 0 {
      result(["phase": s.phase, "confirmedBytes": s.confirmedBytes, "received": s.phase == "received"])
    } else { DispatchQueue.global().asyncAfter(deadline: .now() + 1) { observe(r, remaining: remaining - 1) } }
  }
  nonisolated static func run() {
    do {
      let config = try JSONSerialization.jsonObject(with: Data(contentsOf: docs.appendingPathComponent("config.json"))) as! [String: Any]
      let binding = try JSONSerialization.jsonObject(with: Data(contentsOf: docs.appendingPathComponent("binding.json"))) as! [String: Any]
      func bytes(_ key: String) throws -> Data {
        let text = binding[key] as! String
        var output = Data(), i = text.startIndex
        while i != text.endIndex {
          let end = text.index(i, offsetBy: 2)
          guard let b = UInt8(text[i..<end], radix: 16) else { throw BackgroundFailure.integrity }
          output.append(b); i = end
        }
        return output
      }
      let mode = config["mode"] as! String, service = config["service"] as! String
      let root = docs.appendingPathComponent("runtime"), port = binding["port"] as! Int
      let trust = IntegrationTrust(ca: try Data(contentsOf: docs.appendingPathComponent("root.der")),
        leaf: try Data(contentsOf: docs.appendingPathComponent("leaf.der")), port: port)
      let r = try BackgroundRuntime(directory: root, create: mode == "prepare", keychainService: service,
        control: DurableTestControl(docs, offline: mode == "cancel-offline"), cellular: false,
        activeUnlocked: { true }, trust: trust)
      owner = r
      if mode == "prepare" {
        let source = docs.appendingPathComponent("generated-original")
        let count = 64 * 1024 * 1024 + 12345
        try testGenerate(source, count: count)
        try r.prepare(BackgroundSelection(source: source, safeName: "Synthetic.bin", receiver: bytes("receiver"),
          origin: binding["origin"] as! String, device: bytes("device"), enrollmentEpoch: 1,
          destination: .standalone(intake: bytes("intake")), expiresAt: UInt64(Date().timeIntervalSince1970) + 3600))
        // Simulate unavailable .complete storage at the real read boundary, not an unlocked flag.
        // Simulator does NOT certify physical lock. The original+manifest retain their protection.
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: root.appendingPathComponent("private").path)
        var denied = false
        do { _ = try Data(contentsOf: root.appendingPathComponent("private/manifest")) }
        catch { denied = (error as NSError).code == NSFileReadNoPermissionError }
        try backgroundRequire(denied)
        try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
        let s = r.snapshot()
        result(["ok": s.backgroundReady, "groups": s.sealedGroups, "originalBytes": count,
          "confirmedBytes": s.confirmedBytes, "privateManifestReadDenied": denied], "scheduled.json")
        return
      }
      if mode == "cancel-offline" {
        let ok = try testAwait { r.cancel(completion: $0) }
        let state = try testState(root)
        result(["ok": !ok && state.cancelOperation != nil && state.receiptOutcome == nil,
          "phase": r.snapshot().phase, "cleanupPending": r.snapshot().cleanupPending]); return
      }
      try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
      if mode == "reassociate" {
        let s = r.snapshot(); result(["ok": s.backgroundReady, "groups": s.sealedGroups], "reassociated.json")
        DispatchQueue.global().asyncAfter(deadline: .now() + 20) { observe(r, remaining: 120) }; return
      }
      let state = try testState(root)
      let master = try BackgroundKeychain(service: service).read(state.keyReference)
      let context = try state.outcome(master: master)
      guard let receipt = state.receiptOutcome else { throw BackgroundFailure.integrity }
      let shared = try SealedProtocol.VerifiedReceipt.verify(receipt, keys: .init(master: master, outcome: context)).toOriginalReceipt()
      var privateDenied = false
      do { _ = try Data(contentsOf: root.appendingPathComponent("private/manifest")) }
      catch { privateDenied = (error as NSError).code == NSFileReadNoPermissionError }
      // Raw identity retained only in ignored evidence; exported summary redacts it.
      result(["ok": r.snapshot().phase == "received", "phase": r.snapshot().phase,
        "receiptID": shared.id, "jobID": shared.jobId, "bytes": shared.bytes, "sha256": shared.sha256,
        "confirmedBytes": r.snapshot().confirmedBytes, "privateManifestStillUnavailable": privateDenied])
    } catch { result(["ok": false, "error": String(describing: error)]) }
  }
}

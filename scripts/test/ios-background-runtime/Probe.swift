import UIKit
import Foundation
import CryptoKit
import Security
import Darwin

/// Synthetic out-of-band provisioning only. NOT a production pairing/control transport.
final class LocalControl: BackgroundControl {
  let directory: URL
  init(_ directory: URL) { self.directory = directory }
  func setup(_ m: SealedProtocol.Manifest) throws -> Data {
    let master = try SealedProtocol.random(32)
    try BackgroundFiles.save(m.bytes, to: directory.appendingPathComponent("listener.manifest"), complete: true)
    try BackgroundFiles.save(master, to: directory.appendingPathComponent("listener.master"), complete: true)
    return try SealedProtocol.encodeSetup(keys: .init(master: master, manifest: m), master: master)
  }
  func status(_ m: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data { throw BackgroundFailure.uncertain }
  func revoke(_ m: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data { throw BackgroundFailure.uncertain }
}
struct LocalTrust: BackgroundServerTrust {
  let ca: Data, leaf: Data, port: Int
  func credential(for challenge: URLAuthenticationChallenge) -> URLCredential? {
    let space = challenge.protectionSpace
    guard space.host == "localhost", space.port == port, space.protocol == "https",
      challenge.previousFailureCount == 0, let trust = space.serverTrust,
      let anchor = SecCertificateCreateWithData(nil, ca as CFData) else { return nil }
    guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, "localhost" as CFString)) == errSecSuccess,
      SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
      SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
      SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
      SecTrustEvaluateWithError(trust, nil), let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let first = chain.first, SecCertificateCopyData(first) as Data == leaf else { return nil }
    return URLCredential(trust: trust)
  }
}

@main
final class Probe: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  nonisolated(unsafe) static var owner: BackgroundRuntime?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    let controller = UIViewController(); controller.view.backgroundColor = .systemBackground
    window.rootViewController = controller; window.makeKeyAndVisible(); self.window = window
    DispatchQueue.global(qos: .utility).async { Self.run() }
    return true
  }
  func applicationDidEnterBackground(_ application: UIApplication) {
    Self.result(["enteredBackground": true], directory: FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0], name: "background.json")
  }
  nonisolated static func result(_ value: [String: Any], directory: URL, name: String = "result.json") {
    do { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: directory.appendingPathComponent(name), options: .atomic) }
    catch { _exit(91) }
  }
  nonisolated static func observeLedger(_ runtime: BackgroundRuntime, docs: URL, remaining: Int) {
    let s = runtime.snapshot()
    if s.phase == "verifying" || s.phase == "blocked" || s.phase == "received" || remaining == 0 {
      result(["ok": s.phase == "verifying", "phase": s.phase, "confirmedBytes": s.confirmedBytes,
        "received": s.phase == "received"], directory: docs)
    } else {
      DispatchQueue.global().asyncAfter(deadline: .now() + 1) { observeLedger(runtime, docs: docs, remaining: remaining - 1) }
    }
  }
  nonisolated static func run() {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    do {
      let config = try JSONSerialization.jsonObject(with: Data(contentsOf: docs.appendingPathComponent("config.json"))) as! [String: Any]
      let mode = config["mode"] as! String
      if mode == "unit" {
        let base = docs.appendingPathComponent("unit"); try BackgroundFiles.directory(base)
        let cases = try runRuntimeTests(base)
        result(["ok": true, "cases": cases], directory: docs); return
      }
      let service = config["service"] as! String
      let root = docs.appendingPathComponent("runtime")
      if mode == "crash" {
        let source = docs.appendingPathComponent("crash-original")
        if !FileManager.default.fileExists(atPath: source.path) { try testGenerate(source, count: 1024 * 1024 + 3) }
        let point = config["point"] as! String
        let r = try BackgroundRuntime(directory: root, create: true, keychainService: service,
          control: TestControl(), cellular: false, activeUnlocked: { true }, boundary: {
            if $0.rawValue == point { result(["at": point], directory: docs, name: "checkpoint.json"); _exit(77) }
          }, daemon: TestDaemon())
        try r.prepare(testSelection(source)); throw BackgroundFailure.integrity
      }
      if mode == "recover" {
        let d = TestDaemon()
        let r = try BackgroundRuntime(directory: root, create: false, keychainService: service,
          control: TestControl(), cellular: false, activeUnlocked: { true }, daemon: d)
        let ok = try testAwait { r.restoreAndStart(completion: $0) }
        let state = try testState(root)
        result(["ok": !ok && d.created == 0 && r.snapshot().phase == "blocked", "intents": state.intents.count], directory: docs)
        testDeleteKey(service); return
      }
      if mode == "network" {
        let source = docs.appendingPathComponent("large-original")
        let count = 2 * 64 * 1024 * 1024 + 12345
        try testGenerate(source, count: count)
        let port = config["port"] as! Int
        let trust = LocalTrust(ca: try Data(contentsOf: docs.appendingPathComponent("root.der")),
          leaf: try Data(contentsOf: docs.appendingPathComponent("leaf.der")), port: port)
        let r = try BackgroundRuntime(directory: root, create: true, keychainService: service,
          control: LocalControl(docs), cellular: false, activeUnlocked: { true }, trust: trust)
        owner = r
        let selection = BackgroundSelection(source: source, safeName: "Generated.bin", receiver: try SealedProtocol.random(32),
          origin: "https://localhost:\(port)", device: BackgroundPreseal.uuid(), enrollmentEpoch: 1,
          destination: .standalone(intake: BackgroundPreseal.uuid()), expiresAt: UInt64(Date().timeIntervalSince1970) + 3600)
        try r.prepare(selection)
        try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
        let snapshot = r.snapshot()
        var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
        result(["ok": snapshot.backgroundReady, "groups": snapshot.sealedGroups, "originalBytes": count,
          "peakRSSBytes": usage.ru_maxrss, "confirmedBytes": snapshot.confirmedBytes], directory: docs, name: "scheduled.json")
        // No JS, no background assertion, no further plaintext reads. Runner backgrounds then SIGSTOPs.
        DispatchQueue.global().asyncAfter(deadline: .now() + 20) { observeLedger(r, docs: docs, remaining: 90) }
        return
      }
      if mode == "network-check" {
        // The previous force termination isn't advertised as an automatic relaunch promise.
        let c = LocalControl(docs)
        let r = try BackgroundRuntime(directory: root, create: false, keychainService: service,
          control: c, cellular: false, activeUnlocked: { true })
        owner = r
        // Session reconnect delivers callbacks. No new task creation, no synthetic final receipt.
        DispatchQueue.global().asyncAfter(deadline: .now() + 12) {
          let s = r.snapshot()
          result(["ok": s.phase == "verifying", "phase": s.phase, "confirmedBytes": s.confirmedBytes,
            "received": s.phase == "received"], directory: docs)
          testDeleteKey(service)
        }
        return
      }
      throw BackgroundFailure.integrity
    } catch { result(["ok": false, "error": String(describing: error)], directory: docs) }
  }
}

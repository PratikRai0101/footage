// ONLY compiled into the explicitly flagged, disposable lifecycle test build.
#if FOOTAGE_EXPO_LIFECYCLE_TEST
import UIKit
import Foundation

@MainActor
enum ExpoLifecycleFixture {
  static let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  static var runtime: BackgroundRuntime?
  static var counts: [String: Int] = [:]
  static var order: [String] = []
  static var mode = ""
  static var service = ""
  static func write(_ object: [String: Any], _ name: String) {
    do { try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
      .write(to: docs.appendingPathComponent(name), options: .atomic) }
    catch { fatalError("Private test evidence could not be recorded") }
  }
  static func record(_ event: String) {
    counts[event] = min((counts[event] ?? 0) + 1, 1000)
    if order.count < 64 { order.append(event) }
    write(["counts": counts, "order": order, "main": Thread.isMainThread, "pid": ProcessInfo.processInfo.processIdentifier], "lifecycle.json")
  }
  static func makeRuntime(activity: NativeBackgroundActivity) throws -> (any NativeBackgroundRuntime)? {
    record("factoryBeforeJS")
    let config = try JSONSerialization.jsonObject(with: Data(contentsOf: docs.appendingPathComponent("lifecycle-config.json"))) as! [String: String]
    mode = config["mode"]!; service = config["service"]!
    if mode == "unit" { return nil }
    let binding = try JSONSerialization.jsonObject(with: Data(contentsOf: docs.appendingPathComponent("binding.json"))) as! [String: Any]
    let trust = IntegrationTrust(ca: try Data(contentsOf: docs.appendingPathComponent("root.der")),
      leaf: try Data(contentsOf: docs.appendingPathComponent("leaf.der")), port: binding["port"] as! Int)
    let owner = try BackgroundRuntime(directory: docs.appendingPathComponent("runtime"), create: mode == "prepare",
      keychainService: service, control: DurableTestControl(docs), cellular: false,
      activeUnlocked: { activity.get() }, trust: trust)
    runtime = owner
    record("runtimeCreatedBeforeJS")
    return owner
  }
  static func willLaunch() {
    record("willLaunchBeforeJS")
    do { write(["ok": true, "cases": try runHostTests()], "host-tests.json") }
    catch { write(["ok": false, "error": String(describing: error)], "host-tests.json") }
    let docs = self.docs
    if mode == "unit" {
      DispatchQueue.global(qos: .utility).async {
        do {
          let result = try probeRuntimeDrain(docs)
          Task { @MainActor in write(result, "runtime-drain-probe.json") }
        } catch { Task { @MainActor in write(["error": String(describing: error)], "runtime-drain-probe.json") } }
      }
      return
    }
    guard let runtime else {
      write(["ok": false, "availability": NativeBackgroundHost.shared.availability.rawValue], "native-state.json")
      return
    }
    if mode == "prepare" {
      // Preparation remains active/unlocked-only; no UIKit grace assertion.
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
        let activity = NativeBackgroundHost.shared.activity
        activity.set(activeUnlocked: UIApplication.shared.applicationState == .active && UIApplication.shared.isProtectedDataAvailable)
        DispatchQueue.global(qos: .utility).async {
          do {
            let binding = try JSONSerialization.jsonObject(with: Data(contentsOf: docs.appendingPathComponent("binding.json"))) as! [String: Any]
            func bytes(_ name: String) -> Data {
              let text = binding[name] as! String
              return Data(stride(from: 0, to: text.count, by: 2).map { offset in
                let start = text.index(text.startIndex, offsetBy: offset)
                return UInt8(text[start..<text.index(start, offsetBy: 2)], radix: 16)!
              })
            }
            let source = docs.appendingPathComponent("generated-original")
            try testGenerate(source, count: 64 * 1024 * 1024 + 12345)
            try runtime.prepare(BackgroundSelection(source: source, safeName: "Synthetic.bin", receiver: bytes("receiver"),
              origin: binding["origin"] as! String, device: bytes("device"), enrollmentEpoch: 1,
              destination: .standalone(intake: bytes("intake")), expiresAt: UInt64(Date().timeIntervalSince1970) + 3600))
            try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: docs.appendingPathComponent("runtime/private").path)
            var denied = false
            do { _ = try Data(contentsOf: docs.appendingPathComponent("runtime/private/manifest")) }
            catch { denied = (error as NSError).code == NSFileReadNoPermissionError }
            try backgroundRequire(denied)
            // Check the real private read boundary BEFORE backgrounding. Callback
            // instrumentation itself never opens the protected display manifest.
            try Data([1]).write(to: docs.appendingPathComponent("private-denied-before-background"))
            try backgroundRequire(try testAwait { runtime.restoreAndStart(completion: $0) })
            Task { @MainActor in record("wholeBatchScheduled"); observe(remaining: 600) }
          } catch { Task { @MainActor in write(["ok": false, "error": String(describing: error)], "native-state.json") } }
        }
      }
    } else { observe(remaining: 600) }
  }
  static func observe(remaining: Int) {
    guard let runtime else { return }
    let snapshot = runtime.snapshot()
    var value: [String: Any] = ["phase": snapshot.phase, "confirmedBytes": snapshot.confirmedBytes,
      "originalBytes": snapshot.originalBytes, "groups": snapshot.sealedGroups, "backgroundReady": snapshot.backgroundReady,
      "bridgeCreated": counts["bridgeCreated"] ?? 0, "pid": ProcessInfo.processInfo.processIdentifier]
    do {
      let state = try testState(docs.appendingPathComponent("runtime"))
      if let receipt = state.receiptOutcome {
        let master = try BackgroundKeychain(service: service).read(state.keyReference)
        let context = try state.outcome(master: master)
        let shared = try SealedProtocol.VerifiedReceipt.verify(receipt, keys: .init(master: master, outcome: context)).toOriginalReceipt()
        value["receiptID"] = shared.id; value["jobID"] = shared.jobId; value["sha256"] = shared.sha256; value["bytes"] = shared.bytes
      }
      value["privateDeniedBeforeBackground"] = FileManager.default.fileExists(atPath:
        docs.appendingPathComponent("private-denied-before-background").path)
    } catch { value["ledgerReadFailed"] = true }
    write(value, "native-state.json")
    if remaining > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { observe(remaining: remaining - 1) } }
  }
  static func completed() {
    record("completionMainAfterDrain")
    observe(remaining: 0)
    // Runtime completion is scheduled only after ordered FULL ledger transactions.
    // Independently reopen the actual ledger at handoff, rather than trusting a flag.
    if let state = try? testState(docs.appendingPathComponent("runtime")) {
      write(["phase": state.phase, "confirmedBytes": state.confirmedBytes, "hasReceipt": state.receiptOutcome != nil,
        "main": Thread.isMainThread, "ownedCallbacks": counts["ownedCallback"] ?? 0,
        "completions": counts["completionMainAfterDrain"] ?? 0], "completion-ledger.json")
    }
  }
}
#endif

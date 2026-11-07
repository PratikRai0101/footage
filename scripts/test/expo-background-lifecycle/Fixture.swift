// ONLY compiled into the explicitly flagged, disposable lifecycle test build.
#if FOOTAGE_EXPO_LIFECYCLE_TEST
import UIKit
import Foundation

/// Instrument the actual paired adapter on its native control lane, not a mailbox.
private final class ObservedPairedControl: BackgroundControl {
  let adapter: PairingBackgroundControl, docs: URL
  init(_ adapter: PairingBackgroundControl, docs: URL) { self.adapter = adapter; self.docs = docs }
  func setup(_ m: SealedProtocol.Manifest) throws -> Data { try adapter.setup(m) }
  private func started(_ revoke: Bool) throws {
    try JSONSerialization.data(withJSONObject: ["started": Date().timeIntervalSince1970, "revoke": revoke])
      .write(to: docs.appendingPathComponent("native-control-start.json"), options: .atomic)
  }
  private func ended() {
    try! JSONSerialization.data(withJSONObject: ["ended": Date().timeIntervalSince1970])
      .write(to: docs.appendingPathComponent("native-control-ended.json"), options: .atomic)
  }
  func status(_ m: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data {
    try started(false); defer { ended() }; return try adapter.status(m, query: query)
  }
  func revoke(_ m: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data {
    try started(true); defer { ended() }; return try adapter.revoke(m, query: query)
  }
}

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
    if mode == "unit" || mode == "enroll" { return nil }
    let client = PairingClient(vault: PairingVault(service: service + ".pairing"))
    let confirmed: PairingNativeConfirmedIntake
    let pinned: PairingPinnedTrust
    if mode == "prepare" {
      let binding = try JSONSerialization.jsonObject(with: Data(contentsOf: docs.appendingPathComponent("binding.json"))) as! [String: String]
      confirmed = try PairingNativeConfirmedIntake(afterNativeConfirmation: hex(binding["intake"]!),
        identity: native { try await client.nativeIdentity() })
      pinned = try native { try await client.installedTrust() }
    } else {
      let job = try testState(docs.appendingPathComponent("runtime")).job
      confirmed = try native { try await PairingNativeConfirmedIntake.restoreConfirmedJob(job, client: client) }
      pinned = try native { try await client.confirmedJobTrust(job) }
    }
    if mode == "restore" && config["slowControl"] == "true" {
      // Explicit durable crash-uncertainty fault, before opening the sole native owner.
      // Keep the actual daemon tasks, packet/correlation/job IDs and all accepted ranges.
      try testRewriteState(docs.appendingPathComponent("runtime")) { raw in
        if raw["receiptOutcome"] == nil {
          raw["phase"] = "reconciling"
          var groups = raw["groups"] as! [[String: Any]]
          for i in groups.indices { groups[i]["uncertain"] = true }
          raw["groups"] = groups
        }
      }
    }
    let owner = try BackgroundRuntime(directory: docs.appendingPathComponent("runtime"), create: mode == "prepare",
      keychainService: service, control: ObservedPairedControl(PairingBackgroundControl(client: client,
        nativeConfirmedIntake: confirmed), docs: docs), cellular: false,
      activeUnlocked: { activity.get() }, trust: PairingBackgroundTrust(pinned: pinned))
    runtime = owner
    record("runtimeCreatedBeforeJS")
    let rendezvous = docs.appendingPathComponent("slow-control-rendezvous.json")
    if mode == "restore" && config["slowControl"] == "true"
        && !FileManager.default.fileExists(atPath: rendezvous.path) {
      // TEST-ONLY launch ordering seam. Start the REAL owner's cold reconciliation
      // before returning the installation to the host, then rendezvous with the actual
      // TLS listener. Without this, fast durable drain can beat TLS establishment.
      // The event owner remains free; no event/finish/completion is manufactured.
      // This is not a production startup wait or a background execution assertion.
      let started = Date()
      owner.restoreAndStart { _ in }
      let pending = docs.appendingPathComponent("control-socket-pending.json")
      while !FileManager.default.fileExists(atPath: pending.path) && Date().timeIntervalSince(started) < 3 {
        Thread.sleep(forTimeInterval: 0.001)
      }
      try backgroundRequire(FileManager.default.fileExists(atPath: pending.path))
      write(["testOnlyEarlyRestoreRendezvous": true, "seconds": Date().timeIntervalSince(started)], "slow-control-rendezvous.json")
    }
    return owner
  }
  nonisolated static func hex(_ text: String) -> Data {
    Data(stride(from: 0, to: text.count, by: 2).map { offset in
      let start = text.index(text.startIndex, offsetBy: offset)
      return UInt8(text[start..<text.index(start, offsetBy: 2)], radix: 16)!
    })
  }
  static func willLaunch() {
    record("willLaunchBeforeJS")
    do { write(["ok": true, "cases": try runHostTests()], "host-tests.json") }
    catch { write(["ok": false, "error": String(describing: error)], "host-tests.json") }
    let docs = self.docs
    if mode == "enroll" {
      let service = self.service
      DispatchQueue.global(qos: .utility).async {
        do {
          let client = PairingClient(vault: PairingVault(service: service + ".pairing"))
          let qr = try Data(contentsOf: docs.appendingPathComponent("independent-local.qr"))
          try native { try await client.prepareAfterNativeConfirmation(qr: qr, permissions: 7); try await client.enroll() }
          try native { try await client.recoverLostReply() }
          Task { @MainActor in write(["ok": true, "actualNativeEnrollmentAndRecovery": true], "enrolled.json") }
        } catch { Task { @MainActor in write(["ok": false, "error": String(describing: error)], "enrolled.json") } }
      }
      return
    }
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
        let service = self.service
        activity.set(activeUnlocked: UIApplication.shared.applicationState == .active && UIApplication.shared.isProtectedDataAvailable)
        DispatchQueue.global(qos: .utility).async {
          do {
            let binding = try JSONSerialization.jsonObject(with: Data(contentsOf: docs.appendingPathComponent("binding.json"))) as! [String: Any]
            let client = PairingClient(vault: PairingVault(service: service + ".pairing"))
            let identity = try native { try await client.nativeIdentity() }
            let intake = hex(binding["intake"] as! String)
            let source = docs.appendingPathComponent("generated-original")
            try testGenerate(source, count: 64 * 1024 * 1024 + 12345)
            try runtime.prepare(BackgroundSelection(source: source, safeName: "Synthetic.bin", receiver: identity.receiver,
              origin: identity.origin, device: identity.device, enrollmentEpoch: identity.epoch,
              destination: .standalone(intake: intake), expiresAt: UInt64(Date().timeIntervalSince1970) + 3600))
            // Restore must use the frozen job authority, not a current installation.
            let deleted = SecItemDelete([kSecClass as String: kSecClassGenericPassword,
              kSecAttrService as String: service + ".pairing", kSecAttrAccount as String: "pairing.v1"] as CFDictionary)
            try backgroundRequire(deleted == errSecSuccess)
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
        "completions": counts["completionMainAfterDrain"] ?? 0,
        "uncertainGroups": state.groups.filter(\.uncertain).count,
        "controlSocketPending": FileManager.default.fileExists(atPath: docs.appendingPathComponent("control-socket-pending.json").path),
        "completedAt": Date().timeIntervalSince1970], "completion-ledger.json")
    }
  }
}
#endif

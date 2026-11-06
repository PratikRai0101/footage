import UIKit
import Foundation
import Security
import Darwin

/// Bounded native test command wait; actual control uses production PairingClient.
private final class HarnessWait<T: Sendable>: @unchecked Sendable {
  let semaphore = DispatchSemaphore(value: 0), lock = NSLock()
  var value: Result<T, Error>?
  func finish(_ result: Result<T, Error>) { lock.lock(); value = result; lock.unlock(); semaphore.signal() }
  func get() throws -> T {
    guard semaphore.wait(timeout: .now() + 40) == .success else { throw BackgroundFailure.uncertain }
    lock.lock(); defer { lock.unlock() }; return try value!.get()
  }
}
func native<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) throws -> T {
  let wait = HarnessWait<T>()
  Task.detached { do { wait.finish(.success(try await operation())) } catch { wait.finish(.failure(error)) } }
  return try wait.get()
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
      if mode == "warm" { result(["ok": true]); return }
      let client = PairingClient(vault: PairingVault(service: service + ".pairing"))
      if mode == "enroll" {
        let qr = try Data(contentsOf: docs.appendingPathComponent("independent-local.qr"))
        try native { try await client.prepareAfterNativeConfirmation(qr: qr, permissions: 7); try await client.enroll() }
        // Exercise actual challenge/recovery with the same native-generated device key.
        try native { try await client.recoverLostReply() }
        result(["ok": true, "actualNativeEnrollmentAndRecovery": true]); return
      }
      let root = docs.appendingPathComponent("runtime")
      let confirmed: PairingNativeConfirmedIntake
      let pinned: PairingPinnedTrust
      if mode == "prepare" {
        confirmed = try PairingNativeConfirmedIntake(afterNativeConfirmation: bytes("intake"), identity: native { try await client.nativeIdentity() })
        pinned = try native { try await client.installedTrust() }
      } else {
        let job = try testState(root).job
        confirmed = try native { try await PairingNativeConfirmedIntake.restoreConfirmedJob(job, client: client) }
        pinned = try native { try await client.confirmedJobTrust(job) }
      }
      let identity = confirmed.identity
      let control = PairingBackgroundControl(client: client, nativeConfirmedIntake: confirmed)
      let r = try BackgroundRuntime(directory: root, create: mode == "prepare", keychainService: service,
        control: control, cellular: false, activeUnlocked: { true }, trust: PairingBackgroundTrust(pinned: pinned))
      owner = r
      if mode == "prepare" {
        let source = docs.appendingPathComponent("generated-original")
        let count = 64 * 1024 * 1024 + 12345
        try testGenerate(source, count: count)
        try r.prepare(BackgroundSelection(source: source, safeName: "Synthetic.bin", receiver: identity.receiver,
          origin: identity.origin, device: identity.device, enrollmentEpoch: identity.epoch,
          destination: .standalone(intake: bytes("intake")), expiresAt: UInt64(Date().timeIntervalSince1970) + 3600))
        let savedManifest = try SealedProtocol.Manifest.decode(Data(contentsOf: root.appendingPathComponent("private/manifest")))
        // Actual paired setup retry is the same job/master, never a replacement identity.
        let first = try control.setup(savedManifest), second = try control.setup(savedManifest)
        try backgroundRequire(first == second)
        let changed = try SealedProtocol.Manifest(receiver: savedManifest.receiver, origin: savedManifest.origin,
          job: savedManifest.job, generation: savedManifest.generation, device: savedManifest.device,
          enrollmentEpoch: savedManifest.enrollmentEpoch, destination: .standalone(intake: BackgroundPreseal.uuid()),
          originalBytes: savedManifest.originalBytes, originalSHA256: savedManifest.originalSHA256,
          safeName: savedManifest.safeName, expiresAt: savedManifest.expiresAt, frameHashes: savedManifest.frameHashes)
        var changedSetupRejected = false, changedContextRejected = false
        do { _ = try control.setup(changed) } catch { changedSetupRejected = true }
        let wrongContext = try SealedProtocol.OutcomeContext.fromManifest(changed)
        do { _ = try control.status(wrongContext, query: .fresh(operation: BackgroundPreseal.uuid())) }
        catch { changedContextRejected = true }
        try backgroundRequire(changedSetupRejected && changedContextRejected)
        // Delete ONLY this owned app's current pairing item. Existing job control and
        // TLS must restore from its frozen private authority, without reinstalling it.
        let deleted = SecItemDelete([kSecClass as String: kSecClassGenericPassword,
          kSecAttrService as String: service + ".pairing", kSecAttrAccount as String: "pairing.v1"] as CFDictionary)
        try backgroundRequire(deleted == errSecSuccess)
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
          "confirmedBytes": s.confirmedBytes, "privateManifestReadDenied": denied,
          "exactSetupRetrySameMaster": true, "changedSetupAndOutcomeBindingRejected": true,
          "currentInstallationRemovedAfterFreeze": true], "scheduled.json")
        return
      }
      if mode == "status" {
        let state = try testState(root)
        let master = try BackgroundKeychain(service: service).read(state.keyReference)
        let context = try state.outcome(master: master)
        let query = try SealedProtocol.Query.fresh(operation: BackgroundPreseal.uuid())
        let bytes = try control.status(context, query: query)
        let verified = try SealedProtocol.VerifiedStatus.verify(bytes, keys: .init(master: master, outcome: context), query: query, highWater: state.revision)
        guard let receipt = verified.receipt else { throw BackgroundFailure.integrity }
        let shared = try receipt.toOriginalReceipt()
        result(["ok": true, "receiptID": shared.id, "jobID": shared.jobId, "sha256": shared.sha256, "bytes": shared.bytes]); return
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

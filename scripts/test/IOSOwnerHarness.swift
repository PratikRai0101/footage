// Simulator-only test host. Compiles the production owner unchanged; never part of the Expo pod.
import UIKit
import Foundation
import CryptoKit

@main
final class Harness: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  private var timer: Timer?
  private var owner: TransferOwner?
  private var last = -1
  private let queue = DispatchQueue(label: "footage.harness.commands")
  private var documents: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    window?.rootViewController = UIViewController()
    window?.rootViewController?.view.backgroundColor = .black
    window?.makeKeyAndVisible()
    timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in self?.tick() }
    return true
  }
  private func tick() {
    guard let data = try? Data(contentsOf: documents.appendingPathComponent("command.json")),
          let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let sequence = command["sequence"] as? Int, sequence != last else { return }
    last = sequence
    queue.async { [self] in
      do {
        if owner == nil { owner = try TransferOwner(directory: documents.appendingPathComponent("owner")) }
        guard let owner else { return }
        var extra: [String: Any] = [:]
        switch command["action"] as? String {
        case "prepare":
          try owner.prepare(source: documents.appendingPathComponent("generated-original.mp4").absoluteString, name: "generated-original.mp4", endpoint: command["origin"] as? String ?? "")
        case "prepare-cancel":
          try owner.prepare(source: documents.appendingPathComponent("generated-original.mp4").absoluteString, name: "generated-original.mp4", endpoint: command["origin"] as? String ?? "")
          try owner.cancel()
        case "prepare-missing":
          try owner.prepare(source: documents.appendingPathComponent("missing.mp4").absoluteString, name: "missing.mp4", endpoint: command["origin"] as? String ?? "")
        case "start": try owner.start()
        case "cancel": try owner.cancel()
        case "configure": try owner.configure(origin: command["origin"] as? String ?? "", appearance: "light")
        case "core": try coreTests(); extra["corePassed"] = true
        case "redirect-no-auth":
          let operation = TransferHTTP(origin: command["origin"] as? String ?? "")
          do {
            _ = try operation.execute(method: "PATCH", path: "/probe", file: documents.appendingPathComponent("generated-original.mp4"), offset: 0)
            throw TransferFailure(message: "Redirect probe was not rejected.")
          } catch let error as TransferFailure where error.message.contains("No redirect was followed") {
            extra["redirectRejectedWithoutCredentials"] = true
          }
        case "viewer": extra["viewerValid"] = try owner.viewer().contains("/receive#")
        case "snapshot": break
        default: throw TransferFailure(message: "Unknown test command.")
        }
        var snapshot = try JSONSerialization.jsonObject(with: Data(owner.snapshot().utf8)) as! [String: Any]
        extra["stagedExists"] = snapshot["localUri"] is String
        snapshot.removeValue(forKey: "localUri") // Never log a private selected/staged URI.
        extra["sequence"] = sequence; extra["snapshot"] = snapshot
        extra["settings"] = try JSONSerialization.jsonObject(with: Data(owner.settings().utf8))
        try JSONSerialization.data(withJSONObject: extra, options: [.sortedKeys]).write(to: documents.appendingPathComponent("result.json"), options: .atomic)
      } catch {
        let result: [String: Any] = ["sequence": sequence, "error": error is TransferFailure ? error.localizedDescription : "Native operation failed."]
        try? JSONSerialization.data(withJSONObject: result).write(to: documents.appendingPathComponent("result.json"), options: .atomic)
      }
    }
  }
  private func coreTests() throws {
    let origins = ["http://127.0.0.1:1080/", "https://example.test", "http://[::1]:1080", "http://localhost:1080"]
    for value in origins { _ = try receiverOrigin(value) }
    for value in ["http://example.test", "http://127.0.0.1.evil.test", "http://127.0.0.1@evil.test", "http://0127.0.0.1", "http://%31%32%37.0.0.1", "https://example.test/path", "https://example.test?x=1", "https://example.test#x", "https://example.test:0", "https://example.test\\@evil.test", "//example.test", "file:///tmp/test"] {
      do { _ = try receiverOrigin(value); throw TransferFailure(message: "Invalid origin accepted.") }
      catch let failure as TransferFailure where failure.message == "Invalid origin accepted." { throw failure }
      catch {}
    }
    let directory = documents.appendingPathComponent("core-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try TransferStore(directory: directory)
    let job = TransferJob(id: UUID().uuidString.lowercased(), name: "generated", bytes: 100, sha256: String(repeating: "a", count: 64), origin: "http://127.0.0.1:1080", capability: String(repeating: "b", count: 64), media: TransferMedia(), fileExtension: "mp4", confirmed: 40, phase: .waiting)
    try store.save(job)
    try store.configure(TransferSettings(origin: job.origin, appearance: "light"))
    let reopened = try TransferStore(directory: directory)
    try requireTransfer(reopened.job?.id == job.id && reopened.job?.confirmed == 40 && reopened.settings.appearance == "light", "Durable job/settings roundtrip failed.")
    let receipt = TransferReceipt(id: UUID().uuidString, jobId: job.id, bytes: job.bytes, sha256: job.sha256, verifiedAt: "2026-11-06T12:00:00.000Z")
    try receipt.validate(job)
    let wrong = TransferReceipt(id: receipt.id, jobId: UUID().uuidString, bytes: job.bytes, sha256: job.sha256, verifiedAt: receipt.verifiedAt)
    do { try wrong.validate(job); throw TransferFailure(message: "Wrong receipt accepted.") }
    catch let failure as TransferFailure where failure.message == "Wrong receipt accepted." { throw failure }
    catch {}
    var received = job; received.confirmed = job.bytes; received.phase = .received(receipt)
    try store.save(received)
    try store.savePreparation(.cancelled)
    let cancelled = try TransferStore(directory: directory)
    try requireTransfer(cancelled.preparation == .cancelled && cancelled.job?.id == job.id, "Preparation cancellation revived a previous receipt.")
    let retained = store.original(job)
    let orphan = store.original(UUID().uuidString.lowercased(), fileExtension: "mp4")
    try Data(repeating: 0x46, count: 100).write(to: retained)
    try Data([0x46]).write(to: orphan)
    _ = try TransferOwner(directory: directory, observeLifecycle: false)
    try requireTransfer(FileManager.default.fileExists(atPath: retained.path) && !FileManager.default.fileExists(atPath: orphan.path), "Crash cleanup removed the active original or kept an orphan.")
    let stateURL = directory.appendingPathComponent("transfer.json")
    let corrupt = Data("invalid metadata".utf8)
    try corrupt.write(to: stateURL, options: .atomic)
    do { _ = try TransferStore(directory: directory); throw TransferFailure(message: "Corrupt data silently discarded.") }
    catch let failure as TransferFailure where failure.message == "Corrupt data silently discarded." { throw failure }
    catch {}
    try requireTransfer(try Data(contentsOf: stateURL) == corrupt, "Corrupt state was overwritten.")
  }
}

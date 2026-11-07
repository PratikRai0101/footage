import Foundation
import AVFoundation
import UniformTypeIdentifiers
import UIKit
import OSLog

struct NativeAppFailure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}
func appJSON(_ value: Any) throws -> String {
  String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
}
func appUUID(_ bytes: Data) throws -> String {
  try backgroundRequire(bytes.count == 16)
  let hex = bytes.map { String(format: "%02x", $0) }.joined()
  return "\(hex.prefix(8))-\(hex.dropFirst(8).prefix(4))-\(hex.dropFirst(12).prefix(4))-\(hex.dropFirst(16).prefix(4))-\(hex.dropFirst(20))"
}
struct NativeClipMetadata: Codable, Sendable {
  var durationMs: Int?, width: Int?, height: Int?, mimeType: String?
  var object: [String: Any] { ["durationMs": durationMs as Any? ?? NSNull(), "width": width as Any? ?? NSNull(), "height": height as Any? ?? NSNull(), "mimeType": mimeType as Any? ?? NSNull()] }
  static func inspect(_ url: URL) async -> Self {
    let access = url.startAccessingSecurityScopedResource()
    defer { if access { url.stopAccessingSecurityScopedResource() } }
    var m = Self(mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType)
    let asset = AVURLAsset(url: url)
    if let duration = try? await asset.load(.duration) {
      let seconds = CMTimeGetSeconds(duration)
      if seconds.isFinite && seconds > 0 && seconds < Double(Int.max / 1000) { m.durationMs = max(1, Int(seconds * 1000)) }
    }
    if let track = try? await asset.loadTracks(withMediaType: .video).first,
       let (size, transform) = try? await track.load(.naturalSize, .preferredTransform) {
      let rotated = size.applying(transform)
      if rotated.width.isFinite && rotated.height.isFinite && abs(rotated.width) >= 1 && abs(rotated.height) >= 1 && abs(rotated.width) < 100000 && abs(rotated.height) < 100000 {
        m.width = Int(abs(rotated.width)); m.height = Int(abs(rotated.height))
      }
    }
    return m
  }
}

/// The ordinary app adapter uses the SAME daemon/ledger owner as OS callbacks.
/// Only sanitized presentation JSON crosses the Expo bridge. It never owns upload bytes.
final class NativeAppTransfer: NativeBackgroundRuntime, @unchecked Sendable {
  let runtime: BackgroundRuntime
  let directory: URL
  let client: PairingClient
  private var installedConnection: NativeAppConnection
  var connection: NativeAppConnection { locked { installedConnection } }
  var isPreparing: Bool { locked { preparing != nil } }
  private let lock = NSLock()
  private var preparing: String?
  private var preparationError: String?
  private var preparationCancelled = false
  private var cancelledDuringPreparation = false
  private var lastReconciliation = Date.distantPast
  init(runtime: BackgroundRuntime, directory: URL, client: PairingClient, connection: NativeAppConnection) {
    self.runtime = runtime; self.directory = directory; self.client = client; self.installedConnection = connection
  }
  func restoreAndStart(completion: @escaping @Sendable (Bool) -> Void) { runtime.restoreAndStart(completion: completion) }
  func handleBackgroundEvents(_ identifier: String, completion: @escaping @MainActor @Sendable () -> Void) { runtime.handleBackgroundEvents(identifier, completion: completion) }
  private func locked<T>(_ body: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try body() }
  func prepare(uri: String, name: String, origin: String) throws {
    guard let url = URL(string: uri), url.isFileURL else { throw NativeAppFailure(message: "Choose an accessible original video.") }
    let connection = connection
    try pairingRequire(origin == connection.origin)
    try locked {
      guard preparing == nil else { throw NativeAppFailure(message: "Wait for preparation to finish.") }
      preparing = name; preparationError = nil; preparationCancelled = false; cancelledDuringPreparation = false
    }
    Task.detached(priority: .utility) { [self] in
      let access = url.startAccessingSecurityScopedResource()
      defer { if access { url.stopAccessingSecurityScopedResource() } }
      do {
        let identity = try await client.nativeIdentity()
        try pairingRequire(identity.receiver == connection.receiver && identity.device == connection.device && identity.origin == connection.origin)
        let archived = await withCheckedContinuation { continuation in runtime.archiveForNextSelection { continuation.resume(returning: $0) } }
        guard archived else { throw NativeAppFailure(message: "Finish or cancel the current upload before choosing another original.") }
        let metadata = await NativeClipMetadata.inspect(url)
        let bytes = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard bytes > 0 && bytes <= 1024 * 1024 * 1024 else { throw NativeAppFailure(message: "Choose an original up to 1 GiB for this receiver.") }
        let cancelled = locked { cancelledDuringPreparation }
        guard !cancelled else { throw BackgroundFailure.cancelled }
        let expiry = min(identity.expires, UInt64(Date().timeIntervalSince1970) + 6 * 86400)
        try runtime.prepare(.init(source: url, safeName: name, receiver: identity.receiver, origin: identity.origin,
          device: identity.device, enrollmentEpoch: identity.epoch, destination: .standalone(intake: connection.intake), expiresAt: expiry))
        let privateDirectory = directory.appendingPathComponent("private")
        let metadataURL = privateDirectory.appendingPathComponent("media.json")
        try BackgroundFiles.save(JSONEncoder().encode(metadata), to: metadataURL, complete: true)
        // AVFoundation needs the original extension for some containers. This is a
        // native private hard link to the same staged bytes, never a conversion.
        let ext = url.pathExtension.lowercased()
        if ext.range(of: "^[a-z0-9]{1,12}$", options: .regularExpression) != nil {
          let preview = privateDirectory.appendingPathComponent("preview." + ext)
          try FileManager.default.linkItem(at: privateDirectory.appendingPathComponent("original"), to: preview)
          try BackgroundFiles.syncDirectory(privateDirectory)
        }
        locked { preparing = nil }
      } catch {
        let diagnostic = error as NSError
        Logger(subsystem: "dev.footage.spike", category: "preparation").error("Preparation failed: domain=\(diagnostic.domain, privacy: .public) code=\(diagnostic.code, privacy: .public)")
        locked {
          preparing = nil
          preparationCancelled = cancelledDuringPreparation || (error as? BackgroundFailure) == .cancelled
          preparationError = preparationCancelled ? nil : ((error as? BackgroundFailure) == .inactive ? "Keep Footage open until preparation finishes, then try again." : "Could not prepare the original. Check storage and the computer connection.")
        }
      }
    }
  }
  func installNextConnection(_ connection: NativeAppConnection, identity: PairingInstalledIdentity, trust: PairingPinnedTrust) throws {
    try runtime.installForNextJob(control: PairingBackgroundControl(client: client,
      nativeConfirmedIntake: PairingNativeConfirmedIntake(afterNativeConfirmation: connection.intake, identity: identity)),
      trust: PairingBackgroundTrust(pinned: trust))
    locked { installedConnection = connection }
  }
  func cancel(completion: @escaping @Sendable () -> Void) {
    locked { cancelledDuringPreparation = preparing != nil }
    runtime.cancel { _ in completion() }
  }
  func current() throws -> String {
    let local = locked { (preparing, preparationError, preparationCancelled) }
    if let name = local.0 { return try appJSON(["kind": "preparing", "name": name, "copiedBytes": 0]) }
    guard let state = runtime.stateForPresentation() else {
      if local.2 { return try appJSON(["kind": "preparation_cancelled"]) }
      if let message = local.1 { return try appJSON(["kind": "preparation_failed", "message": message]) }
      return try appJSON(["kind": "empty"])
    }
    let snapshot = runtime.snapshot()
    if state.receiptOutcome == nil && (["verifying", "reconciling"].contains(state.phase) || state.groups.contains(where: \.uncertain)) {
      let check = locked { () -> Bool in
        guard Date().timeIntervalSince(lastReconciliation) >= 3 else { return false }
        lastReconciliation = Date(); return true
      }
      if check { runtime.restoreAndStart { _ in } }
    }
    let manifestURL = directory.appendingPathComponent("private/manifest")
    let manifest = try SealedProtocol.Manifest.decode(Data(contentsOf: manifestURL))
    let metadataURL = directory.appendingPathComponent("private/media.json")
    let metadata = (try? JSONDecoder().decode(NativeClipMetadata.self, from: Data(contentsOf: metadataURL))) ?? NativeClipMetadata()
    let privateFiles = try FileManager.default.contentsOfDirectory(at: manifestURL.deletingLastPathComponent(), includingPropertiesForKeys: nil)
    let preview = privateFiles.first(where: { $0.lastPathComponent.hasPrefix("preview.") }) ?? directory.appendingPathComponent("private/original")
    var value: [String: Any] = ["id": try appUUID(state.job), "name": manifest.safeName, "bytes": state.originalBytes,
      "confirmedBytes": snapshot.confirmedBytes, "sha256": state.originalHash.map { String(format: "%02x", $0) }.joined(),
      "localUri": FileManager.default.fileExists(atPath: preview.path) ? preview.absoluteString : NSNull(), "media": metadata.object,
      "executionActive": state.groups.contains { $0.taskID != nil && $0.resumed }]
    if let envelope = state.receiptOutcome {
      let keychain = BackgroundKeychain(service: NativeAppInstallation.keychainService)
      let master = try keychain.read(state.keyReference)
      let context = try state.outcome(master: master)
      let receipt = try SealedProtocol.VerifiedReceipt.verify(envelope, keys: .init(master: master, outcome: context)).toOriginalReceipt()
      value["kind"] = "received"
      value["receipt"] = ["id": receipt.id, "jobId": receipt.jobId, "bytes": receipt.bytes, "sha256": receipt.sha256, "verifiedAt": receipt.verifiedAt]
    } else if state.cancelOperation != nil {
      value["kind"] = "cancelled"; value["cleanupPending"] = snapshot.cleanupPending
    } else {
      switch snapshot.phase {
      case "ready": value["kind"] = "ready"
      case "transferring":
        if state.groups.contains(where: { $0.uncertain && $0.taskID == nil }) {
          value["kind"] = "waiting"; value["executionActive"] = false; value["message"] = "Your progress is saved. Continue to check the same upload."
        } else { value["kind"] = "uploading" }
      case "verifying": value["kind"] = "verifying"
      case "preparing": value["kind"] = "preparing"; value["copiedBytes"] = 0
      case "blocked": value["kind"] = "failed"; value["retryable"] = false; value["message"] = local.1 ?? "This transfer needs recovery. Cancel it before choosing another original."
      default: value["kind"] = "waiting"; value["message"] = "Waiting for the computer. Continue to check the same upload."
      }
    }
    return try appJSON(value)
  }
  func viewer() async throws -> String {
    guard let state = runtime.stateForPresentation(), state.receiptOutcome != nil else { throw NativeAppFailure(message: "Wait for a verified original.") }
    let master = try BackgroundKeychain(service: NativeAppInstallation.keychainService).read(state.keyReference)
    let context = try state.outcome(master: master)
    let query = try SealedProtocol.Query.fresh(operation: BackgroundPreseal.uuid())
    let bytes = try await client.control(.view, job: state.job, canonicalBody: query.encode(context))
    struct Grant: Decodable { let path: String }
    let grant = try JSONDecoder().decode(Grant.self, from: bytes)
    try pairingRequire(grant.path.range(of: "^/receive#[a-f0-9]{64}$", options: .regularExpression) != nil)
    return context.origin + grant.path
  }
}

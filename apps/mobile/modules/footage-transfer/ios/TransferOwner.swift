import Foundation
import CryptoKit
import AVFoundation
import UIKit
import UniformTypeIdentifiers

final class TransferOwner {
  private let lock = NSRecursiveLock()
  private let worker = DispatchQueue(label: "footage.original.worker", qos: .utility)
  let store: TransferStore
  private var busy = false
  private var executionActive = false
  private var stopped = false
  private var foreground = true
  private var http: TransferHTTP?
  private enum Preparation {
    case copying(String, Int64), cancelled, failed
  }
  private var preparation: Preparation?
  private var observers: [NSObjectProtocol] = []

  init(directory: URL, observeLifecycle: Bool = true) throws {
    store = try TransferStore(directory: directory)
    if let saved = store.preparation { preparation = saved == .failed ? .failed : .cancelled }
    // Never resume execution implicitly. A persisted attempt becomes a manual checkpoint.
    if var job = store.job, !job.phase.terminal, store.preparation == nil {
      job.phase = .waiting
      try store.save(job)
    }
    let retained = store.job.map { store.original($0).lastPathComponent }
    for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
      let orphan = file.lastPathComponent.range(of: "^[a-f0-9-]{36}\\.original(?:\\.[a-z0-9]{1,12})?$", options: .regularExpression) != nil && file.lastPathComponent != retained
      if ["partial", "chunk"].contains(file.pathExtension) || orphan { try FileManager.default.removeItem(at: file) }
    }
    if observeLifecycle {
      foreground = DispatchQueue.main.syncIfNeeded { UIApplication.shared.applicationState == .active }
      observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.suspend() })
      observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
        self?.locked { self?.foreground = true }
      })
    }
  }
  deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }
  private func locked<T>(_ body: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try body() }
  private func active(_ id: String) -> Bool {
    locked { !stopped && foreground && store.job?.id == id && store.job?.phase.terminal == false }
  }
  private func check(_ id: String) throws {
    try requireTransfer(active(id), "Upload paused. Return to Footage and tap Continue.")
  }
  func snapshot() throws -> String {
    try locked {
      if let preparation {
        switch preparation {
        case .copying(let name, let count): return try transferJSON(["kind": "preparing", "name": name, "copiedBytes": count])
        case .cancelled: return try transferJSON(["kind": "preparation_cancelled"])
        case .failed: return try transferJSON(["kind": "preparation_failed", "message": "Could not prepare the original. Check available storage and choose it again."])
        }
      }
      guard let job = store.job else { return try transferJSON(["kind": "empty"]) }
      let file = store.original(job)
      var value: [String: Any] = ["id": job.id, "name": job.name, "bytes": job.bytes, "sha256": job.sha256,
        "confirmedBytes": job.confirmed, "media": job.media.json, "executionActive": executionActive,
        "localUri": FileManager.default.fileExists(atPath: file.path) ? file.absoluteString : NSNull()]
      switch job.phase {
      case .ready: value["kind"] = "ready"
      case .uploading: value["kind"] = "uploading"
      case .waiting: value["kind"] = "waiting"; value["message"] = "Keep Footage open while uploading. Tap Continue to resume."
      case .verifying: value["kind"] = "verifying"
      case .received(let receipt): value["kind"] = "received"; value["receipt"] = receipt.json
      case .cancelled(let pending): value["kind"] = "cancelled"; value["cleanupPending"] = pending
      case .failed(let message, let retryable): value["kind"] = "failed"; value["message"] = message; value["retryable"] = retryable
      }
      return try transferJSON(value)
    }
  }
  func settings() throws -> String { try locked { try transferJSON(["origin": store.settings.origin, "appearance": store.settings.appearance]) } }
  func configure(origin: String, appearance: String) throws {
    let normalized = origin.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "" : try receiverOrigin(origin)
    try locked { try store.configure(TransferSettings(origin: normalized, appearance: appearance)) }
  }
  func prepare(source: String, name: String, endpoint: String) throws {
    let origin = try receiverOrigin(endpoint) // BEFORE creating a capability or touching a selected file.
    guard let sourceURL = URL(string: source), sourceURL.isFileURL else { throw TransferFailure(message: "Choose an accessible original video.") }
    let safeName = String(name.prefix(240)).isEmpty ? "Original video" : String(name.prefix(240))
    try locked {
      try requireTransfer(!busy && foreground, "Return to Footage and wait for the current operation to finish.")
      try requireTransfer(store.job == nil || store.job!.phase.replaceable, "Finish or cancel the existing transfer first.")
      try store.savePreparation(.interrupted)
      stopped = false; busy = true; preparation = .copying(safeName, 0)
    }
    worker.async { [self] in
      let id = UUID().uuidString.lowercased()
      let partial = store.directory.appendingPathComponent("\(id).partial")
      let suffix = sourceURL.pathExtension.lowercased()
      let fileExtension = suffix.range(of: "^[a-z0-9]{1,12}$", options: .regularExpression) != nil ? suffix : nil
      let destination = store.original(id, fileExtension: fileExtension)
      do {
        let access = sourceURL.startAccessingSecurityScopedResource()
        defer { if access { sourceURL.stopAccessingSecurityScopedResource() } }
        let before = try sourceURL.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey])
        let expected = Int64(before.fileSize ?? 0)
        try requireTransfer(before.isRegularFile == true && expected > 0 && expected <= 4 * 1024 * 1024 * 1024, "Choose an original up to 4 GiB.")
        let available = try FileManager.default.attributesOfFileSystem(forPath: store.directory.path)[.systemFreeSize] as? NSNumber
        try requireTransfer((available?.int64Value ?? 0) > expected + 8 * 1024 * 1024, "Not enough storage for a stable local copy.")
        FileManager.default.createFile(atPath: partial.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete])
        let input = try FileHandle(forReadingFrom: sourceURL)
        defer { try? input.close() }
        let output = try FileHandle(forWritingTo: partial)
        defer { try? output.close() }
        var hash = SHA256()
        var count: Int64 = 0
        while true {
          try requireTransfer(locked { !stopped && foreground }, "Preparation cancelled.")
          let data = try input.read(upToCount: 64 * 1024) ?? Data()
          if data.isEmpty { break }
          count += Int64(data.count)
          try requireTransfer(count <= expected, "The selected original changed during preparation.")
          try output.write(contentsOf: data)
          hash.update(data: data)
          locked { preparation = .copying(safeName, count) }
        }
        try output.synchronize()
        let after = try sourceURL.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        try requireTransfer(count == expected && after.fileSize == before.fileSize && after.contentModificationDate == before.contentModificationDate,
                            "The selected original changed during preparation.")
        try FileManager.default.moveItem(at: partial, to: destination)
        let media = Self.inspectURL(destination)
        let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
        let capability = (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
        try locked {
          try requireTransfer(!stopped && foreground, "Preparation cancelled.")
          let previous = store.job
          try store.save(TransferJob(id: id, name: safeName, bytes: count, sha256: digest, origin: origin, capability: capability, media: media, fileExtension: fileExtension))
          preparation = nil
          if let previous { try? FileManager.default.removeItem(at: store.original(previous)) }
        }
      } catch {
        try? FileManager.default.removeItem(at: partial)
        try? FileManager.default.removeItem(at: destination)
        locked {
          preparation = stopped ? .cancelled : .failed
          try? store.savePreparation(stopped ? .cancelled : .failed)
        }
      }
      locked { busy = false }
    }
  }
  func start() throws {
    try locked {
      try requireTransfer(foreground && !busy, "Return to Footage and wait for the current operation to finish.")
      guard let job = store.job else { throw TransferFailure(message: "Prepare an original first.") }
      try requireTransfer(!job.phase.terminal && preparation == nil, "This transfer has ended.")
      stopped = false; busy = true; executionActive = true
    }
    worker.async { [self] in
      defer { locked { busy = false; executionActive = false; http = nil } }
      guard let job = locked({ store.job }) else { return }
      do { try transfer(job) }
      catch {
        // Any uncertain PATCH is left for HEAD on manual continuation, using the SAME identity.
        try? locked {
          guard var current = store.job, current.id == job.id, !current.phase.terminal else { return }
          if stopped { current.phase = .waiting }
          else if let status = error as? TransferHTTPError, status.status == 507 {
            current.phase = .failed("The upload destination is full. Free up space, then try again.", true)
          } else if error is TransferFailure {
            current.phase = .failed((error as? TransferFailure)?.message ?? "Transfer failed.", false)
          } else if let status = error as? TransferHTTPError, (400...499).contains(status.status), ![408, 409, 429].contains(status.status) {
            current.phase = .failed("The destination rejected the upload. Cancel it before choosing another original.", false)
          } else { current.phase = .waiting }
          try store.save(current)
        }
      }
    }
  }
  func suspend() {
    locked {
      foreground = false; stopped = true; executionActive = false
      http?.cancel()
      if case .copying = preparation { preparation = .cancelled; try? store.savePreparation(.cancelled) }
      if var job = store.job, !job.phase.terminal { job.phase = .waiting; try? store.save(job) }
    }
  }
  func cancel() throws {
    try locked {
      if case .copying = preparation { try store.savePreparation(.cancelled); stopped = true; preparation = .cancelled; return }
      if preparation != nil { return }
      guard var job = store.job else { return }
      if case .received = job.phase { return }
      job.phase = .cancelled(true)
      try store.save(job) // Durable cancellation BEFORE stopping transport.
      stopped = true; executionActive = false; http?.cancel()
      worker.async { [self] in
        do {
          let result = try request(job, "DELETE", "/jobs/\(job.id)", allowConflict: true, cleanup: true).json()
          if let receipt = result["receipt"] { try publish(job, receipt) }
          else {
            try requireTransfer(result["id"] as? String == job.id && result["status"] as? String == "cancelled" && result["cleanup"] as? String == "complete", "Cancellation has not been confirmed.")
            try locked {
              guard var current = store.job, current.id == job.id else { return }
              if case .cancelled = current.phase {
                // Do not claim cleanup complete if the private staged copy could not be removed.
                if FileManager.default.fileExists(atPath: store.original(job).path) { try FileManager.default.removeItem(at: store.original(job)) }
                current.phase = .cancelled(false); try store.save(current)
              }
            }
          }
        } catch { /* Pending cancellation persists. Explicit retry is required, including after relaunch. */ }
      }
    }
  }
  private func update(_ job: TransferJob, phase: TransferPhase? = nil, confirmed: Int64? = nil) throws {
    try locked {
      guard var current = store.job, current.id == job.id, !current.phase.terminal else { return }
      if let phase { current.phase = phase }
      if let confirmed { current.confirmed = confirmed }
      try store.save(current)
    }
  }
  private func transfer(_ job: TransferJob) throws {
    try check(job.id)
    let body = try JSONSerialization.data(withJSONObject: ["id": job.id, "name": job.name, "bytes": job.bytes, "sha256": job.sha256])
    let registration = try request(job, "POST", "/jobs", body: body).json()
    try requireTransfer(registration["id"] as? String == job.id && (registration["bytes"] as? NSNumber)?.int64Value == job.bytes, "The destination returned a different job.")
    if registration["status"] as? String == "received", let receipt = registration["receipt"] { try publish(job, receipt); return }
    try requireTransfer(registration["status"] as? String == "uploading", "The destination cannot accept this upload.")
    try check(job.id)
    let head = try request(job, "HEAD", "/files/\(job.id)")
    guard let offsetValue = head.headers.value(forHTTPHeaderField: "Upload-Offset"), let offset = Int64(offsetValue),
          let lengthValue = head.headers.value(forHTTPHeaderField: "Upload-Length"), let length = Int64(lengthValue) else {
      throw TransferFailure(message: "The destination returned invalid upload progress.")
    }
    try requireTransfer(length == job.bytes && (job.confirmed...job.bytes).contains(offset), "The destination lost or changed the saved upload. Cancel before choosing another original.")
    try update(job, phase: .uploading, confirmed: offset)
    var confirmed = offset
    let input = try FileHandle(forReadingFrom: store.original(job))
    defer { try? input.close() }
    let actualSize = try FileManager.default.attributesOfItem(atPath: store.original(job).path)[.size] as? NSNumber
    try requireTransfer(actualSize?.int64Value == job.bytes, "The staged original is no longer complete.")
    try input.seek(toOffset: UInt64(confirmed))
    let chunk = store.directory.appendingPathComponent("\(job.id).chunk")
    defer { try? FileManager.default.removeItem(at: chunk) }
    while confirmed < job.bytes {
      try check(job.id)
      let count = min(2 * 1024 * 1024, job.bytes - confirmed)
      FileManager.default.createFile(atPath: chunk.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete])
      let output = try FileHandle(forWritingTo: chunk)
      do {
        try output.truncate(atOffset: 0)
        var remaining = count
        while remaining > 0 {
          try check(job.id)
          let data = try input.read(upToCount: Int(min(65536, remaining))) ?? Data()
          try requireTransfer(!data.isEmpty, "The staged original ended unexpectedly.")
          try output.write(contentsOf: data); remaining -= Int64(data.count)
        }
        try output.synchronize(); try output.close()
      } catch { try? output.close(); throw error }
      let patch = try request(job, "PATCH", "/files/\(job.id)", file: chunk, offset: confirmed)
      guard patch.status == 204 && patch.headers.value(forHTTPHeaderField: "Upload-Offset") == String(confirmed + count) else {
        throw TransferHTTPError(status: 409) // Uncertain confirmation must reconcile HEAD, never resend at zero.
      }
      confirmed += count
      try update(job, confirmed: confirmed)
    }
    try check(job.id)
    try update(job, phase: .verifying)
    let receipt = try request(job, "POST", "/jobs/\(job.id)/complete").json()
    try publish(job, receipt)
  }
  private func publish(_ job: TransferJob, _ object: Any) throws {
    let receipt = try JSONDecoder().decode(TransferReceipt.self, from: JSONSerialization.data(withJSONObject: object))
    try receipt.validate(job)
    try locked {
      guard var current = store.job, current.id == job.id else { throw TransferFailure(message: "The receipt belongs to another job.") }
      // A committed receipt wins even if Cancel raced its response.
      current.confirmed = current.bytes; current.phase = .received(receipt); try store.save(current)
    }
  }
  private func request(_ job: TransferJob, _ method: String, _ path: String, body: Data? = nil, file: URL? = nil,
                       offset: Int64? = nil, allowConflict: Bool = false, cleanup: Bool = false) throws -> TransferResponse {
    let operation = TransferHTTP(origin: job.origin)
    try locked {
      try requireTransfer(foreground && (cleanup || !stopped), "Return to Footage to continue.")
      http = operation
    }
    defer { locked { if http === operation { http = nil } } }
    let response = try operation.execute(method: method, path: path, capability: job.capability, body: body, file: file, offset: offset)
    if !(200...299).contains(response.status) && !(allowConflict && response.status == 409) { throw TransferHTTPError(status: response.status) }
    return response
  }
  func viewer() throws -> String {
    let job = try locked { () throws -> TransferJob in
      guard let job = store.job, case .received = job.phase else { throw TransferFailure(message: "Wait for a verified receipt.") }
      return job
    }
    let object = try request(job, "POST", "/jobs/\(job.id)/view", cleanup: true).json()
    guard let path = object["path"] as? String, path.range(of: "^/receive#[a-f0-9]{64}$", options: .regularExpression) != nil else {
      throw TransferFailure(message: "The destination returned an invalid viewing link.")
    }
    return job.origin + path
  }
  static func inspect(_ source: String) throws -> String {
    guard let url = URL(string: source), url.isFileURL else { throw TransferFailure(message: "Choose an accessible original video.") }
    let access = url.startAccessingSecurityScopedResource()
    defer { if access { url.stopAccessingSecurityScopedResource() } }
    return try transferJSON(inspectURL(url).json)
  }
  private static func inspectURL(_ url: URL) -> TransferMedia {
    // Called only on a native worker, never the main thread. No transcoding or video Data read.
    let done = DispatchSemaphore(value: 0)
    var media = TransferMedia()
    Task.detached {
      defer { done.signal() }
      let asset = AVURLAsset(url: url)
      media.mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
      if let time = try? await asset.load(.duration) {
        let duration = CMTimeGetSeconds(time)
        if duration.isFinite && duration > 0 && duration < Double(Int.max / 1000) { media.durationMs = max(1, Int(duration * 1000)) }
      }
      if let track = try? await asset.loadTracks(withMediaType: .video).first,
         let (naturalSize, transform) = try? await track.load(.naturalSize, .preferredTransform) {
        let size = naturalSize.applying(transform)
        if size.width.isFinite && size.height.isFinite && abs(size.width) >= 1 && abs(size.height) >= 1 &&
           abs(size.width) <= Double(Int32.max) && abs(size.height) <= Double(Int32.max) {
          media.width = Int(abs(size.width)); media.height = Int(abs(size.height))
        }
      }
    }
    done.wait()
    return media
  }
}

private extension DispatchQueue {
  func syncIfNeeded<T>(_ body: () -> T) -> T { Thread.isMainThread ? body() : sync(execute: body) }
}

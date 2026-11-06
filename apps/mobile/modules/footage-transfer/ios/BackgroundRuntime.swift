import Foundation

struct BackgroundSnapshot: Sendable {
  let phase: String, originalBytes: UInt64, confirmedBytes: UInt64, sealedGroups: Int
  let backgroundReady: Bool, cleanupPending: Bool
}

/// Singleton-neutral: G5 must retain ONE instance before JS and route the owned identifier here.
/// Commands and delegate work serialize on queue, including cancel -> resume fencing.
/// Never initialize a second runtime for the same background-session identifier.
final class BackgroundRuntime: @unchecked Sendable {
  static let sessionIdentifier = BackgroundSession.identifier
  private let queue = DispatchQueue(label: "footage.sealed.native.v1", qos: .utility)
  private let ledger: BackgroundLedger, preseal: BackgroundPreseal, keychain: BackgroundKeychain
  private let control: any BackgroundControl
  private let boundary: (BackgroundBoundary) throws -> Void
  private var daemon: (any BackgroundDaemon)!
  private var storageBlocked = false, enumerating = false
  private var completions: [@MainActor @Sendable () -> Void] = []
  private var drainFinished = false

  init(directory: URL, create: Bool, keychainService: String, control: any BackgroundControl,
       cellular: Bool, activeUnlocked: @escaping () -> Bool, trust: (any BackgroundServerTrust)? = nil,
       boundary: @escaping (BackgroundBoundary) throws -> Void = { _ in },
       daemon: (any BackgroundDaemon)? = nil) throws {
    ledger = try BackgroundLedger(root: directory, create: create)
    keychain = BackgroundKeychain(service: keychainService); self.control = control; self.boundary = boundary
    try keychain.claimLedger(directory, create: create)
    preseal = BackgroundPreseal(ledger: ledger, keychain: keychain, control: control,
      activeUnlocked: activeUnlocked, boundary: boundary)
    // Finish startup repair before constructing a session that may immediately deliver events.
    if ledger.state?.phase == "preparing" { try ledger.change { $0.phase = "blocked" } }
    self.daemon = daemon
    if daemon == nil {
      self.daemon = try BackgroundSession(queue: queue, cellular: cellular, trust: trust,
        event: { [weak self] in self?.applyEvent($0) }, finished: { [weak self] in self?.finishEvents() })
    }
  }
  /// Blocking preparation belongs on a native worker, never main or a UIKit grace assertion.
  /// activeUnlocked must be a thread-safe native lifecycle/protected-data observation, not JS.
  func prepare(_ selection: BackgroundSelection) throws {
    try queue.sync {
      guard !storageBlocked else { throw BackgroundFailure.blocked }
      try preseal.prepare(selection)
    }
  }
  func snapshot() -> BackgroundSnapshot {
    queue.sync {
      let s = ledger.state
      let scheduled = s.map { state in state.groups.count == state.groupCount && state.groups.allSatisfy { $0.taskID != nil && $0.resumed } } ?? false
      return BackgroundSnapshot(phase: storageBlocked ? "blocked" : s?.phase ?? "empty",
        originalBytes: s?.originalBytes ?? 0, confirmedBytes: s?.confirmedBytes ?? 0,
        sealedGroups: s?.groups.count ?? 0,
        backgroundReady: !storageBlocked && s?.cancelOperation == nil && scheduled && s?.phase == "transferring",
        cleanupPending: s.map { $0.receiptOutcome == nil && $0.cancelOperation != nil && !($0.remoteCleanup && $0.localCleanup) } ?? false)
    }
  }
  /// Reassociation always enumerates; completion means command drained, NOT received.
  /// Unknown/duplicate tasks are cancelled; replacement waits for a later enumeration proving absence.
  func restoreAndStart(completion: @escaping @Sendable (Bool) -> Void) {
    queue.async {
      guard !self.enumerating else { completion(false); return }
      self.enumerating = true
      self.daemon.allTasks { tasks in
        self.queue.async {
          defer { self.enumerating = false }
          do { try self.reconcile(tasks); completion(true) }
          catch { self.storageBlocked = true; completion(false) }
          self.completeDrainIfPossible()
        }
      }
    }
  }
  private func material() throws -> (SealedProtocol.Manifest, SealedProtocol.Keys) {
    guard let state = ledger.state else { throw BackgroundFailure.blocked }
    let m = try preseal.loadManifest()
    return (m, try SealedProtocol.Keys(master: keychain.read(state.keyReference), manifest: m))
  }
  private func reconcile(_ tasks: [BackgroundTask]) throws {
    guard let state = ledger.state else {
      tasks.forEach { daemon.cancel($0.id) }
      if !tasks.isEmpty { throw BackgroundFailure.blocked } // No authenticated job context to reconcile.
      return
    }
    // Cancel intent is honored even if manifest/Keychain/protected data cannot be opened.
    if state.cancelOperation != nil { tasks.forEach { daemon.cancel($0.id) } }
    var unknown = false
    for task in tasks {
      let matches = state.groups.filter { $0.taskID == task.id && $0.correlation == task.correlation }
      let copies = tasks.filter { $0.correlation == task.correlation }
      if matches.count != 1 || copies.count != 1 {
        daemon.cancel(task.id); unknown = true
        try ledger.change { s in
          for i in s.groups.indices where s.groups[i].correlation == task.correlation { s.groups[i].uncertain = true }
        }
      }
    }
    try ledger.change { s in
      for i in s.groups.indices {
        if let id = s.groups[i].taskID, !tasks.contains(where: { $0.id == id && $0.correlation == s.groups[i].correlation }) {
          s.groups[i].taskID = nil; s.groups[i].resumed = false; s.groups[i].uncertain = true
        }
      }
    }
    if state.phase == "blocked" || state.phase == "preparing" { throw BackgroundFailure.blocked }
    let (m, keys) = try material() // No protected-data fallback or fabricated empty job.
    if let receipt = state.receiptOutcome {
      _ = try SealedProtocol.VerifiedReceipt.verify(receipt, keys: keys).toOriginalReceipt()
      tasks.forEach { daemon.cancel($0.id) }; return
    }
    let uncertain = unknown || ledger.state!.groups.contains(where: \.uncertain)
    if uncertain || state.cancelOperation != nil || state.phase == "verifying" || state.phase == "reconciling" {
      try query(m, keys: keys)
    }
    storageBlocked = false
    guard let current = ledger.state, current.cancelOperation == nil, current.receiptOutcome == nil,
      !["cancelled", "blocked"].contains(current.phase), current.expires > UInt64(Date().timeIntervalSince1970) else { return }
    if unknown { try ledger.change { $0.phase = "reconciling" }; return }
    try backgroundRequire(current.groups.count == current.groupCount)
    for g in current.groups {
      if current.bitmap & (UInt64(1) << g.index) != 0 { continue }
      try preseal.validatePacket(g)
      let task: BackgroundTask
      if let id = g.taskID {
        guard let existing = tasks.first(where: { $0.id == id && $0.correlation == g.correlation }) else { throw BackgroundFailure.uncertain }
        task = existing
      } else {
        // The consumed correlation survives both sides of task creation. An orphan is never adopted.
        try ledger.change { s in s.groups[g.index].uncertain = true }
        try boundary(.correlationSaved)
        task = try daemon.create(file: preseal.packet(g.index), origin: current.origin,
          correlation: g.correlation, bytes: g.wireBytes)
        try boundary(.taskCreated)
        try ledger.change { s in s.groups[g.index].taskID = task.id; s.groups[g.index].uncertain = false }
        try boundary(.taskBound)
      }
      // This entire transition shares the queue with durable cancellation, including callbacks.
      try backgroundRequire(ledger.state?.cancelOperation == nil)
      try daemon.resume(task.id)
      try boundary(.resumed)
      try ledger.change { s in s.groups[g.index].resumed = true; s.phase = "transferring" }
    }
  }
  private func query(_ m: SealedProtocol.Manifest, keys: SealedProtocol.Keys) throws {
    guard let state = ledger.state else { throw BackgroundFailure.blocked }
    let q = try SealedProtocol.Query.fresh(operation: state.cancelOperation ?? BackgroundPreseal.uuid())
    let bytes = try state.cancelOperation == nil ? control.status(m, query: q) : control.revoke(m, query: q)
    let status = try SealedProtocol.VerifiedStatus.verify(bytes, keys: keys, query: q, highWater: state.revision)
    // Receiver loss of a previously authenticated range is an integrity incident, not restart-at-zero.
    try backgroundRequire(status.groupBitmap & state.bitmap == state.bitmap)
    if let receipt = status.receipt {
      try receive(receipt, keys: keys); return
    }
    try ledger.change { s in
      s.revision = status.revision
      if s.cancelOperation == nil {
        s.bitmap = status.groupBitmap
        s.phase = status.state >= 4 ? "blocked" : status.state == 2 ? "verifying" : "reconciling"
      } else {
        s.phase = status.state >= 4 ? "cancelled" : "cancelRequested"
        s.remoteCleanup = status.cleanup == 2
      }
      for i in s.groups.indices { s.groups[i].uncertain = false }
    }
  }
  func cancel(completion: @escaping @Sendable (Bool) -> Void) {
    queue.async {
      do {
        guard let state = self.ledger.state, state.receiptOutcome == nil else { completion(true); return }
        try self.ledger.change { s in
          if s.cancelOperation == nil { s.cancelOperation = BackgroundPreseal.uuid() }
          s.phase = "cancelRequested"
        }
        // No daemon stop precedes this FULL transaction; operation ID is reused on every revoke.
        self.daemon.allTasks { tasks in
          self.queue.async {
            tasks.forEach { self.daemon.cancel($0.id) }
            do { let (m, keys) = try self.material(); try self.query(m, keys: keys); completion(true) }
            catch { completion(false) } // local fence survives offline/missing key/locked display record
          }
        }
      } catch { self.storageBlocked = true; completion(false) }
    }
  }
  /// Explicit, idempotent cancelled-bulk collection. Keep keys, private manifest and minimal
  /// tombstones for reconciliation; never delete while ANY daemon reference remains.
  func collectCancelled(completion: @escaping @Sendable (Bool) -> Void) {
    queue.async {
      self.daemon.allTasks { tasks in
        self.queue.async {
          do {
            guard tasks.isEmpty, let s = self.ledger.state, s.cancelOperation != nil,
              s.remoteCleanup, s.receiptOutcome == nil else { completion(false); return }
            var files = [self.preseal.original, self.preseal.original.appendingPathExtension("partial")]
            for i in 0..<s.groupCount {
              files += [self.preseal.packet(i), self.preseal.packet(i).appendingPathExtension("partial")]
            }
            for file in files where FileManager.default.fileExists(atPath: file.path) {
              try FileManager.default.removeItem(at: file)
            }
            try BackgroundFiles.syncDirectory(self.ledger.root)
            try BackgroundFiles.syncDirectory(self.preseal.privateDirectory)
            try self.ledger.change { s in
              s.localCleanup = true
              for i in s.groups.indices { s.groups[i].taskID = nil; s.groups[i].resumed = false }
            }
            completion(true)
          } catch { self.storageBlocked = true; completion(false) }
        }
      }
    }
  }
  /// Internal event entry used by the real session and by fault tests; never a bridge API.
  func acceptForTesting(_ event: BackgroundTaskEvent, completion: @escaping @Sendable () -> Void) {
    queue.async { self.applyEvent(event); completion() }
  }
  private func applyEvent(_ event: BackgroundTaskEvent) {
    do {
      guard let state = ledger.state,
        let g = state.groups.first(where: { $0.taskID == event.id && $0.correlation == event.correlation }),
        let hash = g.hash else { return } // Unowned task cannot credit progress.
      // Save uncertainty BEFORE parsing or opening protected material. A failed callback remains reconcilable.
      try ledger.change { s in s.groups[g.index].uncertain = true; s.groups[g.index].taskID = nil; s.groups[g.index].resumed = false }
      guard event.transportOK && event.body.count <= 4096 else { return }
      let (_, keys) = try material()
      let outcome = try SealedProtocol.verifyOutcome(event.body, httpStatus: event.status,
        keys: keys, group: g.index, wireSHA256: hash)
      if let receipt = outcome.receipt { try receive(receipt, keys: keys); return }
      try ledger.change { s in
        guard s.cancelOperation == nil && s.receiptOutcome == nil else { return }
        s.bitmap |= UInt64(1) << g.index; s.revision = max(s.revision, outcome.ack.revision)
        s.groups[g.index].uncertain = false
        s.phase = s.confirmedBytes == s.originalBytes ? "verifying" : "transferring"
      }
    } catch { storageBlocked = true } // pre-event mapping/uncertainty survives; never inferred receipt
  }
  private func receive(_ receipt: SealedProtocol.VerifiedReceipt, keys: SealedProtocol.Keys) throws {
    _ = try receipt.toOriginalReceipt() // Enforce the parent shared UUID/timestamp profile before publication.
    let canonical = try SealedProtocol.encodeReceipt(keys: keys, id: receipt.id,
      verifiedAt: receipt.verifiedAt, revision: receipt.revision)
    try ledger.change { s in
      if let prior = s.receiptOutcome { try backgroundRequire(prior == canonical) }
      s.receiptOutcome = canonical; s.phase = "received"; s.revision = max(s.revision, receipt.revision)
      s.bitmap = s.groupCount == 64 ? UInt64.max : (UInt64(1) << s.groupCount) - 1
    }
  }
  /// G5 subscriber forwards each OS callback once. Unowned identifiers are immediately
  /// completed on main; we never create/invalidate anyone else's session. Owned tokens
  /// accumulate (never overwrite) and drain only behind ordered durable delegate events.
  func handleBackgroundEvents(_ identifier: String, completion: @escaping @MainActor @Sendable () -> Void) {
    if identifier != Self.sessionIdentifier { DispatchQueue.main.async { completion() }; return }
    queue.async { self.completions.append(completion); self.completeDrainIfPossible() }
  }
  private func finishEvents() { drainFinished = true; completeDrainIfPossible() }
  private func completeDrainIfPossible() {
    guard drainFinished && !enumerating && !completions.isEmpty else { return }
    let pending = completions; completions.removeAll(); drainFinished = false
    DispatchQueue.main.async { pending.forEach { $0() } }
  }
  func finishEventsForTesting() { queue.async { self.finishEvents() } }
}

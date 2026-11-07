import Foundation

struct BackgroundSnapshot: Sendable {
  let phase: String, originalBytes: UInt64, confirmedBytes: UInt64, sealedGroups: Int
  let backgroundReady: Bool, cleanupPending: Bool
}

/// The adapter is confined to this lane, including foreground setup. Only one outcome
/// request is submitted by the owner at a time; the lane never touches ledger/daemon state.
/// The unchecked conformance is this serial ownership boundary, not a cast of an adapter.
private final class BackgroundControlWorker: @unchecked Sendable {
  private let queue = DispatchQueue(label: "footage.sealed.control.v1", qos: .utility)
  private var adapter: any BackgroundControl
  init(_ adapter: any BackgroundControl) { self.adapter = adapter }
  func setup(_ m: SealedProtocol.Manifest) throws -> Data { try queue.sync { try adapter.setup(m) } }
  func replace(_ adapter: any BackgroundControl) { queue.sync { self.adapter = adapter } }
  func submit(_ m: SealedProtocol.OutcomeContext, query: SealedProtocol.Query, revoke: Bool,
              completion: @escaping @Sendable (Result<Data, Error>) -> Void) {
    queue.async {
      do { completion(.success(try revoke ? self.adapter.revoke(m, query: query) : self.adapter.status(m, query: query))) }
      catch { completion(.failure(error)) }
    }
  }
}

/// Singleton-neutral: G5 must retain ONE instance before JS and route the owned identifier here.
/// Commands and delegate work serialize on queue, including cancel -> resume fencing.
/// Never initialize a second runtime for the same background-session identifier.
final class BackgroundRuntime: @unchecked Sendable {
  static let sessionIdentifier = BackgroundSession.identifier
  private let queue = DispatchQueue(label: "footage.sealed.native.v1", qos: .utility)
  private let ledger: BackgroundLedger, preseal: BackgroundPreseal, keychain: BackgroundKeychain
  private let control: BackgroundControlWorker
  private let boundary: (BackgroundBoundary) throws -> Void
  private var daemon: (any BackgroundDaemon)!
  private var storageBlocked = false, enumerating = false
  private var completions: [@MainActor @Sendable () -> Void] = []
  private var drainFinished = false
  private var restoring = false, cancelRunning = false, controlInFlight = false
  private var eventEpoch: UInt64 = 0
  // At most one deferred revoke, behind an older status. Repeated commands receive false
  // (not accepted); they do not grow a callback/request queue or change durable identities.
  private var pendingCancel: (@Sendable (Bool) -> Void)?

  init(directory: URL, create: Bool, keychainService: String, control: any BackgroundControl,
       cellular: Bool, activeUnlocked: @escaping () -> Bool, trust: (any BackgroundServerTrust)? = nil,
       boundary: @escaping (BackgroundBoundary) throws -> Void = { _ in },
       daemon: (any BackgroundDaemon)? = nil) throws {
    ledger = try BackgroundLedger(root: directory, create: create)
    keychain = BackgroundKeychain(service: keychainService)
    self.control = BackgroundControlWorker(control); self.boundary = boundary
    try keychain.claimLedger(directory, create: create)
    // Authenticate durable minimal metadata before even exposing a restored snapshot.
    // Protected display/original records are deliberately not opened here.
    if let state = ledger.state, state.outcomeAuthentication != nil {
      let master = try keychain.read(state.keyReference)
      let context = try state.outcome(master: master)
      if let receipt = state.receiptOutcome {
        let verified = try SealedProtocol.VerifiedReceipt.verify(receipt, keys: .init(master: master, outcome: context))
        _ = try verified.toOriginalReceipt()
        try backgroundRequire(state.phase == "received" && state.revision >= verified.revision
          && state.confirmedBytes == state.originalBytes)
      }
    }
    preseal = BackgroundPreseal(ledger: ledger, keychain: keychain,
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
    try backgroundRequire(!Thread.isMainThread)
    let manifest = try queue.sync {
      guard !storageBlocked else { throw BackgroundFailure.blocked }
      // A setup request is impossible before the first durable job row. These
      // are copy-stage crash orphans only, never an acknowledged/received job.
      if ledger.state == nil && FileManager.default.fileExists(atPath: preseal.privateDirectory.path) {
        try FileManager.default.removeItem(at: preseal.privateDirectory)
        try BackgroundFiles.syncDirectory(ledger.root)
      }
      return try preseal.stage(selection)
    }
    do {
      // Caller is the foreground native preparation worker, NOT the event owner.
      let reply = try control.setup(manifest)
      try queue.sync { try preseal.finishPreparation(manifest, reply: reply) }
    } catch {
      queue.sync { try? ledger.change { $0.phase = "blocked" } }
      throw error
    }
  }
  func archiveForNextSelection(completion: @escaping @Sendable (Bool) -> Void) {
    queue.async {
      guard !self.restoring && !self.cancelRunning && !self.controlInFlight else { completion(false); return }
      guard let state = self.ledger.state else { completion(true); return }
      guard state.receiptOutcome != nil || (state.phase == "cancelled" && state.remoteCleanup && state.localCleanup) else { completion(false); return }
      self.daemon.allTasks { tasks in
        self.queue.async {
          guard tasks.isEmpty else { completion(false); return }
          do { try self.ledger.archiveCompleted(); self.storageBlocked = false; completion(true) }
          catch { self.storageBlocked = true; completion(false) }
        }
      }
    }
  }

  // New native confirmation applies only to an EMPTY slot, after the old
  // terminal job was durably archived and all daemon references were removed.
  func installForNextJob(control: any BackgroundControl, trust: (any BackgroundServerTrust)?) throws {
    try queue.sync {
      try backgroundRequire(ledger.state == nil && !restoring && !cancelRunning && !controlInFlight)
      self.control.replace(control)
      (daemon as? BackgroundSession)?.replaceTrust(trust)
    }
  }

  // Native presentation adapter only; never export this ledger record to JS.
  func stateForPresentation() -> BackgroundState? { queue.sync { ledger.state } }
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
      guard !self.restoring && !self.controlInFlight else { completion(false); return }
      self.restoring = true
      self.enumerate(completion: completion)
    }
  }
  private func enumerate(resolvedAt epoch: UInt64? = nil, completion: @escaping @Sendable (Bool) -> Void) {
    enumerating = true
    daemon.allTasks { tasks in
      self.queue.async {
        defer {
          // Only LOCAL reconciliation fences delegate drain, never a control socket.
          self.enumerating = false
          self.completeDrainIfPossible()
        }
        do {
          if try self.reconcile(tasks, controlResolved: epoch == self.eventEpoch) {
            try self.query { [weak owner = self] ok, schedule in
              guard let owner else { completion(false); return }
              if schedule { owner.enumerate(resolvedAt: owner.eventEpoch, completion: completion) }
              else { owner.restoring = false; completion(ok) }
            }
          } else { self.restoring = false; completion(true) }
        } catch { self.storageBlocked = true; self.restoring = false; completion(false) }
      }
    }
  }
  private func material() throws -> (SealedProtocol.OutcomeContext, SealedProtocol.Keys) {
    guard let state = ledger.state else { throw BackgroundFailure.blocked }
    let master = try keychain.read(state.keyReference)
    let context = try state.outcome(master: master)
    return (context, try SealedProtocol.Keys(master: master, outcome: context))
  }
  /// True requests remote reconciliation AFTER durable local task uncertainty.
  private func reconcile(_ tasks: [BackgroundTask], controlResolved: Bool) throws -> Bool {
    guard let state = ledger.state else {
      tasks.forEach { daemon.cancel($0.id) }
      if !tasks.isEmpty { throw BackgroundFailure.blocked } // No authenticated job context to reconcile.
      return false
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
    let (_, keys) = try material() // No protected-data fallback or fabricated empty job.
    if let receipt = state.receiptOutcome {
      _ = try SealedProtocol.VerifiedReceipt.verify(receipt, keys: keys).toOriginalReceipt()
      tasks.forEach { daemon.cancel($0.id) }; return false
    }
    let uncertain = unknown || ledger.state!.groups.contains(where: \.uncertain)
    if !controlResolved && (uncertain || state.cancelOperation != nil || state.phase == "verifying" || state.phase == "reconciling") {
      // A process may die after OS completion and before the socket returns. This state,
      // existing correlations, and cancel ID suffice for another authenticated attempt.
      try ledger.change { s in
        if s.cancelOperation == nil && s.phase != "verifying" { s.phase = "reconciling" }
      }
      return true
    }
    storageBlocked = false
    guard let current = ledger.state, current.cancelOperation == nil, current.receiptOutcome == nil,
      !["cancelled", "blocked"].contains(current.phase), current.expires > UInt64(Date().timeIntervalSince1970) else { return false }
    if unknown { try ledger.change { $0.phase = "reconciling" }; return false }
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
    return false
  }
  /// Capture authenticated immutable context, never ledger, keys, or daemon objects on
  /// the worker. Verify against CURRENT high-water/cancel/event fences on return.
  private func query(completion: @escaping @Sendable (Bool, Bool) -> Void) throws {
    guard !controlInFlight, let state = ledger.state else { throw BackgroundFailure.uncertain }
    let (m, _) = try material()
    let q = try SealedProtocol.Query.fresh(operation: state.cancelOperation ?? BackgroundPreseal.uuid())
    let cancel = state.cancelOperation, epoch = eventEpoch
    controlInFlight = true
    control.submit(m, query: q, revoke: cancel != nil) { [weak self] result in
      guard let self else { return }
      self.queue.async {
        var ok = false, schedule = false
        do {
          guard let current = self.ledger.state, current.outcomeBytes == m.bytes else { throw BackgroundFailure.blocked }
          let (_, keys) = try self.material()
          let status = try SealedProtocol.VerifiedStatus.verify(result.get(), keys: keys, query: q, highWater: current.revision)
          try backgroundRequire(status.groupBitmap & current.bitmap == current.bitmap)
          if let receipt = status.receipt { try self.receive(receipt, keys: keys) }
          else if current.receiptOutcome == nil && current.cancelOperation == cancel {
            try self.ledger.change { s in
              s.revision = status.revision
              if s.cancelOperation == nil {
                s.bitmap = status.groupBitmap
                s.phase = status.state >= 4 ? "blocked" : status.state == 2 ? "verifying" : "reconciling"
              } else {
                s.phase = status.state >= 4 ? "cancelled" : "cancelRequested"
                s.remoteCleanup = status.cleanup == 2
              }
              // Events accepted since dispatch may have introduced NEW uncertainty.
              if self.eventEpoch == epoch { for i in s.groups.indices { s.groups[i].uncertain = false } }
            }
            schedule = cancel == nil && status.state == 1 && self.eventEpoch == epoch
          }
          self.storageBlocked = false; ok = true
        } catch {
          // Network, missing protected authority and stale replies retain durable uncertainty.
          // They do not erase the job, clear cancel, or manufacture a receipt.
        }
        self.controlInFlight = false
        completion(ok, schedule)
        if let pending = self.pendingCancel {
          self.pendingCancel = nil
          self.revoke(completion: pending)
        }
      }
    }
  }
  private func revoke(completion: @escaping @Sendable (Bool) -> Void) {
    if ledger.state?.receiptOutcome != nil { completion(true); return }
    if controlInFlight {
      guard pendingCancel == nil else { completion(false); return }
      pendingCancel = completion; return
    }
    do { try query { ok, _ in completion(ok) } }
    catch { completion(false) }
  }
  func cancel(completion: @escaping @Sendable (Bool) -> Void) {
    queue.async {
      guard !self.cancelRunning else { completion(false); return }
      do {
        guard let state = self.ledger.state, state.receiptOutcome == nil else { completion(true); return }
        self.cancelRunning = true
        try self.ledger.change { s in
          if s.cancelOperation == nil { s.cancelOperation = BackgroundPreseal.uuid() }
          // Setup can still be pending on the foreground worker. Without a master,
          // retain a blocked tombstone rather than publishing unauthenticated readiness.
          s.phase = s.outcomeAuthentication == nil ? "blocked" : "cancelRequested"
        }
        // No daemon stop precedes this FULL transaction; operation ID is reused on every revoke.
        self.daemon.allTasks { tasks in
          self.queue.async {
            tasks.forEach { self.daemon.cancel($0.id) }
            // Local fence survives offline/missing protected material. Neither an
            // enumeration nor remote request queue grows with repeated cancel taps.
            self.revoke { [weak owner = self] ok in
              owner?.cancelRunning = false; completion(ok)
            }
          }
        }
      } catch { self.cancelRunning = false; self.storageBlocked = true; completion(false) }
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
            files += try FileManager.default.contentsOfDirectory(at: self.preseal.privateDirectory, includingPropertiesForKeys: nil).filter { $0.lastPathComponent.hasPrefix("preview.") }
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
    eventEpoch &+= 1
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

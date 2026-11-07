import Foundation
import CryptoKit
import SQLite3
import Security

final class TestControl: BackgroundControl, @unchecked Sendable {
  var manifest: SealedProtocol.Manifest?, master = Data()
  var bitmap: UInt64 = 0, revision: UInt64 = 1
  var state: UInt8 = 1, cleanup: UInt8 = 0
  var offline = false, stale = false
  var operations: [Data] = [], challenges: [Data] = []
  func setup(_ m: SealedProtocol.Manifest) throws -> Data {
    if let manifest { try backgroundRequire(manifest.digest == m.digest) }
    else { manifest = m; master = try SealedProtocol.random(32) }
    return try SealedProtocol.encodeSetup(keys: keys(), master: master)
  }
  func keys() throws -> SealedProtocol.Keys { try SealedProtocol.Keys(master: master, manifest: manifest!) }
  func status(_ m: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data {
    if offline { throw BackgroundFailure.uncertain }
    try backgroundRequire(m.digest == manifest?.digest)
    challenges.append(query.challenge)
    let q = stale ? try SealedProtocol.Query.fresh(operation: query.operation) : query
    return try SealedProtocol.encodeStatus(keys: keys(), query: q,
      fields: .init(revision: revision, state: state, cleanup: cleanup, groupBitmap: bitmap))
  }
  func revoke(_ m: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data {
    operations.append(query.operation)
    return try status(m, query: query)
  }
}
final class TestDaemon: BackgroundDaemon, @unchecked Sendable {
  var tasks: [BackgroundTask] = [], resumed: [Int] = [], cancelled: [Int] = [], created = 0
  func allTasks(_ completion: @escaping @Sendable ([BackgroundTask]) -> Void) { completion(tasks) }
  func create(file: URL, origin: String, correlation: String, bytes: UInt64) throws -> BackgroundTask {
    created += 1
    let t = BackgroundTask(id: created, correlation: correlation, suspended: true); tasks.append(t); return t
  }
  func resume(_ id: Int) throws { resumed.append(id) }
  func cancel(_ id: Int) { cancelled.append(id) }
}

final class DeferredEnumerationDaemon: BackgroundDaemon, @unchecked Sendable {
  private let lock = NSLock()
  private var callback: (@Sendable ([BackgroundTask]) -> Void)?
  let entered = DispatchSemaphore(value: 0)
  func allTasks(_ completion: @escaping @Sendable ([BackgroundTask]) -> Void) {
    lock.lock(); callback = completion; lock.unlock(); entered.signal()
  }
  func deliver(_ tasks: [BackgroundTask]) {
    lock.lock(); let completion = callback; callback = nil; lock.unlock()
    completion?(tasks)
  }
  func create(file: URL, origin: String, correlation: String, bytes: UInt64) throws -> BackgroundTask { throw BackgroundFailure.blocked }
  func resume(_ id: Int) throws { throw BackgroundFailure.blocked }
  func cancel(_ id: Int) {}
}

func testState(_ root: URL) throws -> BackgroundState {
  var db: OpaquePointer?, statement: OpaquePointer?
  guard sqlite3_open_v2(root.appendingPathComponent("ledger.sqlite").path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { throw BackgroundFailure.storage }
  defer { sqlite3_finalize(statement); sqlite3_close(db) }
  try backgroundRequire(sqlite3_prepare_v2(db, "SELECT state FROM runtime WHERE id=1", -1, &statement, nil) == SQLITE_OK && sqlite3_step(statement) == SQLITE_ROW)
  let n = Int(sqlite3_column_bytes(statement, 0))
  guard let ptr = sqlite3_column_blob(statement, 0) else { throw BackgroundFailure.integrity }
  return try JSONDecoder().decode(BackgroundState.self, from: Data(bytes: ptr, count: n))
}
func testRewriteState(_ root: URL, change: (inout [String: Any]) -> Void) throws {
  let state = try testState(root)
  var raw = try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as! [String: Any]
  change(&raw)
  let bytes = try JSONSerialization.data(withJSONObject: raw)
  var db: OpaquePointer?, statement: OpaquePointer?
  try backgroundRequire(sqlite3_open(root.appendingPathComponent("ledger.sqlite").path, &db) == SQLITE_OK)
  defer { sqlite3_finalize(statement); sqlite3_close(db) }
  try backgroundRequire(sqlite3_prepare_v2(db, "UPDATE runtime SET state=? WHERE id=1", -1, &statement, nil) == SQLITE_OK)
  let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
  try bytes.withUnsafeBytes { buffer in
    try backgroundRequire(sqlite3_bind_blob(statement, 1, buffer.baseAddress, Int32(buffer.count), transient) == SQLITE_OK)
  }
  try backgroundRequire(sqlite3_step(statement) == SQLITE_DONE)
}
func testAwait(_ operation: (@escaping @Sendable (Bool) -> Void) -> Void) throws -> Bool {
  let signal = DispatchSemaphore(value: 0)
  final class Box: @unchecked Sendable { var result = false }
  let box = Box()
  operation { box.result = $0; signal.signal() }
  try backgroundRequire(signal.wait(timeout: .now() + 30) == .success)
  return box.result
}
func testEvent(_ runtime: BackgroundRuntime, _ event: BackgroundTaskEvent) throws {
  let signal = DispatchSemaphore(value: 0)
  runtime.acceptForTesting(event) { signal.signal() }
  try backgroundRequire(signal.wait(timeout: .now() + 30) == .success)
}
func testDeleteKey(_ service: String, reference: String? = nil) {
  var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
  if let reference { q[kSecAttrAccount as String] = reference }
  SecItemDelete(q as CFDictionary)
}
func testSelection(_ source: URL) throws -> BackgroundSelection {
  BackgroundSelection(source: source, safeName: "Synthetic.bin", receiver: try SealedProtocol.random(32),
    origin: "https://localhost:9443", device: BackgroundPreseal.uuid(), enrollmentEpoch: 1,
    destination: .standalone(intake: BackgroundPreseal.uuid()), expiresAt: UInt64(Date().timeIntervalSince1970) + 3600)
}
func testGenerate(_ url: URL, count: Int) throws {
  let output = try BackgroundFiles.create(url, complete: true); defer { try? output.close() }
  var buffer = Data(count: 65536)
  for i in buffer.indices { buffer[i] = UInt8(truncatingIfNeeded: i * 31 + i / 251) }
  var remaining = count
  while remaining > 0 { let n = min(buffer.count, remaining); try output.write(contentsOf: buffer.prefix(n)); remaining -= n }
  try output.synchronize()
}
func runRuntimeTests(_ base: URL) throws -> [String] {
  var passed: [String] = []
  let source = base.appendingPathComponent("small-original")
  try testGenerate(source, count: 1024 * 1024 + 7)
  let service = "test.footage.background." + UUID().uuidString
  defer { testDeleteKey(service) }
  func root(_ name: String) -> URL { base.appendingPathComponent(name) }
  func runtime(_ name: String, _ control: TestControl, _ daemon: TestDaemon,
               create: Bool = true, hook: @escaping (BackgroundBoundary) throws -> Void = { _ in }) throws -> BackgroundRuntime {
    try BackgroundRuntime(directory: root(name), create: create, keychainService: service,
      control: control, cellular: false, activeUnlocked: { true }, boundary: hook, daemon: daemon)
  }
  func expectFailure(_ operation: () throws -> Void) throws {
    do { try operation() } catch { return }; throw BackgroundFailure.integrity
  }
  for point in [BackgroundBoundary.consumed, .encrypted, .groupPublished, .groupRecorded, .setupSaved] {
    let name = "seal-" + point.rawValue, c = TestControl(), d = TestDaemon()
    var r: BackgroundRuntime? = try runtime(name, c, d, hook: { if $0 == point { throw BackgroundFailure.storage } })
    try expectFailure { try r!.prepare(testSelection(source)) }
    let before = try testState(root(name))
    try backgroundRequire(before.phase == "blocked")
    r = nil
    r = try runtime(name, c, d, create: false)
    let reopened = r!
    try backgroundRequire(!(try testAwait { reopened.restoreAndStart(completion: $0) }) && d.created == 0)
    try expectFailure { try reopened.prepare(testSelection(source)) }
    try backgroundRequire(try testState(root(name)).intents == before.intents)
    passed.append("seal-burn-" + point.rawValue)
  }
  // Initial and exact-byte retry, missing task, fresh query, sparse/progress and receipt boundaries.
  do {
    let c = TestControl(), d = TestDaemon(), name = "retry"
    let r = try runtime(name, c, d); try r.prepare(testSelection(source))
    try backgroundRequire(r.snapshot().phase == "ready" && !r.snapshot().backgroundReady)
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    let first = try testState(root(name)), g = first.groups[0]
    try backgroundRequire(r.snapshot().backgroundReady && d.resumed == [g.taskID!])
    let file = root(name).appendingPathComponent("group-0.sealed")
    let hash = try BackgroundFiles.hash(file)
    d.tasks = [] // daemon lost response/task: no inferred progress, fresh status before exact retry.
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    try backgroundRequire(d.created == 2 && c.challenges.count == 1 && r.snapshot().confirmedBytes == 0)
    try backgroundRequire(try BackgroundFiles.hash(file).1 == hash.1)
    let now = try testState(root(name)).groups[0]
    let ack = try SealedProtocol.encodeAck(keys: c.keys(), group: 0, wireSHA256: now.hash!, revision: 5)
    let outcome = try SealedProtocol.encodeOutcome(ack: ack)
    try testEvent(r, .init(id: now.taskID!, correlation: now.correlation, status: 200, body: outcome, transportOK: true))
    try backgroundRequire(r.snapshot().phase == "verifying" && r.snapshot().confirmedBytes == first.originalBytes)
    // Stale challenge/status must fail without discarding the saved high-water/range.
    c.stale = true
    try backgroundRequire(!(try testAwait { r.restoreAndStart(completion: $0) }))
    try backgroundRequire(try testState(root(name)).revision == 5)
    passed += ["exact-packet-retry", "missing-task-fresh-status", "chunk-not-receipt", "stale-status-rejected"]
  }
  for point in [BackgroundBoundary.correlationSaved, .taskCreated, .taskBound, .resumed] {
    let name = "bind-" + point.rawValue, c = TestControl(), d = TestDaemon()
    var r: BackgroundRuntime? = try runtime(name, c, d, hook: { if $0 == point { throw BackgroundFailure.storage } })
    try r!.prepare(testSelection(source))
    try backgroundRequire(!(try testAwait { r!.restoreAndStart(completion: $0) }))
    r = nil
    r = try runtime(name, c, d, create: false)
    let oldCreated = d.created
    if point == .taskCreated {
      try backgroundRequire(try testState(root(name)).groups[0].taskID == nil && !d.tasks.isEmpty)
    } else if point == .taskBound || point == .resumed {
      try backgroundRequire(try testState(root(name)).groups[0].taskID != nil)
    }
    try backgroundRequire(oldCreated <= 1)
    try backgroundRequire(try testAwait { r!.restoreAndStart(completion: $0) })
    if point == .taskCreated {
      try backgroundRequire(!d.cancelled.isEmpty && d.created == oldCreated && !c.challenges.isEmpty)
      d.tasks = []
      try backgroundRequire(try testAwait { r!.restoreAndStart(completion: $0) })
      try backgroundRequire(d.created == 2)
    } else if point == .taskBound || point == .resumed {
      try backgroundRequire(d.created == oldCreated)
    }
    passed.append("task-window-" + point.rawValue)
  }
  do {
    let c = TestControl(), d = TestDaemon(), name = "cancel"
    let r = try runtime(name, c, d); try r.prepare(testSelection(source))
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    let g = try testState(root(name)).groups[0]
    c.offline = true
    try backgroundRequire(!(try testAwait { r.cancel(completion: $0) }))
    let cancelled = try testState(root(name))
    try backgroundRequire(cancelled.cancelOperation != nil && d.cancelled.contains(g.taskID!))
    let ack = try SealedProtocol.encodeAck(keys: c.keys(), group: 0, wireSHA256: g.hash!, revision: 2)
    try testEvent(r, .init(id: g.taskID!, correlation: g.correlation, status: 200,
      body: SealedProtocol.encodeOutcome(ack: ack), transportOK: true))
    try backgroundRequire(r.snapshot().confirmedBytes == 0 && r.snapshot().phase == "cancelRequested")
    c.offline = false
    try backgroundRequire(try testAwait { r.cancel(completion: $0) })
    try backgroundRequire(c.operations.count == 2 && c.operations[0] == c.operations[1])
    try backgroundRequire(c.challenges.count == 1)
    d.tasks = []
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    try backgroundRequire(d.created == 1 && r.snapshot().cleanupPending)
    passed += ["cancel-fence-stale-ack", "durable-revoke-id-offline", "no-local-deletion"]
  }
  do {
    let c = TestControl(), d = TestDaemon(), name = "cancel-before-resume"
    let r = try runtime(name, c, d); try r.prepare(testSelection(source))
    try backgroundRequire(try testAwait { r.cancel(completion: $0) })
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    try backgroundRequire(d.created == 0 && d.resumed.isEmpty)
    passed.append("cancel-before-resume")
  }
  do {
    let c = TestControl(), d = TestDaemon(), name = "key-loss"
    let r = try runtime(name, c, d); try r.prepare(testSelection(source))
    testDeleteKey(service, reference: try testState(root(name)).keyReference)
    try backgroundRequire(!(try testAwait { r.restoreAndStart(completion: $0) }) && d.created == 0)
    passed.append("key-loss-blocked-no-regeneration")
  }
  do {
    let c = TestControl(), d = TestDaemon(), name = "body-loss"
    let r = try runtime(name, c, d); try r.prepare(testSelection(source))
    try FileManager.default.removeItem(at: root(name).appendingPathComponent("group-0.sealed"))
    try backgroundRequire(!(try testAwait { r.restoreAndStart(completion: $0) }) && d.created == 0)
    passed.append("missing-packet-no-reseal")
  }
  do {
    let c = TestControl(), d = TestDaemon(), name = "manifest-locked"
    var owner: BackgroundRuntime? = try runtime(name, c, d); try owner!.prepare(testSelection(source))
    let manifest = root(name).appendingPathComponent("private/manifest")
    let privateDirectory = root(name).appendingPathComponent("private")
    try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: privateDirectory.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: privateDirectory.path) }
    var denied = false
    do { _ = try Data(contentsOf: manifest) } catch { denied = (error as NSError).code == NSFileReadNoPermissionError }
    try backgroundRequire(denied)
    try backgroundRequire(try testAwait { owner!.restoreAndStart(completion: $0) })
    let g = try testState(root(name)).groups[0]
    owner = nil
    owner = try runtime(name, c, d, create: false)
    let r = owner!
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    try backgroundRequire(d.created == 1) // cold reassociation, not replacement identity
    let ack = try SealedProtocol.encodeAck(keys: c.keys(), group: 0, wireSHA256: g.hash!, revision: 3)
    try testEvent(r, .init(id: g.taskID!, correlation: g.correlation, status: 200,
      body: SealedProtocol.encodeOutcome(ack: ack), transportOK: true))
    c.bitmap = 1; c.revision = 3; c.state = 2
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    c.offline = true
    try backgroundRequire(!(try testAwait { r.cancel(completion: $0) }))
    c.offline = false
    try backgroundRequire(try testAwait { r.cancel(completion: $0) })
    let receipt = try SealedProtocol.encodeReceipt(keys: c.keys(), id: BackgroundPreseal.uuid(),
      verifiedAt: UInt64(Date().timeIntervalSince1970), revision: 4)
    // A matching late final receipt wins cancel; even its verification cannot open display data.
    let rebound = try testState(root(name))
    let minimal = try SealedProtocol.Keys(master: c.master, outcome: rebound.outcome(master: c.master))
    _ = try SealedProtocol.VerifiedReceipt.verify(receipt, keys: minimal).toOriginalReceipt()
    try expectFailure { _ = try Data(contentsOf: manifest) }
    passed += ["locked-context-ack-status-revoke-cold-reassociation", "locked-context-final-receipt-profile"]
    var bad = rebound
    bad.outcomeAuthentication = Data(repeating: 0, count: 32)
    try expectFailure { _ = try bad.outcome(master: c.master) }
    passed.append("durable-context-authentication-rejects-substitution")
  }
  for attack in ["original-identity", "context-mac", "forged-received"] {
    let name = "durable-" + attack, c = TestControl(), d = TestDaemon()
    var owner: BackgroundRuntime? = try runtime(name, c, d)
    try owner!.prepare(testSelection(source)); owner = nil
    try testRewriteState(root(name)) { value in
      if attack == "original-identity" { value["originalHash"] = Data(repeating: 0, count: 32).base64EncodedString() }
      else if attack == "context-mac" { value["outcomeAuthentication"] = Data(repeating: 0, count: 32).base64EncodedString() }
      else {
        value["phase"] = "received"; value["receiptOutcome"] = Data(repeating: 0, count: 200).base64EncodedString()
        value["bitmap"] = 1; value["revision"] = 999
      }
    }
    try expectFailure { _ = try runtime(name, c, d, create: false) }
    try backgroundRequire(d.created == 0)
    passed.append("durable-load-rejects-" + attack + "-before-snapshot")
  }
  do {
    let c = TestControl(), d = TestDaemon(), name = "final-cancel-race"
    let r = try runtime(name, c, d); try r.prepare(testSelection(source))
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    let g = try testState(root(name)).groups[0]
    c.offline = true
    _ = try testAwait { r.cancel(completion: $0) }
    let ack = try SealedProtocol.encodeAck(keys: c.keys(), group: 0, wireSHA256: g.hash!, revision: 3)
    let receipt = try SealedProtocol.encodeReceipt(keys: c.keys(), id: BackgroundPreseal.uuid(),
      verifiedAt: UInt64(Date().timeIntervalSince1970), revision: 4)
    try testEvent(r, .init(id: g.taskID!, correlation: g.correlation, status: 200,
      body: SealedProtocol.encodeOutcome(ack: ack, receipt: receipt), transportOK: true))
    try backgroundRequire(r.snapshot().phase == "received" && r.snapshot().confirmedBytes == r.snapshot().originalBytes)
    passed.append("verified-final-receipt-wins-cancel")
  }
  do {
    let c = TestControl(), d = TestDaemon(), name = "disk-failure"
    let r = try runtime(name, c, d); try r.prepare(testSelection(source))
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    var db: OpaquePointer?
    try backgroundRequire(sqlite3_open(root(name).appendingPathComponent("ledger.sqlite").path, &db) == SQLITE_OK)
    defer { sqlite3_close(db) }
    // Fail the actual ledger write transaction (without filling shared disk).
    try backgroundRequire(sqlite3_exec(db, "CREATE TRIGGER fail_write BEFORE INSERT ON runtime BEGIN SELECT RAISE(FAIL,'injected write failure'); END", nil, nil, nil) == SQLITE_OK)
    try backgroundRequire(!(try testAwait { r.cancel(completion: $0) }))
    try backgroundRequire(d.cancelled.isEmpty && (try testState(root(name))).cancelOperation == nil)
    passed.append("failed-cancel-transaction-never-stops-daemon-first")
  }
  do {
    let c = TestControl(), d = TestDaemon(), name = "partial-disk-failure"
    let r = try runtime(name, c, d, hook: { if $0 == .encrypted { throw POSIXError(.ENOSPC) } })
    try expectFailure { try r.prepare(testSelection(source)) }
    let s = try testState(root(name))
    try backgroundRequire(s.phase == "blocked" && s.intents.count == 1 && s.groups.isEmpty && d.created == 0)
    try backgroundRequire(FileManager.default.fileExists(atPath: root(name).appendingPathComponent("group-0.sealed.partial").path))
    passed.append("enospc-injected-retains-burned-partial-never-schedules")
  }
  do {
    let name = "metadata-loss", c = TestControl(), d = TestDaemon()
    var r: BackgroundRuntime? = try runtime(name, c, d); try r!.prepare(testSelection(source)); r = nil
    try FileManager.default.removeItem(at: root(name).appendingPathComponent("ledger.sqlite"))
    try expectFailure { _ = try runtime(name, c, d) }
    passed.append("missing-database-never-recreates-empty")
  }
  do {
    let name = "inactive", c = TestControl(), d = TestDaemon()
    final class Active { var value = true }
    let active = Active()
    let r = try BackgroundRuntime(directory: root(name), create: true, keychainService: service,
      control: c, cellular: false, activeUnlocked: { active.value },
      boundary: { if $0 == .encrypted { active.value = false } }, daemon: d)
    try expectFailure { try r.prepare(testSelection(source)) }
    try backgroundRequire(r.snapshot().phase == "blocked" && !r.snapshot().backgroundReady && d.created == 0)
    // Simulator returns no protectionKey attribute. Physical lock/protection evidence is a separate gate.
    passed.append("active-unlocked-loss-never-reports-ready")
  }
  do {
    let name = "cleanup", c = TestControl(), d = TestDaemon()
    let r = try runtime(name, c, d); try r.prepare(testSelection(source))
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    c.state = 4; c.cleanup = 2
    try backgroundRequire(try testAwait { r.cancel(completion: $0) })
    try backgroundRequire(!(try testAwait { r.collectCancelled(completion: $0) }))
    let body = root(name).appendingPathComponent("group-0.sealed")
    try backgroundRequire(FileManager.default.fileExists(atPath: body.path))
    d.tasks = []
    for _ in 0..<2 { try backgroundRequire(try testAwait { r.collectCancelled(completion: $0) }) }
    try backgroundRequire(!FileManager.default.fileExists(atPath: body.path) && !r.snapshot().cleanupPending)
    try backgroundRequire(FileManager.default.fileExists(atPath: root(name).appendingPathComponent("private/manifest").path))
    passed.append("idempotent-cleanup-only-after-remote-and-daemon-absence")
  }
  do {
    let name = "directory-loss", c = TestControl(), d = TestDaemon()
    var r: BackgroundRuntime? = try runtime(name, c, d); try r!.prepare(testSelection(source)); r = nil
    try FileManager.default.removeItem(at: root(name))
    try expectFailure { _ = try runtime(name, c, d) }
    passed.append("missing-directory-keychain-identity-blocks-reset")
  }
  do {
    let name = "duplicates", c = TestControl(), d = TestDaemon()
    let r = try runtime(name, c, d); try r.prepare(testSelection(source))
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    let first = d.tasks[0]
    d.tasks.append(BackgroundTask(id: 999, correlation: first.correlation, suspended: true))
    d.tasks.append(BackgroundTask(id: 998, correlation: UUID().uuidString, suspended: true))
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    try backgroundRequire(Set(d.cancelled) == Set([first.id, 999, 998]) && d.created == 1)
    d.tasks = []
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    try backgroundRequire(d.created == 2 && c.challenges.count >= 2)
    passed.append("unknown-duplicate-cancel-reconcile-before-replacement")
  }
  do {
    let name = "unowned-without-job", c = TestControl(), d = TestDaemon()
    let r = try runtime(name, c, d)
    d.tasks = [BackgroundTask(id: 999, correlation: UUID().uuidString, suspended: true)]
    try backgroundRequire(!(try testAwait { r.restoreAndStart(completion: $0) }))
    try backgroundRequire(r.snapshot().phase == "blocked" && d.cancelled == [999])
    try expectFailure { try r.prepare(testSelection(source)) }
    passed.append("unowned-daemon-without-job-blocks-new-identity")
  }
  do {
    let name = "forgery", c = TestControl(), d = TestDaemon()
    let r = try runtime(name, c, d); try r.prepare(testSelection(source))
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    let g = try testState(root(name)).groups[0]
    try testEvent(r, .init(id: g.taskID!, correlation: g.correlation, status: 200,
      body: Data(repeating: 0, count: 4097), transportOK: true))
    try backgroundRequire(r.snapshot().confirmedBytes == 0 && (try testState(root(name))).groups[0].uncertain)
    passed.append("oversize-fake-success-no-progress")
  }
  do {
    let name = "drain", c = TestControl(), d = TestDaemon()
    let r = try runtime(name, c, d); try r.prepare(testSelection(source))
    try backgroundRequire(try testAwait { r.restoreAndStart(completion: $0) })
    let g = try testState(root(name)).groups[0]
    let ack = try SealedProtocol.encodeAck(keys: c.keys(), group: 0, wireSHA256: g.hash!, revision: 4)
    try testEvent(r, .init(id: g.taskID!, correlation: g.correlation, status: 200,
      body: SealedProtocol.encodeOutcome(ack: ack), transportOK: true))
    let signal = DispatchSemaphore(value: 0), drainedRoot = root(name)
    r.handleBackgroundEvents("another.module") { MainActor.assertIsolated(); signal.signal() }
    try backgroundRequire(signal.wait(timeout: .now() + 5) == .success)
    for _ in 0..<2 {
      r.handleBackgroundEvents(BackgroundRuntime.sessionIdentifier) {
        MainActor.assertIsolated()
        if (try? testState(drainedRoot).bitmap) == 1 { signal.signal() }
      }
    }
    try backgroundRequire(signal.wait(timeout: .now() + 0.1) == .timedOut)
    r.finishEventsForTesting()
    for _ in 0..<2 { try backgroundRequire(signal.wait(timeout: .now() + 5) == .success) }
    r.finishEventsForTesting()
    try backgroundRequire(signal.wait(timeout: .now() + 0.1) == .timedOut)
    passed += ["unowned-main-completion", "multiple-completions-once-after-durable-drain"]
  }
  for failReconciliation in [false, true] {
    let d = DeferredEnumerationDaemon(), c = TestControl()
    let r = try BackgroundRuntime(directory: root("enumeration-drain-\(failReconciliation)"), create: true,
      keychainService: service, control: c, cellular: false, activeUnlocked: { false }, daemon: d)
    let completed = DispatchSemaphore(value: 0), restored = DispatchSemaphore(value: 0)
    r.handleBackgroundEvents(BackgroundRuntime.sessionIdentifier) { MainActor.assertIsolated(); completed.signal() }
    r.restoreAndStart { _ in restored.signal() }
    try backgroundRequire(d.entered.wait(timeout: .now() + 5) == .success)
    r.finishEventsForTesting()
    // Queue barrier: the sole finish event is processed while enumeration is held.
    try testEvent(r, .init(id: -1, correlation: nil, status: 0, body: Data(), transportOK: false))
    try backgroundRequire(completed.wait(timeout: .now() + 0.1) == .timedOut)
    d.deliver(failReconciliation ? [.init(id: 999, correlation: UUID().uuidString, suspended: true)] : [])
    try backgroundRequire(restored.wait(timeout: .now() + 5) == .success)
    try backgroundRequire(completed.wait(timeout: .now() + 5) == .success)
    try backgroundRequire(completed.wait(timeout: .now() + 0.1) == .timedOut)
    passed.append(failReconciliation ? "finish-during-failed-enumeration-drains-once" : "finish-during-enumeration-drains-once")
  }
  return passed
}

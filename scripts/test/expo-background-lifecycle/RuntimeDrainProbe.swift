import Foundation

/// A deterministic UNIT interleaving, not an OS callback. No real daemon/session.
private final class DeferredEnumeration: BackgroundDaemon, @unchecked Sendable {
  private let lock = NSLock()
  private var callback: (@Sendable ([BackgroundTask]) -> Void)?
  let entered = DispatchSemaphore(value: 0)
  func allTasks(_ completion: @escaping @Sendable ([BackgroundTask]) -> Void) {
    lock.lock(); callback = completion; lock.unlock(); entered.signal()
  }
  func deliver() {
    lock.lock(); let completion = callback; callback = nil; lock.unlock()
    completion?([])
  }
  func create(file: URL, origin: String, correlation: String, bytes: UInt64) throws -> BackgroundTask { throw BackgroundFailure.blocked }
  func resume(_ id: Int) throws { throw BackgroundFailure.blocked }
  func cancel(_ id: Int) {}
}

func probeRuntimeDrain(_ docs: URL) throws -> [String: Any] {
  let daemon = DeferredEnumeration()
  let runtime = try BackgroundRuntime(directory: docs.appendingPathComponent("unit-drain-probe"), create: true,
    keychainService: "test.footage.drainprobe." + UUID().uuidString,
    control: DurableTestControl(docs, offline: true), cellular: false, activeUnlocked: { false }, daemon: daemon)
  let completed = DispatchSemaphore(value: 0), restored = DispatchSemaphore(value: 0)
  runtime.handleBackgroundEvents(BackgroundRuntime.sessionIdentifier) { completed.signal() }
  runtime.restoreAndStart { _ in restored.signal() }
  try backgroundRequire(daemon.entered.wait(timeout: .now() + 5) == .success)
  runtime.finishEventsForTesting()
  // Barrier on the real native queue ensures finish was processed while enumeration
  // was outstanding, BEFORE releasing getAllTasks. No timing race in the injection.
  let barrier = DispatchSemaphore(value: 0)
  runtime.acceptForTesting(.init(id: -1, correlation: nil, status: 0, body: Data(), transportOK: false)) { barrier.signal() }
  try backgroundRequire(barrier.wait(timeout: .now() + 5) == .success)
  daemon.deliver()
  try backgroundRequire(restored.wait(timeout: .now() + 5) == .success)
  let missedDrain = completed.wait(timeout: .now() + 1) == .timedOut
  if missedDrain {
    // UNIT-only extra finish proves the token/main queue was healthy, but cannot
    // repair the production race: the OS owes no second didFinishEvents callback.
    runtime.finishEventsForTesting()
    try backgroundRequire(completed.wait(timeout: .now() + 5) == .success)
  }
  return ["unitOnly": true, "finishDuringEnumerationLeavesPendingToken": missedDrain,
    "extraSyntheticFinishNeeded": missedDrain]
}

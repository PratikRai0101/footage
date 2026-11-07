import Foundation

@MainActor
private final class HostTestRuntime: @preconcurrency NativeBackgroundRuntime {
  var restores = 0
  var handlers: [@MainActor @Sendable () -> Void] = []
  func restoreAndStart(completion: @escaping @Sendable (Bool) -> Void) { restores += 1; completion(true) }
  func handleBackgroundEvents(_ identifier: String, completion: @escaping @MainActor @Sendable () -> Void) {
    handlers.append(completion)
  }
}

@MainActor
func runHostTests() throws -> [String] {
  var factories = 0, completions = 0
  let owner = HostTestRuntime()
  let host = NativeBackgroundHost { _ in factories += 1; return owner }
  host.handle("unrelated.session") { completions += 1; precondition(Thread.isMainThread) }
  try backgroundRequire(factories == 0 && completions == 1)
  host.launch(); host.launch()
  try backgroundRequire(factories == 1 && owner.restores == 1)
  for _ in 0..<2 { host.handle(BackgroundRuntime.sessionIdentifier) { completions += 1; precondition(Thread.isMainThread) } }
  try backgroundRequire(completions == 1 && owner.handlers.count == 2)
  // Runtime's ordered durable drain is tested by the existing native suite. The host
  // additionally fences an accidental duplicate call without losing either token.
  owner.handlers.forEach { $0(); $0() }
  try backgroundRequire(completions == 3)
  host.handle(BackgroundRuntime.sessionIdentifier) { completions += 1 }
  try backgroundRequire(completions == 3 && owner.handlers.count == 3)
  owner.handlers[2]()
  try backgroundRequire(completions == 4)
  var opens = 0
  let unavailable = NativeBackgroundHost { _ in opens += 1; throw BackgroundFailure.storage }
  unavailable.launch()
  unavailable.handle(BackgroundRuntime.sessionIdentifier) { completions += 1 }
  try backgroundRequire(unavailable.availability == .blocked && opens == 1 && completions == 5)
  unavailable.protectedDataAvailable()
  try backgroundRequire(opens == 2 && unavailable.availability == .blocked)
  let absent = NativeBackgroundHost { _ in nil }
  absent.launch()
  absent.handle(BackgroundRuntime.sessionIdentifier) { completions += 1 }
  try backgroundRequire(absent.availability == .notInstalled && completions == 6)
  return ["unrelated-no-factory-main-once", "one-owner-before-bridge", "two-tokens-not-overwritten",
    "duplicate-completion-fenced", "second-event-batch", "protected-open-blocked-not-empty",
    "protected-data-retry", "missing-backend-unavailable"]
}

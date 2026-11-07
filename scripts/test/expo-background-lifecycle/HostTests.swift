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
  var fallthroughs = 0
  for id in ["unrelated.session", "", "footage.sealed.background.v10", "footage.sealed.background.v1.extra",
             "00000000-0000-4000-8000-000000000000"] {
    if !FootageBackgroundSessionRouter.route(id, host: host, completionHandler: { completions += 100 }) {
      // The generated AppDelegate forwards this exact completion to super.
      fallthroughs += 1
    }
  }
  try backgroundRequire(factories == 0 && completions == 0 && fallthroughs == 5)
  host.handle("unrelated.session") { completions += 1; precondition(Thread.isMainThread) }
  try backgroundRequire(factories == 0 && completions == 1)
  host.launch(); host.launch()
  try backgroundRequire(factories == 1 && owner.restores == 1)
  for _ in 0..<2 {
    try backgroundRequire(FootageBackgroundSessionRouter.route(BackgroundRuntime.sessionIdentifier, host: host) {
      completions += 1; precondition(Thread.isMainThread)
    })
  }
  try backgroundRequire(completions == 1 && owner.handlers.count == 2)
  // Runtime's ordered durable drain is tested by the existing native suite. The host
  // additionally fences an accidental duplicate call without losing either token.
  owner.handlers.forEach { $0(); $0() }
  try backgroundRequire(completions == 3)
  host.handle(BackgroundRuntime.sessionIdentifier) { completions += 1 }
  try backgroundRequire(completions == 3 && owner.handlers.count == 3)
  owner.handlers[2]()
  try backgroundRequire(completions == 4)
  var opens = 0, deniedReads = 0
  let protected = ExpoLifecycleFixture.docs.appendingPathComponent("host-protected-state")
  let retained = Data("Retain pre-event uncertainty; never received".utf8)
  try retained.write(to: protected, options: .atomic)
  try FileManager.default.setAttributes([.posixPermissions: 0, .protectionKey: FileProtectionType.complete], ofItemAtPath: protected.path)
  defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: protected.path) }
  let unavailable = NativeBackgroundHost { _ in
    opens += 1
    do { _ = try Data(contentsOf: protected) }
    catch {
      if (error as NSError).code == NSFileReadNoPermissionError { deniedReads += 1 }
      throw error
    }
    return nil
  }
  unavailable.launch()
  unavailable.handle(BackgroundRuntime.sessionIdentifier) { completions += 1 }
  try backgroundRequire(unavailable.availability == .blocked && opens == 1 && completions == 5)
  unavailable.protectedDataAvailable()
  try backgroundRequire(opens == 2 && deniedReads == 2 && unavailable.availability == .blocked)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: protected.path)
  try backgroundRequire(try Data(contentsOf: protected) == retained)
  let absent = NativeBackgroundHost { _ in nil }
  absent.launch()
  absent.handle(BackgroundRuntime.sessionIdentifier) { completions += 1 }
  try backgroundRequire(absent.availability == .notInstalled && completions == 6)
  return ["exact-id-router-foreign-fallthrough-untouched", "unrelated-no-factory-main-once", "one-owner-before-bridge", "two-tokens-not-overwritten",
    "duplicate-completion-fenced", "second-event-batch", "protected-open-blocked-not-empty",
    "protected-data-retry", "missing-backend-unavailable"]
}

import Foundation

/// The host owns lifetime and handoff, not jobs, secrets, or outcome verification.
protocol NativeBackgroundRuntime: AnyObject, Sendable {
  func restoreAndStart(completion: @escaping @Sendable (Bool) -> Void)
  func handleBackgroundEvents(_ identifier: String, completion: @escaping @MainActor @Sendable () -> Void)
}
extension BackgroundRuntime: NativeBackgroundRuntime {}

/// UIKit observations are captured on main; preparation reads only this locked value.
final class NativeBackgroundActivity: @unchecked Sendable {
  private let lock = NSLock()
  private var allowed = false
  func set(activeUnlocked: Bool) { lock.lock(); allowed = activeUnlocked; lock.unlock() }
  func get() -> Bool { lock.lock(); defer { lock.unlock() }; return allowed }
}

@MainActor
final class NativeBackgroundCompletion {
  private var handler: (() -> Void)?
  init(_ handler: @escaping () -> Void) { self.handler = handler }
  func finish() {
    guard let handler else { return }
    self.handler = nil
    handler()
  }
}

@MainActor
final class NativeBackgroundHost {
  typealias Factory = @MainActor (NativeBackgroundActivity) throws -> (any NativeBackgroundRuntime)?
  static let shared = NativeBackgroundHost(factory: NativeBackgroundInstallation.makeRuntime)
  enum Availability: String { case notInstalled, starting, installed, blocked }
  private let factory: Factory
  let activity = NativeBackgroundActivity()
  private(set) var availability = Availability.notInstalled
  private(set) var runtime: (any NativeBackgroundRuntime)?
  private var attempted = false

  init(factory: @escaping Factory) { self.factory = factory }

  /// Called by subscriber registration, before AppDelegate / React construction.
  /// A failed open never becomes an empty replacement. A factory must not throw after
  /// creating a session owner. Only protected-data availability retries a failed open.
  func launch() {
    guard !attempted else { return }
    attempted = true
    availability = .starting
    do {
      runtime = try factory(activity)
      guard let runtime else { availability = .notInstalled; return }
      availability = .installed
      runtime.restoreAndStart { _ in }
    } catch { availability = .blocked }
  }

  func connectionInstalled() {
    guard runtime == nil else { return }
    attempted = false
    launch()
  }

  func protectedDataAvailable() {
    if availability == .blocked && runtime == nil { attempted = false; launch() }
  }

  func handle(_ identifier: String, completion: @escaping () -> Void) {
    let token = NativeBackgroundCompletion(completion)
    // Do not open storage, construct, or invalidate ANY session for another module.
    guard identifier == BackgroundRuntime.sessionIdentifier else { token.finish(); return }
    launch()
    guard let runtime else {
      // No authorized backend / protected storage: retain pre-event durable state.
      // Nothing has been processed or credited. Later authorized restore reconciles.
      token.finish(); return
    }
    runtime.handleBackgroundEvents(identifier) { token.finish() }
  }
}

/// Explicit native assembly seam for the installed paired-service owner (G1).
/// A production integrator replaces this resolver with installed native configuration:
/// directory + explicit create policy, Keychain service, BackgroundControl, trust, and
/// native activity observation. No JS token, launch argument, URL or file enables it.
/// Missing credentials/backend/protected storage must return nil or throw, never reset.
@MainActor
enum NativeBackgroundInstallation {
  static func makeRuntime(activity: NativeBackgroundActivity) throws -> (any NativeBackgroundRuntime)? {
    #if FOOTAGE_EXPO_LIFECYCLE_TEST
    return try ExpoLifecycleFixture.makeRuntime(activity: activity)
    #else
    return try NativeAppInstallation.makeRuntime(activity: activity)
    #endif
  }
}

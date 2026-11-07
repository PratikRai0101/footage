import Foundation

/// AppDelegate dispatches before Expo's all-subscriber aggregator. No other
/// subscriber owns this session, and no filesystem finish event is fabricated.
@MainActor
public enum FootageBackgroundSessionRouter {
  /// True transfers this one UIKit completion to the retained native owner.
  /// False leaves it untouched: the caller MUST forward to super unchanged.
  public static func handle(_ identifier: String, completionHandler: @escaping () -> Void) -> Bool {
    #if FOOTAGE_EXPO_LIFECYCLE_TEST
    if identifier == BackgroundRuntime.sessionIdentifier { ExpoLifecycleFixture.record("ownedCallback") }
    #endif
    return route(identifier, host: NativeBackgroundHost.shared) {
      #if FOOTAGE_EXPO_LIFECYCLE_TEST
      ExpoLifecycleFixture.completed()
      #endif
      completionHandler()
    }
  }

  static func route(_ identifier: String, host: NativeBackgroundHost,
                    completionHandler: @escaping () -> Void) -> Bool {
    guard identifier == BackgroundRuntime.sessionIdentifier else { return false }
    host.handle(identifier, completion: completionHandler)
    return true
  }
}

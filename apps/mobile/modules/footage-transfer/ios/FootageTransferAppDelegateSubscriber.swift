import ExpoModulesCore
import UIKit

public final class FootageTransferAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func subscriberDidRegister() {
    NativeBackgroundHost.shared.launch()
    #if FOOTAGE_EXPO_LIFECYCLE_TEST
    ExpoLifecycleFixture.record("subscriberRegistered")
    #endif
  }

  public func application(_ application: UIApplication,
                          willFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    // ExpoAppDelegate does not forward protected-data delegate methods in 58.0.21.
    // Subscribe to UIKit notifications instead; never query UIKit on the worker.
    NotificationCenter.default.addObserver(self, selector: #selector(protectedAvailable),
      name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(protectedUnavailable),
      name: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil)
    update(application)
    NativeBackgroundHost.shared.launch()
    #if FOOTAGE_EXPO_LIFECYCLE_TEST
    ExpoLifecycleFixture.willLaunch()
    #endif
    return true
  }

  public func applicationDidBecomeActive(_ application: UIApplication) { update(application) }
  public func applicationWillResignActive(_ application: UIApplication) {
    NativeBackgroundHost.shared.activity.set(activeUnlocked: false)
  }
  public func applicationDidEnterBackground(_ application: UIApplication) {
    update(application)
    #if FOOTAGE_EXPO_LIFECYCLE_TEST
    ExpoLifecycleFixture.record("enteredBackground")
    #endif
  }
  @objc private func protectedUnavailable() {
    NativeBackgroundHost.shared.activity.set(activeUnlocked: false)
  }
  @objc private func protectedAvailable() {
    update(UIApplication.shared)
    NativeBackgroundHost.shared.protectedDataAvailable()
  }
  private func update(_ application: UIApplication) {
    NativeBackgroundHost.shared.activity.set(activeUnlocked:
      application.applicationState == .active && application.isProtectedDataAvailable)
  }

  public func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                          completionHandler: @escaping () -> Void) {
    #if FOOTAGE_EXPO_LIFECYCLE_TEST
    ExpoLifecycleFixture.record(identifier == BackgroundRuntime.sessionIdentifier ? "ownedCallback" : "unrelatedCallback")
    #endif
    NativeBackgroundHost.shared.handle(identifier) {
      #if FOOTAGE_EXPO_LIFECYCLE_TEST
      ExpoLifecycleFixture.completed()
      #endif
      completionHandler()
    }
  }
}

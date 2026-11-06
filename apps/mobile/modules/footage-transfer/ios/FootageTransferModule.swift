import ExpoModulesCore

/// Discovery only. Registering a native launch owner is NOT authorization to upload.
/// Shared iOS picker/preview continues to use its existing preview-only path. G1/G6
/// must supply the reviewed native selection/snapshot adapter before bridge activation.
public final class FootageTransferModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FootageTransfer")
    OnCreate {
      #if FOOTAGE_EXPO_LIFECYCLE_TEST
      Task { @MainActor in ExpoLifecycleFixture.record("bridgeCreated") }
      #endif
    }
    AsyncFunction("device") { () -> String in
      "{\"platform\":\"ios\",\"manufacturer\":\"Apple\",\"supportsTransfer\":false,\"scheduler\":\"background-urlsession\"}"
    }
    AsyncFunction("current") { () throws -> String in throw FootageTransferUnavailable() }
    AsyncFunction("prepare") { (_: String, _: String, _: String) throws in throw FootageTransferUnavailable() }
    AsyncFunction("start") { () throws in throw FootageTransferUnavailable() }
    AsyncFunction("cancel") { () throws in throw FootageTransferUnavailable() }
    AsyncFunction("viewer") { () throws -> String in throw FootageTransferUnavailable() }
  }
}

private struct FootageTransferUnavailable: LocalizedError {
  var errorDescription: String? {
    "iPhone transfer is unavailable until an authorized paired native service and all release gates are installed. Saved state has not been discarded."
  }
}

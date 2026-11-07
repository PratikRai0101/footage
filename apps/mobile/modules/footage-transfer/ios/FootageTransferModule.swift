import ExpoModulesCore
import Foundation
import UIKit

public final class FootageTransferModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FootageTransfer")
    OnCreate {
      #if FOOTAGE_EXPO_LIFECYCLE_TEST
      Task { @MainActor in ExpoLifecycleFixture.record("bridgeCreated") }
      #endif
    }
    AsyncFunction("device") { () async throws -> String in
      let installed = await MainActor.run { NativeBackgroundHost.shared.runtime is NativeAppTransfer }
      return try await MainActor.run {
        try appJSON(["platform": "ios", "manufacturer": "Apple", "model": UIDevice.current.model,
          "systemVersion": UIDevice.current.systemVersion, "supportsTransfer": installed, "scheduler": "background-urlsession"])
      }
    }
    AsyncFunction("connect") { (uri: String) async throws -> String in
      try await NativeAppInstallation.connect(uri: uri)
    }
    AsyncFunction("settings") { () async throws -> String in
      let origin = try await MainActor.run { try NativeAppInstallation.connection()?.origin ?? "" }
      return try appJSON(["origin": origin, "appearance": UserDefaults.standard.string(forKey: "footage.appearance") ?? "dark"])
    }
    AsyncFunction("configure") { (origin: String, appearance: String) async throws in
      try pairingRequire(["dark", "light", "system"].contains(appearance))
      let connected = try await MainActor.run { try NativeAppInstallation.connection()?.origin ?? "" }
      guard origin == connected else { throw NativeAppFailure(message: "Connect the computer using its connection file. An address alone cannot authorize uploads.") }
      UserDefaults.standard.set(appearance, forKey: "footage.appearance")
    }
    AsyncFunction("inspect") { (uri: String) async throws -> String in
      guard let url = URL(string: uri), url.isFileURL else { throw NativeAppFailure(message: "Choose an accessible original video.") }
      let metadata = await NativeClipMetadata.inspect(url)
      return try appJSON(metadata.object)
    }
    AsyncFunction("current") { () async throws -> String in
      if let owner = await Self.owner() { return try owner.current() }
      let blocked = await MainActor.run { NativeBackgroundHost.shared.availability == .blocked }
      if blocked { throw NativeAppFailure(message: "Could not open the saved transfer. Unlock the phone and reopen Footage; saved state has not been discarded.") }
      return "{\"kind\":\"empty\"}"
    }
    AsyncFunction("prepare") { (uri: String, name: String, origin: String) async throws in
      guard let owner = await Self.owner() else { throw NativeAppFailure(message: "Connect your computer in Settings first.") }
      await MainActor.run {
        NativeBackgroundHost.shared.activity.set(activeUnlocked: UIApplication.shared.applicationState == .active && UIApplication.shared.isProtectedDataAvailable)
      }
      try owner.prepare(uri: uri, name: name, origin: origin)
    }
    AsyncFunction("start") { () async throws in
      guard let owner = await Self.owner() else { throw NativeAppFailure(message: "Connect your computer first.") }
      let accepted = await withCheckedContinuation { continuation in
        owner.restoreAndStart { ok in continuation.resume(returning: ok) }
      }
      if !accepted { throw NativeAppFailure(message: "The upload is waiting. Check the computer connection, then Continue.") }
    }
    AsyncFunction("cancel") { () async throws in
      guard let owner = await Self.owner() else { throw NativeAppFailure(message: "The saved upload is unavailable; it has not been deleted.") }
      await withCheckedContinuation { continuation in owner.cancel { continuation.resume() } }
    }
    AsyncFunction("openViewer") { () async throws in
      guard let owner = await Self.owner() else { throw NativeAppFailure(message: "Open a verified original first.") }
      try await NativeOriginalViewer.open(owner)
    }
    AsyncFunction("viewer") { () async throws -> String in
      guard let owner = await Self.owner() else { throw NativeAppFailure(message: "Open a verified original first.") }
      return try await owner.viewer()
    }
  }
  private static func owner() async -> NativeAppTransfer? {
    await MainActor.run { NativeBackgroundHost.shared.runtime as? NativeAppTransfer }
  }
}

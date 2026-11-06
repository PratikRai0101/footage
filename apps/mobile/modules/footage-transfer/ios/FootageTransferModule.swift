import ExpoModulesCore
import UIKit

public final class FootageTransferModule: Module {
  private static let instance: Result<TransferOwner, Error> = Result {
    let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("FootageTransfer", isDirectory: true)
    return try TransferOwner(directory: directory)
  }
  private func command<T>(_ body: (TransferOwner) throws -> T) throws -> T {
    do { return try body(Self.instance.get()) }
    catch let error as TransferFailure { throw error }
    catch { throw TransferFailure(message: "Could not access the saved transfer or destination. Saved data has not been discarded.") }
  }
  public func definition() -> ModuleDefinition {
    Name("FootageTransfer")
    AsyncFunction("device") { () -> String in
      try transferJSON(["platform": "ios", "manufacturer": "Apple", "model": UIDevice.current.model,
        "systemVersion": UIDevice.current.systemVersion, "supportsTransfer": true, "scheduler": "foreground-session"])
    }.runOnQueue(.main)
    AsyncFunction("current") { try self.command { try $0.snapshot() } }
    AsyncFunction("settings") { try self.command { try $0.settings() } }
    AsyncFunction("configure") { (origin: String, appearance: String) in
      try self.command { try $0.configure(origin: origin, appearance: appearance) }
    }
    AsyncFunction("prepare") { (uri: String, name: String, endpoint: String) in
      try self.command { try $0.prepare(source: uri, name: name, endpoint: endpoint) }
    }
    AsyncFunction("start") { try self.command { try $0.start() } }
    AsyncFunction("cancel") { try self.command { try $0.cancel() } }
    AsyncFunction("viewer") { try self.command { try $0.viewer() } }
    AsyncFunction("inspect") { (uri: String) in
      do { return try TransferOwner.inspect(uri) }
      catch { throw TransferFailure(message: "Could not read this video's details.") }
    }
  }
}

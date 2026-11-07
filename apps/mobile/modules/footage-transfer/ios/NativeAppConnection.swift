import Foundation
import UIKit

struct NativeAppConnection: Codable, Sendable {
  let origin: String, title: String
  let receiver: Data, device: Data, intake: Data
}

private final class NativePairingResult<T: Sendable>: @unchecked Sendable {
  private let lock = NSLock(), ready = DispatchSemaphore(value: 0)
  private var result: Result<T, Error>?
  func finish(_ value: Result<T, Error>) { lock.lock(); result = value; lock.unlock(); ready.signal() }
  func take() throws -> T {
    guard ready.wait(timeout: .now() + 5) == .success else { throw NativeAppFailure(message: "Could not open the saved connection.") }
    lock.lock(); defer { lock.unlock() }
    guard let result else { throw BackgroundFailure.blocked }; return try result.get()
  }
}

/// Native-only Keychain and independent connection-file import. A normal app has
/// no fixture switch or network-supplied trust. The file is chosen by the user.
@MainActor
enum NativeAppInstallation {
  nonisolated static let keychainService = "dev.footage.transfer.native.v1"
  static var client: PairingClient { PairingClient(vault: PairingVault(service: keychainService)) }
  static var directory: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FootageOriginals", isDirectory: true)
  }
  private static var profile: PairingVault { PairingVault(service: keychainService, account: "connection.v1") }
  static func connection() throws -> NativeAppConnection? {
    guard let data = try profile.read() else { return nil }
    return try JSONDecoder().decode(NativeAppConnection.self, from: data)
  }
  private static func native<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) throws -> T {
    let result = NativePairingResult<T>()
    Task.detached { do { result.finish(.success(try await operation())) } catch { result.finish(.failure(error)) } }
    return try result.take()
  }
  static func makeRuntime(activity: NativeBackgroundActivity) throws -> NativeAppTransfer? {
    guard let connection = try connection() else {
      if FileManager.default.fileExists(atPath: directory.appendingPathComponent("ledger.sqlite").path) { throw BackgroundFailure.blocked }
      return nil
    }
    let client = client
    let saved: BackgroundState? = try {
      guard FileManager.default.fileExists(atPath: directory.appendingPathComponent("ledger.sqlite").path) else { return nil }
      let ledger = try BackgroundLedger(root: directory, create: false)
      return ledger.state
    }()
    let installed = try native { () async throws -> (PairingNativeConfirmedIntake, PairingPinnedTrust) in
      if let saved {
        return (try await PairingNativeConfirmedIntake.restoreConfirmedJob(saved.job, client: client), try await client.confirmedJobTrust(saved.job))
      }
      let identity = try await client.nativeIdentity()
      try pairingRequire(identity.receiver == connection.receiver && identity.device == connection.device && identity.origin == connection.origin)
      return (try PairingNativeConfirmedIntake(afterNativeConfirmation: connection.intake, identity: identity), try await client.installedTrust())
    }
    let runtime = try BackgroundRuntime(directory: directory, create: saved == nil, keychainService: keychainService,
      control: PairingBackgroundControl(client: client, nativeConfirmedIntake: installed.0), cellular: true,
      activeUnlocked: activity.get, trust: PairingBackgroundTrust(pinned: installed.1))
    return NativeAppTransfer(runtime: runtime, directory: directory, client: client, connection: connection)
  }
  static func connect(uri: String) async throws -> String {
    let existing = NativeBackgroundHost.shared.runtime as? NativeAppTransfer
    guard existing?.canChangeConnection != false else { throw NativeAppFailure(message: "Finish or cancel the current upload before changing the connection.") }
    guard let url = URL(string: uri), url.isFileURL else { throw NativeAppFailure(message: "Choose the connection file from your computer.") }
    struct Destination: Decodable { let id: UUID; let title: String }
    struct File: Decodable { let format: String; let offer: String; let destinations: [Destination] }
    let access = url.startAccessingSecurityScopedResource()
    defer { if access { url.stopAccessingSecurityScopedResource() } }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let data = try handle.read(upToCount: 8193) ?? Data()
    guard data.count <= 8192 else { throw NativeAppFailure(message: "The connection file is too large.") }
    let file = try JSONDecoder().decode(File.self, from: data)
    guard file.format == "footage-connection-v1", let qr = Data(base64Encoded: file.offer), !file.destinations.isEmpty, file.destinations.count <= 16 else { throw NativeAppFailure(message: "Choose a Footage connection file exported by your computer.") }
    let offer = try PairingOffer(qr)
    for d in file.destinations { try pairingRequire(!d.title.isEmpty && d.title.utf8.count <= 120 && !d.title.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)) }
    let chosen = try await choose(file.destinations.map(\.title), origin: offer.origin.text)
    let destination = file.destinations[chosen]
    guard existing?.canChangeConnection != false else { throw NativeAppFailure(message: "Finish or cancel the current upload before changing its destination.") }
    let client = client
    try await client.replaceAfterNativeConfirmation(qr: qr, permissions: offer.mask)
    do { try await client.enroll() }
    catch {
      // Registration may have committed before its reply was lost. Recover only
      // this device/key, never enroll a replacement or choose another computer.
      do { try await client.recoverLostReply() }
      catch { throw NativeAppFailure(message: "Approve the connection on your computer, then export a fresh connection file and try again.") }
    }
    let identity = try await client.nativeIdentity()
    var uuid = destination.id.uuid
    let intake = withUnsafeBytes(of: &uuid) { Data($0) }
    let connection = NativeAppConnection(origin: identity.origin, title: destination.title, receiver: identity.receiver, device: identity.device, intake: intake)
    if let existing { try existing.selectFutureConnection(connection, identity: identity, trust: await client.installedTrust()) }
    try profile.save(JSONEncoder().encode(connection))
    NativeBackgroundHost.shared.connectionInstalled()
    return try appJSON(["origin": connection.origin, "title": connection.title])
  }
  static func selectDestination() async throws -> String {
    guard let existing = NativeBackgroundHost.shared.runtime as? NativeAppTransfer, existing.canChangeConnection else { throw NativeAppFailure(message: "Connect your computer first and finish preparation.") }
    struct Entry: Decodable { let id: UUID; let title: String; let kind: String }
    struct Listing: Decodable { let version: Int; let destinations: [Entry] }
    let client = client
    let listing = try JSONDecoder().decode(Listing.self, from: await client.listDestinations())
    try pairingRequire(listing.version == 1 && !listing.destinations.isEmpty && listing.destinations.count <= 16)
    for item in listing.destinations { try pairingRequire(["inbox", "thread"].contains(item.kind) && !item.title.isEmpty && item.title.utf8.count <= 120 && !item.title.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)) }
    let selected = try await choose(listing.destinations.map(\.title), origin: existing.connection.origin, heading: "Choose destination", note: "Applies to your next original. Existing uploads keep their confirmed destination.")
    guard existing.canChangeConnection else { throw NativeAppFailure(message: "Finish or cancel the current upload before changing its destination.") }
    let identity = try await client.nativeIdentity(); var uuid = listing.destinations[selected].id.uuid
    let connection = NativeAppConnection(origin: identity.origin, title: listing.destinations[selected].title, receiver: identity.receiver, device: identity.device, intake: withUnsafeBytes(of: &uuid) { Data($0) })
    try existing.selectFutureConnection(connection, identity: identity, trust: await client.installedTrust())
    try profile.save(JSONEncoder().encode(connection))
    return try appJSON(["origin": connection.origin, "title": connection.title])
  }
  static func confirmSend(_ title: String) async throws {
    let selected = try await choose(["Send to thread"], origin: title, heading: "Send verified original?", note: "This starts or queues T3 agent work in this exact destination. It does not authorize paid generation.")
    try pairingRequire(selected == 0)
  }
  private static func choose(_ titles: [String], origin: String, heading: String = "Connect computer", note: String = "Choose where your originals will be received. Only open a connection file you obtained directly from your own computer.") async throws -> Int {
    try await withCheckedThrowingContinuation { continuation in
      let alert = UIAlertController(title: heading, message: "\(origin)\n\n\(note)", preferredStyle: .alert)
      for (index, title) in titles.enumerated() { alert.addAction(UIAlertAction(title: title, style: .default) { _ in continuation.resume(returning: index) }) }
      alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(throwing: NativeAppFailure(message: heading == "Send verified original?" ? "Cancelled. Nothing was sent." : "Selection cancelled.")) })
      let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      guard var controller = scenes.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else { continuation.resume(throwing: BackgroundFailure.inactive); return }
      while let presented = controller.presentedViewController { controller = presented }
      controller.present(alert, animated: true)
    }
  }
}

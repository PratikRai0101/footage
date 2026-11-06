import Foundation
import CryptoKit
import Security
import SQLite3
import Darwin

enum BackgroundFailure: Error { case storage, integrity, blocked, cancelled, inactive, uncertain }
func backgroundRequire(_ value: Bool) throws { if !value { throw BackgroundFailure.integrity } }

/// Private, backup-excluded storage. All callers run on the runtime's serial queue.
enum BackgroundFiles {
  static func protect(_ url: URL, complete: Bool, directory: Bool = false) throws {
    try FileManager.default.setAttributes([
      .posixPermissions: directory ? 0o700 : 0o600,
      .protectionKey: complete ? FileProtectionType.complete : .completeUntilFirstUserAuthentication
    ], ofItemAtPath: url.path)
    var u = url, values = URLResourceValues(); values.isExcludedFromBackup = true
    try u.setResourceValues(values)
  }
  static func directory(_ url: URL, complete: Bool = false) throws {
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    try protect(url, complete: complete, directory: true)
  }
  static func syncDirectory(_ url: URL) throws {
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw BackgroundFailure.storage }; defer { close(fd) }
    guard fsync(fd) == 0 else { throw BackgroundFailure.storage }
  }
  static func create(_ url: URL, complete: Bool) throws -> FileHandle {
    let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw BackgroundFailure.storage }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    do { try protect(url, complete: complete); return handle }
    catch { try? handle.close(); throw error }
  }
  static func publish(_ handle: FileHandle, partial: URL, final: URL) throws {
    try handle.synchronize(); try handle.close()
    // Never overwrite an immutable body, including after a failed prior attempt.
    guard link(partial.path, final.path) == 0 else { throw BackgroundFailure.storage }
    guard unlink(partial.path) == 0 else { throw BackgroundFailure.storage }
    try syncDirectory(final.deletingLastPathComponent())
  }
  static func save(_ bytes: Data, to url: URL, complete: Bool) throws {
    let part = url.appendingPathExtension("partial")
    let handle = try create(part, complete: complete)
    defer { try? handle.close() }
    try handle.write(contentsOf: bytes)
    try publish(handle, partial: part, final: url)
  }
  static func hash(_ url: URL) throws -> (UInt64, Data) {
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw BackgroundFailure.storage }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
    var digest = SHA256(), count: UInt64 = 0
    while let bytes = try handle.read(upToCount: 65536), !bytes.isEmpty {
      count += UInt64(bytes.count); digest.update(data: bytes)
    }
    return (count, Data(digest.finalize()))
  }
}

/// Missing/locked items never generate a replacement. One immutable item per generation.
final class BackgroundKeychain {
  let service: String
  init(service: String) { self.service = service }
  private func query(_ reference: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
     kSecAttrAccount as String: reference, kSecAttrSynchronizable as String: false]
  }
  func install(_ master: Data, reference: String) throws {
    try backgroundRequire(master.count == 32)
    var q = query(reference); q[kSecValueData as String] = master
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw BackgroundFailure.storage }
  }
  /// Keychain identity survives a missing spool/DB. A new directory is not permission
  /// to erase an old native identity or automatically register another active job.
  func claimLedger(_ root: URL, create: Bool) throws {
    let reference = "ledger.identity." + SealedProtocol.hash(Data(root.lastPathComponent.utf8)).map { String(format: "%02x", $0) }.joined()
    let file = root.appendingPathComponent("keychain-identity")
    var q = query(reference); q[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound {
      guard create && !FileManager.default.fileExists(atPath: file.path) else { throw BackgroundFailure.blocked }
      let identity = try SealedProtocol.random(32)
      try install(identity, reference: reference)
      try BackgroundFiles.save(identity, to: file, complete: false)
    } else {
      guard status == errSecSuccess, let identity = result as? Data,
        identity.count == 32, try Data(contentsOf: file) == identity else { throw BackgroundFailure.blocked }
    }
  }
  func read(_ reference: String) throws -> Data {
    var q = query(reference); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
      let bytes = result as? Data, bytes.count == 32 else { throw BackgroundFailure.blocked }
    return bytes
  }
}

struct BackgroundGroup: Codable {
  let index: Int, correlation: String
  var hash: Data?, wireBytes: UInt64 = 0
  var taskID: Int?, resumed = false, uncertain = false
}
struct BackgroundState: Codable {
  let version: Int
  let keyReference: String, receiver: Data, origin: String, job: Data, generation: Data, device: Data
  let digest: Data, originalBytes: UInt64, originalHash: Data, expires: UInt64, groupCount: Int
  var phase = "preparing"
  var intents: [Int: Data] = [:]
  var groups: [BackgroundGroup] = []
  var bitmap: UInt64 = 0, revision: UInt64 = 0
  var cancelOperation: Data?, remoteCleanup = false, localCleanup = false
  var receiptOutcome: Data?
  var confirmedBytes: UInt64 {
    var bytes: UInt64 = 0
    for i in 0..<groupCount {
      if bitmap & (UInt64(1) << i) == 0 { break }
      bytes += min(originalBytes - UInt64(i) * 64 * 1024 * 1024, 64 * 1024 * 1024)
    }
    return bytes
  }
  init(_ m: SealedProtocol.Manifest) {
    version = 1; keyReference = UUID().uuidString; receiver = m.receiver; origin = m.origin
    job = m.job; generation = m.generation; device = m.device; digest = m.digest
    originalBytes = m.originalBytes; originalHash = m.originalSHA256; expires = m.expiresAt
    groupCount = m.groupCount
  }
  func validate() throws {
    try backgroundRequire(version == 1 && UUID(uuidString: keyReference) != nil)
    try backgroundRequire(receiver.count == 32 && digest.count == 32 && originalHash.count == 32)
    try backgroundRequire(job.count == 16 && generation.count == 16 && device.count == 16)
    _ = try SealedProtocol.origin(origin)
    try backgroundRequire(originalBytes > 0 && originalBytes <= SealedProtocol.maxOriginal)
    try backgroundRequire(groupCount == Int((originalBytes + 67108863) / 67108864))
    try backgroundRequire(["preparing", "ready", "transferring", "reconciling", "verifying", "received", "cancelRequested", "cancelled", "blocked"].contains(phase))
    try backgroundRequire(groupCount == 64 || bitmap >> groupCount == 0)
    try backgroundRequire(Set(groups.map(\.index)).count == groups.count && Set(groups.map(\.correlation)).count == groups.count)
    for (position, g) in groups.enumerated() {
      try backgroundRequire(g.index == position && g.index < groupCount && UUID(uuidString: g.correlation) != nil)
      if let hash = g.hash { try backgroundRequire(hash.count == 32 && g.wireBytes > 128 && g.wireBytes <= UInt64(SealedProtocol.maxGroupWire)) }
      if let id = g.taskID { try backgroundRequire(id > 0 && g.hash != nil) }
    }
    try backgroundRequire(Set(intents.values).count == intents.count)
    for (frame, id) in intents {
      try backgroundRequire(frame >= 0 && UInt64(frame) < (originalBytes + 8388607) / 8388608 && id.count == 16)
    }
    if let operation = cancelOperation { try backgroundRequire(operation.count == 16) }
    try backgroundRequire(phase != "received" || receiptOutcome != nil)
  }
}

/// A single FULL/WAL transaction publishes the entire small bounded state. Not an atomic-JSON store.
/// flock prevents a second native owner opening the same directory. No reset-on-decode-error path.
final class BackgroundLedger {
  let root: URL
  private var db: OpaquePointer?
  private let lockFD: Int32
  private(set) var state: BackgroundState?
  init(root: URL, create: Bool) throws {
    self.root = root
    if create { try BackgroundFiles.directory(root) }
    let lockURL = root.appendingPathComponent("owner.lock")
    lockFD = open(lockURL.path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    guard lockFD >= 0 else { throw BackgroundFailure.storage }
    guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { close(lockFD); throw BackgroundFailure.blocked }
    do {
      try BackgroundFiles.protect(lockURL, complete: false)
      let url = root.appendingPathComponent("ledger.sqlite")
      let exists = FileManager.default.fileExists(atPath: url.path)
      try backgroundRequire(exists || create)
      // An initialization marker prevents opening a removed DB as an empty runtime.
      let marker = root.appendingPathComponent("initialized")
      if !exists { try backgroundRequire(!FileManager.default.fileExists(atPath: marker.path)) }
      var info = stat()
      if exists { try backgroundRequire(lstat(url.path, &info) == 0 && info.st_mode & S_IFMT == S_IFREG) }
      guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | (exists ? 0 : SQLITE_OPEN_CREATE) | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else { throw BackgroundFailure.storage }
      try execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA busy_timeout=1000;")
      try backgroundRequire(try scalar("PRAGMA journal_mode") == "wal" && scalar("PRAGMA synchronous") == "2"
        && scalar("PRAGMA fullfsync") == "1" && scalar("PRAGMA quick_check") == "ok")
      if !exists { try execute("CREATE TABLE runtime(id INTEGER PRIMARY KEY CHECK(id=1), state BLOB);") }
      try BackgroundFiles.protect(url, complete: false)
      for suffix in ["-wal", "-shm"] {
        let sidecar = URL(fileURLWithPath: url.path + suffix)
        if FileManager.default.fileExists(atPath: sidecar.path) { try BackgroundFiles.protect(sidecar, complete: false) }
      }
      var statement: OpaquePointer?
      guard sqlite3_prepare_v2(db, "SELECT state FROM runtime WHERE id=1", -1, &statement, nil) == SQLITE_OK else { throw BackgroundFailure.storage }
      defer { sqlite3_finalize(statement) }
      let result = sqlite3_step(statement)
      if result == SQLITE_ROW {
        let n = Int(sqlite3_column_bytes(statement, 0))
        guard n > 0 && n <= 262144, let bytes = sqlite3_column_blob(statement, 0) else { throw BackgroundFailure.integrity }
        state = try JSONDecoder().decode(BackgroundState.self, from: Data(bytes: bytes, count: n))
        try state?.validate()
      } else { try backgroundRequire(result == SQLITE_DONE && !exists) }
      if !exists { try BackgroundFiles.save(Data([1]), to: marker, complete: false) }
      try BackgroundFiles.syncDirectory(root)
    } catch { if let db { sqlite3_close(db) }; flock(lockFD, LOCK_UN); close(lockFD); throw error }
  }
  deinit { sqlite3_close(db); flock(lockFD, LOCK_UN); close(lockFD) }
  private func execute(_ sql: String) throws {
    guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw BackgroundFailure.storage }
  }
  private func scalar(_ sql: String) throws -> String {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw BackgroundFailure.storage }
    defer { sqlite3_finalize(statement) }
    guard sqlite3_step(statement) == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { throw BackgroundFailure.storage }
    return String(cString: text)
  }
  func save(_ value: BackgroundState) throws {
    try value.validate()
    if let prior = state {
      try backgroundRequire(prior.digest == value.digest && prior.keyReference == value.keyReference
        && prior.job == value.job && prior.generation == value.generation
        && (prior.cancelOperation == nil || prior.cancelOperation == value.cancelOperation)
        && (prior.receiptOutcome == nil || prior.receiptOutcome == value.receiptOutcome)
        && value.revision >= prior.revision && value.bitmap & prior.bitmap == prior.bitmap)
      for (frame, id) in prior.intents { try backgroundRequire(value.intents[frame] == id) }
    }
    let data = try JSONEncoder().encode(value)
    try backgroundRequire(data.count <= 262144)
    try execute("BEGIN IMMEDIATE")
    do {
      var s: OpaquePointer?
      guard sqlite3_prepare_v2(db, "INSERT OR REPLACE INTO runtime(id,state) VALUES(1,?)", -1, &s, nil) == SQLITE_OK else { throw BackgroundFailure.storage }
      defer { sqlite3_finalize(s) }
      let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
      let result = data.withUnsafeBytes { sqlite3_bind_blob(s, 1, $0.baseAddress, Int32($0.count), transient) }
      guard result == SQLITE_OK && sqlite3_step(s) == SQLITE_DONE else { throw BackgroundFailure.storage }
      try execute("COMMIT"); state = value
    } catch { try? execute("ROLLBACK"); throw error }
  }
  func change(_ body: (inout BackgroundState) throws -> Void) throws {
    guard var value = state else { throw BackgroundFailure.blocked }
    try body(&value); try save(value)
  }
}

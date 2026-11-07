import Foundation
import CryptoKit
import Darwin

/// Fault points are explicit so crash tests can stop the real pipeline at its persistence boundaries.
enum BackgroundBoundary: String { case staged, setupSaved, consumed, encrypted, groupPublished, groupRecorded, correlationSaved, taskCreated, taskBound, resumed }
struct BackgroundSelection {
  let source: URL, safeName: String
  let receiver: Data, origin: String, device: Data, enrollmentEpoch: UInt64
  let destination: SealedProtocol.Destination
  let expiresAt: UInt64
}

/// No transport authority defaults. The embedding native G1 owner must authorize the exact
/// setup manifest and minimal outcome binding using masks 0x01/0x02/0x04, fixed HTTPS paths,
/// no redirects, exact paired trust and bounded binary responses. Never a JS adapter.
/// Status/revoke must not reopen private destination/display metadata. No default authority.
protocol BackgroundControl {
  func setup(_ manifest: SealedProtocol.Manifest) throws -> Data // canonical FTSET001, <=80 bytes
  func status(_ context: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data
  func revoke(_ context: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data
}

final class BackgroundPreseal {
  let ledger: BackgroundLedger, keychain: BackgroundKeychain
  let activeUnlocked: () -> Bool
  let boundary: (BackgroundBoundary) throws -> Void
  var privateDirectory: URL { ledger.root.appendingPathComponent("private") }
  var original: URL { privateDirectory.appendingPathComponent("original") }
  var manifestURL: URL { privateDirectory.appendingPathComponent("manifest") }
  func packet(_ index: Int) -> URL { ledger.root.appendingPathComponent("group-\(index).sealed") }
  init(ledger: BackgroundLedger, keychain: BackgroundKeychain,
       activeUnlocked: @escaping () -> Bool, boundary: @escaping (BackgroundBoundary) throws -> Void) {
    self.ledger = ledger; self.keychain = keychain
    self.activeUnlocked = activeUnlocked; self.boundary = boundary
  }
  private func checkActive() throws {
    guard activeUnlocked() else { throw BackgroundFailure.inactive }
    if ledger.state?.cancelOperation != nil { throw BackgroundFailure.cancelled }
  }
  private func unchanged(_ a: stat, _ b: stat) throws {
    try backgroundRequire(a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size
      && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec
      && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec)
  }
  /// Owner-serialized staging. The foreground caller performs remote setup OUTSIDE
  /// the event owner, then returns its bytes to finishPreparation on that owner.
  func stage(_ selection: BackgroundSelection) throws -> SealedProtocol.Manifest {
    try checkActive(); try backgroundRequire(ledger.state == nil && selection.source.isFileURL)
    _ = try SealedProtocol.origin(selection.origin)
    _ = try SealedProtocol.text(selection.safeName, max: 240, name: true)
    try BackgroundFiles.directory(privateDirectory, complete: true)
    let scoped = selection.source.startAccessingSecurityScopedResource()
    defer { if scoped { selection.source.stopAccessingSecurityScopedResource() } }
    let fd = open(selection.source.path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw BackgroundFailure.storage }
    let input = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? input.close() }
    var before = stat(); try backgroundRequire(fstat(fd, &before) == 0 && before.st_mode & S_IFMT == S_IFREG
      && before.st_size > 0 && UInt64(before.st_size) <= SealedProtocol.maxOriginal)
    let bytes = UInt64(before.st_size)
    let available = try FileManager.default.attributesOfFileSystem(forPath: ledger.root.path)[.systemFreeSize] as? NSNumber
    // Conservative admission only, NOT a guarantee about daemon-owned snapshots or future ENOSPC.
    guard (available?.uint64Value ?? 0) > 3 * bytes + 512 * 1024 * 1024 else { throw BackgroundFailure.storage }
    let partial = original.appendingPathExtension("partial")
    let output = try BackgroundFiles.create(partial, complete: true); defer { try? output.close() }
    var published = false
    defer { if !published { try? FileManager.default.removeItem(at: partial) } }
    var whole = SHA256(), frame = SHA256(), hashes: [Data] = [], frameCount = 0, count: UInt64 = 0
    while let data = try input.read(upToCount: 65536), !data.isEmpty {
      try checkActive(); count += UInt64(data.count); try backgroundRequire(count <= bytes)
      try output.write(contentsOf: data); whole.update(data: data); frame.update(data: data); frameCount += data.count
      if frameCount == SealedProtocol.frameBytes { hashes.append(Data(frame.finalize())); frame = SHA256(); frameCount = 0 }
    }
    if frameCount > 0 { hashes.append(Data(frame.finalize())) }
    var after = stat(), pathAfter = stat()
    try backgroundRequire(fstat(fd, &after) == 0 && lstat(selection.source.path, &pathAfter) == 0 && count == bytes)
    try unchanged(before, after); try unchanged(before, pathAfter)
    try BackgroundFiles.publish(output, partial: partial, final: original); published = true
    try boundary(.staged); try checkActive()
    let m = try SealedProtocol.Manifest(receiver: selection.receiver, origin: selection.origin,
      job: Self.uuid(), generation: Self.uuid(), device: selection.device,
      enrollmentEpoch: selection.enrollmentEpoch, destination: selection.destination,
      originalBytes: bytes, originalSHA256: Data(whole.finalize()), safeName: selection.safeName,
      expiresAt: selection.expiresAt, frameHashes: hashes)
    try m.validateSetupTime(now: UInt64(Date().timeIntervalSince1970))
    // Persist identity BEFORE setup: timeout or partial installation may not silently create a new job.
    try BackgroundFiles.save(m.bytes, to: manifestURL, complete: true)
    try ledger.save(try BackgroundState(m))
    return m
  }
  func finishPreparation(_ m: SealedProtocol.Manifest, reply: Data) throws {
    do {
      // A late setup reply still supplies recovery authority for this SAME job,
      // even if cancel won while the socket waited. Save it before checking the
      // cancel/activity fence. Never seal or schedule across that fence.
      try backgroundRequire(ledger.state?.digest == m.digest
        && (ledger.state?.phase == "preparing" || ledger.state?.cancelOperation != nil))
      _ = try SealedProtocol.decodeSetup(reply, manifest: m)
      // G2 intentionally doesn't export its master. Its exact 80-byte canonical setup
      // has already been validated; extract only its fixed master field for Keychain.
      let master = Data(reply[40..<72])
      try keychain.install(master, reference: ledger.state!.keyReference)
      let authentication = try SealedProtocol.OutcomeContext.fromManifest(m).authentication(master: master)
      try ledger.change { $0.outcomeAuthentication = authentication }
      try boundary(.setupSaved); try checkActive()
      try seal(m)
    } catch {
      // Includes consumed intent/AES/file/DB failure. There is deliberately no resume-sealing API.
      try? ledger.change { $0.phase = "blocked" }; throw error
    }
  }
  static func uuid() -> Data { var id = UUID().uuid; return withUnsafeBytes(of: &id) { Data($0) } }
  private func seal(_ m: SealedProtocol.Manifest) throws {
    let keys = try SealedProtocol.Keys(master: keychain.read(ledger.state!.keyReference), manifest: m)
    let session = SealedProtocol.SealSession(keys: keys)
    let input = try FileHandle(forReadingFrom: original); defer { try? input.close() }
    var before = stat(); try backgroundRequire(fstat(input.fileDescriptor, &before) == 0 && UInt64(before.st_size) == m.originalBytes)
    var whole = SHA256()
    for group in 0..<m.groupCount {
      try checkActive()
      let final = packet(group), part = final.appendingPathExtension("partial")
      let output = try BackgroundFiles.create(part, complete: false); defer { try? output.close() }
      let header = try SealedProtocol.groupHeader(m, group)
      var wire = SHA256(), wireBytes = UInt64(header.count)
      try output.write(contentsOf: header); wire.update(data: header)
      let p = try m.partition(group)
      for index in p.firstFrame..<(p.firstFrame + p.frameCount) {
        try autoreleasepool {
          try checkActive()
          let length = try m.frameLength(index)
          let plaintext = try input.read(upToCount: length) ?? Data()
          // Hash/length checks precede allocation and also occur inside the production codec.
          try backgroundRequire(plaintext.count == length && SealedProtocol.hash(plaintext) == m.frameHashes[index])
          whole.update(data: plaintext)
          let intent = try session.consume(frame: index) { record in
            try ledger.change {
              try backgroundRequire($0.intents[index] == nil && !$0.intents.values.contains(record.sealID))
              $0.intents[index] = record.sealID
            }
            try boundary(.consumed)
          }
          let encrypted = try intent.seal(plaintext)
          try boundary(.encrypted)
          try output.write(contentsOf: encrypted); wire.update(data: encrypted); wireBytes += UInt64(encrypted.count)
        }
      }
      try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: part.path)
      try BackgroundFiles.publish(output, partial: part, final: final)
      try boundary(.groupPublished)
      let hash = Data(wire.finalize())
      try ledger.change { $0.groups.append(BackgroundGroup(index: group, correlation: UUID().uuidString, hash: hash, wireBytes: wireBytes)) }
      try boundary(.groupRecorded)
    }
    var after = stat(); try backgroundRequire(fstat(input.fileDescriptor, &after) == 0)
    try unchanged(before, after)
    try backgroundRequire(Data(whole.finalize()) == m.originalSHA256 && (try input.read(upToCount: 1) ?? Data()).isEmpty)
    try checkActive()
    try ledger.change { try backgroundRequire($0.groups.count == m.groupCount); $0.phase = "ready" }
  }
  func validatePacket(_ g: BackgroundGroup) throws {
    guard let hash = g.hash else { throw BackgroundFailure.blocked }
    let (count, actual) = try BackgroundFiles.hash(packet(g.index))
    try backgroundRequire(count == g.wireBytes && actual == hash)
  }
}

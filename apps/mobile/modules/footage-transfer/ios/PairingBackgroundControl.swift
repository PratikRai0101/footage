import Foundation

/// Construct only after native UI has displayed and confirmed this exact intake and receiver.
/// Not a JS destination handle, an inferred inbox, or a receiver scope grant.
struct PairingNativeConfirmedIntake: Sendable {
  let intake: Data
  let identity: PairingInstalledIdentity
  init(afterNativeConfirmation intake: Data, identity: PairingInstalledIdentity) throws {
    try pairingRequire(intake.count == 16)
    self.intake = intake; self.identity = identity
  }
  /// Cold-launch restoration of an EXISTING native confirmation, not a new choice.
  /// Missing/expired private job authority throws; never consult current pairing/UI.
  static func restoreConfirmedJob(_ job: Data, client: PairingClient) async throws -> Self {
    let saved = try await client.confirmedJobBinding(job)
    let identity = try await client.confirmedJobIdentity(job)
    return try Self(afterNativeConfirmation: saved.intake, identity: identity)
  }
}

/// The blocking half runs only on native utility workers. The async half never uses
/// that queue or main for completion. Transport has its own 30s resource deadline;
/// the 35s wait is bounded even if an actor cannot make progress. Late results are
/// discarded, never treated as a receipt or permission to create another identity.
private final class PairingControlWait<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock(), done = DispatchSemaphore(value: 0)
  private var result: Result<Value, Error>?
  func finish(_ value: Result<Value, Error>) { lock.lock(); result = value; lock.unlock(); done.signal() }
  func wait() throws -> Value {
    guard done.wait(timeout: .now() + 35) == .success else { throw PairingFailure.rejected }
    lock.lock(); defer { lock.unlock() }
    guard let result else { throw PairingFailure.rejected }; return try result.get()
  }
}

final class PairingBackgroundControl: BackgroundControl {
  private let client: PairingClient
  private let confirmed: PairingNativeConfirmedIntake
  init(client: PairingClient, nativeConfirmedIntake: PairingNativeConfirmedIntake) {
    self.client = client; confirmed = nativeConfirmedIntake
  }
  private func perform<T: Sendable>(_ operation: @escaping @Sendable () async throws -> T) throws -> T {
    try pairingRequire(!Thread.isMainThread)
    let waiter = PairingControlWait<T>()
    let task = Task.detached(priority: .utility) {
      do { waiter.finish(.success(try await operation())) }
      catch { waiter.finish(.failure(error)) }
    }
    defer { task.cancel() }
    return try waiter.wait()
  }
  func setup(_ manifest: SealedProtocol.Manifest) throws -> Data {
    let c = confirmed, f = c.identity, client = client
    guard case .standalone(let intake) = manifest.destination else { throw PairingFailure.rejected }
    try pairingRequire(intake == c.intake && manifest.receiver == f.receiver && manifest.origin == f.origin
      && manifest.device == f.device && manifest.enrollmentEpoch == f.epoch && manifest.expiresAt <= f.expires)
    let binding = try PairingControlBinding(receiver: manifest.receiver, origin: manifest.origin,
      device: manifest.device, epoch: manifest.enrollmentEpoch, job: manifest.job,
      generation: manifest.generation, manifestDigest: manifest.digest, intake: intake, expires: manifest.expiresAt)
    let body = manifest.bytes
    return try perform {
      let installed = try await client.nativeIdentity()
      try pairingRequire(installed.receiver == f.receiver && installed.origin == f.origin && installed.device == f.device
        && installed.epoch == f.epoch && installed.expires == f.expires)
      try await client.confirmStandaloneAfterNativeConfirmation(binding)
      return try await client.control(.setup, binding: binding, canonicalBody: body)
    }
  }
  private func outcome(_ context: SealedProtocol.OutcomeContext, query: SealedProtocol.Query,
                       operation: PairingControlOperation) throws -> Data {
    let client = client, job = context.job, body = query.encode(context)
    // Copy only minimal nonsecret binding fields across the actor boundary.
    let receiver = context.receiver, origin = context.origin, device = context.device, epoch = context.enrollmentEpoch
    let generation = context.generation, digest = context.digest, expiry = context.expiresAt, destination = context.destinationDigest
    _ = try SealedProtocol.Query.decode(body, outcome: context)
    return try perform {
      let saved = try await client.confirmedJobBinding(job)
      try pairingRequire(saved.receiver == receiver && saved.origin == origin && saved.device == device && saved.epoch == epoch
        && saved.generation == generation && saved.manifestDigest == digest && saved.expires == expiry
        && pairingHash(Data([1]) + saved.intake) == destination)
      return try await client.control(operation, job: job, canonicalBody: body)
    }
  }
  func status(_ context: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data {
    try outcome(context, query: query, operation: .status)
  }
  func revoke(_ context: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data {
    try outcome(context, query: query, operation: .revoke)
  }
}

/// Background bodies may follow redirects. This only pins TLS at the paired origin;
/// it does NOT claim URLSession rejects redirects. Bodies contain no control credential.
struct PairingBackgroundTrust: BackgroundServerTrust {
  let pinned: PairingPinnedTrust
  func credential(for challenge: URLAuthenticationChallenge) -> URLCredential? { pinned.credential(for: challenge) }
}

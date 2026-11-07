import Foundation

struct BackgroundTask: Sendable {
  let id: Int, correlation: String?
  let suspended: Bool
}
struct BackgroundTaskEvent: Sendable {
  let id: Int, correlation: String?, status: Int, body: Data
  let transportOK: Bool
}
/// Native-only app-scoped trust. Must reject other hosts/ports/keys and never alter OS trust.
/// Nil uses system TLS; it does not permit private CA onboarding by itself.
protocol BackgroundServerTrust {
  func credential(for challenge: URLAuthenticationChallenge) -> URLCredential?
}
protocol BackgroundDaemon: AnyObject {
  func allTasks(_ completion: @escaping @Sendable ([BackgroundTask]) -> Void)
  func create(file: URL, origin: String, correlation: String, bytes: UInt64) throws -> BackgroundTask
  func resume(_ id: Int) throws
  func cancel(_ id: Int)
}

/// State, URLSession callbacks and commands share the runtime queue. @unchecked Sendable is
/// confined to this queue; only URLSession's Sendable task array crosses its enumeration callback.
final class BackgroundSession: NSObject, URLSessionDataDelegate, @unchecked Sendable, BackgroundDaemon {
  static let identifier = "footage.sealed.background.v1"
  private static let claimLock = NSLock()
  // Protected by claimLock; a background session lives for the process lifetime.
  nonisolated(unsafe) private static var claimed = false
  private let queue: DispatchQueue
  private let event: (BackgroundTaskEvent) -> Void
  private let finished: () -> Void
  private var trust: (any BackgroundServerTrust)?
  private var session: URLSession!
  private var tasks: [Int: URLSessionTask] = [:]
  private struct Response { var bytes = Data(); var rejected = false }
  private var responses: [Int: Response] = [:]
  init(queue: DispatchQueue, cellular: Bool, trust: (any BackgroundServerTrust)?,
       event: @escaping (BackgroundTaskEvent) -> Void, finished: @escaping () -> Void) throws {
    Self.claimLock.lock()
    let alreadyClaimed = Self.claimed
    if !alreadyClaimed { Self.claimed = true }
    Self.claimLock.unlock()
    guard !alreadyClaimed else { throw BackgroundFailure.blocked }
    self.queue = queue; self.event = event; self.finished = finished; self.trust = trust
    super.init()
    let config = URLSessionConfiguration.background(withIdentifier: Self.identifier)
    config.sessionSendsLaunchEvents = true; config.isDiscretionary = false
    config.httpCookieStorage = nil; config.httpShouldSetCookies = false
    config.urlCredentialStorage = nil; config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.allowsCellularAccess = cellular; config.tlsMinimumSupportedProtocolVersion = .TLSv12
    config.timeoutIntervalForResource = 7 * 86400
    let delegate = OperationQueue(); delegate.maxConcurrentOperationCount = 1; delegate.underlyingQueue = queue
    session = URLSession(configuration: config, delegate: self, delegateQueue: delegate)
  }
  // Called only by the serialized runtime after proving no daemon tasks remain.
  func replaceTrust(_ trust: (any BackgroundServerTrust)?) { self.trust = trust }
  func allTasks(_ completion: @escaping @Sendable ([BackgroundTask]) -> Void) {
    session.getAllTasks { [weak self] tasks in
      guard let self else { return }
      self.queue.async {
        self.tasks = Dictionary(uniqueKeysWithValues: tasks.map { ($0.taskIdentifier, $0) })
        completion(tasks.map { BackgroundTask(id: $0.taskIdentifier, correlation: $0.taskDescription, suspended: $0.state == .suspended) })
      }
    }
  }
  func create(file: URL, origin: String, correlation: String, bytes: UInt64) throws -> BackgroundTask {
    _ = try SealedProtocol.origin(origin)
    guard let url = URL(string: origin + "/sealed/v1/ingest") else { throw BackgroundFailure.integrity }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
    request.httpMethod = "POST"; request.httpShouldHandleCookies = false
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    let task = session.uploadTask(with: request, fromFile: file)
    task.taskDescription = correlation
    task.countOfBytesClientExpectsToSend = Int64(bytes)
    task.countOfBytesClientExpectsToReceive = 4096
    tasks[task.taskIdentifier] = task
    return BackgroundTask(id: task.taskIdentifier, correlation: correlation, suspended: true)
  }
  func resume(_ id: Int) throws {
    guard let task = tasks[id] else { throw BackgroundFailure.uncertain }; task.resume()
  }
  func cancel(_ id: Int) { tasks[id]?.cancel() }
  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    authenticate(challenge, completionHandler)
  }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    authenticate(challenge, completionHandler)
  }
  private func authenticate(_ challenge: URLAuthenticationChallenge,
                            _ completion: (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
      completion(.cancelAuthenticationChallenge, nil); return
    }
    if let trust {
      if let credential = trust.credential(for: challenge) { completion(.useCredential, credential) }
      else { completion(.cancelAuthenticationChallenge, nil) }
    } else { completion(.performDefaultHandling, nil) }
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
      http.value(forHTTPHeaderField: "Content-Type") == "application/octet-stream",
      response.expectedContentLength <= 4096 else {
      responses[dataTask.taskIdentifier] = Response(rejected: true); completionHandler(.cancel); return
    }
    responses[dataTask.taskIdentifier] = Response(); completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    let id = dataTask.taskIdentifier
    // Background uploads can deliver data/completion WITHOUT didReceive(response:).
    // Validate task.response here too; absence of the optional headers callback is not failure.
    var response = responses[id] ?? Response()
    let http = dataTask.response as? HTTPURLResponse
    if http?.statusCode != 200 || http?.value(forHTTPHeaderField: "Content-Type") != "application/octet-stream"
        || (http?.expectedContentLength ?? 0) > 4096 || data.count > 4096 - response.bytes.count {
      response.rejected = true; dataTask.cancel()
    }
    else if !response.rejected { response.bytes.append(data) }
    responses[id] = response
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let response = responses.removeValue(forKey: task.taskIdentifier) ?? Response(rejected: true)
    event(BackgroundTaskEvent(id: task.taskIdentifier, correlation: task.taskDescription,
      status: (task.response as? HTTPURLResponse)?.statusCode ?? 0, body: response.bytes,
      transportOK: error == nil && !response.rejected))
    tasks.removeValue(forKey: task.taskIdentifier)
  }
  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) { finished() }
}

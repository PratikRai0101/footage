import Foundation

struct TransferHTTPError: Error { let status: Int }
struct TransferResponse {
  let status: Int
  let headers: HTTPURLResponse
  let data: Data
  func json() throws -> [String: Any] {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw TransferFailure(message: "The destination returned invalid metadata.")
    }
    return object
  }
}

// Each operation owns a foreground session. The delegate veto happens BEFORE any redirected request.
// Response bytes are capped in the delegate, not after URLSession has buffered an arbitrary body.
final class TransferHTTP: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
  private let done = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var task: URLSessionTask?
  private var cancelled = false
  private var response: HTTPURLResponse?
  private var bytes = Data()
  private var failure: Error?
  private let origin: String
  init(origin: String) { self.origin = origin }
  func cancel() {
    lock.lock(); cancelled = true; let current = task; lock.unlock()
    current?.cancel()
  }
  func execute(method: String, path: String, capability: String? = nil, body: Data? = nil, file: URL? = nil,
               offset: Int64? = nil) throws -> TransferResponse {
    try requireTransfer(try receiverOrigin(origin) == origin && path.hasPrefix("/") && !path.hasPrefix("//") &&
                        !path.contains("\\") && !path.contains("%") && !path.contains("?") && !path.contains("#"),
                        "Invalid destination request.")
    guard let url = URL(string: origin + path) else { throw TransferFailure(message: "Invalid destination request.") }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 30
    if let capability { request.setValue("Bearer \(capability)", forHTTPHeaderField: "Authorization") }
    request.setValue("1.0.0", forHTTPHeaderField: "Tus-Resumable")
    if let offset {
      request.setValue(String(offset), forHTTPHeaderField: "Upload-Offset")
      request.setValue("application/offset+octet-stream", forHTTPHeaderField: "Content-Type")
    } else if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    request.httpBody = body
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForResource = 60
    configuration.waitsForConnectivity = false
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    let pending: URLSessionTask = file.map { session.uploadTask(with: request, fromFile: $0) } ?? session.dataTask(with: request)
    lock.lock(); task = pending; let stopped = cancelled; lock.unlock()
    if stopped { pending.cancel() }
    pending.resume()
    done.wait()
    session.finishTasksAndInvalidate()
    lock.lock(); task = nil; lock.unlock()
    if let failure { throw failure }
    guard let response else { throw TransferFailure(message: "The destination did not respond.") }
    try requireTransfer(response.url == url, "The destination attempted to redirect the request.")
    return TransferResponse(status: response.statusCode, headers: response, data: bytes)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    failure = TransferFailure(message: "The destination attempted to redirect the request. No redirect was followed.")
    completionHandler(nil)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let http = response as? HTTPURLResponse, response.expectedContentLength <= 65536 else {
      failure = TransferFailure(message: "The destination response exceeded the metadata limit.")
      completionHandler(.cancel); return
    }
    self.response = http
    completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if bytes.count + data.count > 65536 {
      failure = TransferFailure(message: "The destination response exceeded the metadata limit.")
      dataTask.cancel()
    } else { bytes.append(data) }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if failure == nil { failure = error }
    done.signal()
  }
}

import Foundation
import Security
import Darwin

// Minimal definite-length DER walker, used only to extract exact SPKI and SAN/EKU.
// SecTrust remains the chain/signature/date/server-policy authority.
private struct PairingDER {
  let bytes: Data, tag: UInt8, content: Data
  init(_ bytes: Data) throws {
    var offset = 0; self = try Self.read(bytes, &offset); try pairingRequire(offset == bytes.count)
  }
  private init(bytes: Data, tag: UInt8, content: Data) { self.bytes = bytes; self.tag = tag; self.content = content }
  static func read(_ data: Data, _ offset: inout Int) throws -> Self {
    let start = offset
    try pairingRequire(data.count - offset >= 2); let tag = data[offset]; offset += 1
    let first = Int(data[offset]); offset += 1
    let length: Int
    if first < 128 { length = first } else {
      let n = first & 127; try pairingRequire(n > 0 && n <= 4 && n <= data.count - offset && data[offset] != 0)
      var value = 0; for _ in 0..<n { value = (value << 8) | Int(data[offset]); offset += 1 }
      try pairingRequire(value >= 128); length = value
    }
    try pairingRequire(length <= data.count - offset)
    let content = data.subdata(in: offset..<(offset + length)); offset += length
    return Self(bytes: data.subdata(in: start..<offset), tag: tag, content: content)
  }
  func children() throws -> [Self] {
    var result: [Self] = [], offset = 0
    while offset < content.count { result.append(try Self.read(content, &offset)) }
    return result
  }
}
private func pairingCertificateDates(_ bytes: Data, now: Date) throws {
  let root = try PairingDER(bytes), cert = try root.children(); try pairingRequire(cert.count == 3)
  let tbs = try cert[0].children(), shift = tbs.first?.tag == 0xa0 ? 1 : 0
  try pairingRequire(tbs.count > 3 + shift)
  let validity = try tbs[3 + shift].children(); try pairingRequire(validity.count == 2)
  func date(_ field: PairingDER) throws -> Date {
    let yearDigits = field.tag == 0x17 ? 2 : 4
    try pairingRequire(field.tag == 0x17 || field.tag == 0x18)
    let b = Array(field.content)
    try pairingRequire(b.count == yearDigits + 11 && b.last == 90 && b.dropLast().allSatisfy { (48...57).contains($0) })
    func number(_ start: Int, _ n: Int) -> Int { b[start..<(start + n)].reduce(0) { $0 * 10 + Int($1 - 48) } }
    var year = number(0, yearDigits)
    if yearDigits == 2 { year += year >= 50 ? 1900 : 2000 }
    let calendar = Calendar(identifier: .gregorian), zone = TimeZone(secondsFromGMT: 0)!
    let c = DateComponents(calendar: calendar, timeZone: zone, year: year, month: number(yearDigits, 2), day: number(yearDigits + 2, 2), hour: number(yearDigits + 4, 2), minute: number(yearDigits + 6, 2), second: number(yearDigits + 8, 2))
    guard let result = calendar.date(from: c) else { throw PairingFailure.rejected }
    var utc = calendar; utc.timeZone = zone
    let back = utc.dateComponents([.year,.month,.day,.hour,.minute,.second], from: result)
    try pairingRequire(back.year == c.year && back.month == c.month && back.day == c.day && back.hour == c.hour && back.minute == c.minute && back.second == c.second)
    return result
  }
  try pairingRequire(try date(validity[0]) <= now && now <= date(validity[1]))
}
struct PairingCertificate {
  let spki: Data
  let dns: [String]
  let ips: [Data]
  init(_ bytes: Data) throws {
    let root = try PairingDER(bytes), cert = try root.children()
    try pairingRequire(root.tag == 0x30 && cert.count == 3 && cert[0].tag == 0x30)
    let tbs = try cert[0].children(), shift = tbs.first?.tag == 0xa0 ? 1 : 0
    try pairingRequire(tbs.count > 6 + shift && tbs[5 + shift].tag == 0x30)
    spki = tbs[5 + shift].bytes
    var names: [String] = [], addresses: [Data] = [], serverAuth = false, foundSAN = false
    guard let ext = tbs.first(where: { $0.tag == 0xa3 }) else { throw PairingFailure.rejected }
    let wrappers = try ext.children(); try pairingRequire(wrappers.count == 1 && wrappers[0].tag == 0x30)
    for entry in try wrappers[0].children() {
      let fields = try entry.children(); try pairingRequire(entry.tag == 0x30 && fields.count >= 2 && fields[0].tag == 6)
      guard let value = fields.last, value.tag == 4 else { throw PairingFailure.rejected }
      if fields[0].content == Data([0x55, 0x1d, 0x11]) {
        try pairingRequire(!foundSAN); foundSAN = true
        let san = try PairingDER(value.content); try pairingRequire(san.tag == 0x30)
        for name in try san.children() {
          if name.tag == 0x82 {
            guard let text = String(data: name.content, encoding: .ascii) else { throw PairingFailure.rejected }
            names.append(text.lowercased())
          } else if name.tag == 0x87 { addresses.append(name.content) }
        }
      } else if fields[0].content == Data([0x55, 0x1d, 0x25]) {
        let eku = try PairingDER(value.content); try pairingRequire(eku.tag == 0x30)
        serverAuth = try eku.children().contains { $0.tag == 6 && $0.content == Data([0x2b,0x06,0x01,0x05,0x05,0x07,0x03,0x01]) }
      }
    }
    try pairingRequire(foundSAN && serverAuth); dns = names; ips = addresses
  }
  func matches(_ host: String) -> Bool {
    var v4 = in_addr(), v6 = in6_addr()
    if inet_pton(AF_INET, host, &v4) == 1 { return ips.contains(withUnsafeBytes(of: &v4) { Data($0) }) }
    if inet_pton(AF_INET6, host, &v6) == 1 { return ips.contains(withUnsafeBytes(of: &v6) { Data($0) }) }
    // Deliberately stricter than wildcard certificate matching: exact QR hostname SAN.
    return dns.contains(host)
  }
}
enum PairingRoute: String { case enroll = "/pair/v1/enroll", challenge = "/pair/v1/challenge", recover = "/pair/v1/recover" }

final class PairingHTTP {
  private let offer: PairingOffer
  init(_ offer: PairingOffer) { self.offer = offer }
  func send(_ route: PairingRoute, body: Data) async throws -> Data {
    try pairingRequire(body.count <= 16384)
    return try await withCheckedThrowingContinuation { continuation in
      let exchange = PairingExchange(offer: offer, continuation: continuation)
      exchange.start(route, body)
    }
  }
}
private final class PairingExchange: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
  private let offer: PairingOffer
  private var continuation: CheckedContinuation<Data, Error>?
  private var session: URLSession?
  private var bytes = Data()
  private var rejected = false
  init(offer: PairingOffer, continuation: CheckedContinuation<Data, Error>) { self.offer = offer; self.continuation = continuation }
  func start(_ route: PairingRoute, _ body: Data) {
    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCredentialStorage = nil
    config.tlsMinimumSupportedProtocolVersion = .TLSv12
    config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 30
    let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: config, delegate: self, delegateQueue: queue); self.session = session
    guard let url = URL(string: offer.origin.text + route.rawValue) else { finish(.failure(PairingFailure.rejected)); return }
    var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = body
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    session.dataTask(with: request).resume()
  }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    let space = challenge.protectionSpace
    do {
      try pairingRequire(space.authenticationMethod == NSURLAuthenticationMethodServerTrust && space.protocol == "https" && space.host == offer.origin.host && space.port == offer.origin.port && challenge.previousFailureCount == 0)
      guard let trust = space.serverTrust, let anchor = SecCertificateCreateWithData(nil, offer.ca as CFData) else { throw PairingFailure.rejected }
      try pairingRequire(SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, offer.origin.host as CFString)) == errSecSuccess)
      try pairingRequire(SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess)
      try pairingRequire(SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess)
      try pairingRequire(SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess)
      try pairingRequire(SecTrustEvaluateWithError(trust, nil))
      try pairingCertificateDates(offer.ca, now: Date())
      guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { throw PairingFailure.rejected }
      for certificate in chain { try pairingCertificateDates(SecCertificateCopyData(certificate) as Data, now: Date()) }
      let cert = try PairingCertificate(SecCertificateCopyData(leaf) as Data)
      try pairingRequire(cert.matches(offer.origin.host) && pairingHash(cert.spki) == offer.pin)
      completionHandler(.useCredential, URLCredential(trust: trust))
    } catch { rejected = true; completionHandler(.cancelAuthenticationChallenge, nil) }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    // Never answer HTTP authentication/client-certificate challenges from any store.
    rejected = true; completionHandler(.cancelAuthenticationChallenge, nil)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    rejected = true; completionHandler(nil)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let response = response as? HTTPURLResponse, response.statusCode == 200,
      response.url == dataTask.originalRequest?.url,
      response.value(forHTTPHeaderField: "Content-Type") == "application/octet-stream",
      response.expectedContentLength <= 16384 else { rejected = true; completionHandler(.cancel); return }
    completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if data.count > 16384 - bytes.count { rejected = true; dataTask.cancel() } else { bytes.append(data) }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if rejected { finish(.failure(PairingFailure.rejected)) }
    else if let error { finish(.failure(error)) }
    else { finish(.success(bytes)) }
  }
  private func finish(_ result: Result<Data, Error>) {
    let callback = continuation; continuation = nil
    session?.finishTasksAndInvalidate(); session = nil; callback?.resume(with: result)
  }
}

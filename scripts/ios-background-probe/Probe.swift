// Standalone, disposable Simulator research app. Not a production transport.
import UIKit
import Foundation
import Security
import CryptoKit

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
func digest(_ d: Data) -> String { hex(Data(SHA256.hash(data: d))) }
func json(_ o: Any) -> Data { try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) }
let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
func event(_ o: [String: Any]) {
    let u = documents.appendingPathComponent("events.jsonl")
    if !FileManager.default.fileExists(atPath: u.path) { FileManager.default.createFile(atPath: u.path, contents: nil) }
    let h = try! FileHandle(forWritingTo: u); try! h.seekToEnd()
    try! h.write(contentsOf: json(o).addingNewline()); try! h.close()
}
extension Data { func addingNewline() -> Data { var d = self; d.append(10); return d } }

final class Transport: NSObject, URLSessionDataDelegate, URLSessionDownloadDelegate {
    let config: [String: Any]
    var session: URLSession!
    var bytes = Data()
    var key: SymmetricKey?
    var ackKey: SymmetricKey?
    var expectedAck: Data?
    var expectedOffset = 0
    var pin = ""
    var root: SecCertificate!
    var challengeCount = 0
    var redirects = 0
    init(_ config: [String: Any]) {
        self.config = config
        super.init()
        let b = Bundle.main
        pin = digest(try! Data(contentsOf: b.url(forResource: "leaf", withExtension: "der")!))
        root = SecCertificateCreateWithData(nil, try! Data(contentsOf: b.url(forResource: "root", withExtension: "der")!) as CFData)!
    }
    func trust(_ challenge: URLAuthenticationChallenge, _ completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else { completion(.performDefaultHandling, nil); return }
        challengeCount += 1
        let p = challenge.protectionSpace
        let origin = URL(string: config["origin"] as! String)!
        let originOK = p.host == origin.host && p.port == origin.port && p.protocol == "https"
        if config["anchor"] as? String == "custom" {
            SecTrustSetAnchorCertificates(trust, [root!] as CFArray)
            SecTrustSetAnchorCertificatesOnly(trust, true)
        }
        let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] ?? []
        let pinOK = chain.first.map { digest(SecCertificateCopyData($0) as Data) == pin } ?? false
        var e: CFError?
        let trusted = SecTrustEvaluateWithError(trust, &e)
        event(["event": "trust", "host": p.host, "port": p.port, "originOK": originOK, "pinOK": pinOK, "trusted": trusted])
        if originOK && pinOK && trusted { completion(.useCredential, URLCredential(trust: trust)) }
        else { completion(.cancelAuthenticationChallenge, nil) }
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) { trust(challenge, completionHandler) }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) { trust(challenge, completionHandler) }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        redirects += 1; completionHandler(nil)
    }
    func start() {
        let c: URLSessionConfiguration
        if config["foreground"] as? Bool == true { c = .ephemeral }
        else { c = .background(withIdentifier: "test.footage.transport." + (config["name"] as! String)) }
        c.isDiscretionary = false; c.sessionSendsLaunchEvents = true
        c.httpCookieStorage = nil; c.httpShouldSetCookies = false; c.urlCredentialStorage = nil; c.urlCache = nil
        c.timeoutIntervalForRequest = 30; c.timeoutIntervalForResource = 240
        let q = OperationQueue(); q.maxConcurrentOperationCount = 1
        session = URLSession(configuration: c, delegate: self, delegateQueue: q)
        if config["sealed"] as? Bool == true { setup(); return }
        let url = URL(string: config["url"] as! String)!
        var r = URLRequest(url: url)
        if config["auth"] as? Bool == true { r.setValue("Bearer " + String(repeating: "synthetic-", count: 4), forHTTPHeaderField: "Authorization") }
        if config["metadata"] as? Bool == true {
            session.downloadTask(with: r).resume()
        } else {
            r.httpMethod = "PATCH"
            let d = Data(repeating: 0x46, count: 65536)
            let f = documents.appendingPathComponent("upload.bin"); try! d.write(to: f)
            event(["event": "expected", "bytes": d.count, "sha256": digest(d)])
            session.uploadTask(with: r, fromFile: f).resume()
        }
    }
    // Setup owns a separate foreground session; rejects every redirect before secret acquisition.
    var setupSession: URLSession?
    func setup() {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil; c.urlCache = nil; c.urlCredentialStorage = nil
        let s = URLSession(configuration: c, delegate: self, delegateQueue: nil); setupSession = s
        let origin = config["origin"] as! String
        var r = URLRequest(url: URL(string: origin + "/setup")!); r.httpMethod = "POST"
        s.dataTask(with: r) { data, response, error in
            guard error == nil, let h = response as? HTTPURLResponse, h.statusCode == 200,
                  h.url == r.url, let data,
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                  let kb = Data(base64Encoded: o["key"] ?? ""), kb.count == 32, let job = o["job"] else {
                event(["event": "setupFailed"]); return
            }
            let master = SymmetricKey(data: kb)
            // Distinct HKDF labels for encryption and acknowledgments, not a bearer-derived secret.
            let salt = Data(job.utf8)
            self.key = HKDF<SHA256>.deriveKey(inputKeyMaterial: master, salt: salt, info: Data("probe-v1/body".utf8), outputByteCount: 32)
            self.ackKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: master, salt: salt, info: Data("probe-v1/ack".utf8), outputByteCount: 32)
            let length = self.config["length"] as? Int ?? 65536
            var plain = Data(count: length)
            let randomOK = plain.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, length, $0.baseAddress!) }
            precondition(randomOK == errSecSuccess)
            let hash = digest(plain)
            let context = "probe-v1|\(job)|0|\(length)|\(hash)"
            let aad = Data(context.utf8)
            let sealed = try! AES.GCM.seal(plain, using: self.key!, authenticating: aad).combined!
            let header = json(["v": 1, "job": job, "offset": 0, "length": length, "sha256": hash])
            // uint32 BE header length || JSON || nonce(12) || ciphertext || tag(16).
            var wire = Data(); var n = UInt32(header.count).bigEndian
            withUnsafeBytes(of: &n) { wire.append(contentsOf: $0) }; wire.append(header); wire.append(sealed)
            let ack = "probe-v1/ack|\(job)|0|\(length)|\(hash)|\(digest(wire))"
            self.expectedAck = Data(ack.utf8); self.expectedOffset = length
            let bodyKeyBytes = self.key!.withUnsafeBytes { Data($0) }
            let ackKeyBytes = self.ackKey!.withUnsafeBytes { Data($0) }
            let noPlaintextOrKeys = wire.range(of: plain) == nil && wire.range(of: kb) == nil &&
                wire.range(of: bodyKeyBytes) == nil && wire.range(of: ackKeyBytes) == nil &&
                wire.range(of: Data(kb.base64EncodedString().utf8)) == nil
            precondition(noPlaintextOrKeys)
            event(["event": "sealedBoundary", "noPlaintextOrKeys": noPlaintextOrKeys])
            let f = documents.appendingPathComponent("sealed.bin")
            try! wire.write(to: f, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            event(["event": "sealedReady", "bytes": length, "sha256": hash, "wireBytes": wire.count, "wireHash": digest(wire)])
            var req = URLRequest(url: URL(string: self.config["url"] as! String)!)
            req.httpMethod = "PATCH"; req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            self.session.uploadTask(with: req, fromFile: f).resume()
            event(["event": "scheduled", "session": self.session.configuration.identifier!])
            s.finishTasksAndInvalidate()
        }.resume()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard bytes.count + data.count <= 4096 else { dataTask.cancel(); return }; bytes.append(data)
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        bytes = (try? Data(contentsOf: location)) ?? Data()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        // Foreground setup completion is owned by its completion closure.
        if session === setupSession { return }
        let h = task.response as? HTTPURLResponse
        var accepted = 0
        var ackContextMatched = false
        var ackMACVerified = false
        if let ackKey, let expectedAck,
           let o = try? JSONSerialization.jsonObject(with: bytes) as? [String: String] {
            ackContextMatched = o["ack"] == String(decoding: expectedAck, as: UTF8.self)
            if let mac = Data(base64Encoded: o["mac"] ?? "") {
                ackMACVerified = HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: expectedAck, using: ackKey)
            }
            if ackContextMatched && ackMACVerified && error == nil && h?.statusCode == 200 { accepted = expectedOffset }
        }
        let result: [String: Any] = ["event": "complete", "status": h?.statusCode ?? 0,
            "error": (error as NSError?)?.code ?? 0, "errorDescription": error.map { String(describing: $0) } ?? "", "redirectCallbacks": redirects,
            "trustCallbacks": challengeCount, "acceptedPlaintextOffset": accepted,
            "ackContextMatched": ackContextMatched, "ackMACVerified": ackMACVerified,
            "responseBytes": bytes.count, "finalURL": h?.url?.absoluteString ?? ""]
        event(result)
        try! json(result).write(to: documents.appendingPathComponent("result.json"), options: .atomic)
        session.finishTasksAndInvalidate()
    }
}

@main
final class App: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    var transport: Transport?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds); window?.rootViewController = UIViewController()
        window?.rootViewController?.view.backgroundColor = .systemBackground; window?.makeKeyAndVisible()
        event(["event": "launched", "pid": ProcessInfo.processInfo.processIdentifier])
        let a = ProcessInfo.processInfo.arguments
        if let i = a.firstIndex(of: "--config"), i + 1 < a.count {
            let c = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: a[i + 1]))) as! [String: Any]
            transport = Transport(c); transport!.start()
        }
        return true
    }
    func applicationDidEnterBackground(_ application: UIApplication) { event(["event": "enteredBackground"]) }
}

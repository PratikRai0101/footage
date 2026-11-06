import Foundation
import CryptoKit

struct TransferFailure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}
func requireTransfer(_ condition: Bool, _ message: String) throws {
  if !condition { throw TransferFailure(message: message) }
}

// Only an origin may acquire authority. Never resolve server Location or uploadPath values.
func receiverOrigin(_ input: String) throws -> String {
  let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
  guard let c = URLComponents(string: raw), let scheme = c.scheme, ["http", "https"].contains(scheme),
        let host = c.host?.lowercased(), !host.isEmpty, c.user == nil, c.password == nil,
        c.query == nil, c.fragment == nil, c.path == "" || c.path == "/",
        !raw.contains("\\"), !host.contains("%"), c.url != nil else {
    throw TransferFailure(message: "Enter only the HTTP or HTTPS receiver origin.")
  }
  try requireTransfer(c.port == nil || (1...65535).contains(c.port!), "Choose a receiver port between 1 and 65535.")
  if scheme == "http" {
    let h = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    let parts = h.split(separator: ".", omittingEmptySubsequences: false)
    let octets = parts.compactMap { Int($0) }
    let v4 = parts.count == 4 && octets.count == 4 && octets.allSatisfy { (0...255).contains($0) } &&
      (octets[0] == 10 || octets[0] == 127 || (octets[0] == 172 && (16...31).contains(octets[1])) ||
       (octets[0] == 192 && octets[1] == 168) || (octets[0] == 169 && octets[1] == 254))
    let v6 = h == "::1" || (h.contains(":") && h.range(of: "^(fc|fd|fe[89ab])[0-9a-f:]+$", options: .regularExpression) != nil)
    try requireTransfer(h == "localhost" || v4 || v6, "Local HTTP requires a private network address. Use HTTPS for a non-local receiver.")
  }
  var result = c
  result.path = ""
  return result.string!
}

struct TransferMedia: Codable {
  var durationMs: Int? = nil
  var width: Int? = nil
  var height: Int? = nil
  var mimeType: String? = nil
  var json: [String: Any] {
    ["durationMs": durationMs as Any? ?? NSNull(), "width": width as Any? ?? NSNull(),
     "height": height as Any? ?? NSNull(), "mimeType": mimeType as Any? ?? NSNull()]
  }
}
struct TransferReceipt: Codable {
  let id: String
  let jobId: String
  let bytes: Int64
  let sha256: String
  let verifiedAt: String
  func validate(_ job: TransferJob) throws {
    let date = ISO8601DateFormatter()
    date.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let validDate = date.date(from: verifiedAt) != nil || ISO8601DateFormatter().date(from: verifiedAt) != nil
    try requireTransfer(UUID(uuidString: id) != nil && validDate && jobId == job.id && bytes == job.bytes && sha256 == job.sha256,
                        "The receipt does not match this original.")
  }
  var json: [String: Any] { ["id": id, "jobId": jobId, "bytes": bytes, "sha256": sha256, "verifiedAt": verifiedAt] }
}
enum TransferPhase: Codable {
  case ready, uploading, waiting, verifying
  case received(TransferReceipt)
  case cancelled(Bool)
  case failed(String, Bool)
  var terminal: Bool {
    switch self { case .received, .cancelled: return true; default: return false }
  }
  var replaceable: Bool {
    switch self { case .received, .cancelled(false): return true; default: return false }
  }
}
struct TransferJob: Codable {
  let id: String
  let name: String
  let bytes: Int64
  let sha256: String
  let origin: String
  let capability: String
  let media: TransferMedia
  var confirmed: Int64 = 0
  var phase: TransferPhase = .ready
  func validate() throws {
    try requireTransfer(UUID(uuidString: id) != nil && bytes > 0 && bytes <= 4 * 1024 * 1024 * 1024 &&
                        (0...bytes).contains(confirmed) && sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil &&
                        capability.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                        "Saved transfer is invalid. It has not been discarded.")
    try requireTransfer(try receiverOrigin(origin) == origin, "Saved destination is invalid. It has not been discarded.")
    if case .received(let receipt) = phase {
      try receipt.validate(self)
      try requireTransfer(confirmed == bytes, "Saved receipt has incomplete confirmation.")
    }
  }
}
struct TransferSettings: Codable {
  var origin = ""
  var appearance = "dark"
}

// Atomic writes precede publication in memory. Decode failures are never treated as absence.
final class TransferStore {
  let directory: URL
  private let jobURL: URL
  private let settingsURL: URL
  enum Preparation: String, Codable { case interrupted, cancelled, failed }
  private struct State: Codable { let job: TransferJob?; let preparation: Preparation? }
  private(set) var job: TransferJob?
  private(set) var preparation: Preparation?
  private(set) var settings: TransferSettings
  init(directory: URL) throws {
    self.directory = directory
    jobURL = directory.appendingPathComponent("transfer.json")
    settingsURL = directory.appendingPathComponent("settings.json")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var protected = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try protected.setResourceValues(values)
    settings = TransferSettings()
    if FileManager.default.fileExists(atPath: jobURL.path) {
      let state = try JSONDecoder().decode(State.self, from: readMetadata(jobURL))
      job = state.job
      preparation = state.preparation
      try job?.validate()
    }
    if FileManager.default.fileExists(atPath: settingsURL.path) {
      settings = try JSONDecoder().decode(TransferSettings.self, from: readMetadata(settingsURL))
      try validateSettings(settings)
    }
  }
  func original(_ id: String) -> URL { directory.appendingPathComponent("\(id).original") }
  func save(_ value: TransferJob) throws {
    try value.validate()
    try JSONEncoder().encode(State(job: value, preparation: nil)).write(to: jobURL, options: [.atomic, .completeFileProtection])
    job = value
    preparation = nil
  }
  func savePreparation(_ value: Preparation) throws {
    try JSONEncoder().encode(State(job: job, preparation: value)).write(to: jobURL, options: [.atomic, .completeFileProtection])
    preparation = value
  }
  private func readMetadata(_ url: URL) throws -> Data {
    let input = try FileHandle(forReadingFrom: url)
    defer { try? input.close() }
    let bytes = try input.read(upToCount: 65537) ?? Data()
    try requireTransfer(bytes.count <= 65536, "Saved transfer metadata is too large. It has not been discarded.")
    return bytes
  }
  func configure(_ value: TransferSettings) throws {
    try validateSettings(value)
    try JSONEncoder().encode(value).write(to: settingsURL, options: [.atomic, .completeFileProtection])
    settings = value
  }
  private func validateSettings(_ value: TransferSettings) throws {
    try requireTransfer(["dark", "light", "system"].contains(value.appearance), "Choose a supported appearance.")
    if !value.origin.isEmpty { _ = try receiverOrigin(value.origin) }
  }
}

func transferJSON(_ value: Any) throws -> String {
  String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
}

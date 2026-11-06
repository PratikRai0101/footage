import Foundation
import Security
import CryptoKit
import LocalAuthentication
import Darwin

// Private one-request pipe protocol, NOT a secret-export CLI. The wrapping master
// never leaves Security.framework/CryptoKit. No args/env carry secret material.
// Production service/account are fixed; test items require an explicit UUID namespace.
struct Failure: Error {}
func require(_ value: Bool) throws { if !value { throw Failure() } }
struct Reader {
  let data: Data
  var offset = 0
  mutating func take(_ n: Int) throws -> Data {
    try require(n >= 0 && n <= data.count - offset)
    defer { offset += n }; return data.subdata(in: offset..<(offset + n))
  }
  mutating func number(_ n: Int) throws -> Int { try take(n).reduce(0) { ($0 << 8) | Int($1) } }
  mutating func field(_ max: Int) throws -> Data { let n = try number(4); try require(n <= max); return try take(n) }
}
do {
  try require(CommandLine.arguments.count == 1)
  var input = Data()
  while true {
    let part = FileHandle.standardInput.readData(ofLength: 4096)
    if part.isEmpty { break }
    try require(part.count <= 131072 - input.count); input.append(part)
  }
  var r = Reader(data: input)
  try require(try r.take(8) == Data("FTOSKEY1".utf8))
  let op = try r.number(1)
  guard let namespace = String(data: try r.field(80), encoding: .utf8) else { throw Failure() }
  let context = try r.field(1024), body = try r.field(65536 + 28)
  try require(r.offset == input.count && (1...5).contains(op))
  let test = namespace.hasPrefix("test.")
  if test {
    let text = String(namespace.dropFirst(5))
    try require(UUID(uuidString: text)?.uuidString.lowercased() == text)
  } else { try require(namespace == "production") }
  let authentication = LAContext(); authentication.interactionNotAllowed = true
  let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.footage.desktop.wrapping.v1",
    kSecAttrAccount as String: namespace, kSecAttrSynchronizable as String: false,
    kSecUseAuthenticationContext as String: authentication]
  if op == 1 {
    try require(body.isEmpty && context.isEmpty)
    // Add-only. Duplicate, denied, or locked never means reset/replace.
    var bytes = Data(count: 32)
    try require(bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) } == errSecSuccess)
    var add = query; add.removeValue(forKey: kSecUseAuthenticationContext as String)
    add[kSecValueData as String] = bytes
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    try require(SecItemAdd(add as CFDictionary, nil) == errSecSuccess)
  } else if op == 5 {
    // No production deletion or arbitrary service/account selection.
    try require(test && context.isEmpty && body.isEmpty)
    try require(SecItemDelete(query as CFDictionary) == errSecSuccess)
  } else {
    var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    try require(SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess)
    guard let raw = result as? Data, raw.count == 32 else { throw Failure() }
    let key = SymmetricKey(data: raw)
    if op == 2 { try require(context.isEmpty && body.isEmpty) }
    else {
      try require(!context.isEmpty)
      let aad = Data("footage/desktop-wrap/v1\0".utf8) + Data(namespace.utf8) + Data([0]) + context
      let output: Data
      if op == 3 {
        try require(body.count <= 65536)
        guard let combined = try AES.GCM.seal(body, using: key, authenticating: aad).combined else { throw Failure() }
        output = combined
      } else {
        try require(body.count >= 28)
        output = try AES.GCM.open(AES.GCM.SealedBox(combined: body), using: key, authenticating: aad)
      }
      // Ciphertext only on stdout. Unwrapped record material uses a dedicated
      // inherited private pipe, never stdout/stderr, arguments, or environment.
      if op == 3 { FileHandle.standardOutput.write(output) }
      else { FileHandle(fileDescriptor: 3, closeOnDealloc: false).write(output) }
    }
  }
} catch {
  // Deliberately no OS error description/input/keys in logs or stdout.
  exit(1)
}

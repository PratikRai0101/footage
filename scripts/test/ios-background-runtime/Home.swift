import XCTest

/// Runs only on the disposable destination chosen by run.py, never a booted-device alias.
@MainActor
final class HomeTests: XCTestCase {
  func testHome() { XCUIDevice.shared.press(.home) }
  func testReturn() { XCUIApplication(bundleIdentifier: "test.footage.backgroundruntime").activate() }
}

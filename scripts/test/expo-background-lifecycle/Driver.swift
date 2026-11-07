import XCTest

@MainActor
final class LifecycleDriver: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "dev.footage.spike")
  func testNormalPicker() {
    app.activate()
    XCTAssertTrue(app.buttons["Choose a video"].waitForExistence(timeout: 30), app.debugDescription)
    XCTAssertFalse(app.buttons["Upload original"].exists)
    XCTAssertTrue(app.staticTexts["Preview only"].firstMatch.exists)
    let cancel = app.buttons["Cancel"]
    for _ in 0..<2 {
      app.buttons["Choose a video"].tap()
      if cancel.waitForExistence(timeout: 8) { break }
    }
    XCTAssertTrue(cancel.exists, app.debugDescription)
    cancel.tap()
    XCTAssertTrue(app.buttons["Choose a video"].waitForExistence(timeout: 10))
  }
  func testHome() { XCUIDevice.shared.press(.home) }
  func testActivate() { app.activate() }
}

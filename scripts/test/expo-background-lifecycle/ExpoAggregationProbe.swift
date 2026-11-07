import Foundation

/// Bookkeeping-unit reproduction using the installed Expo 58 source, NOT an OS event.
/// Compile alongside expo-file-system/ios/BackgroundSessionCompletion.swift.
@main
struct ExpoAggregationProbe {
  static func main() {
    let completion = BackgroundSessionCompletion()
    var callbacks = 0
    let id = "footage.sealed.background.v1"
    let token = completion.receiveHandler(id) { callbacks += 1 }
    completion.expire(id, token: token)
    precondition(callbacks == 0, "Dependency changed: reassess the unknown-session blocker")
    // This artificial finish is ONLY on this standalone bookkeeping object. It is
    // never sent to the real subscriber/session, nor counted as lifecycle evidence.
    completion.finishEvents(id)
    precondition(callbacks == 1)
    print("Expo 58 dependency defect reproduced: unrelated handler remains pending after deadline; requires its own finish event.")
  }
}

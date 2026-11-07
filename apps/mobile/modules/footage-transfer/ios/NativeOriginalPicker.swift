import Foundation
import UIKit
import UniformTypeIdentifiers

/// Holds the exact URL grant delivered by UIKit. Reconstructing a URL from a JS
/// string is not a reliable lifetime/authorization boundary for Files providers.
final class NativeOriginalSelection: @unchecked Sendable {
  let url: URL
  private let scoped: Bool
  init(_ url: URL) { self.url = url; scoped = url.startAccessingSecurityScopedResource() }
  deinit { if scoped { url.stopAccessingSecurityScopedResource() } }
}

@MainActor
final class NativeOriginalPicker: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  private static var active: NativeOriginalPicker?
  private static var selection: NativeOriginalSelection?
  private var continuation: CheckedContinuation<String, Error>?
  static func selected(_ uri: String) throws -> NativeOriginalSelection {
    guard let selection, selection.url.absoluteString == uri else { throw NativeAppFailure(message: "Choose this original again to grant access.") }
    return selection
  }
  static func choose() async throws -> String {
    guard active == nil else { throw NativeAppFailure(message: "Finish choosing a video first.") }
    return try await withCheckedThrowingContinuation { continuation in
      let owner = NativeOriginalPicker(); owner.continuation = continuation; active = owner
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.movie], asCopy: false)
      picker.delegate = owner; picker.presentationController?.delegate = owner; picker.allowsMultipleSelection = false
      guard var controller = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else { owner.finish(.failure(BackgroundFailure.inactive)); return }
      while let presented = controller.presentedViewController { controller = presented }
      controller.present(picker, animated: true) { picker.presentationController?.delegate = owner }
    }
  }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let url = urls.first, url.isFileURL else { finish(.failure(BackgroundFailure.integrity)); return }
    let retained = NativeOriginalSelection(url)
    Self.selection = retained
    let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize
    do {
      finish(.success(try appJSON(["uri": url.absoluteString, "name": url.lastPathComponent, "size": size.flatMap { $0 > 0 ? $0 : nil } as Any? ?? NSNull()])))
    } catch { finish(.failure(error)) }
  }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(.success("null")) }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(.success("null")) }
  private func finish(_ result: Result<String, Error>) {
    let callback = continuation; continuation = nil; Self.active = nil; callback?.resume(with: result)
  }
}

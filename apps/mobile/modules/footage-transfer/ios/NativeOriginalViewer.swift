import UIKit
import WebKit

@MainActor
final class NativeOriginalViewer: UIViewController, WKNavigationDelegate {
  private let url: URL
  private let trust: PairingPinnedTrust
  private var web: WKWebView!
  init(url: URL, trust: PairingPinnedTrust) { self.url = url; self.trust = trust; super.init(nibName: nil, bundle: nil) }
  required init?(coder: NSCoder) { nil }
  override func viewDidLoad() {
    super.viewDidLoad()
    let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent(); config.allowsInlineMediaPlayback = true
    web = WKWebView(frame: .zero, configuration: config); web.navigationDelegate = self
    view = web; title = "Original"
    navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
    web.load(URLRequest(url: url))
  }
  func webView(_ webView: WKWebView, respondTo challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
    if let credential = trust.credential(for: challenge) { return (.useCredential, credential) }
    return (.cancelAuthenticationChallenge, nil)
  }
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
    guard let target = navigationAction.request.url,
      target.scheme == url.scheme, target.host == url.host, target.port == url.port,
      target.path == "/receive" || target.path.hasPrefix("/viewer/") else { return .cancel }
    return .allow
  }
  static func open(_ owner: NativeAppTransfer) async throws {
    guard let state = owner.runtime.stateForPresentation() else { throw BackgroundFailure.blocked }
    let link = try await owner.viewer()
    let trust = try await owner.client.confirmedJobTrust(state.job)
    guard let url = URL(string: link), var controller = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else { throw BackgroundFailure.inactive }
    while let presented = controller.presentedViewController { controller = presented }
    controller.present(UINavigationController(rootViewController: NativeOriginalViewer(url: url, trust: trust)), animated: true)
  }
}

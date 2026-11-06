# iOS background upload origin blocker

## Result

Implementation stopped before changing the app. Apple's background URLSession cannot enforce the current no-redirect authority boundary through its redirect delegate. A standalone iPhone Simulator probe confirmed that a background PATCH forwarded the generated file to a different origin.

This is not a Footage upload, receipt, or background lifecycle success. iOS remains preview-only. No native module, JS contract, server, workflow, or UI changed.

## Existing boundary and platform behavior

`apps/mobile/modules/footage-transfer/android/src/main/java/expo/modules/footagetransfer/TransferOwner.kt` sets `instanceFollowRedirects = false` for both metadata requests and tus connections. `ReceiverOrigin.kt` validates the selected origin before any upload authority exists.

Apple's [Downloading files in the background](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background), under "Comply with background transfer limitations", states:

> Redirects are always followed. As a result, even if you have implemented urlSession(_:task:willPerformHTTPRedirection:newRequest:completionHandler:), it is not called.

A response URL check runs too late to prevent the file from leaving the selected origin. Stripping Authorization does not prevent disclosure of the original bytes. The probe did not use an Authorization header and makes no claim about capability forwarding.

The Expo 58.0.21 source was also inspected before choosing an API. Relevant files are `expo/ios/Expo/ExpoAppDelegate.swift`, `expo-modules-core/ios/AppDelegates/ExpoAppDelegateSubscriberManager.swift`, and `expo-file-system/ios/Legacy/FileSystemBackgroundSessionHandler.swift` under `node_modules`. Expo supports forwarding background-session completion events. That integration does not override Apple's redirect behavior.

## Simulator experiment

The probe used a newly created, separate iPhone 16 simulator with iOS 26.2, Xcode 27.2, and the iPhoneSimulator27.2 SDK. It did not use the existing Footage simulator or a physical phone.

Two owned Node HTTP listeners bound unused ports on loopback. Their different ports made them different origins. The configured origin returned HTTP 307 to the other origin. The sink recorded accepted byte length and SHA-256.

The generated fixture contained 65,536 bytes of `0x46`. Its SHA-256 was `c0258020dcc175789c8ea95afc0cc5f25a5a07296d6395d3bf3b09f85b92b87a`. It was synthetic binary data, not video or personal media.

The probe called `uploadTask(with:fromFile:)` with method PATCH. Its `URLSessionTaskDelegate` implemented `willPerformHTTPRedirection` and always returned `nil` to reject redirects.

- With `URLSessionConfiguration.background(withIdentifier:)`, the sink accepted all 65,536 bytes with the matching SHA-256. Completion returned HTTP 204 without an error. The redirect delegate ran zero times.
- With `URLSessionConfiguration.ephemeral`, the redirect delegate ran once and completion stopped at HTTP 307 without an error.

The local build required simulator signing via `CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`. An unsigned early probe could not connect to `nsurlsessiond` and was not used as evidence. No signing credentials were accessed.

Ignored local artifacts are in `artifacts/ios-redirect-probe/`. They include `background-main.swift`, `main.swift` for the foreground control, `receiver.mjs`, the generated Xcode project, build logs, `background-accepted.json`, `background-result.json`, `foreground-result.json`, and `safe-evidence.json`. Raw logs remain ignored because they contain local simulator paths. The probe simulator was shut down and deleted, and the owned listeners were stopped.

## Checks

These baseline commands passed after the investigation:

- `npm ci`
- `npm test`
- `npm run typecheck`
- `npm run lint`

The standalone native probe built with `xcodebuild -project artifacts/ios-redirect-probe/RedirectProbe.xcodeproj -target RedirectProbe -configuration Debug -sdk iphonesimulator -arch arm64 CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`, with a local `CONFIGURATION_BUILD_DIR` under ignored artifacts. Installation and launch used `simctl` with the isolated simulator identifier.

No full Footage iOS build, end-to-end receiver receipt, interruption recovery, cancellation, persisted settings, or UI preview validation is claimed.

## Decision needed

A native foreground owner can use file-backed URLSession uploads, reject redirects, preserve durable jobs, and reconcile server offsets after interruption. A bounded UIKit background execution grace period does not promise continued transfer after suspension. That changes the requested lifecycle behavior and needs a decision before implementation resumes.

Using background URLSession instead requires an explicitly approved change to the authority model or another proven transport design. The receiver promising not to redirect does not enforce the existing client boundary. Force-quit must not be presented as an automatic restart guarantee under either design.

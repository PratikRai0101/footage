# iOS Simulator check

Tested on the available **iPhone Duo, iOS 27.1** simulator. This is a real built/installed application run, not a browser-sized mockup. No physical iPhone or iOS background transfer is claimed.

## Result

- Release ARM64 simulator `.app` built, installed and cold-launched with embedded JavaScript/assets and **no Metro**.
- The real system Files picker selected only `footage-ios-generated.mp4` from a dedicated generated-test folder.
- The selected clip actually played. The uncut simulator recording shows its embedded source clock advancing to `00:00:02.033` and moving test-pattern geometry. Frames at one and three recording seconds have 27,165 changed pixels inside the preview, not merely a changing system clock.
- Actual player metadata appears as **0:08 · 1280 × 720 · 4.0 MiB**.
- Cancelling the system picker retains the existing selected filename and metadata.
- Light/dark themes render; System follows the simulator's original light appearance. At Accessibility Large, content scrolls and the primary action remains reachable. Original text-size category `large` was restored; OS appearance was not changed. The automation's generic scroll did not reach the content container; a raw drag inside the scroll view then exposed the complete preview-only disclosure, with its accessibility nodes hittable (`large-after-drag-tree.json`). This was a harness targeting issue, not counted as successful scrolling until that actual drag.
- The UI explicitly says preview-only, offers choosing another video, and does not offer Upload or a fake received state.

## Bugs found and fixed

The first simulator run reproduced two real gaps:

1. Duration/resolution stayed unavailable because inspection only called the Android module. Preview-only builds now read real Expo Video source/track metadata, normalize unknown/indefinite values to unavailable, and ignore stale URI callbacks. Android retains its native persisted metadata as the authority.
2. The iOS screen inherited Android upload wording, a disabled Upload button, and the promise that nothing is copied before confirmation. Preview-only presentation now removes the upload action and explains that the system picker may import a temporary preview copy. Original uploads/receipts require Android.

Two copy regressions failed before the fix. Four new presentation/metadata tests pass afterward. Current local suites total 26 receiver + 17 mobile + 2 proxy tests; the existing two native origin tests also pass. TypeScript and Expo lint pass.

## Fixture and evidence

Generated H.264 Main/AAC video: 8 seconds, 1280×720, **4,161,576 bytes**. SHA-256:

`087c25d01d569da4de721d49392c53a460155c379d0c5028faaeaabc5d35fa81`

The local-provider original's hash remains unchanged. Do not infer a verified upload from preview playback. No personal media, iCloud login or signing account was used.

[Sanitized result and executable/JS hashes](ios-simulator.json). Raw evidence under `artifacts/ios-simulator/` includes:

- `03-review-before-fix.png`, `04-review-after-fix.png`.
- `local-preview.mp4`, `05-playback-1.png`, `06-playback-3.png`.
- `07-light.png`, `theme-dark.png`, `theme-system.png`.
- `08-large-text.png`, `09-large-text-scrolled.png` and accessibility trees.
- `mobile-before-fix.tap`, `all-tests.tap`, `typecheck.log`, `lint.log`.

One rebuild exceeded its 300-second runner limit during native C++ compilation. It was not counted as a completed build; the subsequent resumed `xcodebuild` completed successfully (`build-resume.log`).

## Reproduce

```sh
npm run ios:build
xcrun simctl boot FA652008-7FC6-4054-A1F9-4D5E6464FA3C # if shutdown
xcrun simctl install FA652008-7FC6-4054-A1F9-4D5E6464FA3C \
  artifacts/ios-simulator/Footage.app
xcrun simctl launch FA652008-7FC6-4054-A1F9-4D5E6464FA3C dev.footage.spike
```

The scheme and bundle identifier are Footage / `dev.footage.spike`. The build script uses CNG and CocoaPods; it does not hand-edit generated iOS files. `scripts/record-ios-evidence.py` consolidates the existing captures and checks their moving preview and fixture hash; it does not substitute for driving the UI again. Local UI automation used pinned `agent-device@0.21.35` and XCTest.

The `.app` is simulator-only and unsigned. It is not an IPA or installable physical-iPhone build.

## Android cross-platform regression

The shared UI changes were rebuilt into the standalone Android APK. A fresh API 36 emulator upload again reached a receipt with independently matching original bytes/hash (`android-regression.json`).

An earlier regression attempt failed because the Mac moved from its previous `<private-lan-ip>` LAN address to `<private-lan-ip>`; the still-bound old receiver address was unreachable. This setup failure remains recorded in `android-lan-change.json`, not relabeled a recovery pass. The generated job had zero confirmed bytes and no server registration. The test operator stopped the owned emulator app, rebound only the isolated receiver to loopback, independently cancelled that unregistered job, and reset generated-fixture emulator data for a **separate fresh test**. That fresh test used ADB reverse to loopback, not Wi-Fi. The physical receiver data and phone were not reset.

## Not tested / not implemented

**Native iOS uploads, background recovery and receipts are not implemented.** This check validates the iOS preview/UI subset only. Other iPhone/iOS versions, physical hardware, VoiceOver audio, Safari receiving-side playback, 4K memory and HDR fidelity remain unverified. The existing physical Samsung background evidence does not establish any iOS behavior.

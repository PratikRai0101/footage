# Footage

An independent original-video intake prototype. Not an official Cardboard app or integration.

## Current build: 0.5.0

The normal iPhone Release app now connects to a computer and uploads originals through the native background engine. Real system-picker selection, explicit trust/destination confirmation, two consecutive uploads with distinct matching receipts, cold relaunch and the pinned read-only received viewer were exercised on iOS 26.2 Simulator. The approved full-frame layout, Instrument Serif and charcoal/warm-white palette are unchanged. No test-build switch or JS byte uploader is required.

```sh
npm ci
npm run ios:build
xcrun simctl install <simulator-id> artifacts/ios-simulator/Footage.app
xcrun simctl launch <simulator-id> dev.footage.spike
```

**Connect first:** Settings → Connect computer imports a private two-minute connection file from your own computer and confirms its actual destination. Until connected, Preview only is intentional. Preparation needs the app open; prepared encrypted file-backed transfers use native background URLSession. Force-quit is not an automatic restart guarantee.

**T3 handoff is explicit and computer-side:** `deliver JOB_ID` verifies the original in the chosen same-host thread workspace; `send JOB_ID` queues a retry-safe text reference and can start agent work. No automatic send/edit occurs, and there is no pretend phone dispatch button. Live T3 credential compatibility was not exercised against a personal account. See **[setup and complete workflow](docs/RUN.md)**.

Current evidence: [`docs/evidence/normal-app-0.5.md`](docs/evidence/normal-app-0.5.md). Background lifecycle evidence: [`docs/evidence/expo-background-lifecycle.md`](docs/evidence/expo-background-lifecycle.md). The previous [0.4 rebuild](docs/evidence/full-frame-ios-rebuild.json) remains historical. Product limits: [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md).

The Android upload flow remains: choose a clip, review its preview/metadata, confirm Upload, and receive a server-verified receipt. Kotlin owns copying, hashing, persistence and transfer; JavaScript never uploads video bytes or receives the upload capability.

## Source history

The app and receiver share the public repository [PratikRai0101/footage](https://github.com/PratikRai0101/footage). Expo's original scaffold commit and the small implementation commits are preserved. Personal device identifiers and local machine paths were redacted from unpublished history before the first push. Media, recordings, build outputs and runtime credentials are excluded from Git.

GitHub CI/CD is disabled by request. Run typecheck, lint and tests locally. Before pushing, run `npm run preflight:public` from a clean working tree. See [evidence scope and privacy](docs/evidence/README.md).

## Run locally

Use Node 22.23 or another version supported by `package.json`, an Android SDK, and JDK 21.

```sh
npm ci
npm test
npm run typecheck
npm run lint
# Trusted private network only; default without this variable is loopback.
FOOTAGE_HOST=0.0.0.0 npm run server
```

The receiver uses port 1080 and stores data in `apps/server/data/`. Permit the firewall connection only on your trusted network. In Footage's settings, enter `http://<computer-LAN-IP>:1080`. The phone must reach that address; its own `127.0.0.1` is not your computer unless an ADB reverse is installed.

### Standalone demo APK

```sh
npm run android:demo
adb devices -l
adb -s <device-serial> install -r artifacts/footage-demo.apk
```

Open **Footage** normally. This ARM64, release-mode **local-demo** APK embeds JavaScript, fonts and imagery. It does **not** require Metro. It uses development signing, not a store/distribution key. The build script discovers common SDK/JDK locations; set `ANDROID_HOME` and `JAVA_HOME` if needed.

HTTP is enabled for the local demo, but native origin validation refuses public cleartext hosts and malformed origins before sending a capability. Use a private LAN IP for HTTP, or trusted HTTPS elsewhere. This does not turn the receiver into an internet-ready service. Do not expose it publicly.

### Development client

```sh
npm run android:build
adb -s <device-serial> install -r artifacts/footage-spike-debug.apk
npm run mobile -- --dev-client
```

Only this development APK requires Metro. Expo Go cannot load the Kotlin module. For USB setup, reverse ports 8081 and 1080 and use `http://127.0.0.1:1080`; that route is not Wi-Fi evidence. Generated Android files come from Expo prebuild; custom native code stays in `apps/mobile/modules/footage-transfer/`.

### iOS Simulator — native paired uploads

```sh
npm run ios:build
xcrun simctl install <simulator-UUID> artifacts/ios-simulator/Footage.app
xcrun simctl launch <simulator-UUID> dev.footage.spike
```

The ad-hoc-signed Release `.app` embeds JS/assets and needs no Metro. It is Simulator-only, not a physical iPhone distribution build. Follow [Connect a Mac](docs/RUN.md#connect-a-mac), then use the normal Upload original action. The paired receiver currently admits up to 1 GiB, subject to quota/disk. Private LAN denial, physical protection and Android paired-KeyStore execution still need device-scoped acceptance; no production reliability claim is made.

## Try the flow

1. Configure your receiver, then choose a video with the system picker.
2. Review the filename, size, available duration/resolution and local preview. The labeled Sintel sample still on the empty screen is never selected or uploaded.
3. Confirm **Upload original**. Only now does the native owner save and hash a stable app-owned copy. Keep the app open during preparation. If scheduling was interrupted, use **Continue upload**.
4. Progress reflects receiver-confirmed bytes, not bytes written to a socket. Waiting retains the job and reconciles the server offset before resuming.
5. **Checking your clip** is not success. **Original verified** requires a matching job, full byte length, SHA-256 and server receipt.
6. Open **View received file** to play a supported original or download its unchanged bytes. Sharing mints a single-use link redeemable for two minutes. Anyone holding it can redeem it; the resulting read-only session lasts ten minutes.

Preview support depends on device/browser codecs. Missing metadata or failed preview does not imply the original cannot be transferred. Byte verification does not establish HDR display fidelity.

## What was actually tested

See [the finish evidence](docs/evidence/mobile-finish.md) and [the full evidence matrix](docs/evidence/spike-status.md).

- **Current local checks:** receiver, codec, pairing and explicit T3 contract-fixture tests; shared presentation/device contracts; native runtime fault tests; typecheck and lint. See the current build evidence for exact counts. The T3 contract fixture is not a live-account send.
- **Normal 0.5 iPhone app:** real connection-file picker/confirmation and native enrollment, upload/receipt, independent receiving hash, a second upload retaining the first original, cold relaunch, and read-only pinned viewer. Background OS-wake tests use the same engine in the separately scoped paired Expo acceptance build.
- **Historical version-scoped checks:**
- **API 36 emulator:** actual system picker, metadata, native preparation/upload, first-run notification consent, matching receipt, and standalone launch with Metro stopped. A real transport-proxy interruption resumed the same upload identity. This is not physical Wi-Fi or power-state evidence.
- **Historical iOS 27.1 preview build:** real Files picker/AVKit preview and metadata, neutral picker cancellation, themes and Accessibility Large. This record predates the 0.5 native uploader.
- **Real Chromium:** authenticated original decoded, played, sought and downloaded; actual byte ranges and matching independent SHA-256 checked. Mobile browser emulation is not Safari or physical-phone proof.
- **Historical physical Samsung, Android 13:** Home, USB route loss/recovery, real Wi-Fi loss/recovery, and a 350.8-second continuous screen-off AOD transfer with power saving on passed under the recorded conditions. The earlier failed stress runs remain failures. See [receiver fix](docs/evidence/receiver-disconnect-fix.md) and [screen-off fix](docs/evidence/android13-screen-wifi.md).

The earlier physical results belong to their diagnostic binary. A subsequent [final-APK Samsung check](docs/evidence/android13-final-device.md) verified the preceding version 0.2 standalone build: real upload/receipt integrity, Home, actual WLAN loss/same-job recovery, 226.5 seconds of continuous powered AOD, visible cancellation/resource release and the native viewer page. The installed APK hash matched. Original network/power flags were restored and no transfer resources remained. The version 0.3 UI removes repeated demo/debug text and moves limitations and receipt details out of the main flow. Its DJI recording and evidence are separate from the preceding lifecycle suite. Real 4K HEVC preview and original-byte integrity are now exercised with the explicitly supplied 386,918,637-byte file. Unplugged execution, deep Doze, TalkBack, cellular switching, HDR/colour fidelity and measured media-memory behavior remain unverified. No general background-reliability or production-readiness claim is made.

## Architecture

- `apps/mobile/src/app/`: one Expo Router route; no tabs or editor.
- `apps/mobile/src/features/intake/`: controller, pure presentation, preview, settings and screening-room view.
- `apps/mobile/modules/footage-transfer/android/`: metadata, stable staging, streaming SHA-256, AtomicFile job state, tus Java client and native scheduling.
- `apps/server/src/`: maintained `@tus/server` 2.4.6 / disk store 2.1.1, SQLite outcomes, serialized mutation and streaming verification.
- `apps/server/src/{viewer-access,viewer-page,content}.ts`: bounded read-only viewer grants/sessions, private screening room and authenticated ranges.

Original capabilities stay native. Browser links contain only short-lived exchange codes, removed from history before session exchange. Viewer sessions use HttpOnly, SameSite=Strict cookies (Secure under TLS), cannot mutate uploads, and do not hold upload locks while streaming playback. See [viewer architecture](docs/architecture/receiver-viewer.md) and [mobile decisions](docs/architecture/mobile-finish.md).

API 26–33 uses a foreground service with a bounded CPU wake lock and, when starting on Wi-Fi, an API-appropriate Wi-Fi lock. Work ending, cancellation or a 30-minute attempt-window expiry releases resources. Expiry preserves the job for explicit continuation; that branch is not hardware-tested. API 34+ uses a user-initiated transfer job, exercised on the API 36 emulator, not hardware. Notification-drawer visibility depends on permission. No automatic force-stop/process-death recovery is promised.

Cancellation retains cleanup-pending status when deletion is not confirmed. Server commit may win a cancellation race; an existing verified receipt is not revoked by Cancel. Received-artifact deletion and automatic retention are not implemented.

Run one receiver process per data directory. The legacy Android spike has open private-network registration. The explicit paired receiver uses HTTPS, app-scoped independent trust and local operator approval; it admits up to 1 GiB, within the existing 20-job/8-GiB budgets. The binary 4-GiB ceiling is not an admission guarantee. Neither receiver is advertised as an internet-ready production service. Never publish capability headers, native private storage or authenticated requests.

## Reproduce checks

```sh
npm test
npm run typecheck
npm run lint
# After prebuild, with JAVA_HOME and ANDROID_HOME configured:
apps/mobile/android/gradlew -p apps/mobile/android \
  :footage-transfer:testDebugUnitTest :footage-transfer:lintDebug
```

Device/browser runners and qualifications are in [finish evidence](docs/evidence/mobile-finish.md). The older physical stress instructions remain in [screen-off evidence](docs/evidence/android13-screen-wifi.md). They use generated fixtures, never bypass keyguard, and must restore network/power settings. Do not infer cleanup after externally killing a runner.

Upstream Expo development-tooling advisories remain; no incompatible major override was forced. Node 22 SQLite emits an experimental warning. No public backend or store build has been released, and no application has been submitted. The [authoritative plan](../Cardboard_MVP_Plan.md) still leaves the physical lifecycle gate open.

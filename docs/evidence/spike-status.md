# Transfer spike evidence

Recorded 29 October 2026; updated after the screening-room implementation. This is still not a completed physical lifecycle gate.

## Screening-room finish

The selected UI, local video preview, native duration/resolution metadata, standalone APK and secure receiving-side player are implemented. [Finish evidence](mobile-finish.md) separates API 36 emulator/native checks and real browser playback from the historical physical runs below. The new standalone APK has since passed the [scoped physical Samsung follow-up](android13-final-device.md), including powered WLAN recovery/AOD and cancellation. Unplugged/deep-Doze coverage is still open. The historical physical artifact is preserved in [artifact-before-ui-finish.json](artifact-before-ui-finish.json).

## What passed locally

- Twenty-six integration tests exercise the actual Node HTTP receiver, maintained tus implementation and read-only viewer. The earlier 15-test transport log remains [server-tests.tap](server-tests.tap); current combined checks are in the finish evidence.
- Seventeen mobile contract/presentation tests validate receipt matching, preparation, waiting, cleanup and actionable failure states. Two native JVM tests validate receiver-origin safety.
- Exact received bytes and SHA-256 match the fixture, and authenticated download returns those bytes.
- A partial upload resumes after receiver restart from its HEAD offset. This interrupts between completed PATCH requests, not a proven physical-phone disconnect mid-request.
- Repeated registration does not truncate a partial upload.
- Receipt completion is repeatable, including after restart.
- Incomplete and mismatched files cannot produce a receipt or download.
- Cancellation persists across restart and blocks late writes and completion.
- A concurrent cancellation/completion request pair results in one durable outcome.
- A cancellation tombstone before registration blocks a delayed registration.
- Missing and incorrect capabilities are rejected.
- Malformed and oversized metadata is rejected.
- The tus Java client's HTTP-method-override fallback reaches the same handler.
- Aborting content-length and chunked PATCH bodies preserves the prefix and permits resume.
- An abandoned HEAD queued behind a PATCH cannot deadlock subsequent requests. These regressions failed before the [receiver fix](receiver-disconnect-fix.md) and pass afterward.
- Two device-tool tests check the real streaming limiter's bytes, headers, control responses, and abort propagation. Run `npm run test:device-tools`.
- TypeScript checks pass for receiver and mobile app. Expo ESLint passes.
- Android debug compilation passes, including the local Kotlin module.
- Android native lint reports zero errors and four warnings: a conservative usable-space check and three KTX style suggestions. The lint task is configured to fail on errors.
- The debug APK's signature verifies. See [artifact.json](artifact.json) for its recorded hash.
- Expo's Android JavaScript/Hermes export succeeds. This checks bundling, not launch or rendering.

Reproduce the automated checks from the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run lint
bash scripts/build-android.sh
```

Native lint can be rerun with `JAVA_HOME` and `ANDROID_HOME` set:

```sh
apps/mobile/android/gradlew -p apps/mobile/android :footage-transfer:lintDebug
```

## Physical Android 13 results

The installed development app runs on Samsung SM-N981U1, Android 13/API 33. Its native foreground-service path was observed with a notification. Notification-drawer visibility depends on Android permission. Android 14+ UIDT has since been exercised on the API 36 emulator, not physical hardware.

A generated 60-second, 1280×720 H.264/AAC clip contains 299,779,969 bytes. The source copied onto the phone, staged native original, received file, and receipt all have SHA-256 `297f52087a50b9e741bb007ea66b8b1ef46ee3b45fa652f557392bc441d694da`. No personal footage was selected.

Passed observations:

- App launch, native bridge, system picker, review, and confirmed native preparation.
- Actual phone-to-receiver transfer over ADB USB reverse.
- Server bytes continued increasing after pressing Home, with the foreground service observed.
- Disconnecting the actual USB transport caused the native owner to enter waiting.
- Restoring the route resumed the same upload identity from server progress.
- After the route was restored, server bytes increased while the same phone reported non-interactive Samsung AOD `Dozing`.
- Both sides published the same receipt after completion. An independent read of the received file confirmed its length and hash.
- The native start promise now resolves in JavaScript. The previous false UI error was reproduced before enforcing an explicit `Unit` result and checking the real UI afterward.

[The current device record](android13-usb.json) combines the Home/disconnect trace and the continuation of that same job. The job is `463a57a8-a1a1-4411-bd97-01933dfc1657`, with receipt `a4e71403-07ae-49f2-8065-9916e2656088`. The [dedicated screen trace](android13-screen.json) records non-interactive state before and after observed server growth. The [earlier record](android13-usb-before-screen.json) retains the original failed screen assertion.

Removing a reverse listener did not break an already pooled connection, so the next run disconnected the actual USB transport. The original screen assertion expected `Asleep`, but Samsung AOD reports `Dozing`. A corrected dedicated test then passed, with server bytes increasing while `Dozing` was observed. This is non-interactive AOD evidence, not deep Doze evidence.

A later USB reconnect required renewed authorization and paused the test runner. After the user authorized it, the screen test inspected the existing native job in waiting state, restored forwarding, and completed that same upload without creating a fresh identity. The paused run is retained in the current record rather than described as an uninterrupted automated pass. No lock bypass was attempted.

The native start-command regression was separate. Its implicit Kotlin lambda result exposed `ComponentName` to Expo after the service started, producing a false JavaScript error. An explicit `fun(): Unit` command result prevents that object from crossing the boundary. [Before/after device evidence](android13-start-command.json) includes the failed acknowledgment check and the subsequent resolved promise with a verified receipt.

These results apply to a USB-connected, powered phone and generated media. They do not establish Wi-Fi, cellular, unplugged execution, deep Doze, or universal background reliability.

## Real Wi-Fi follow-up

The [Wi-Fi recovery record](android13-wifi-recovery.json) preserves a real receiver failure and the fix. During actual Wi-Fi loss with cellular disabled, Android waited correctly but the original receiver deadlocked. Local tests reproduced both an aborted PATCH and an abandoned queued HEAD blocking later requests. The receiver now skips disconnected queued requests and awaits tus storage work without waiting for response delivery to a destroyed socket.

After deployment, the same existing upload resumed. A second controlled Wi-Fi loss under the fixed receiver entered waiting and resumed under the same ID without another server restart. The receiver TCP peer matched the phone's Wi-Fi address, and no USB upload forward was present. Bytes also advanced during non-interactive AOD. The original generated clip eventually completed with matching hashes and receipts.

The extended run later hit its no-progress deadline and finished after wake/settings restoration. A shorter repeat reached the same interruption/recovery observations but was terminated by the outer runner deadline, then completed afterward. Neither historical full stress scenario is counted as passed. Network flags were checked afterward as Wi-Fi enabled and cellular enabled, matching their original state.

## Screen-off execution-resource fix

The [later phone-side test](android13-screen-wifi.md) reproduced the screen-off stall using a streaming-limited real Wi-Fi upload with power saving enabled. A partial CPU wake lock alone did not fix the uninterrupted repeat. The foreground service now also owns a high-performance Wi-Fi lock on the tested API 33 path.

The same retained generated-clip job then reached a verified receipt after 350.8 seconds of continuous non-interactive AOD. No phone polling occurred during that quiet interval, and the OS last-wake timestamp was unchanged through receipt. The native owner retried two socket timeouts without a screen wake. Independent source/received hashes and both receipts agreed, and both wake locks were released after completion.

A separate visible cancellation test acquired both locks, cancelled through the real UI, released both locks, confirmed server cleanup, and issued no receipt. Original network and power-saving flags were restored. No global battery exemption was applied. This does not establish offline cancellation.

The service has a 30-minute attempt window and preserves progress for explicit continuation after expiry. That expiry branch is implemented but not yet hardware-tested. The API 34+ scheduling candidate is unchanged.

## Coverage and remaining checks

| Scenario | State | Reason |
| --- | --- | --- |
| Personal camera-video intake | Untested | Generated test clip only |
| Extended screen-off Wi-Fi reliability | Limited physical pass | 350.8 seconds of continuous AOD with power saving enabled and a generated fixture; larger-duration and unplugged cases remain open |
| Cellular transfer and switching | Untested | Cellular was disabled to prevent fallback during Wi-Fi loss |
| Unplugged background execution | Untested | Phone remained USB-connected and powered |
| Process death and relaunch | Untested | No device run |
| Phone offline cancellation and cleanup retry | Untested | No device run |
| 4K file memory behavior | Untested | No real footage or device measurement |
| HDR byte transfer and preview fidelity | Untested | No supported sample or device run |
| iOS Simulator preview/UI | Pass on iOS27.1 | Actual system picker, moving video, real metadata, cancellation, appearance and enlarged text; [evidence](ios-simulator.md) |
| Physical iPhone or iOS transfer | Not implemented / unverified | iOS build is preview-only; no native upload engine |
| Lost write response after a successful server write | Untested | Aborted mid-body PATCH recovery is tested; ambiguous completed-write response injection remains pending |
| Video playback at the receiving side | Browser pass | Actual original decoded/played/sought/downloaded with ranges and matching hash; browser/device codec support is not universal |
| Finished UI, accessibility, and motion | Implemented; emulator checks | Dark/light UI, small width and enlarged text inspected; actual TalkBack/physical-device verification remains open |

The first build had no device; later physical runs used the authorized Samsung and its API 33 foreground-service path. The final standalone APK has since been installed and tested on that same physical phone; see the separate follow-up. Emulator checks remain distinct evidence.

## Implementation choices

The receiver uses `@tus/server` 2.4.6 and `@tus/file-store` 2.1.1 in one Node process, with SQLite job and receipt persistence. This replaces the proposed tusd sidecar candidate to avoid coordinating receipt and cancellation state across backend processes. It is still the maintained tus protocol, not a new resumable protocol.

Android uses `tus-java-client` 0.5.1 and a local Expo module. API 26 through 33 use a foreground data-sync service started while the activity is visible. It publishes a notification, updates confirmed progress, and stops after the native owner finishes. The foreground service owns bounded CPU and Wi-Fi wake resources rather than relying on its notification to keep execution active. Cancellation stops the service, releases those resources, and retains cleanup state. API 34+ retains the user-initiated transfer-job candidate. The actual observed path is the foreground service on API 33.

The native single-job store uses `AtomicFile` with serialized updates and typed phases. It persists the staged asset before scheduling and keeps capability material out of JavaScript snapshots. Preparation is performed only after confirmation. JavaScript issues commands and polls snapshots; it does not transfer video bytes.

The separate debug APK requires Metro. `artifacts/footage-demo.apk` is a standalone release-mode local-demo build with development signing and native public-HTTP origin rejection. No public backend is deployed, and no application has been submitted.

## Known limitations and follow-up

- Repeat screen-off tests with larger files and unplugged power before claiming broad background reliability. Deep Doze and the 30-minute expiry branch remain open.
- The finished UI now has a scoped physical Samsung pass. TalkBack, unplugged execution and deep Doze still need verification before closing the full lifecycle gate.
- Received-artifact deletion and automatic retention are not implemented. Cancelling after commit returns the existing receipt rather than pretending it was revoked.
- The receiver is private-network development software. Open registration, HTTP, in-process locking, and fixed demo quotas are not a public service design.
- SQLite in the Node 22 runtime emits an experimental warning.
- `npm audit` reports eight upstream Expo tooling advisories: three high and five low, including transitive effects. The direct receiver Zod dependency was updated to patched 4.6.7. Expo's Zod 3 dependency was not forcibly replaced by an incompatible major version. Do not expose Metro or the spike receiver publicly.

The record supports the specific Android 13 Home, USB-recovery, non-interactive AOD, start-command, qualified real Wi-Fi recovery, continuous screen-off Wi-Fi transfer, and visible cancellation observations above. It does not support a general background-reliability, memory-bound, upload-speed, customer-outcome, or production-readiness claim.

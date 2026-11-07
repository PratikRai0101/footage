# Expo 58 owned-session routing and paired OS completion

## Result

**The reproduced outer-completion ownership defect is fixed. Production upload activation remains NO-GO.** Two fresh actual Expo runs each completed two OS-driven background launches/event batches without JS. Every batch invoked the real UIKit outer completion once on main, after Footage's durable ledger processing. The final batch verified the common G3 receipt for **67,121,209 original bytes in two presealed groups**, with an independent receiving hash match.

The current proof uses production `PairingClient`, `PairingBackgroundControl`, `PairingBackgroundTrust`, `BackgroundRuntime`, macOS `DesktopKeyStore`, and `PairedService`. It does not use the old synthetic control mailbox. Independent local test-controller QR delivery and explicit local approval authorize the generated test device. These are test-only substitutes for scanner/operator UX, not automatic production trust.

The slow-control event-queue blocker is fixed. Remote status and revoke now run on a bounded native control lane, separate from durable local reconciliation and delegate drain. Held-control native tests and an actual paired Expo two-wake run prove completion while control is still pending. The controlled OS test uses an explicit, test-only startup-ordering rendezvous described below. It is not proof of every natural launch ordering or the full G5 gate. `g5Passed` remains false. The ordinary iPhone app still exposes only the approved picker/local preview.

Implementation: `e852a3c`. Paired OS acceptance tests: `4d8f874`. Parent runtime enumeration fix: `f01abe9`.

## App-owned dispatch contract

`apps/mobile/plugins/withFootageBackgroundSession.cjs`, registered in `apps/mobile/app.json`, uses Expo's standard `withAppDelegate` mod. Clean prebuild generates this dispatch before Expo's subscriber aggregation:

```swift
if FootageBackgroundSessionRouter.handle(identifier, completionHandler: completionHandler) {
  return
}
super.application(application, handleEventsForBackgroundURLSession: identifier, completionHandler: completionHandler)
```

- The public, main-actor `FootageBackgroundSessionRouter` accepts only exact equality with the native stable identifier, `footage.sealed.background.v1`. It does not infer ownership from UUIDs or prefixes.
- The owned event goes to `NativeBackgroundHost.shared`, then the same retained `BackgroundRuntime`. Each supplied completion retains its own `NativeBackgroundCompletion` main-actor once-token. No system completion runs before the runtime's ordered durable drain, except safe deferral when no authorized runtime can open.
- Every other identifier returns false without consuming the completion or opening native storage. AppDelegate forwards the original identifier, application, and completion unchanged to `super`.
- `FootageTransferAppDelegateSubscriber` still initializes the host before React, observes native activity, and handles protected-data notifications. It no longer implements the background-session callback. There is no second delivery path through Expo.
- The plugin accepts the exact locked Expo 58.0.21 Footage AppDelegate template or its exact routed output. Repeated application is byte-identical. Unknown language, template drift, altered routing, or duplicate output throws a clear ownership-review error. Upgrades cannot silently drop this route.

This is application dispatch, not a dependency ownership patch. No installed Expo source changed. No filesystem finish notification, timeout-based `finishedEvents`, private API, or extra URLSession owner was added.

### Why the owned callback bypasses aggregation

The installed `ExpoAppDelegateSubscriberManager` broadcasts this event to every responding subscriber and waits for every contribution. `FileSystemBackgroundSessionHandler` retains every identifier, including foreign Footage sessions. Its `BackgroundSessionCompletion` requires its own `finishedEvents` even after deadline expiry. Filesystem never receives that event for Footage's session.

The old actual-app builds reached a genuine receipt but never called the outer completion. `ExpoAggregationProbe.swift` still reproduces this installed bookkeeping behavior. Its artificial finish is unit-only and is not OS evidence. The route prevents the Footage-owned event from entering that bookkeeping at all. Unrelated sessions retain Expo's existing behavior unchanged.

The separate runtime enumeration race is **already fixed by the parent**. `f01abe9` clears `enumerating` before the deferred drain recheck on both successful and failed reconciliation. Both deterministic native regressions pass. The Expo probe now asserts the race is absent and needs no extra finish event. That routing-only change did not edit the runtime, codec, pairing client, or production paired service. The later nonblocking runtime change is described below.

## Ordinary app and compile-time assembly

`NativeBackgroundInstallation.makeRuntime(activity:)` remains the native installation seam. Normal Release returns no installation. Missing native authority or protected storage never creates a replacement job, empty ledger, guessed destination, or foreground uploader. Native discovery reports `supportsTransfer: false`; upload commands remain closed. JS/UI, Android contracts, and picker/preview sources are unchanged.

The actual ordinary Release executable contains the public router and subscriber but no fixture, test waiter, generated original, or mailbox adapter symbols. Embedded JS/assets run without Metro. Destination-scoped XCTest verifies **Preview only**, no **Upload original**, opening/cancelling the real document picker, and return to the preview-only screen. This is not a newly selected-video playback or physical-device test.

`FOOTAGE_EXPO_LIFECYCLE_TEST=1 pod install` adds only the ignored generated fixture source, itself guarded by the matching Swift compilation condition. The separate test Xcode build sets that condition. No ordinary Release launch argument, file, URL, or environment lookup enables test authority. Test-only files select actions only in the fixture binary.

The fixture uses the native assembly seam to enroll and recover through G1, explicitly confirm the generated standalone intake, and construct real paired control/trust. After setup freezes job authority, it deletes only its current native installation. Both cold wakes restore the saved job authority, not current pairing or protected display metadata. The fixture reuses the existing paired test controller and native test helpers. It adds no transport, decryptor, master minting, or receipt authority.

The test SceneDelegate deliberately does not start React. The actual Expo AppDelegate, factory construction, module loader/provider, registration, and lifecycle forwarding remain. This is a compile-time no-JS assembly, not a claim that an unmodified ordinary foreground launch suppresses React. Generated files and normal Pods configuration are restored, followed by an ordinary Release rebuild and binary inspection.

## OS-driven paired acceptance

Earlier routing-only evidence: `artifacts/expo-background-lifecycle/92a1cc9e-17b6-49c6-b55f-c6566439c59a/safe-summary.json`.

Independent earlier successful run: `artifacts/expo-background-lifecycle/d99c63fb-ee4e-47f0-95b7-ff21d9989812/safe-summary.json`.

Each run creates its own iPhone 16 Simulator on iOS 26.2 and one recorded, fresh macOS test Keychain account. The measured sequence is:

1. Clean Expo prebuild preserves the committed router. A second prebuild produces identical AppDelegate bytes. Generated ordinary/test providers each contain the module and early subscriber in both provider branches.
2. Ordinary Release passes the actual picker/preview-only XCTest. The separately built fixture app creates no JS bridge.
3. Native generates its own signing key, enrolls over independently authenticated TLS using the locally supplied QR, receives explicit local approval, and exercises challenge/recovery. No native installed credential is injected.
4. While active and unlocked, the real native owner stages/hashes the generated original, performs paired setup, fully seals two groups, and durably schedules both file-backed tasks. The fixture then denies POSIX access to `runtime/private` and verifies an actual manifest read fails before backgrounding.
5. Destination-scoped XCTest presses Home. The runner SIGKILLs only its owned app PID. It observes the owned Simulator's `nsurlsessiond` socket before releasing the first group. It never activates the app or invokes the measured callback.
6. iOS launches another process and delivers the owned session through generated AppDelegate routing. The runtime opens before JS. At completion, an independent SQLite ledger reopen records **67,108,864 confirmed original bytes**, no receipt, and one native completion on main.
7. The AppDelegate wrapper observes the actual UIKit-supplied outer completion. It records one invocation on main with that already-written durable-ledger observation, then calls UIKit's handler. The runner requires the outer record before releasing another group. Missing outer completion now fails, rather than becoming a successful observation of absence.
8. The runner SIGKILLs that OS-launched process and releases the second group. Production G3 assembles/hash-verifies the original and publishes the existing common `Jobs` receipt. iOS launches a third distinct process and delivers the second event batch without JS.
9. At the second outer completion, the independently reopened ledger is **received**, has the saved authenticated receipt, and confirms all **67,121,209** bytes. The runner checks native receipt ID, job, size, and SHA-256 against the one actual `Jobs` receipt and an independent hash of the receiving original. Both native and outer counts equal one for this batch.
10. The manifest remains permission-denied. A later explicitly labelled no-JS native relaunch reopens the same receipt. That explicit relaunch is not counted as an OS wake.

The two latest outer records are `first-os-aggregate.json` and `os-aggregate-completion.json`. The legacy filename says aggregate, but these now witness the actual outer UIKit completion through the owned direct route, **not an Expo subscriber aggregate**. The wrapper decorates the real callback in generated AppDelegate. It never invokes the subscriber, simulates an OS event, or substitutes for runtime drain.

Both wire hashes match the exact saved native packets. Ingest sees zero Authorization and Cookie headers. Streaming scans find neither the enrolled reusable credential nor the generation master in binary or hexadecimal form. The receiver stores one job with one shared receipt. Network response gates are test-only options on the existing paired test controller; production authentication, ingest, supervision, and finality remain unchanged.

The latest callback-entry-to-outer observations are about 0.0095 and 0.0072 seconds. They cover fast local event drain **after callback entry**, not cold-launch duration, network deadlines, or an OS execution guarantee. The runner rejects a recorded callback interval of 10 seconds or more, but that check does not bound startup work before callback entry.

**SIGKILL is an abrupt process-exit experiment, not natural jetsam, screen lock, or user force-quit.** Simulator permission denial is not physical data protection. No automatic restart guarantee follows for user force-quit, another OS, or another device. First-unlock/reboot and daemon-owned file protection remain unproved.

## Failure and ownership acceptance tests

The nine actual-app host cases cover exact-ID routing, untouched foreign identifiers, one early runtime, distinct completion tokens, duplicate and late completion attempts, another batch, protected open failure, protected-data retry, and missing backend.

The protected-open case denies access at a real native file-read boundary. The host stays blocked, completes its owned token as deferred, and retains the exact pre-event bytes. The runtime unavailable-control unit test removes task availability and makes control fail immediately. Independent ledger reopen requires uncertain task mappings, zero confirmed bytes, and no receipt before completion. It drains in less than the test's five-second assertion. These artificial unit callbacks are not included in OS counts.

### Nonblocking control reconciliation

The original `restoreAndStart -> reconcile -> query` and `cancel -> query` paths called synchronous paired control on the event owner. The adapter's 35-second wait blocked completion registration, delegate events and the enumeration/drain recheck. The first gated production-runtime regression failed at a bounded drain timeout before the fix. Its ignored result is `artifacts/ios-background-runtime/7eeafdb0-6de6-45ee-8341-0e384dced92d/safe-summary.json`.

`BackgroundRuntime` now confines its adapter to `BackgroundControlWorker`. Only that separate serial lane executes remote status and revoke. Before dispatch, the native event owner commits missing-task uncertainty or local cancellation with its stable revoke operation ID. It validates and copies immutable `OutcomeContext` and a fresh `Query` to the worker. No ledger, daemon, private manifest or verification key crosses to that worker.

`enumerating` fences only local task reconciliation. The existing deferred clear-and-drain ordering remains. Actual native events, their FULL/WAL transactions, token registration and `didFinishEvents` continue while the control socket waits. The host and router never complete early on the runtime's behalf.

Remote results return to the serialized owner. It checks the current outcome binding, current revision and accepted bitmap, exact query authentication and current cancel fence. A late uploading status cannot undo cancel. A matching immutable final receipt can win. A later event prevents the old request from clearing new uncertainty or authorizing task creation. Successful uploading reconciliation enumerates tasks again before scheduling, with the same event-generation fence. No remote result calls OS completion.

Admission is bounded to one control request, one restore command and one cancel command. Cancel can wait behind status in one pending slot. Repeated commands receive `false`, rather than accumulating requests, callbacks or enumerations. Requests never run in parallel. Network failure and missing protected authority retain the same durable job and uncertainty. Reopening does not depend on a pending socket having finished.

Public command callbacks retain their meaning: restore completes after its accepted reconciliation command, including any remote result and subsequent local scheduling pass, not on receipt. Cancel reports its remote reconciliation result; `false` can coexist with a durably saved local cancel. The host ignores these command results and drains UIKit through the separate durable event contract. No callback was changed to report fake handoff success.

Foreground `prepare` still requires a native worker and active/unlocked eligibility. Staging and sealing retain serialized ledger mutation. Its remote setup wait now runs outside the event queue too. A cancel during setup persists a blocked tombstone before stopping tasks. A late valid setup reply saves the same job's recovery authority, but cannot seal or schedule across cancel. There is no new background assertion or weaker plaintext protection.

The native suite now has **50 passing cases: all 39 existing cases and 11 additions**. The additions hold status, revoke and foreground setup; require once/main/durable drain before release; process real authenticated acks during held status; reject a reply below the current high-water; fence late uploading status; accept a matching final receipt; bound repeated commands; test duplicate finish and another callback after drain; and reopen actual SQLite state after network error or owner loss with status/revoke still pending. Reopen tests observe the real ledger lock release, not just weak-reference clearing. Native counts are behavior tests, not source assertions.

### Actual paired held-response OS proof

The flagged `--two-wakes --slow-control` test retains production `PairingClient`, `PairingBackgroundControl`, `PairedService`, OS wrapping and the real daemon session. Only the existing test listener has a new explicit fault gate. It authenticates and computes a real status response, then withholds that TLS response until the independent local runner releases it. Production service routes, crypto, deadlines and admission bounds are unchanged.

The cold fixture marks its existing task mappings uncertain before opening the sole runtime, preserving job, generation, packets, correlations and accepted ranges. A fixture-only early `restoreAndStart` rendezvous waits at most three seconds for the listener's actual pending-socket observation before returning the installation to the actual host. This controls launch ordering, not completion: it neither invokes an OS callback nor supplies a finish event, and the production host has no such wait. Native events can already drain during this rendezvous.

This explicit seam matters. An earlier run without it (`90723986-8e7f-4449-8143-049f78a7e28d`) naturally completed UIKit while the TLS response was held for about 0.152 seconds. Other attempts completed local processing before TLS establishment reached the listener. Those attempts failed the stronger held-socket assertion; they are not relabelled passes. The controlled run proves the actual host with already-pending native control, not a guarantee about every unmodified cold-launch ordering.

In the controlled run, startup control and the authenticated held socket precede the actual owned AppDelegate callback. UIKit's real outer handler returns once on main after an independent ledger reopen shows 67,108,864 confirmed bytes, no receipt and one still-uncertain group. The paired adapter has not returned. The runner keeps the response held for another ten seconds and verifies there is no second completion. It then kills only that OS-launched process before releasing control. A second actual OS wake processes the other group and saves the same G3 receipt for 67,121,209 bytes, independently hash-matched at the receiver. A separately labelled explicit native relaunch reopens that receipt.

Latest completed evidence: `artifacts/expo-background-lifecycle/ef21f1e7-035b-4738-ab5c-21cebd4abfdd/safe-summary.json`. The held TLS response lasted **10.126 seconds**. The two actual outer completions took **0.00530 and 0.00673 seconds** from callback entry, each once on main. Native control start to the first durable completion was 0.08692 seconds; the test-only startup rendezvous took 0.04683 seconds. Receipt `caebe541-eb68-43be-ae2b-ca9d75c79574` matches job `6de3b657-2067-492a-8684-a48f643adef6`, 67,121,209 bytes and SHA-256 `32c2fa179eb7182bcaf5b962937ba22912d0862c95c624fa119471ee466cca4a`. Independent receiver hashing agrees.

There is no mailbox, synthetic progress, timer-based completion, foreground upload or force-quit restart promise. Simulator SIGKILL, permission denial and this controlled startup seam do not pass natural jetsam, physical protection or all G5 scheduling conditions.

## Build fingerprints and checks

Xcode **27.2 / 27B52**, iPhoneSimulator 27.2 SDK, owned iOS 26.2 Simulator. Installed locked versions are `expo@58.0.21`, `expo-modules-core@58.0.28`, and `expo-file-system@58.0.13`.

Latest build-scoped SHA-256 values are not reproducible-build guarantees:

| Artifact | SHA-256 |
| --- | --- |
| Ordinary Release before test | `4193de9d86396fd33e4402b3133398dc34e6d6b8ea0d99a18ab9c0433a655665` |
| Compile-time test Release | `7b5da6a5f8c9e3375df450df14cfad6f19e8a26bb9c11fe0fb22a5bbe5337f02` |
| Restored ordinary Release | `4193de9d86396fd33e4402b3133398dc34e6d6b8ea0d99a18ab9c0433a655665` |
| Embedded JS | `af858981e958695c0a4fd4b4208ea4e5beac1f75571cb03b95eb2361eb4c012d` |
| Generated routed AppDelegate | `487f1da45ce81e0b7189205315bb39f3d80dfbfe411fdee8d50e2be322fc8864` |
| Paired test controller with explicit held-control gate | `436b607f932d6fb7c51db68557a6a083cb0d23904930873c62de957850b73376` |

Executed checks:

```sh
FOOTAGE_TEST_KEYCHAIN=1 python3 scripts/test/expo-background-lifecycle/run.py --two-wakes --slow-control
node --test scripts/test/expo-background-lifecycle/plugin.test.cjs
python3 scripts/test/ios-background-runtime/run.py --unit-only
FOOTAGE_TEST_KEYCHAIN=1 npm test
npm run typecheck
npm run lint
npx --no-install tsc -p scripts/paired-background-integration/tsconfig.json
python3 -m py_compile scripts/test/expo-background-lifecycle/run.py
node --check scripts/paired-background-integration/listener.mjs
git diff --check
python3 scripts/public-repo-preflight.py
```

- Two complete paired Expo runs pass the required actual outer completion checks, including ordinary, test, and restored ordinary Release builds. No build warning is suppressed.
- All **50 native runtime cases** pass in a fresh owned Simulator, including all 39 existing cases and both parent enumeration regressions. Latest result: `artifacts/ios-background-runtime/a5f75e35-687e-4018-992f-5d89baf1b54b/safe-summary.json`. Combined production pairing, codec and background sources also compile for iPhoneOS with Swift 6 warnings as errors.
- All **105 root cases pass with the real-Keychain test opted in**, with no skips. Typecheck, lint and paired test-controller typecheck pass. The root Keychain test now records its exact fresh namespace before initialization and retains cleanup metadata if deletion fails. No pending cleanup metadata remains from these runs.
- Three plugin tests pass against the actual installed Expo template. They reject unknown/altered source and ensure the subscriber has no second background-session method.
- The public-history preflight and whitespace checks pass after the commits. Private artifacts remain ignored.

This task uses only its own `artifacts/expo-background-lifecycle/owned-build-control-7c12d930` incremental cache. The runner checks disk before and after builds and requires a six-GiB margin. Ordinary, test and restored ordinary `.app` copies and hashes are preserved in each completed run. Free disk is approximately 15 GiB at wrap-up. No other checkout's build outputs were deleted.

Each fresh macOS account is written to ignored exact-account cleanup metadata **before initialization**. Deletion is registered before any later constructor and runs even if listener shutdown fails. Metadata is removed only after exact deletion succeeds. Both runs report exact deletion, owned listener shutdown, owned Simulator deletion, and no cleanup errors. Native test items live only in the recorded disposable Simulator, which is deleted. The six old accounts without retained IDs remain unresolved. No Keychain enumeration or broad deletion was attempted.

## Historical evidence and remaining product gates

The earlier synthetic-mailbox two-wake run at `artifacts/expo-background-lifecycle/36b0b010-f638-47c2-a5d8-74e80f4e5cdb/safe-summary.json` proved G3 receipt verification but not outer completion. The old forged-ack/lost-final-response run at `artifacts/expo-background-lifecycle/05ae43fe-684e-4fef-942d-da20c0eb2e80/safe-summary.json` remains historical fault evidence. Neither is relabelled paired or a passing system handoff. The standalone [paired integration](paired-background-integration.md) retains its receiver restart, offline-cancel, and supervision scope; those adversaries were not all repeated in the new valid-outcome Expo run.

Open gates remain unmodified natural-launch ordering and broader G5 scheduling acceptance, native production installation and shared iOS bridge activation, scanner/confirmation/re-pair UX, trusted desktop operator UX, private LAN/local-network denial, AndroidKeyStore and shared Android acceptance, and physical iPhone/Android protection and scheduling. Production receiver startup, retention, repair, and platform support also remain gated. No foreground branch was merged and no foreground fallback was added.

No push, subagent, cloud/EAS/account/billing/workflow, T3/Cardboard action, global trust change, personal media, physical device, existing Simulator/AVD, or foreign listener was used.

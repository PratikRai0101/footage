# Expo 58 owned-session routing and paired OS completion

## Result

**The reproduced outer-completion ownership defect is fixed. Production upload activation remains NO-GO.** Two fresh actual Expo runs each completed two OS-driven background launches/event batches without JS. Every batch invoked the real UIKit outer completion once on main, after Footage's durable ledger processing. The final batch verified the common G3 receipt for **67,121,209 original bytes in two presealed groups**, with an independent receiving hash match.

The current proof uses production `PairingClient`, `PairingBackgroundControl`, `PairingBackgroundTrust`, `BackgroundRuntime`, macOS `DesktopKeyStore`, and `PairedService`. It does not use the old synthetic control mailbox. Independent local test-controller QR delivery and explicit local approval authorize the generated test device. These are test-only substitutes for scanner/operator UX, not automatic production trust.

The remaining lifecycle gate is slow or unavailable control during startup reconciliation. The synchronous paired adapter can wait 35 seconds while the runtime's serial queue and enumeration fence prevent event drain. Neither the ownership fix nor a fast loopback run proves that deadline safe. `g5Passed` remains false. The ordinary iPhone app still exposes only the approved picker/local preview.

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

The separate runtime enumeration race is **already fixed by the parent**. `f01abe9` clears `enumerating` before the deferred drain recheck on both successful and failed reconciliation. Both deterministic native regressions pass. The Expo probe now asserts the race is absent and needs no extra finish event. This task does not edit the runtime, codec, pairing client, or production paired service.

## Ordinary app and compile-time assembly

`NativeBackgroundInstallation.makeRuntime(activity:)` remains the native installation seam. Normal Release returns no installation. Missing native authority or protected storage never creates a replacement job, empty ledger, guessed destination, or foreground uploader. Native discovery reports `supportsTransfer: false`; upload commands remain closed. JS/UI, Android contracts, and picker/preview sources are unchanged.

The actual ordinary Release executable contains the public router and subscriber but no fixture, test waiter, generated original, or mailbox adapter symbols. Embedded JS/assets run without Metro. Destination-scoped XCTest verifies **Preview only**, no **Upload original**, opening/cancelling the real document picker, and return to the preview-only screen. This is not a newly selected-video playback or physical-device test.

`FOOTAGE_EXPO_LIFECYCLE_TEST=1 pod install` adds only the ignored generated fixture source, itself guarded by the matching Swift compilation condition. The separate test Xcode build sets that condition. No ordinary Release launch argument, file, URL, or environment lookup enables test authority. Test-only files select actions only in the fixture binary.

The fixture uses the native assembly seam to enroll and recover through G1, explicitly confirm the generated standalone intake, and construct real paired control/trust. After setup freezes job authority, it deletes only its current native installation. Both cold wakes restore the saved job authority, not current pairing or protected display metadata. The fixture reuses the existing paired test controller and native test helpers. It adds no transport, decryptor, master minting, or receipt authority.

The test SceneDelegate deliberately does not start React. The actual Expo AppDelegate, factory construction, module loader/provider, registration, and lifecycle forwarding remain. This is a compile-time no-JS assembly, not a claim that an unmodified ordinary foreground launch suppresses React. Generated files and normal Pods configuration are restored, followed by an ordinary Release rebuild and binary inspection.

## OS-driven paired acceptance

Latest ignored evidence: `artifacts/expo-background-lifecycle/92a1cc9e-17b6-49c6-b55f-c6566439c59a/safe-summary.json`.

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

### Exact remaining deadline gate

`BackgroundRuntime.restoreAndStart` holds `enumerating` until `reconcile` returns. Missing/uncertain tasks, cancellation, or verifying state can call `query` synchronously on the serial event queue. `PairingBackgroundControl` then waits up to 35 seconds, while `PairingHTTP` permits a 30-second resource lifetime. `didFinishEvents`, completion registration, and the deferred drain recheck cannot progress on that queue during the wait.

Immediate refusal tests and the two fast local OS runs do not prove a safe slow-network bound. A detached adapter task does not free the waiting runtime queue. Calling UIKit early from the host would hide this defect by completing before durable processing, so the router does not do that. G5/activation must remain blocked until the runtime/control owner supplies and proves a lifecycle-budgeted defer or nonblocking reconciliation policy. No production deadline fix is claimed here.

## Build fingerprints and checks

Xcode **27.2 / 27B52**, iPhoneSimulator 27.2 SDK, owned iOS 26.2 Simulator. Installed locked versions are `expo@58.0.21`, `expo-modules-core@58.0.28`, and `expo-file-system@58.0.13`.

Latest build-scoped SHA-256 values are not reproducible-build guarantees:

| Artifact | SHA-256 |
| --- | --- |
| Ordinary Release before test | `30ba548bf1266358dfefc499c6d71fa9ce5c5db7a2f35f29af1c67c655800504` |
| Compile-time test Release | `83eee46792c19c2150d5c3c1314e155f0b8468b968ae61fd268524c8ada9f549` |
| Restored ordinary Release | `9adcc1e3c02273234e919bd9c451f0e03e75a5b0f42f4632cbba311fb00edf48` |
| Embedded JS | `3e6b70f4a3eb027b8e0e00848dd9c1f5b676f328f8b34c01c14715adf2eab070` |
| Generated routed AppDelegate | `487f1da45ce81e0b7189205315bb39f3d80dfbfe411fdee8d50e2be322fc8864` |
| Existing paired test controller | `189a1632d73f8cc153ff00516a92c52bf24384956953fbf648cd2acaa222c443` |

Executed checks:

```sh
FOOTAGE_TEST_KEYCHAIN=1 python3 scripts/test/expo-background-lifecycle/run.py --two-wakes
node --test scripts/test/expo-background-lifecycle/plugin.test.cjs
python3 scripts/test/ios-background-runtime/run.py --unit-only
npm test
npm run typecheck
npm run lint
npx --no-install tsc -p scripts/paired-background-integration/tsconfig.json
python3 -m py_compile scripts/test/expo-background-lifecycle/run.py
node --check scripts/paired-background-integration/listener.mjs
git diff --check
python3 scripts/public-repo-preflight.py
```

- Two complete paired Expo runs pass the required actual outer completion checks, including ordinary, test, and restored ordinary Release builds. No build warning is suppressed.
- All **39 native runtime cases** pass in a fresh owned Simulator, including both parent enumeration regressions. Combined native runtime sources also compile for iPhoneOS with Swift 6 warnings as errors through that runner.
- **104 root cases pass; one optional real-Keychain root case is skipped.** Typecheck, lint, and the paired test-controller typecheck pass. The actual Expo paired runs separately exercise OS wrapping and exact-item cleanup. This root run does not supersede the parent's earlier opted-in 105-case result.
- Three plugin tests pass against the actual installed Expo template. They reject unknown/altered source and ensure the subscriber has no second background-session method.
- The public-history preflight and whitespace checks pass after the commits. Private artifacts remain ignored.

The runner reuses only `artifacts/expo-background-lifecycle/owned-build-a9771bfc`, checks disk before/after builds, and requires a six-GiB margin. Free disk remained approximately 13 GiB after both runs. No other checkout's build outputs were deleted.

Each fresh macOS account is written to ignored exact-account cleanup metadata **before initialization**. Deletion is registered before any later constructor and runs even if listener shutdown fails. Metadata is removed only after exact deletion succeeds. Both runs report exact deletion, owned listener shutdown, owned Simulator deletion, and no cleanup errors. Native test items live only in the recorded disposable Simulator, which is deleted. The six old accounts without retained IDs remain unresolved. No Keychain enumeration or broad deletion was attempted.

## Historical evidence and remaining product gates

The earlier synthetic-mailbox two-wake run at `artifacts/expo-background-lifecycle/36b0b010-f638-47c2-a5d8-74e80f4e5cdb/safe-summary.json` proved G3 receipt verification but not outer completion. The old forged-ack/lost-final-response run at `artifacts/expo-background-lifecycle/05ae43fe-684e-4fef-942d-da20c0eb2e80/safe-summary.json` remains historical fault evidence. Neither is relabelled paired or a passing system handoff. The standalone [paired integration](paired-background-integration.md) retains its receiver restart, offline-cancel, and supervision scope; those adversaries were not all repeated in the new valid-outcome Expo run.

Open gates remain slow-control deadline handling, native production installation and shared iOS bridge activation, scanner/confirmation/re-pair UX, trusted desktop operator UX, private LAN/local-network denial, AndroidKeyStore and shared Android acceptance, and physical iPhone/Android protection and scheduling. Production receiver startup, retention, repair, and platform support also remain gated. No foreground branch was merged and no foreground fallback was added.

No push, subagent, cloud/EAS/account/billing/workflow, T3/Cardboard action, global trust change, personal media, physical device, existing Simulator/AVD, or foreign listener was used.

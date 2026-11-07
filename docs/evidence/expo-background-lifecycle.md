# Expo 58 native background lifecycle: implemented, activation blocked

## Result

**G5 is not passed. Production upload activation remains NO-GO.** This is an actual local Expo app build and OS-driven background-session experiment, not another standalone UIKit transport proof.

The Expo test build received **two OS-driven background launches/event batches**, without starting JS. The second wake durably verified the actual G3 original receipt: **67,121,209 original bytes, two presealed groups**, matching the independently hashed receiving original. Footage's completion contribution ran once on main after durable ledger processing in each batch.

Two independently reproduced completion defects prevent claiming a complete system handoff:

1. **Expo dependency:** the installed filesystem subscriber retains Footage's unrelated session handler. Expo's outer aggregated system completion never executes, despite Footage completing its contribution.
2. **G4 runtime race:** if `didFinishEvents` arrives during outstanding task enumeration, `restoreAndStart` checks the drain before clearing `enumerating`, then clears it without checking again. The pending handler can leak. The controlled native-unit reproduction confirms this interleaving. The live two-wake run did not hit it.

Neither other owner's source was modified to conceal these defects.

## Implemented native assembly

Implementation commit: `912c1dc`. Actual-app tests and defect reproductions: `cc86f48`.

Files are under `apps/mobile/modules/footage-transfer/ios/`:

- `FootageTransfer.podspec` compiles the existing G1/G2/G4 owners and the native host with Swift 6, linking Security, CryptoKit and SQLite. It targets iOS 16.4, matching the app; a pod requiring iOS 17 would be silently excluded by this Expo autolinker.
- `FootageTransferAppDelegateSubscriber` is registered through the actual local `expo-module.config.json` Apple configuration. `subscriberDidRegister` initializes the host before AppDelegate/React construction, not when JS lazily imports a module.
- `NativeBackgroundHost` retains one runtime for the process and launches/reassociates it once. It uses the runtime's existing stable `footage.sealed.background.v1` session, directory writer lock and process-wide session claim. It does not own another ledger, transport, receipt or job.
- Owned callbacks go to that same runtime. Each supplied completion has its own main-actor once-token; handlers are not overwritten. Unrelated identifiers complete immediately on main without calling the factory or touching another session.
- Failed native configuration/storage opens remain `blocked`; absent installation is `notInstalled`. Neither creates an empty replacement, discards data, fabricates a destination, or reports a receipt. If an owned callback cannot open its runtime, the host completes as deferred while retaining pre-event durable state for later authorized reassociation.
- Protected-data notifications update a thread-safe native active/unlocked observation and permit a failed open to retry. **Expo 58.0.21 does not forward the corresponding protected-data delegate methods**; using only subscriber methods for them would not work.
- `FootageTransferModule` is a capability-discovery/closed command facade. It reports `supportsTransfer: false` and rejects current/upload/cancel/viewer commands instead of inventing an empty job or a foreground fallback.

### Ordinary installed app

The ordinary Release build contains **no usable fixture/control adapter or synthetic credentials**. The factory's normal branch returns no installation. Existing iOS JS discovery remains deliberately disabled; the original picker, local preview, preview-only copy and settings behavior are unchanged. Android discovery/contracts and all UI sources are unchanged. Native `device()` is not claimed to be the future shared iOS transfer-contract adapter.

The actual ordinary Release app has embedded JS/assets and needs no Metro server. Destination-scoped XCTest verified the preview-only screen, absence of Upload original, opening/cancelling the native document picker, and return to the same preview-only screen. This is not a new selected-video playback or physical-device test.

### Native configuration seam for G1

`NativeBackgroundInstallation.makeRuntime(activity:)` is the explicit **native compile-time assembly point**. Its result is retained as `NativeBackgroundRuntime`; production assembly can construct the existing `BackgroundRuntime` with:

- the installed storage directory and explicit initial-creation policy;
- dedicated native Keychain service;
- G1's authorized `BackgroundControl` and app-scoped `BackgroundServerTrust`;
- explicit cellular policy and `activity.get()` for native preparation eligibility.

The production resolver is intentionally not implemented here. No JS bearer, command argument, URL, environment lookup or installed file enables synthetic authority. Missing credentials/backend must return unavailable or throw; protected-data failure must not trigger reset/creation. The factory must not throw after successfully creating a session owner. Enrollment/UI activation and refreshing a newly installed pairing in an already running app remain future native integration work.

G1 control setup still uses `Manifest`. Status/revoke must use the existing authenticated minimal `OutcomeContext`, installed native authority and fresh query, without opening protected display metadata or following a current UI destination. This host does not duplicate paired transport.

## Test build isolation

Run locally, with installed locked dependencies and CocoaPods:

```sh
python3 scripts/test/expo-background-lifecycle/run.py --two-wakes
python3 scripts/test/expo-background-lifecycle/run.py
```

The runner creates/deletes its own iPhone 16 Simulator on iOS 26.2. It never uses an existing Simulator, physical device, AVD, personal media or real credential. It checks disk before each full build, reuses its own derived-data directory and stops only its own loopback listener. Free disk was approximately 25 GiB initially and 18 GiB after the recorded runs; no other worktree artifacts were deleted.

Ordinary app build command, following `CI=1 npx expo prebuild --platform ios --no-install` in `apps/mobile` and `pod install` in `apps/mobile/ios`:

```sh
xcodebuild -workspace apps/mobile/ios/Footage.xcworkspace -scheme Footage \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath artifacts/expo-background-lifecycle/build -jobs 2 \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
```

The test pod is selected only at **build time** by `FOOTAGE_EXPO_LIFECYCLE_TEST=1 pod install`. Its extra generated source is in ignored `apps/mobile/modules/footage-transfer/ios/build/lifecycle-test/`, excluded by the normal pod source glob, and additionally guarded by `#if FOOTAGE_EXPO_LIFECYCLE_TEST`. The test Xcode invocation adds that compilation condition. No normal Release runtime launch-argument/file/URL trust switch exists. Ad-hoc Simulator signing uses no real signing key; unsigned experimental test builds could not reliably access Simulator Keychain and are not the recorded proof.

The generated assembly reuses the existing `ios-background-integration/Probe.swift` synthetic mailbox control and strict generated-CA trust implementation, plus the existing runtime fixture helpers. It does not maintain another uploader, decryptor, acknowledgment signer or receipt server. The listener is the existing G3 adapter calling production `SealedIngest`/`Jobs`.

For valid responses, the runner derives an ignored listener from that same source, disables only its deliberate acknowledgment-forgery branch, and uses its existing final-response switch. `--two-wakes` adds a private gate before accepting the second group. These are response/scheduling fault controls, not replacement ingest/finality implementations. The unchanged default listener supplies the separate forged-ack/lost-final-response run.

The test-only generated SceneDelegate deliberately does **not** call `startReactNative`; the actual Expo AppDelegate, factory construction, loader/provider, subscriber registration and lifecycle forwarding remain. Thus preparation, reassociation, event processing and receipt verification execute without JS or the bridge. This is a compile-time no-JS test assembly, not a claim that an unmodified foreground Release launch suppresses React.

An additional test-only AppDelegate wrapper observes the **outer completion passed through `super`** before calling UIKit's supplied handler. It never invokes the subscriber or fabricates a system callback. This distinguishes Footage's own completion contribution from Expo's aggregate completion. Generated AppDelegate/SceneDelegate files and normal pod configuration are restored in `finally`.

## Observed OS behavior

Recorded final valid run: ignored `artifacts/expo-background-lifecycle/36b0b010-f638-47c2-a5d8-74e80f4e5cdb/safe-summary.json`.

1. The ordinary Release app passed the picker/preview-only XCTest. Both actual generated provider branches contained `FootageTransferModule.self` and `FootageTransferAppDelegateSubscriber.self`; native compilation/linking succeeded. The runner checks the generated file, not only config source.
2. In the separately compiled test app, native registration constructed exactly one runtime before JS. A native worker generated and fully sealed the original, then durably scheduled both groups while active/unlocked.
3. The test denied the private directory's POSIX permissions and verified a real manifest read failed **before backgrounding**. Callback instrumentation never opens the protected display manifest. The runtime uses authenticated minimal context; the directory remained permission-denied after the wakes. This is access-denial injection, not physical screen-lock evidence.
4. Destination-scoped XCTest pressed Home. The runner then SIGKILLed only the owned app PID. It observed the owned Simulator's `nsurlsessiond` socket before releasing the listener. No `simctl terminate`/foreground activation was used to induce the measured wakes.
5. The first group produced an actual iOS background launch with a different PID. The real Expo subscriber received the owned ID. Durable ledger reopen at Footage's completion showed **67,108,864 confirmed original bytes**, no receipt, one callback and one main-thread completion contribution.
6. After recording that first batch and observing the missing outer aggregate completion for 30 seconds, the runner SIGKILLed that OS-launched process and released the second group. G3 assembled/hash-verified the original and published its existing authoritative `Jobs` receipt.
7. iOS launched another process and delivered the second owned callback through Expo. Without JS, native verification durably reached **received**, with all **67,121,209** original bytes and the exact receiving receipt ID/job/size/SHA-256. Reopening the ledger at handoff showed received plus the saved receipt; Footage contributed completion exactly once on main. No protected manifest was opened during callback processing.
8. Both receiving wire hashes matched the exact saved native packets. Ingest had zero Authorization and Cookie headers. The G3 store had one job and one matching shared original receipt, not test-invented finality.
9. The final outer aggregate completion was still absent during the 75-second observation window. An explicitly labelled later native relaunch independently recovered the same receipt; it is not counted as an OS wake.

**SIGKILL is an OS-style abrupt process exit, not proof of natural jetsam, memory pressure, screen lock or user force-quit behavior.** The Simulator happened to relaunch these owned processes. No automatic restart guarantee follows for force-quit, another OS/device, or a deadline. First-unlock/reboot and daemon-owned file protection remain unproved.

Separate fault run: ignored `artifacts/expo-background-lifecycle/05ae43fe-684e-4fef-942d-da20c0eb2e80/safe-summary.json`. The unchanged listener returned a canonical forged ack and destroyed the final response after actual G3 publication. Native OS-event observation remained blocked with **zero confirmed bytes and no receipt**. A later explicit no-JS native relaunch authenticated status and recovered the exact G3 receipt. Transport completion and fake outcomes were not called received. Receiver restart/cancel/redirect adversaries retain their existing G3/G4 evidence scope; they were not all repeated in the Expo app.

### Build fingerprints

Xcode **27.2 / 27B52**, iPhoneSimulator 27.2 SDK, iOS 26.2 owned Simulator. Locked installed sources: `expo@58.0.21`, `expo-modules-core@58.0.28`, `expo-file-system@58.0.13`.

Final valid-run SHA-256 values (build-scoped, not reproducible-build guarantees):

| Artifact | SHA-256 |
| --- | --- |
| Ordinary Release executable | `520fa505a65422e1b55a58f1a975d557ad615bceaa40144f709dbdd4f58dc9b3` |
| Compile-time test Release executable | `717861a499a9a78c70c4fc7cc11bda7fdbfca47dda03347c5b26f5860793c583` |
| Embedded JS bundle | `0b3330b28dbdef918f35eda3cbec01f40edae2af6db97c68bf546c53ec36dd1d` |
| Existing G3 test adapter source | `4c068c2e3f1db39e2c5e318de0d758ff25bc6e1697d74aa66942be18fbc5d387` |

After the test configuration was removed, another ordinary Release rebuild passed with executable SHA-256 `e243b116f7b5a5d41da54411c742302be364a5e42a469dcd7cd3133ee53d9352` and the same embedded JS hash. The rebuilt executable contains the subscriber but no fixture symbols. Generated AppDelegate and SceneDelegate contain no test condition.

Raw paths, PIDs, generated certificates, fixture bytes, credentials, keys, receipt identities and logs remain ignored. Exported summaries contain bounded assertions/counts/fingerprints, not personal data or network identities. All owned Simulators/listeners were deleted/stopped.

## Required owner fixes / exact open gates

### Expo filesystem subscriber prevents aggregate completion

The generated provider includes both Footage and `FileSystemBackgroundSessionHandler`. `ExpoAppDelegateSubscriberManager.swift:163–188` calls every responding subscriber and waits for every contribution.

In `expo-file-system/ios/Legacy/FileSystemBackgroundSessionHandler.swift:37–41`, **every** identifier is passed to `BackgroundSessionCompletion.receiveHandler`, with no ownership check. `BackgroundSessionCompletion.swift:66–69` requires `finishedEvents` even after its deadline expires. For Footage's session, the filesystem module will never receive its own `finishEvents` notification. Its handler remains pending indefinitely; completing Footage's contribution cannot finish the aggregate.

The outer actual-app instrumentation observed this omission in both OS-driven batches. The installed bookkeeping source independently reproduces it:

```sh
mkdir -p artifacts/expo-background-lifecycle/regression
xcrun swiftc -swift-version 6 -warnings-as-errors \
  node_modules/expo-file-system/ios/BackgroundSessionCompletion.swift \
  scripts/test/expo-background-lifecycle/ExpoAggregationProbe.swift \
  -o artifacts/expo-background-lifecycle/regression/expo-aggregation-probe
artifacts/expo-background-lifecycle/regression/expo-aggregation-probe
```

This unit probe's artificial finish operates on a separate bookkeeping object only; it is **not** counted as OS lifecycle evidence. The dependency owner needs an ownership-aware prompt completion for unrelated sessions, then the outer actual-app check must be repeated. Do not work around it by calling private filesystem finish methods, stealing sessions or fabricating another module's drain.

Installed `BackgroundSessionCompletion.swift` SHA-256: `13e17f24de79ef85fde0a7dc6444f5b9718d2d81d3e7dd78438435a6b97533b8`.

### G4 enumeration/drain ordering defect

`BackgroundRuntime.swift:78–81` defers `enumerating = false` until **after** `completeDrainIfPossible()`. That drain function rejects `enumerating == true`. If `finishEvents` already ran while enumeration was outstanding, clearing the flag in the defer does not wake the pending handler.

`scripts/test/expo-background-lifecycle/RuntimeDrainProbe.swift` deterministically holds `allTasks`, enqueues a finish event, barriers the native queue, then releases enumeration. Restore completes but the handler does not. Only a second artificial unit finish releases it. No real daemon/session exists in this probe and it is not OS evidence. The actual Expo test build records `runtimeEnumerationDrainRaceReproduced: true`.

**Parent/G4 action:** clear the enumeration fence before rechecking drain on every enumeration exit (including errors), and add this interleaving to the owner's native regression suite. No new API is necessary for that ordering correction. This task does not edit `BackgroundRuntime.swift`.

A separate, unproved deadline concern remains: startup reconciliation can synchronously call `BackgroundControl.status/revoke` on the serial queue while enumeration fences drain. The runtime/control owners must bound/defer unavailable control work rather than wait indefinitely for networking before system completion. Fast loopback callbacks do not prove a production deadline policy.

### Other activation gates

- Install and prove G1 native paired control/OS wrapping, credentials, permissions and confirmed immutable destination assembly. The test mailbox is not production pairing.
- Repeat actual Expo event aggregation after both completion defects are fixed, including unavailable control/protected storage and the unmodified release lifecycle.
- Complete the shared iOS snapshot/selection/receipt bridge and Android paired execution acceptance without UI redesign or foreground-only fallback.
- Physical iPhone and Android: lock/first unlock/reboot, local-network denial, long workloads, real scheduling, storage/memory budgets and cancellation. No physical or Android device claim is made here.
- Receiver supervision, production routing, retention and all other G1–G7 requirements remain in force.

## Regression checks

- **104 root tests pass**: 78 receiver, 20 mobile, six tooling. Typecheck and lint pass. Android sources/discovery/contracts and UI files were not edited.
- **37 existing native runtime cases pass** in their own fresh owned Simulator with the existing Debug runner. That Simulator was deleted. The new eight host seam cases pass inside the actual Expo test module; the separate drain probe is a reproduced defect, not a passing safety gate.
- Combined Pairing + SealedProtocol + Background owners + NativeBackgroundHost compile against iPhoneOS at deployment target 17 with **Swift 6 warnings as errors**. No owner warning was suppressed. The actual Expo pod uses Swift 6 with normal warnings because Expo's prebuilt Objective-C headers emit nullability/forward-protocol warnings; those remain visible, not suppressed.
- Actual ordinary and flagged Expo Release builds pass locally; generated provider, embedded bundle and absence of fixture symbols in the normal executable are checked.
- Python syntax, installed Expo bookkeeping reproduction, diff whitespace and public-repository preflight pass.

No push, cloud/EAS/account/billing/workflow/T3/Cardboard operation, foreign listener termination, physical device, personal media or other worktree mutation was performed.

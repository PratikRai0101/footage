# Paired background control and OS-wrapped durable receiver

## Scope and result

The standalone owned iPhone Simulator app now uses production `PairingClient`, `PairingBackgroundControl`, `BackgroundRuntime`, and the explicitly constructed HTTPS `PairedService`. Actual `PairingAuthority` authorizes setup, status, and revoke. Actual `SealedIngest` publishes the common `Jobs` original receipt. A fresh macOS Keychain item wraps receiver identity, enrolled credentials, and generation masters. There is no in-memory wrapping fallback or injected native installed credential.

The final run transfers **67,121,209 original bytes** in two fully presealed groups while the app is Home-backgrounded and SIGSTOPed. The saved encrypted bodies total **67,121,933 bytes**. The receiver retries a transient finalization error and publishes the receipt without a phone retry, phone completion call, or receiver restart. Native authenticated status and later revoke obtain that same receipt. An independent receiving SHA-256 matches the native original identity.

This is not the Expo G5 host, a scanner, or physical-device evidence. Default app and receiver startup remain unchanged. The normal app remains preview-only. Android and tus sources and protocols are unchanged.

## Native API ready for the G5 owner

New source: `apps/mobile/modules/footage-transfer/ios/PairingBackgroundControl.swift`.

- `PairingNativeConfirmedIntake(afterNativeConfirmation:identity:)` requires an explicit native confirmation precondition and exact intake16. It never chooses an inbox or invents a T3 destination. `identity` comes from `PairingClient.nativeIdentity()`.
- `PairingBackgroundControl(client:nativeConfirmedIntake:)` implements the existing synchronous `BackgroundControl` interface. Setup receives a canonical G2 manifest, compares receiver, exact origin, device, enrollment epoch, intake, and expiry, then freezes `PairingControlBinding` before the real G1 setup request. Installed authority must still match that confirmation.
- `status` and `revoke` accept authenticated `OutcomeContext` plus `Query`. They compare the minimal context against the saved native job binding, including destination digest and expiry, then use `PairingClient.control` by job ID. They do not open the private manifest or consult current pairing, settings, or UI selection. The exact canonical query is checked again by G1.
- Cold launch uses `PairingNativeConfirmedIntake.restoreConfirmedJob(_:client:)` and `PairingClient.confirmedJobTrust(_:)`. These restore an existing private confirmation, not new consent. Missing or expired job authority throws. The integrated run deletes only its current native installation after setup, then proves cold status and revoke still use the original job authority.
- `PairingBackgroundTrust(pinned:)` adapts G1's app-scoped exact-origin TLS policy to `BackgroundServerTrust`. New jobs obtain the policy with `installedTrust()`. Existing jobs obtain it with `confirmedJobTrust(_:)`. Background URLSession can follow redirects. This adapter does not claim otherwise. Redirectable bodies contain only encrypted protocol packets, with no credential or master.

Synchronous control refuses main-thread execution. A detached utility task calls the existing async actor and transport. Completion uses a lock-protected result and a 35-second bounded wait. The HTTP transport retains its 30-second resource deadline and its own delegate queue. It never needs the waiting runtime queue or main queue for completion. A timeout remains uncertain and cannot create another job or accept progress. No Swift 6 warning is suppressed.

G2 remains the sole outcome verifier. Paired HTTP success returns bounded bytes, not accepted ranges, cleanup confirmation, or a receipt. No new JS API exports credentials, keys, masters, or these native objects.

### Exact pairing-boundary changes

The prior pairing owner had no API to compare minimal locked context against its saved binding or obtain the saved trust policy. Without those APIs, the adapter would need to reopen private display data, read current pairing, or duplicate TLS validation. Those are the demonstrated integration defects addressed here.

`PairingClient` adds native-only `confirmedJobBinding`, `confirmedJobIdentity`, `installedTrust`, and `confirmedJobTrust`. Each saved-job accessor reads and verifies the original private installation. `PairingTrust.swift` factors the existing validation body into `PairingPinnedTrust`; the existing control exchange calls that same validator. Chain, dates, exact SAN, origin, port, SPKI pin, and app-scoped CA checks are unchanged. All 28 existing native control cases pass after this extraction.

On the receiver, `PairingAuthority.assertListenerBinding` compares the configured origin, CA, and leaf SPKI digest against the authority's provisioning. It never derives authority from HTTP headers. No pairing wire format, permissions, scope rule, or Android pairing implementation changes.

## Explicit HTTPS service and local approval

New source: `apps/server/src/paired-service.ts`.

`PairedService.open(config)` requires an exact HTTPS origin, numeric local bind address, TLS key/certificate/CA, actual `PairingAuthority` and its trusted local controller, `Jobs`, an actual `DesktopKeyStore`, private storage, and the current standalone intake allowlist. The local owner updates that in-memory set after resolving access. No network or indeterminate destination lookup runs inside the publication lock. There is no default key store, default listener, automatic offer, automatic approval, or import from `main.ts` or `server.ts`.

`open` does not listen. `service.listen()` explicitly binds the configured port and address and validates the resulting binding. The supplied certificate must name the configured origin host, be currently valid, and match the authority's provisioned CA and pin. Node validates the TLS key/certificate pair. Host must equal the configured authority text; forwarded headers are refused and never supply authority. Plain HTTP has no handler, and the service has no redirect behavior.

The only active network routes are exact POST paths:

- `/pair/v1/enroll`, `/pair/v1/challenge`, `/pair/v1/recover`.
- `/sealed/v1/setup`, `/sealed/v1/status`, `/sealed/v1/revoke`, `/sealed/v1/ingest`.

Unknown paths and query variants return unavailable. `/sealed/v1/view` and `/pair/v1/destinations` return 503. There is no invented reply schema, viewer activation, remote approval endpoint, T3 credential, or agent invocation.

The separate returned `local` controller creates offers, lists bounded pending enrollment fingerprints, approves an exact pending request with scopes, revokes devices, and creates rotation candidates. Enrollment verifies offer and device proof before entering a maximum-eight-request local approval queue. It waits at most 15 seconds, subject to the configured body deadline. Only an explicit trusted local `approveEnrollment` action can authorize that exact body. Shutdown refuses pending approvals. Challenge and recovery still use G1's one-use, expiring, rate-limited protocol.

Admission enforces 8 KiB headers, duplicate-header rejection, eight connections, TLS handshake and header deadlines, idle connection limits, and an absolute request-body deadline. Configured body deadlines are bounded to 100 milliseconds through five minutes; the default is 30 seconds. Streaming caps are 64 KiB setup, 16 KiB pairing, and 4 KiB status/revoke. G3 independently bounds encrypted bodies. Replies are bounded too. Bodies cannot use cookies, proxy credentials, or content encoding. Control uses only an enrolled bearer in Authorization. Errors expose no secret-bearing body or diagnostic.

`advertisedMaxOriginalBytes` is **1 GiB** for this service slice. G3 still checks the actual remaining quota, storage amplification, disk space, and lifetime identity budget. The binary 4 GiB limit is unchanged. The fixed 8 GiB reservation budget is not increased, and no full-size acceptance is claimed.

## Receiver-owned supervision and shutdown

`SealedIngest.retryPending()` performs one bounded pass over durable jobs. It rechecks enrolled epoch, expiry, and destination access, retries verifying jobs, and retries pending cleanup. Existing per-job finalizer promises prevent two finalizers for one job. Finalization rechecks live authority before assembly and under the common publication lock before publication. A received original remains immutable.

The service schedules the next pass only after the previous one finishes. Pending work or sweep failure increases the interval up to 30 seconds. Healthy idle sweeps return to the configured interval, normally one second. There is no busy retry loop or phone `/complete` dependency. Transient storage errors retain durable pending state. Integrity-frozen jobs remain recovery-required, not fabricated cancellations or receipts. Startup likewise leaves failed transient finalization pending for supervision.

`service.close()` is idempotent. It stops admissions, refuses pending enrollment approvals, stops future sweeps, drains sockets and request operations, awaits the current sweep, and calls `SealedIngest.drain()` before closing Jobs and pairing storage. Slow peer sockets have a bounded shutdown deadline. Filesystem publication is drained rather than abandoned at that deadline. Common locks, receipt publication, tombstones, retained outcome keys, and quotas remain G3-owned.

## Executed proof and regressions

Final integrated evidence is in ignored `artifacts/paired-background-integration/89f294d7-e7f8-4ba8-8c56-801812199b27/safe-summary.json`. The run uses Xcode 27.2 build 27B52, Swift 6 warnings-as-errors, an owned iPhone 16 Simulator on iOS 26.2, Node 22.23.1, and macOS Keychain.

The executed sequence establishes these facts:

1. Native generates its own device signing key and enrolls through TLS using a QR supplied over the independent local test-controller channel. An explicit local operator action approves the pending request. Native then performs actual challenge/recovery with that same device key. The test does not manufacture installed native secrets.
2. Native explicitly confirms the generated standalone intake precondition. Exact paired setup retries return the same master and job identity. Changed setup destination and substituted outcome context are rejected. The current native installation is removed after the private job confirmation is frozen.
3. Native fully presealed two groups, schedules the batch, and cold-reassociates the same task IDs and correlations. The test denies access to the private directory. An actual manifest read fails with permission denial. Neither status nor revoke needs that manifest.
4. Destination-scoped XCTest presses Home. The runner SIGSTOPs only its owned app process and observes its `nsurlsessiond` socket before releasing the bodies. Actual G3 commits both groups. A one-time error at the real original-sync boundary leaves verifying state. Receiver supervision publishes the common receipt while the app remains stopped, without another phone request or restart.
5. Independent receiving file size and SHA-256 match the authoritative receipt. Streaming wire hashes equal the native saved packets. Background requests carry zero Authorization and Cookie headers. Byte scanning finds neither the enrolled reusable credential nor the generation master, in binary or hexadecimal form, in the encrypted bodies.
6. Test-only fault injection corrupts an authentic ack's HMAC and destroys final responses after publication, including daemon retries. Native callbacks reject the forged response before cancellation, with no accepted progress or receipt. A real challenged native status obtains the same autonomous receipt through G1 and G2 without the private manifest.
7. The receiver is actually stopped. Cold native cancel persists its operation and cleanup-pending intent while real HTTPS is offline. The same receiver storage reopens with the same OS wrapping item and exact Jobs receipt. Actual G3 rejects a tampered saved group. An exact-packet retry preserves one job and one receipt.
8. Cold native revoke through the saved job authority returns that already-committed receipt. Native reaches `received` with its exact receipt ID, job ID, original length, and independently matched SHA-256. The receipt wins offline cancellation. The manifest remains unreadable.

The network fault controller is test-only. It wraps calls to production ingest for pause, observation, transient failure, forged response, and response loss. It does not decrypt, assemble, authorize, mint a master, or manufacture a receipt. Production service routing is used for enrollment, setup, status, revoke, and ingest. There is no filesystem control mailbox.

Executed commands include:

```sh
FOOTAGE_TEST_KEYCHAIN=1 python3 scripts/paired-background-integration/run.py
FOOTAGE_TEST_KEYCHAIN=1 node --import tsx --test scripts/paired-background-integration/service.test.mts
python3 scripts/paired-background-integration/control-regression.py
python3 scripts/test/ios-background-runtime/run.py --unit-only
FOOTAGE_TEST_KEYCHAIN=1 npm test
npm run typecheck
npm run lint
npx --no-install tsc -p scripts/paired-background-integration/tsconfig.json
npx --no-install tsc -p scripts/test/sealed-ingest/tsconfig.json
```

The existing Keychain root test requires its helper compiled at ignored `artifacts/desktop-key-store/helper`. The root suite passes all 105 tests with that test opted in. The focused service suite passes seven TAP tests, including its parent test. It covers authentic enrollment, no remote approval, wrong credentials/device/scope, expired and revoked enrollment, reserved interfaces, unknown routes, Host/forwarded-header denial, chunked streaming caps, automatic finalization retry, access/revocation cleanup, late receipt, and shutdown during body reception and finalization. The native control regression passes all 28 trust/redirect/permission cases with zero control secrets at redirect sinks. The runtime unit regression passes 37 cases.

The G1-only proof builders previously globbed every `Pairing*.swift` file. The new adapter also requires G4 protocols. Parent integration changed the ordinary G1 probe builder to an explicit owner-source list, with an explicit G2 codec addition in the control probe. Both direct runners now exclude the G4 adapter by construction, without a wrapper monkeypatch. The first parent control-probe build exposed a missing explicit G2 source; that source-list error was fixed and all 28 actual Simulator cases passed on the next run. `control-regression.py` now delegates to the ordinary fixed runner. The integrated proof separately compiles all production pairing, codec, and background sources together. The combined sources also compile for the iPhoneOS SDK at deployment target iOS 17 with Swift 6 warnings-as-errors. No warning suppression, Expo build, Pods install, or package change is used.

Python syntax, Node syntax, diff whitespace, root typecheck/lint, both test-tool typechecks, and public-history preflight are checked. No 4 GiB fixture is allocated.

## Parent verification

The parent integrated the native adapter and supervised service, reran all 105 root tests with the fresh-item Keychain test opted in and all seven focused service tests, typecheck/lint, service-tool typecheck and combined Swift 6 iPhoneOS compilation. It also independently reran all 28 native control cases in a fresh owned Simulator; that Simulator and listener were cleaned up. The multi-group daemon/paired-receipt proof above remains the worker's recorded run, not a new parent run.

Parent hardened test teardown so a service shutdown exception cannot skip deletion of that test's exact known Keychain item. Cleanup metadata is removed only after deletion succeeds. Its local artifact check found no retained exact-account cleanup record for the six early leaked service-test entries. No Keychain enumeration or broad deletion was performed; that incident remains unresolved.

## Cleanup incident and remaining gates

The successful integrated run stops its listener, deletes its disposable Simulator, and deletes exactly its newly created UUID Keychain item. Current service tests record each exact new namespace before initialization and register exact-item cleanup before later constructors. Their completed runs remove those items and cleanup records. No global trust, existing Keychain item, parent Simulator, AVD, physical device, or personal media is used.

An early failing service-test run created six fresh test-only Keychain items, then failed in the HTTPS constructor before cleanup registration. That first version did not retain their random account UUIDs. Those six items remain. No Keychain enumeration or broad deletion was attempted, because discovering them that way would inspect pre-existing items outside the allowed exact-namespace boundary. This is a test cleanup defect, not evidence of an existing credential change. The test is corrected, but cleanup of those six unknown accounts requires a separately authorized metadata-discovery step. It is not claimed complete.

Remaining product gates are native scanner and confirmation UX, trusted desktop operator UI, actual Expo subscriber/module/bridge assembly and lifecycle, private LAN and local-network denial, physical iPhone protection and termination behavior, AndroidKeyStore execution, shared Android acceptance, and physical-device release evidence. The receiver OS backend remains macOS-only. This slice does not pass those gates or enable normal uploads. Receipts authenticate the shared-key-holder boundary, not public third-party attestation.

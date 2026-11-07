# Ordinary app acceptance — 0.5.0 / build 5

## Result

**The ordinary iPhone Release app is no longer inherently preview-only.** It imports a private connection file, obtains explicit native trust/destination confirmation, enrolls with the receiver, prepares the selected original natively and transfers it through background URLSession. Unconnected phones deliberately remain Preview only. No fixture runtime, synthetic default authority, Metro or JS byte uploader was installed in this app.

The approved full-frame layout and styling remain unchanged. The received viewer is receipt-gated and pinned to the paired HTTPS receiver. Explicit T3 delivery/send is computer-side, not an invented phone button.

## Actual built-app checks

Owned iPhone 16 Simulator, iOS 26.2, embedded-JS Release app; generated media only. The owned receiver used the production PairingAuthority/PairedService/sealed-ingest code and its own precisely recorded test-only macOS Keychain namespace. The fixture explicitly approved its own generated enrollment request; the normal CLI requires local operator approval.

1. Imported the private two-minute connection export using Files. Confirmed the actual computer fingerprint/destination in the native alert; enrolled over independently pinned TLS.
2. Selected a generated eight-second 1280 × 720 H.264 MP4, **4,098,434 bytes**, in the real picker. Reviewed before Upload original. Native preparation/upload reached **Original verified.** Independent source/receiver/native original byte counts and SHA-256 matched the common receipt.
3. Repeated with a distinct job/receipt; earlier original/receipt remained archived. Cold relaunch restored the current received action.
4. Selected a generated **79,595,914-byte** MP4 and completed a two-group upload. This fixture contains the same eight-second movie plus a valid random-filled ISO BMFF `free` box; it is a transfer-size fixture, not a long-video/4K performance result.
5. For the decisive **ordinary-app background** run, paused the owned receiver immediately after authenticated setup. Verified both daemon tasks had been created/resumed and confirmed bitmap was zero. Pressed actual **Home**, observed `runningBackground`, then resumed the receiver. The receiver committed the matching receipt and the native ledger reached `received` **before returning to the app**. App state was still `runningBackground` at the final observation. No test-assembly or lifecycle-fixture configuration was used.
6. Independently hashed all **four** received originals and all corresponding native current/archived originals against generated sources and their distinct receipts. All matched; the first originals were not replaced by later uploads.
7. Installed the final build, cold-launched, restored the latest receipt, opened/cancelled the native picker with the receipt unchanged, and opened/closed the paired read-only original page. Its displayed latest receipt matched the background receipt. Viewer metadata was checked; this run is not a native in-WebView download/export certification.

The background run preceded only the final native picker-dismissal delegate assignment. The final build's cold restoration, picker cancellation and viewer were checked separately; there is no retained executable hash for that preceding background binary. The final executable/APK hashes and sanitized outcomes are in [the machine-readable record](normal-app-0.5.json).

## Defects found rather than hidden

- Platform OpenSSL defaults produced explicit-parameter/weak-signature certificates rejected by iOS. Provisioning now explicitly uses named P-256 curves and SHA-256; no trust bypass was added.
- Ordinary scene-based activity was not represented by the earlier lifecycle-test host path. Native UIKit foreground/background/protected-data notifications now drive activity; preparation still fails closed while inactive/locked.
- Reconstructing a Files URL from a JS string did not retain a larger selected file's grant. iOS now owns an open-in-place UIKit picker and the exact native URL grant across review/preparation. No app-owned stable original copy is made before Upload original.
- The paired HTTP/1.1 receiver admits one authenticated group at a time. The daemon now queues the full presealed batch with one connection per host, avoiding parallel quarantine-budget races.
- An initial `simctl launch Settings` attempt did not immediately satisfy the background-state assertion and was not counted as background acceptance. The bounded controller resumed the owned receiver in `finally`; the successful test uses actual Home and explicit state observations. A mismatched viewer text selector also failed; the actual page was then checked against its displayed `RECEIVED & VERIFIED` text.

## Local verification

- **108** root tests: 80 server, 22 shared mobile contract/presentation, six tooling. The fresh-item macOS Keychain test was explicitly enabled.
- **52** native background runtime cases, including empty-ledger reopening and terminal archival/restart.
- **8** paired-service integration tests; **3** routing-plugin tests.
- TypeScript, normal-app fixture typecheck and Expo lint pass.
- Ordinary iOS Release and current **Android 0.5 Release APK** both build. Android device/runtime acceptance was not repeated.

Private logs, snapshots, generated media, receiver state, cleanup metadata and the bounded controller result remain ignored under `artifacts/app-finish/`. Test helpers: `scripts/test/normal-app/receiver.mts` and `background.py`. The background controller requires an already connected/selected fixture in the real UI; it is not a fake unit-test upload. Existing fixture state/cleanup metadata is never silently overwritten on rerun.

## T3 boundary

The owned outside-client MCP fixture exercises same-computer environment/project/thread/workspace checks, verified streaming workspace intake, durable target/receipt/request/auth-namespace identity, lost send reply followed by process reopen, and concurrent retry without duplicate accepted messages. `deliver` does not start an agent; only separate `send` queues the reference. No real T3 account credential, live message, Cardboard launch/edit or paid generation was used. Live compatibility remains an explicitly authorized acceptance step, not a result inferred from the fixture.

## Limits

This is local-prototype acceptance, **not production/store approval**. Physical iPhone lock/protection, LAN denial, cellular changes, current Android device/AndroidKeyStore behavior and paired T3 workflow parity remain outstanding. Android keeps its existing native receiver flow; no cross-platform paired-flow parity is claimed. Neither Home nor SIGKILL tests establish user-force-quit automatic restart. The paired service admits up to 1 GiB subject to quota/disk, not the binary 4-GiB ceiling. Private-CA viewer sharing across other devices and native download/export need separate acceptance.

The test receiver deletes only its recorded fresh Keychain item at shutdown. Historical six unknown test-only items remain disclosed; no broad Keychain enumeration/deletion was used. The dedicated acceptance Simulator was removed after preserving native filesystem evidence (not its Keychain). The pre-existing parent Simulator is preserved with the ordinary 0.5 app installed; previous app/APK binaries were retained.

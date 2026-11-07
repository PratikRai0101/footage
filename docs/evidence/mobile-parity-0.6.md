# Shared phone implementation acceptance — 0.6.0 / build 6

## Implemented result

Both ordinary Release apps now support **paired original upload, native phone-side destination selection, workspace-only delivery and separately confirmed T3 send**. The Android implementation reuses TransferOwner and its existing OS schedulers; it does not fork the app or upload video through JS. Both platforms use canonical G2 sealed groups and the common receiver/Jobs receipt.

Phone selection is limited to the computer's explicit authorized catalog, up to 16 destinations. It is not unrestricted browsing of every T3 account/project. The receiver resolves supplied environment/project/thread/workspace identities before exporting choices. Actual T3 credentials stay on the computer.

## Actual app runs

Owned iPhone 16/iOS26.2 Simulator and API36 Android emulator; generated media only. The Android test used loopback ADB reverse and an owned rootable emulator for native state observations. AndroidKeyStore APIs were actually exercised, but hardware-backed storage/physical-device behavior is not certified.

- Both apps imported a fresh private connection file and completed native confirmation plus approved pairing over independently pinned HTTPS. No global CA installation or synthetic default authority was added to the apps.
- Both selected **Editing room B** through Settings → Choose destination, reviewed a generated eight-second 1280×720 original and uploaded **4,098,434 bytes** to a matching authenticated receipt.
- Cancelling the separate native send confirmation started no agent. Android's workspace-only delivery independently verified the original in the selected workspace without sending a message.
- For each platform, the owned MCP fixture accepted one explicit send and deliberately lost its reply. The app displayed unconfirmed/retry, not Sent. The next destination was changed to **A**, then the app was explicitly cold-reopened. The existing original and native retry confirmation still named **B**. Retry reconciled the original request without duplication: **four send requests, exactly two accepted messages for two distinct originals**, both to B. This is not a user-force-quit automatic restart claim.
- Both ordinary apps then uploaded a **79,595,914-byte/two-group** original to next destination **A**. The receiver paused after setup; full preseal and native scheduling were observed with zero confirmed bytes. After actual Home/background state was observed, the receiver resumed. Both receiver receipt and native received state committed **before returning to the app**. There was no fixture-only app assembly, Metro or JS byte transfer.
- The large fixture is the same eight-second generated movie plus a valid random-filled ISO BMFF `free` box. It is a transfer-size test, not a long-video/4K/HDR performance result.
- Android cancellation was exercised during an actual sealed request while the receiver was paused/unreachable. Cancellation returned locally with **cleanup pending**, closed the native data path, and only reported removal after authenticated reconciliation on reconnect. The receiver retained no received receipt for that cancelled job; the selected external source's SHA-256 was unchanged.
- All **four received originals** were independently hashed at source, receiver and native current/history storage; byte counts and SHA-256 matched. Both delivered workspace copies matched too. Background completion/cancellation caused **zero automatic T3 sends**.
- Android's pinned read-only viewer downloaded and independently hashed the received original, then played the verified cached original. A real rendered check found the first native Close control overlapping the system area; final insets were corrected and Close was exercised successfully. No TLS-error bypass was used.

The final job-scoped socket/restart recovery and native reply-whitelisting hardening was added after the background/cancellation/send acceptance runs. Final iOS/Android builds compiled and were separately cold-smoked against retained state: iPhone restored its verified original/thread control; Android restored authenticated cancellation. Those last hardening changes are not falsely represented as a repeated full in-flight acceptance run.

## Verification and artifacts

- **109 root tests:** 80 server, 23 mobile contract/presentation, six tooling, with explicit fresh-item macOS Keychain opt-in.
- **52** native Swift runtime cases; **9** paired HTTPS service tests, including destination scopes and purpose-bound handoff; **3** routing-plugin tests.
- **17** JVM pairing cases. Kotlin→production Node group authentication and Node→Kotlin receipt/status interoperability passed for 173 bytes and **67,108,881 bytes**; tampering, wrong keys/challenges, stale revisions and purpose replay were rejected.
- Typecheck, fixture typecheck and Expo lint pass. Both embedded-JS Release builds pass. Final Android assembly skipped native debug-symbol extraction after that nonessential task stalled; Kotlin/native application compilation and APK assembly succeeded.

Sanitized numeric outcomes/build hashes: [mobile-parity-0.6.json](mobile-parity-0.6.json). Private logs, generated media, native filesystem evidence and tested binaries remain ignored under `artifacts/mobile-parity/`. Device keystores were not exported. The owned receiver drained, its exact fresh macOS Keychain item was deleted, and the dedicated Simulator/AVD were removed. The pre-existing parent Simulator/historical Android AVD were preserved; normal 0.6 is installed on the parent Simulator.

Controllers: `scripts/test/mobile-parity/{receiver.mts,background.py,cancel.py}` and `scripts/test/sealed-android/`. Controllers require already reviewed generated media in the normal UI and explicitly owned test resources. Failed/stale UI-selector attempts were not counted as product success. The final cross-language harness uses the public validated `Binding.match` constructor, not a private-constructor bypass.

## Remaining acceptance, not claimed results

No personal T3 credential/account/thread or real Cardboard action was used: the local MCP fixture validates the implementation contract, not live compatibility. Physical phones, LAN denial/switching, lock/protection, Doze and sustained large-media operation require separate authorized verification. Viewer external-browser CA sharing and broader retention/repair/migration operations are not production-certified. Six historical unknown test-only Keychain items remain disclosed; no unrelated credential enumeration/deletion occurred. CI/CD remains disabled.

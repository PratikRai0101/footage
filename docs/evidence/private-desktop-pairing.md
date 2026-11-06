# Isolated private-desktop pairing evidence

G1 implementation only. No production routes, native module exports, app configuration, UI, existing transfer owner, or sealed-protocol files changed. Main iOS remains preview-only. This is not a completed G1 acceptance gate or background-upload integration.

## Implemented interfaces

`apps/server/src/pairing.ts` exports `PairingAuthority.open(config)`. Its result separates the receiver authority from a trusted desktop-only `local` controller.

- `local.createOffer` creates a bounded binary QR and a two-minute, one-use in-memory offer. Restart discards pending offers, not enrolled devices.
- `inspectEnrollment` verifies canonical P-256 proof of possession before it exposes display data. `local.approve` binds the exact enrollment body and a subset of offered scopes. There is no approval HTTP endpoint.
- `enroll` atomically persists the device, wrapped control credential, scopes, epoch, and expiry before returning the signed record. Replay cannot enroll a different public key.
- `challenge` and `recover` bind the offer, enrolled device, operation magic, receiver, exact origin, and nonce. Challenges last 60 seconds and consume once. Both operations share a durable per-device limit of ten requests per minute. Recovery returns the same credential, not a replacement key or enrollment.
- `authorize` checks the credential, own-device ownership, epoch, permission subset, and intake or environment/project scope. `assertActiveEpoch` is the integration check for an ingest commit under the common job lock.
- `local.revoke` durably increments the epoch once and denies later authority and recovery. Repeated revocation returns that same epoch. `local.rotation` signs a strictly increasing transition. Neither API mutates existing job bindings.

SQLite uses WAL, `synchronous=FULL`, and immediate enrollment/recovery transactions. The authority requires a private directory and database, refuses a symlink database, and checks every wrapped enrolled credential at startup. A missing, locked, or replaced wrapping backend blocks startup. No plaintext receiver identity private key or control credential is persisted in the database.

`PairingKeyStore.wrap/unwrap` is an injected authenticated, context-bound OS wrapping-key boundary. There is deliberately **no production backend or fallback**. The test listener uses an ephemeral in-memory AES-GCM wrapping key. It is not an OS credential-store implementation.

`pairing-wire.ts`, `PairingWire.swift`, and `PairingWire.kt` implement the G0-corrected G1 binary records. QR bytes cap at 2,048, CA DER at 1,024, identity SPKI at 128, and origin at 512. Pairing requests and replies cap at 16 KiB. Enrollment proves possession before offer consumption. A zero permission mask is canonical and grants no operation, including an authorization request with operation mask zero. Native clients independently verify the signed record, native device key, credential digest, permission mask, exact origin, and fresh nonce before installation.

The Swift `PairingClient` persists the pending offer and P-256 private key before enrollment. One Keychain item atomically installs the credential and record with `AfterFirstUnlockThisDeviceOnly` accessibility and synchronization disabled. Missing storage is an error, not key regeneration. The Kotlin client has a native `PairingDeviceVault` boundary. `PairingAndroidVault` uses non-exportable AndroidKeyStore P-256 and AES keys, authenticated encrypted state in a private no-backup directory, `AtomicFile`, explicit file sync, and directory sync.

No client returns keys or credentials through a JS interface. Pairing clients expose installation status, not secrets. Rotation verification returns an uninstalled candidate for future native confirmation, never an automatic identity change.

## Actual iPhone Simulator proof

`python3 scripts/pairing-probe/run.py` passed all 17 cases on a newly created iPhone 16 Simulator, iOS 26.2, arm64, built with Xcode 27.2 build 27B52. Xcode compiles the production `Pairing*.swift` files with a standalone UIKit runner. There is no Expo or React runtime in this test app.

The test uses disposable private TLS certificates and native app-scoped anchors. It never installs a root certificate in an OS trust store. ATS arbitrary loads and local-network exceptions are both false. The tested private TLS hostname is loopback `localhost`, not a LAN `.local` hostname.

The successful cases prove the following behavior:

- Explicit synthetic local approval leads to one enrollment and a verified Keychain installation. Challenge recovery verifies and reinstalls the same credential.
- A listener commits enrollment, drops the reply, and closes the connection. A new native client instance reads the saved pending key and recovers successfully without another enrollment.
- Native parsing rejects every truncated QR prefix and a trailing byte. Common canonical DNS, IPv4, and compressed IPv6 origin cases agree with Node and Kotlin.
- An old-key-signed rotation verifies. Reusing its epoch fails. Verification does not activate the candidate.

The negative listener cases prove the following behavior:

- Wrong leaf key, hostname, CA chain, expired leaf, future leaf, expired anchor, missing server-auth EKU, and missing SAN receive **zero pairing-body bytes**. The HTTP QR is rejected before a request.
- Same-origin, alternate-port HTTPS, and HTTP redirect sinks each receive **zero bytes**. The authenticated initial receiver does receive the enrollment request before sending its redirect. These are foreground pairing control operations, not background URLSession uploads.
- Forged record signatures and replies over 16 KiB never install credentials.
- A 401 Basic challenge does not use synthetic credentials seeded in the app's shared credential store. Cookies seeded in shared storage, and cookies returned by the listener, never appear on enrollment or recovery requests. All 17 cases record zero Cookie and Authorization headers.

Swift uses an ephemeral session with cookies, URL cache, and shared credential storage disabled. It restricts requests to compiled pairing paths on the QR origin. The trust delegate checks the exact host and port, TLS policy, independently acquired anchor-only chain, all certificate dates including the anchor, exact SAN, server-auth EKU, and the leaf SPKI pin. Redirects and other authentication challenges cancel. The listener receives no body before those checks pass.

The alternate-port test is a redirect after an independently trusted origin, not a claim that a newly scanned, explicitly approved QR cannot name another port. There is no API for callers to override the paired request origin.

## Android source and JVM proof

`python3 scripts/pairing-probe/jvm.py` compiles all four production Kotlin pairing files against Android 36 and Kotlin 2.3.0. It then passed the same 17 listener cases on JDK 21, including signature interoperability, lost response, rotation, response bounds, anchor expiry, zero-byte sinks, and shared cookie/auth isolation.

The Kotlin transport uses a dedicated TLS socket, an anchor-only trust manager, explicit dates, SAN, EKU and pin checks, and HTTPS endpoint identification. It completes the handshake before writing application bytes. It has no HTTP redirect, cookie jar, credential manager, cache, or HTTP fallback. Its HTTP response parser has bounded headers and bodies.

**This is JVM networking evidence, not an Android app or emulator run.** The JVM test injects an in-memory signer and state store. AndroidKeyStore, Android TLS-provider behavior, `AtomicFile`, and Android backup/lock behavior have compile coverage only. No AVD was started or modified.

## Receiver and repository checks

The six receiver pairing tests cover concurrent offer consumption, expiry, replay, bad proof before consumption, exact local approval, permission/scope subsets, own-device authority, same-key recovery, challenge replay/expiry, rate limits, durable rotation/revocation, pending-offer loss, restart, private-file refusal, and wrapping-key loss. They exercise public methods and signatures, not source assertions.

`npm test` passed all 32 server tests, 20 mobile-presentation tests, and six device-tool tests. `npm run typecheck`, `npm run lint`, and `git diff --check` passed. Public-history preflight is run after committing the intended files because it refuses an uncommitted tree.

Raw certificates, keys, QR records, databases, build logs, and native results stay under ignored `artifacts/pairing-probe/`. Generated runs use private directories. The runners stop their own listeners and delete their own Simulator. The existing Simulator and existing AVD were not used. No physical device, personal media, existing secret, T3 action, cloud build, account operation, push, or new checkout was involved. Free disk remained about 34 GiB after the runs.

## Unfinished activation gates and parent reconciliation

- A real desktop OS wrapping-key backend, provisioning and key-loss UI are missing. The authority cannot be activated with the test backend.
- Native QR scanner, independent acquisition, receiver/origin confirmation, desktop approval UI, and explicit re-pair UI are missing. The test runner acts as the local operator for generated identities through a local file, never a network approval route.
- Actual shared Expo 58 app builds, AndroidKeyStore execution, LAN private-host onboarding, local-network denial, and physical-device evidence are missing. Loopback Simulator success does not prove those conditions. Protected-data behavior has no physical-device proof.
- No production HTTPS adapter or credential-bearing setup/control transport is activated. Its future adapter must enforce the configured listener origin, streaming bounds, fixed paths, and operation-specific permission bits. It must not infer authority from Host or forwarded headers.
- The receiver job owner must use `assertActiveEpoch` at commit and coordinate revocation/cancellation under its existing common job lock. This slice neither cancels active generations nor changes already received originals. Destination access must be rechecked against the desktop's current target permissions during setup. Old-job adoption by a new enrollment remains forbidden without a separately approved recovery flow.
- The parent must reconcile pairing identity/epoch types with the other worker's G2 codec. G1 records stay separate here. No sealed-protocol file changed. The binary field order and G0 corrections are unchanged. Local policy selects seven-day enrollments, ten challenge/recovery requests per minute, and two-minute rotation candidates. Rotation fetching, trusted confirmation, and activation are intentionally absent.
- G3 through G7 remain required. Nothing here enables real iPhone upload, substitutes foreground upload, or claims whole-job background completion.

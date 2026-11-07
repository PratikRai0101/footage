# Implementation status — 0.6.0

The remaining requested implementation is complete: **paired Android upload parity and phone-side T3 destination selection/delivery/send controls**. This is a working shared local prototype, not production/store certification.

## Implemented

- One Expo iPhone/Android app, preserving the approved full-frame layout, Instrument Serif and charcoal/warm-white palette. Coral identifies an actual confirmed destination, never an example thread.
- Native private connection-file import, explicit trust/destination confirmation and desktop-approved enrollment on both platforms. The phone chooses only from the computer's authorized destination catalog; changing the next destination cannot redirect an existing original.
- Both platforms stage/hash and fully preseal originals after Upload original. Swift and Kotlin implement the same canonical G2 format and use the same HTTPS receiver, shared original publication and matching Jobs receipt. No video bytes, upload credentials, signing keys or generation masters cross the JS bridge.
- iOS retains the tested native background URLSession/ledger lifecycle. Android retains its existing native TransferOwner and API26–33 foreground-service/API34+ user-initiated-job schedulers, with AndroidKeyStore-wrapped pairing/job state, durable seal intents, immutable ciphertext retries, authenticated original-byte progress and final receipts. A saved paired job never falls back to plaintext tus.
- Android closes the job-bound active data socket on cancellation/scheduler stop. Cancellation remains pending while the receiver is unreachable; cleanup is reported only after authenticated confirmation. A matching committed receipt wins. Received originals/receipts are archived rather than replaced by the next job.
- Both ordinary Release apps completed a **79,595,914-byte/two-group** upload after Home; receiver and native state reached received before returning to the app. Generated fixtures only. These are Simulator/emulator results, not physical lock/Doze evidence.
- **Phone-side T3:** Settings → Choose destination selects a real desktop-allowlisted thread. After a matching original receipt, Send to thread requires a separate native confirmation. Save to thread without starting agent is separate. Purpose-bound native HMAC requests prevent replaying a view/status query as send consent.
- Desktop T3 delivery verifies the exact same-host environment/project/thread/workspace, streams/hash-checks the original into `.footage-originals/`, and persists immutable target/receipt/message/request/credential-namespace state. Explicit send queues a text reference without interrupting active work. There is no large-attachment limit bypass or direct T3 database edit.
- Both apps exercised lost send replies, changed the next destination, explicitly cold-reopened, and retried the original destination without duplicate accepted messages against an owned local MCP fixture. No live T3 account was sent a message; no Cardboard action or paid generation was run.
- Paired read-only viewing remains separate from write authority. iPhone uses the pinned viewer; Android downloads through pinned native sockets, independently hashes the received bytes, and plays/shares a private cached copy without installing a global CA.

## Boundaries retained

Apple background URLSession may redirect; only immutable ciphertext/public framing may follow it. Exact-origin pinned, nonredirecting control and authenticated G2 outcomes remain mandatory. Preparation needs the app open. No user-force-quit automatic-restart guarantee is made; explicit reopen reconciles the same job.

The paired service admits up to **1 GiB**, within quota/disk budgets—not the binary 4-GiB ceiling. The legacy Android private-network receiver remains available as an explicit separate setup, never a paired-job fallback. Desktop wrapping currently supports macOS only. The phone catalog is an explicit allowlist (up to 16 destinations), not unrestricted T3 browsing or credential discovery.

## Verification still required

- Physical iPhone/Android lock, LAN denial, network switching, Android power/Doze and sustained large-original behavior. Emulator AndroidKeyStore execution does not certify hardware backing.
- Live T3 compatibility/delivery using the user's chosen credential/target, then a separately authorized Cardboard inspection/edit. The owned contract fixture does not certify a personal account.
- Broader release operations: retention/repair, replacement-generation migration, Windows/Linux wrapping and private-CA sharing across external browsers. These are not claimed as production-ready.

Six historical test-only macOS Keychain items still lack exact IDs. Do not enumerate/delete unrelated credentials. Current fixtures record exact namespaces before initialization and delete only their own item, even when shutdown fails.

## Run and evidence

See [RUN.md](RUN.md) and [0.6 acceptance](evidence/mobile-parity-0.6.md). Earlier version-scoped evidence remains historical. Local checks and public-history preflight precede push. GitHub CI/CD stays disabled; no billing, deployment, app-store submission or personal-device/media access is authorized by these tests.

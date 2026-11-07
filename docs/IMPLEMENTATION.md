# Implementation status — 0.5.0

Status describes the actual local prototype, not store/physical-device certification. GitHub CI/CD remains disabled; checks run locally.

## Implemented and exercised

- Approved full-frame layout, Instrument Serif and charcoal/warm-white styling, unchanged.
- **Ordinary iPhone Release app:** native Files selection with retained original URL grant, real metadata/preview, private computer connection import, explicit native trust/destination confirmation and operator-approved enrollment. Before connection, Preview only is deliberate.
- **Native original ownership:** after Upload original, stage/hash/full-preseal, durable ledger, encrypted file-backed background URLSession tasks, original-byte confirmed progress and authenticated matching receipt. No video bytes, signing keys or upload credentials cross the JS bridge.
- **Actual ordinary-app background completion:** a generated 79,595,914-byte, two-group MP4 completed at the receiver and reached native `received` while the app remained backgrounded after Home. The receiver was paused until background state was observed. This was not a lifecycle-fixture app or a foreground-only uploader. See [current evidence](evidence/normal-app-0.5.md).
- Consecutive uploads durably archive earlier originals/receipts before reusing the active slot. Cold relaunch restores the current receipt. Cancellation records intent; offline cleanup is not represented as completed deletion.
- **Mac receiver:** explicit HTTPS provisioning, app-scoped trust, local enrollment approval, macOS Keychain wrapping, bounded sealed ingest, shared durable Jobs receipts, supervised finalization and receipt-gated read-only viewing. Conservative admission is **1 GiB**, within quota/disk budgets; the binary 4-GiB ceiling is not advertised capacity.
- **Explicit T3 handoff on the computer:** allowlisted same-host environment/project/thread/workspace selected at receiver configuration. `deliver JOB_ID` streams and independently hashes the original into the exact workspace without starting an agent. `send JOB_ID` separately queues a text reference, with durable target/receipt/request/auth-namespace identity and uncertain-result reconciliation. No active-thread following, large-attachment limit bypass or direct T3 database modification.
- T3 handoff uses an explicitly supplied outside-client credential. The owned MCP contract fixture tests lost replies, restart, duplicate/concurrent retry, wrong/archived targets and original integrity. **No live T3 account was sent a message, and no Cardboard action was run.** There is no phone-side send button.
- One shared Expo app retains the existing Android native tus/foreground-service/user-initiated-job path. Android paired connection/T3 workflow parity is not claimed; Android still uses its existing receiver setup.

## Run it

See **[RUN.md](RUN.md)** for the private connection-file flow, Mac receiver, operator commands, explicit T3 configuration and platform limits. Build outputs remain ignored local artifacts, not a store distribution.

## Background safety and activation scope

Apple background URLSession can follow redirects without consulting the redirect-veto callback. TLS/ATS-only protection was experimentally rejected. The implemented transport allows **immutable ciphertext/public framing** to redirect, never original plaintext or reusable write/delete authority. Exact-origin pinned nonredirecting control and authenticated G2 outcomes remain mandatory.

The integrated engine has native ledger/recovery/fault tests and actual paired Expo OS wakes before JS, including durable handoff while a separate remote control response remains pending. Exact session-ID AppDelegate routing preserves unrelated Expo behavior. The held-control lifecycle fixture has its documented startup rendezvous; it is not silently relabelled as natural scheduling or ordinary production configuration.

**Scoped activation decision:** normal 0.5 local-prototype controls are enabled only after explicit authorized native connection, following the ordinary-app acceptance above. This supersedes the earlier blanket "normal controls remain disabled" milestone. It does not assert that all [G1–G7 release gates](architecture/sealed-background-upload.md) passed or weaken any cryptographic/authority check. Production/store acceptance remains **NO-GO** pending the following work.

## Still required for broader release

- Physical iPhone protection/lock, LAN permission denial, network changes and sustained large-file behavior; no user-force-quit automatic-restart guarantee.
- Current Android native/device acceptance and paired T3 workflow parity. Historical Samsung/API33 results are version-scoped, not current release certification; JVM pairing does not prove AndroidKeyStore.
- Live, explicitly authorized T3 compatibility/dispatch acceptance and separately requested Cardboard inspection/edit. Contract-fixture success is not a real-account end-to-end claim.
- Viewer sharing across devices with private-CA trust, receiver retention/repair, replacement-generation/operator migration workflows, and Windows/Linux wrapping backends. Reserved destination-list transport remains unavailable; selected destinations currently come from the authenticated private connection export.
- Six historical test-only macOS Keychain entries lack exact IDs and remain unresolved. Do not enumerate/delete unrelated credentials. Current fixtures record their exact namespace before initialization, refuse to overwrite unresolved cleanup metadata, and delete only that item.

## Delivery discipline

Small coherent commits; local tests/typecheck/lint and public-history preflight before push; clean worktree. No GitHub automation, billing changes, deployment, personal-media inspection or real agent/Cardboard action is implied by this implementation. Earlier design/probe documents remain historical and version-scoped.

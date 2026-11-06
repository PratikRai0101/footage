# Sealed background originals: independent review and implementation contract

**Review date:** 2026-11-06. **Status:** reviewed design proposal; not integrated or enabled. This review was performed independently, without child agents. Production app/server sources, Android behavior and CI/CD remain unchanged.

## Overview

**GO for building isolated vertical slices of B under this contract. NO-GO for enabling real uploads or claiming completion until gates G1–G7 pass.** A (TLS/ATS alone) stays rejected. iPhone background upload and Android support are both acceptance requirements; foreground-only is not a substitute.

B's fundamentals pass conditional security review: authenticated encryption can keep originals confidential when background URLSession redirects, provided redirectable requests contain only immutable encrypted packets and public framing. A captured packet authorizes replay of exactly its original range at exactly its bound receiver/job/generation, not arbitrary writes or deletion. Only authenticated committed outcomes advance accepted original progress. Control authority stays in native storage and nonredirecting, authenticated operations. A redirect sink may relay a packet and return a genuine receiver acknowledgment; that is valid progress only because the chosen receiver actually committed those exact bytes.

This is a change of **mechanism**, not of the confidentiality/authority invariant. It is not a no-redirect transport. It does not conceal timing, size, opaque upload identity or traffic relationships. It does not protect against a compromised chosen receiver, phone/native runtime or desktop credential store. Shared-key HMAC authenticates the receiver-key-holder boundary to this client; the client also knows the key and can produce the MAC. **It is not public third-party attestation.**

The proof demonstrates one chunk, CryptoKit/Node interoperability, rejection of a forged acknowledgment and 64 MiB daemon continuation in an owned Simulator while the app was backgrounded and SIGSTOPed. It deliberately does not implement pairing, durable receiver keys/ranges/final receipts, multiple tasks or Expo cold launch. These are known scope boundaries, not newly discovered bugs. The independent review did find one proof-harness defect, fixed separately below.

### Key concepts

- **Original identity:** exact staged bytes, size and SHA-256; no video export, codec conversion, orientation rewrite or metadata rewriting.
- **Binding:** receiver identity + canonical exact HTTPS origin + job + generation + immutable manifest + explicit destination. Settings and the active T3 thread cannot change it.
- **Frame:** bounded AES-256-GCM plaintext input. **Group:** immutable file-backed task containing several frames. Original, frame and ciphertext byte counts are different units.
- **Accepted range:** authenticated and durably committed original bytes. Socket progress is only activity.
- **Final receipt:** the single receiver-owned original outcome after assembly, whole-file hash and durable publication. A group acknowledgment is not a receipt.
- **Native runtime:** owns plaintext, secrets, sealing, daemon tasks, reconciliation and cancellation without React/JS execution.

## Grounding: how the existing system works

React Native's `useTransfer.ts` commands a native owner and observes a sanitized snapshot. Android `TransferOwner.kt` stages and hashes the original, syncs it, persists one job in `TransferState.kt` using `AtomicFile`, and uses tus-java-client with redirects disabled. Service/job schedulers are execution adapters, not separate success authorities. The capability remains native. Receipt matching gates Received, and local cancellation persists before remote cleanup. Existing HTTP/private-network settings are a spike, not authenticated pairing.

The foreground Swift foundation on `t3/ios-foreground-upload-slice` (`f91b1ab..1d5d530`, remote `work/ios-upload-core`) has useful copy/hash, mutation checks, durable identity, cancellation-before-stop and matching receipts. `TransferHTTP.swift` vetoes redirects in ephemeral sessions. Its owner deliberately stops on loss of foreground; its store and plaintext are `.complete` protected. Its lazy Expo module singleton is **not** a native cold-launch owner. Reuse the staging/receipt concepts, not the foreground suspend/manual-Continue policy or plaintext protection changes disguised as lifecycle support. Main remains iOS preview-only.

Receiver `server.ts` routes both control and tus under a per-job in-process promise queue. It waits for tus storage completion rather than response socket delivery (the aborted PATCH/queued HEAD regressions matter here). `jobs.ts` stores capability hashes, terminal outcomes and pre-registration cancellation in SQLite. `/complete` streams the stored original hash before `Jobs.receive`. Cancellation and receipt publication share the lock; an already received job wins. The lock is single-process only. The installed `@tus/file-store` writes through a stream and reports offsets from file size; that alone is not the file-fsync/SQLite publication ordering specified here. `jobs.ts` enables WAL but does not explicitly configure the new durability contract.

`viewer-access.ts` exchanges a one-use read code for a short-lived read-only browser session. It is separate from write/cancel authority. Neither that viewer nor a T3 dispatcher may acquire sealed-ingest keys. Existing receipt fields (`id`, `jobId`, `bytes`, `sha256`, `verifiedAt`) remain the shared original outcome, extended with authenticated binding—not a second iOS success database.

## Independent findings and concrete gates

| ID | Severity / classification | Evidence and conclusion | Required gate |
| --- | --- | --- | --- |
| R1 | **Medium, actual research-harness defect; fixed** | `listeners.mjs` invoked `adversarialChecks(b)` before authenticating `b`. Its tamper test flips the last ciphertext byte and calls mutating `accept`. Send an authentic packet with that byte already flipped: the self-test restores it, commits the authentic original, then the actual request returns 400. The same ordering existed in `/verify-captured`. The live listener regression initially failed because a receiver file existed after rejection. | Authenticate the incoming packet without side effects before synthetic checks; fixed only in the research listener. New live tests prove rejected mutations publish no file. Do not copy synthetic attack checks into production ingest. Full Simulator run was not repeated after this ordering-only fix. |
| R2 | **High if omitted from integration; known design gap, not proof exploit** | The probe's generated CA and `/setup` secret are not authenticated private-desktop onboarding. Existing origin validation accepts private HTTP; that cannot carry production setup/control secrets. | G1: independent pairing trust, exact HTTPS origin, permission/revocation tests on both platforms before any real upload. |
| R3 | **High integration gate; known scope** | Probe `accept` has in-memory job keys/offset and unsynced test file output. Its authenticated ack cannot promise recovery after receiver crash. Existing tus receipt persistence is not sufficient evidence of power-loss-safe sealed range publication. | G3: file/DB crash ordering, range map, original assembly and one durable receipt, fault-injected at each boundary. |
| R4 | **High integration gate; known scope** | One probe task and one response buffer do not implement task-specific callbacks, stable task mappings, multi-group scheduling or no-JS relaunch. Foreground Swift cannot supply those guarantees. | G4/G5: native ledger/session reconstruction and a whole-job no-JS multi-task run in built Expo 58; later physical-device acceptance. |
| R5 | **Medium integration gate; declared metadata exposure** | Probe public JSON includes original SHA-256 and uses delimiter strings. The generated UUID/number/hash domains make no demonstrated ambiguity exploit in this probe; this is not a general production schema. | G2: fixed binary schema below; no original hash or filename in public group framing; bounds/overflow/differential parser tests. |
| R6 | **Evidence limitation, not crypto certification** | `verify.py` consumes sanitized assertions, not independent raw network or cryptographic evidence. The runner checks wire hash equality before sanitizing, but `safe-summary.expected` drops the native wire hash, so the verifier cannot independently redo that equality. It also cannot reconstruct authentication from exported keys (intentionally absent). | Retain the bounded evidence claim. Live Node tests independently exercise listener bytes and MACs; add Swift/Node vectors and built-app adversarial acceptance before activation. Do not label the verifier a security certification. |

**Attack assessment:** changing ciphertext, range, job, generation or destination must fail authentication/binding; returning 200/204, `Upload-Offset` or a public-context fake ack must not count. Authentic packet replay and genuine ack relay are intentionally permitted, not bypasses. Replay cannot revive a cancelled/expired generation. No general credential is placed on a background request, including headers supplied by caches, cookies, credential storage or a shared session. The probe does not prove production resistance to resource exhaustion; bounded parsing is mandatory. No new plaintext/key-disclosure or arbitrary-authority exploit of B's cryptographic construction was found.

## Caller usage first (design only)

The following APIs and bodies are **not implemented**. They belong only in this document until their slice is built and tested.

```ts
// Shared JS UI: command/observe only. A URI is an opaque local selection handle,
// not bytes, an upload path, a key or a capability. Pairing uses a native scanner.
await transfer.pairFromDesktop();                // native UI + explicit trust confirmation
const destination = await transfer.chooseDestination(); // explicit standalone or exact T3 choice
await transfer.prepare({ selection, destination });     // copies/hash/seals; truthful preparation
await transfer.start();                         // resumes the same durable native job
const snapshot = await transfer.current();      // accepted ORIGINAL bytes, never wire offsets
await transfer.cancel();                        // durable intent; may remain cleanupPending
const view = await transfer.viewer();           // only after matching original receipt
// No queueFrame(), decrypt(), acknowledge(), supplyToken() or JS refill callbacks.
```

`chooseDestination` returns a non-secret opaque native handle to an immutable, locally persisted confirmation record, not caller-editable authoritative T3 IDs. Candidate identities come from the authenticated desktop, are permission-checked there and are shown for explicit user confirmation; `prepare` resolves that exact handle and binds it to its one job. Reject stale/unconfirmed/consumed handles and never resolve them through the current active thread. `prepare` captures the confirmed destination once. A changed setting applies only to a future job. `start` refuses incomplete preparation, expired/revoked pairing, incompatible receiver or disk failure; it never falls back to plaintext/foreground tus on iOS. Returning from `start` means the durable scheduling command was accepted, not that all daemon tasks are running or that the receiver has the original. Repeated commands use the same job/operation identity. One active job remains the initial shared-app limit.

## Two viable lifecycle/storage sketches

These are whole-shape alternatives. Both preserve frame authentication, durable outcomes and native ownership.

### Sketch A — full presealed, framed transfer groups (selected)

Stage/hash the complete original while active and unlocked; authenticate setup; seal all bounded frames into immutable group files; persist every group and task binding; enqueue/resume the batch before declaring background preparation complete. For an illustrative v1 layout, 8 MiB frames aggregate into 64 MiB groups. A 4 GiB original gives 512 frames and 64 tasks, **not** 512 JS-dependent wakes or one 4 GiB in-memory `Data`. These are proposed protocol limits, not measured optima, memory guarantees or throughput claims.

- Foreground preparation is an honest prerequisite. If the app locks/backgrounds halfway through preparation, it does not claim a background-capable whole job. Preserve/clean partials on next unlock; no UIKit grace-period workaround is relied upon.
- Once the complete batch is scheduled, the daemon has every body file. Native callbacks need not read `.complete` plaintext or encrypt more frames under lock.
- App-owned disk is approximately original + full ciphertext + ledger; OS-owned task snapshots may add substantial disk. Keep original for preview/recovery until outcome retention permits removal. Check/reserve space, handle ENOSPC at every step and test daemon overhead; do not promise a universal `2N` free-space rule.
- Bound memory by a frame pipeline, not a whole group. CryptoKit may copy buffers: <=8 MiB plaintext input is not <=8 MiB RSS. Measure peak memory separately.
- A lost partial task may resend the entire group (up to proposed 64 MiB); already committed groups dedupe. No dependence on URLSession support for a separate resumable-upload draft protocol.
- Few sessions, one batch, no encryption refill wake chain. OS still controls start time, connectivity, retry and completion delivery. Task-count/resource limits must be verified in the built app.

### Sketch B — bounded preseal window, native event-driven refill

Keep the original staged, seal/enqueue a bounded multi-group window (for example four 64 MiB groups), then replenish a batch when native completion events free slots. A durable frame cursor and key/allocation journal live in the native owner; JS never schedules the next window. Received ranges and final receipt are identical to A.

- Disk is original + window + unsafely uncertain tasks retained until reconciliation; memory still frame-bounded. Total task count is comparable to A, but many task creations occur after background wakes.
- Apple's resume rate limiter and discretionary treatment of work started in the background can delay refill. It cannot guarantee uninterrupted upload of the rest of a large original. Batch refill mitigates, not removes, that constraint [S1].
- To refill while physically locked, original bytes must be available after first unlock. That is an explicit weakening from the foreground foundation's `.complete` staging policy. Otherwise stop refill at lock and report waiting-for-unlock; queued packets can finish, but the whole job may not.
- Refill may run out of permitted execution time midway through sealing; journal partial output and consumed seal identities, persist a continuation, and never assume another immediate wake. BGProcessing may be optional opportunistic help, never the correctness dependency.
- A viable lower-storage mode if its delayed/locked preparation boundary is accepted, but it has more hidden lifecycle state and needs separate locked-original policy consent/proof. It is not selected as the initial fulfillment of reliable whole-job background intake.

| Dimension | A: full preseal | B: bounded window |
| --- | --- | --- |
| OS wake/rate dependency after queueing | Events/recovery only; no refill required | Repeated native refill batches; delays may stall remaining bytes |
| Illustrative 4 GiB task count | 64 queued group tasks | 64 total, window queued at once |
| App-owned disk | ~2 originals plus overhead | Original + window + uncertain ciphertext |
| Encryption memory | Bounded frame inputs/copies | Same, plus background-time pressure |
| Retry amplification | Up to one group per lost partial attempt | Same group bound, plus refill recovery |
| Access after first unlock | Ciphertext/ledger/keys only; original stays `.complete` | Original also needs after-first-unlock access for locked refill |
| Public JS interface depth | One preparation/start/observe surface | Same surface, more internal cursor/refill/lock policy |
| Honest boundary | Finish preparation while active/unlocked first | Only window prepared; completion can wait for native execution/unlock |

**Synthesis decision:** select A, with small independently authenticated frames aggregated into larger immutable file-backed groups. It is the smallest supportable shape because it removes the refill scheduling problem and avoids weakening staged plaintext protection. It is not the lowest-disk choice. If measured disk/task limits make A impractical, revisit B explicitly rather than silently shipping partial-window behavior as whole-job background support. Do not add dozens of one-method wrappers for framing, scheduling and status: two deep owners suffice, native runtime and receiver encrypted ingest.

## Where things live / responsibility and type sketch

Planned files are ownership assignments, not new compiled stubs:

| Owner | Responsibilities / existing integration |
| --- | --- |
| `modules/footage-transfer/ios/TransferOwner.swift` + `TransferModel.swift` (foreground branch) | Evolve into one native runtime and durable ledger. Stage/hash, pairing references, immutable job, seal allocation, group files, URLSession delegate, verify outcomes, recovery, cancellation. A serialized worker/actor owns mutation; callbacks never block main-thread networking. |
| `modules/footage-transfer/ios/TransferHTTP.swift` | Nonredirecting exact-origin authenticated control transport only. No reuse as a background plaintext transport. Native pairing/trust logic is private to the runtime. |
| `modules/footage-transfer/ios/TransferAppDelegateSubscriber.swift` (planned) | Thin native launch/event bridge to the same runtime, no independent jobs or success state. Register in local `expo-module.config.json`; do not depend on lazy JS module construction. |
| `modules/footage-transfer/src/contracts.ts`, native module, `useTransfer.ts` | Shared command/snapshot schema. Both platforms produce the same original receipt outcome; no key or envelope APIs. Keep local preview handle but no raw media over bridge. |
| Android `TransferOwner.kt` / `TransferState.kt` | Keep no-redirect tus execution. Add shared pairing/destination/receipt binding at its control boundary; native Android staging/services remain platform-specific. |
| `apps/server/src/sealed-ingest.ts` (planned) | One deep module: bounded wire parsing, key derivation, authenticated quarantine, group dedupe/ranges, storage ordering, original assembly, outcome envelopes and repair. Not a tus offset adapter. |
| `apps/server/src/jobs.ts`, `contracts.ts`, `server.ts` | Authoritative common job/generation/destination/receipt and cancellation lock; route sealed ingest explicitly. Durable schema migration and shared publication coordinator for tus and sealed. Never two success ledgers. |
| `viewer-access.ts`, future T3 delivery owner | Read-only grants and post-receipt delivery/dispatch respectively. Neither owns transfer success; dispatch requires separate immutable consent and idempotent delivery record. |

```swift
// Design-only domain sketches: constructors validate; verified wrappers are private-init.
struct ReceiverBinding { let identity: Digest32; let origin: ExactHTTPSOrigin; let pairing: PairingID }
struct OriginalIdentity { let bytes: OriginalByteCount; let sha256: Digest32 }
enum Destination {
  case standalone(intake: UUID)
  case t3(environment: OpaqueID, project: OpaqueID, thread: OpaqueID,
          workspace: OpaqueID, consent: UUID)
}
struct Manifest { let canonical: Data; let digest: Digest32 } // decoded immutable fields below
struct SealedGroup { let index: UInt32; let range: OriginalRange; let file: URL; let wireHash: Digest32 }
struct TaskBinding { let session: String; let taskID: Int; let job: UUID; let generation: UUID; let group: UInt32 }
struct VerifiedAck { private init() {} /* validated range, manifest, wire hash, revision */ }
struct VerifiedReceipt { private init() {} /* shared original receipt + complete binding */ }
enum LocalOutcome {
  case preparing, ready, transferring, reconciling, verifying
  case cancelRequested, cancellationUnconfirmed, cancelled
  case received(VerifiedReceipt)
  case blocked(RecoveryReason) // no key/file, revoked pairing, storage integrity, expired
}
final class TransferRuntime {
  func prepare(_ selection: NativeSelection, destination: ConfirmedDestination) async throws { /* not implemented */ }
  func start() async throws { /* not implemented: idempotent ledger + daemon reconciliation */ }
  func cancel() async throws { /* not implemented: durable intent first */ }
  func snapshot() throws -> TransferSnapshot { /* not implemented */ }
  func restoreBeforeJavaScript() throws { /* not implemented */ }
  func handleBackgroundEvents(_ identifier: String, completion: @escaping () -> Void) { /* not implemented */ }
}
```

```ts
// Design only; derive production types from Zod/binary codecs at the boundary.
// OriginalBytes, JobId, GenerationId, Digest32, Revision and ConfirmedDestination are validated brands.
type Transport = { kind: 'tus' } | { kind: 'sealed-v1' };
type ReceiverOutcome =
  | { kind: 'uploading'; revision: Revision; committedGroups: GroupBitmap }
  | { kind: 'received'; revision: Revision; receipt: BoundOriginalReceipt }
  | { kind: 'cancelled' | 'expired' | 'failed'; revision: Revision };
interface EncryptedIngest {
  setup(input: AuthorizedSetup): Promise<NativeOnlySetupReply>;
  ingest(input: BoundedBody): Promise<AuthenticatedOutcomeBytes>;
  status(input: AuthorizedFreshQuery): Promise<AuthenticatedOutcomeBytes>;
  revoke(input: AuthorizedFreshQuery): Promise<AuthenticatedOutcomeBytes>;
  repairOnStartup(): Promise<void>;
}
// Jobs owns the single mutation serialization/publication boundary for both transports.
interface JobPublication {
  withJob<T>(id: JobId, operation: (job: LockedJob) => Promise<T>): Promise<T>;
  publishOriginal(input: VerifiedDurableOriginal): Promise<BoundOriginalReceipt>;
}
// Function bodies are intentionally absent here; no production placeholder implementation is authorized.
```

The native runtime owns task-level state independently of the job outcome: `sealIntent -> sealed -> taskBound -> resumed -> responseUncertain | authenticated`. Job cancellation blocks every scheduling transition, including callbacks already queued. `received` is terminal and requires a matching final receipt. An `executionActive` flag is observational, never an outcome. Snapshot `confirmedBytes` is the authenticated contiguous original prefix; optionally expose accepted sparse bytes under a different name, never as percent complete by default. Preparation/sealing progress must not masquerade as receiver progress.

## G1 — pairing and control authority (must prove before real uploads)

### Private-desktop onboarding

1. On a desktop the user already controls, explicit **Pair phone** creates a random 32-byte one-use offer secret and offer ID, expiring after two minutes by desktop clock. Desktop displays a native/local trusted-screen QR containing protocol version, receiver identity/public key, app-scoped CA DER, expected TLS leaf SPKI SHA-256, canonical exact HTTPS origin, offer ID/secret, expiry and requested permissions. Bound QR <=16 KiB. Scanning a QR from the untrusted receiver web/network response is **not** independent authentication. If using manual pairing instead, independently compare the full fingerprint through an already authenticated channel; a code obtained over the same untrusted HTTP link does not qualify.
2. Native scanner shows receiver/origin and requests explicit confirmation. No setup secret, device credential or offer proof is sent until TLS has validated the independently acquired chain/key **and exact host/port/SAN**. Require TLS >=1.2, valid certificate dates, server-auth usage, exact public key pin and hostname policy. Trust only this pairing's CA within this app/session, never install a global CA. Reject redirects even to the same origin for every pairing/setup/control operation. If ATS disallows this private certificate/name on a supported OS, refuse onboarding: no arbitrary-load allowance, silent HTTP or accept-all challenge fallback.
3. Over that authenticated ephemeral connection, submit offer ID/secret, a fresh nonce, native-generated device P-256 signing public key and desired permission set. Desktop independently displays/approves that device and exact permissions. Atomically consume the offer (including concurrent requests), persist enrollment and return a random device control credential plus signed pairing record binding receiver/origin, device key/ID, permissions, revocation epoch and expiry. Credential retrieval after a lost response requires a fresh challenge signed by the same enrolled device key; the offer cannot enroll another device or replay an old response. Fresh challenges are one-use, expire in 60 seconds and bind operation/offer/device/receiver/origin. Native verifies the pairing record before durable installation.
4. Initial permission-mask bits are `0x01` create-own-upload, `0x02` query-own-job, `0x04` revoke-own-unreceived-job, `0x08` mint-own-received-view and `0x10` list-allowed-destinations; reject any other bit. Persist allowed intake IDs and T3 environment/project scopes in the desktop enrollment record and enforce them for each destination lookup/setup. These permit only uploads within that scope, own-job control and read-only views for own received originals. No general desktop shell, T3 account token, all-threads scope or delete-received permission. Desktop keeps its long-lived T3 credentials. Desktop enforces scopes at setup and rechecks target access, not just UI filtering. Store device secret/signing key and job secrets in native Keychain/Android Keystore-backed storage, never JS settings.
5. Desktop revocation increments a durable device epoch and denies new control/setup and uncommitted ingest for its active generations; cancel/expire them under the job lock. Already received originals remain received. Lost/revoked credential requires explicit re-pair; offer secrets and pending offers are not persistent authority. A revoked phone may remain locally blocked/cancellation-unconfirmed because it can no longer query control. Explicit desktop-approved recovery must authorize access to that same old job before a newly enrolled device can reconcile it; do not infer cleanup from a 401/403.
6. Reissued TLS certificates with the same pinned key may remain valid under the paired CA/date/name policy. New identity/key or origin requires explicit native approval of an old-key-signed transition binding old/new keys, origin and strictly increasing epoch, fetched over the old authenticated channel; compromised/lost old key requires independent re-pair instead. Never learn a new pin from a TLS failure/redirect. Existing manifests retain old bindings; finish/revoke against the old authorized identity or create a new generation after reconciliation. Do not rewrite in-flight destinations during rotation.

Pairing endpoints are fixed, nonredirecting HTTPS routes: `/pair/v1/enroll`, `/pair/v1/challenge` and `/pair/v1/recover`. The canonical QR record is `"FTQR0001" || identitySPKI:LP16 || caDER:LP16 || tlsPin32 || origin:LP16 || offerUUID16 || offerSecret32 || expiresAt:u64 || permissionMask:u32`. Enrollment body is `"FTENRL01" || offerUUID16 || offerSecret32 || deviceUUID16 || deviceSPKI:LP16 || nonce32 || permissionMask:u32`. It is sent only after the QR-authenticated TLS checks above. Reply is `"FTENRO01" || controlCredential32 || pairingRecord:LP32`; the signed record challenge field must equal the enrollment nonce. Challenge request is `"FTCHAL01" || offerUUID16 || deviceUUID16 || nonce32`; reply is `"FTCHLO01" || nonce32 || serverChallenge32 || expiresAt:u64`. Recovery body is `"FTRECV01" || offerUUID16 || deviceUUID16 || nonce32 || serverChallenge32 || signature:LP16`, signed by the enrolled device over all preceding bytes plus receiverID32 and origin:LP16. Challenge lookup/recovery is rate-limited and only for the already approved device; a public offer ID reveals no credential. Recovery consumes the challenge atomically and returns the same control credential with a newly signed pairing record binding the fresh nonce. Signature requests expire after 60 seconds. All pairing bodies/replies are <=16 KiB, reject trailing bytes, and use the G2 encoding rules. Persist the native pending offer/device key before enrollment; a lost native key requires a new user-approved offer, never public-key replacement on recovery.

Receiver identity is `SHA256(DER SubjectPublicKeyInfo)` of its persistent P-256 identity key, separately from TLS leaf SPKI if different; desktop signs pairing/rotation records with that identity key. Canonical signed record encoding uses the same primitive encoding rules as G2 with distinct 8-byte record magics (`FTPAIR01`, `FTROT001`). Pair record fields in order: receiver ID, origin LP16, device UUID, device public key LP16 (DER SPKI), permission mask u32 (unknown bits rejected), epoch u64, expiry u64, controlCredentialSHA256:32, challenge32, then signature LP16 (DER ECDSA-SHA256). QR fingerprints/CA authenticate this identity before accepting the signature. Rotation fields: old receiver ID, new identity SPKI LP16, new TLS pin32, new CA DER LP16, new origin LP16, next epoch u64, expiry u64, challenge32, signature LP16 by old key. Sign exactly the bytes preceding the signature; no JSON canonicalization or low-entropy human code used as a key.

**Pairing proof gate:** in actual iPhone and Android builds, prove own app-scoped CA/private hostname support without global trust edits, correct hostname/key/origin rejection, no secrets reaching redirect/HTTP/forged certificate endpoints, concurrent offer consumption, expiry/replay rejection, lost-response recovery for the same device, explicit permissions, rotation and revocation. Include local-network denial and certificate expiry failures. The generated-CA Simulator experiment does not satisfy this gate. Until then, only synthetic isolated tests; real upload controls stay disabled.

### Control transport

Only native code sends device credentials in Authorization to fixed nonredirecting exact-origin HTTPS routes. Disable cookies, shared credential storage, cache and automatic auth reuse. Paths are compiled constants plus validated IDs, never server-supplied `Location`/upload URLs. Responses are capped while streaming (64 KiB control; 4 KiB ingest outcome). Bearers authorize control; a fresh random 32-byte generation master from a CSPRNG independently protects content/outcomes. **Never derive it from a bearer.** Desktop persists that master wrapped by a local OS-credential-store wrapping key before acknowledging setup; losing it blocks recovery, it does not justify recreating it under the same generation. Native stores the returned master before sealing. Setup is idempotent by `(device, job, generation, manifestDigest)`; exact retry returns the same secret/limits, changed binding conflicts. A timed-out setup is reconciled, not replaced with a new identity automatically.

## G2 — canonical schema, immutable binding and cryptography

### Encoding and limits (proposed sealed-v1 contract)

All authenticated records are exact binary concatenations in the listed order. Integers are unsigned big-endian, no variable integer encoding, floats, optional omitted fields or trailing bytes. UUIDs are 16 network-order bytes. Digests/MACs/keys are 32 bytes. `LP16` = u16 byte length followed by those bytes; `LP32` analogous u32. UTF-8 must be valid, NFC and canonical before hashing; IDs are opaque, case-sensitive, <=128 UTF-8 bytes. Reject reserved bits/unknown variants and noncanonical encodings. Compare MACs with CryptoKit verification/Node constant-time comparison after checking length. Production binary codecs must have independent Swift/Node vectors and fuzz boundaries.

Canonical origin: `https://` + lower-case ASCII A-label DNS name (no trailing dot), canonical dotted IPv4 or bracketed RFC5952 IPv6, **explicit decimal port** 1–65535, no path, userinfo, query, fragment, percent escapes or IPv6 zone. Input normalization is shown to the user before confirmation; the canonical origin itself is <=512 bytes. DNS/network changes cannot change the pinned identity. A new host/port is a new binding, even with the same certificate.

Initial negotiated limits are fixed by the manifest and cannot be relaxed by an ingest header: original 1..4 GiB inclusive; frame 8 MiB except final remainder; group 8 frames/64 MiB except final remainder; <=512 frames and <=64 groups; at most one active native job and one background session. Total control manifest <=64 KiB, group header exactly 128 bytes, wire body <=64 MiB + 512 bytes, ingest response <=4 KiB. Proposal expiry is at most seven days from setup. These are design bounds, not performance results. Gate measurements may motivate a versioned lower-limit profile before activation; do not accept arbitrary server chunk sizing. Use UInt64/BigInt for wire arithmetic and checked addition/multiplication before converting to platform indices; convert to JS Number only after checking the <=4 GiB original bound. Never truncate u64 to signed 32-bit. Reject zero, overlaps, holes, oversized final frame, duplicate indices and index/range inconsistency before allocating buffers.

### Private manifest and destination

`manifest = "FTMAN001"[8] || receiverID32 || origin:LP16 || jobUUID16 || generationUUID16 || deviceUUID16 || enrollmentEpoch:u64 || destination:LP16 || originalBytes:u64 || originalSHA256:32 || safeName:LP16 || expiresAt:u64 || frameBytes:u32 || framesPerGroup:u16 || frameCount:u32 || frameSHA256[frameCount]`.

`destination` is exactly one of:

- `0x01 || intakeUUID16`: an explicit receiver standalone inbox chosen by the user, not a fabricated T3 target.
- `0x02 || environment:LP16 || project:LP16 || thread:LP16 || workspace:LP16 || consentUUID16`: exact desktop-resolved immutable identities authorized when the user confirms. Workspace is a receiver-owned stable identity, never a caller-supplied filesystem path. Active-thread changes are irrelevant. If the target is unavailable or access changes, retain the original outcome and report delivery blocked; do not choose another thread.

Hash canonical manifest bytes with SHA-256. `safeName` is <=240 UTF-8 bytes, NFC and excludes control characters/path separators; store under server-generated names regardless. Original hash, name, frame hashes and destination details stay on the authenticated control path/encrypted native storage, not in public group framing. The public manifest digest includes random job/generation IDs, rather than being an unsalted original fingerprint. Still disclose linkage/size; do not claim metadata anonymity. Native computes frame hashes during stable staging and compares them during sealing, detecting mutation before using keys. Verify staged size/identity before and after sealing, and total hash against the staged identity. No mutable selected URI is re-read for retries.

Setup: `POST /sealed/v1/setup`, authenticated control only, binary manifest as body. Reply is `"FTSET001" || manifestDigest32 || master32 || expiresAt:u64`; exact URL/status/content-type/body length and manifest/expiry must match. The receiver validates authorization and immutability before storing it. Generation UUID is fresh for every replacement, and master is independent fresh randomness. A job has one current generation; superseding an unreceived generation first durably tombstones it under the job lock. A received job cannot be superseded. Protocol selection is persisted at registration: no mixing tus writes and sealed ranges for the same generation.

### Public group / frame wire

`POST /sealed/v1/ingest` is the only redirectable body route. No Authorization, cookies, control proof, key, secret URL query, user filename, original SHA or arbitrary metadata headers. Content-Type is `application/octet-stream`. No automatic compression or content encoding. The body is:

| Group header (exactly 128 bytes) | Size |
| --- | ---: |
| ASCII `FTSEAL01` | 8 |
| receiverID | 32 |
| job UUID, generation UUID | 16 + 16 |
| manifest digest | 32 |
| group index, first frame index (u32 each) | 4 + 4 |
| frame count (u16), reserved zero (u16) | 2 + 2 |
| original offset (u64), original group length (u32) | 8 + 4 |

Each frame follows as `frameIndex:u32 || originalLength:u32 || sealID16 || nonce12 || ciphertext[originalLength] || tag16`. Exactly the deterministic manifest partition is allowed; no extra bytes/frames. Each frame's AAD is `"FTBODY01" || exactGroupHeader128 || frameIndex:u32 || originalLength:u32 || sealID16`. Native computes `wireSHA256` over the entire exact group file. A group is accepted atomically; valid prefix frames in a truncated/invalid group are not accepted ranges.

HKDF-SHA256 with salt `manifestDigest`, master IKM and 32-byte output derives:

- frame key: info `"footage/sealed-v1/body" || frameIndex:u32 || sealID16`;
- ack key: info `"footage/sealed-v1/ack"`;
- final-receipt key: info `"footage/sealed-v1/receipt"`;
- status/revoke-outcome key: info `"footage/sealed-v1/status"`.

AES-256-GCM only, 12-byte nonce, 16-byte tag, no custom cipher or truncated authentication tag. Each frame key is used for **one encryption invocation**. Native durably records a CSPRNG sealID and `consumed` seal intent before calling CryptoKit; a crash/throw does not authorize resealing with that key. Generate a random nonce for that invocation, persist its exact output, sync and atomically rename before marking sealed. Enforce distinct sealIDs within a generation. With <=512 independent 128-bit sealIDs the birthday collision bound is below 2^-110 even without that check; nonce reuse under a given key is prevented structurally by one encryption, not by hoping a reused counter survives a crash. On missing/corrupt sealed output or uncertain sealing intent, abandon that generation after reconciliation/revocation and use a new generation/master; do not recompute a possibly published frame. Retry **exact saved ciphertext**, never reseal it. Protect the ledger from backup rollback, exclude spool/ledger from backups and bind device identity. Missing Keychain items after restore are a blocked job, not key regeneration.

Group files become read-only, native-private immutable objects until every daemon reference is gone. Validate their size/hash before initial scheduling and retry; never overwrite a queued filename. Detect missing/mutated plaintext or envelopes and fail closed. Retain uncertain ciphertext/keys through retry/revoke resolution. Secret cleanup and original retention are explicit native operations, not JS garbage collection.

### Outcome envelopes

For all outcomes, fixed record fields are parsed/bound before construction of a verified domain value; transport status/header/final URL/wire count alone never authenticates anything.

- `AckPayload = "FTACK001" || receiverID32 || job16 || generation16 || manifestDigest32 || groupIndex:u32 || wireSHA256:32 || originalOffset:u64 || originalLength:u32 || revision:u64`. Ack is `payload || HMAC(ackKey, payload)`, exactly 192 bytes. It proves that full group is durably committed, not whole-file receipt. Client requires exact ledger wire hash/range/manifest. Different groups may complete out of order and return older revisions: adding that immutable committed range is allowed unless local cancellation/terminal state forbids it; high-water revision is `max`. No sparse range becomes a contiguous prefix through a hole.
- `ReceiptPayload = "FTRCPT01" || receiverID32 || job16 || generation16 || manifestDigest32 || destinationDigest32 || receiptUUID16 || verifiedAt:u64 || revision:u64`. Receipt is payload + HMAC(receiptKey,payload). This is the authenticated envelope for the **same** authoritative receipt row used by tus/content/viewer/delivery. Original size/hash are bound by the immutable manifest digest and key derivation, not unnecessarily echoed in this publicly replay-obtainable response. Native verification materializes the shared receipt's `bytes`/`sha256` from its bound original identity; an arbitrary JS/caller identity cannot supply them. The receiver's durable receipt row retains the actual verified size/hash. Timestamp is UTC seconds; adapters render `verifiedAt` as ISO8601. Extend shared receipt validation with generation/receiver/manifest/destination binding while preserving original ID/bytes/hash fields; old unbound jobs remain explicitly legacy, never silently upgraded.
- Ingest response is `"FTOUT001" || ack:LP32 || finalReceipt:LP32` (empty finalReceipt means not yet finalized). Max 4 KiB. Only HTTP 200 with complete bounded canonical envelope is eligible for direct acceptance. Other outcomes/errors are uncertain and trigger authenticated reconciliation, never accepted progress. A valid final receipt returned via a relay is still genuine for that job, not a new authority grant.
- `POST /sealed/v1/status` and `/sealed/v1/revoke` are nonredirecting authenticated control routes. Request is `"FTQUERY1" || job16 || generation16 || manifestDigest32 || operationUUID16 || challenge32`; route distinguishes operation. Revoke operation UUID persists across retries. Fresh random challenge per attempt; matching response required.
- Status payload is `"FTSTAT01" || receiverID32 || job16 || generation16 || manifestDigest32 || operationUUID16 || challenge32 || revision:u64 || state:u8 || cleanup:u8 || expiresAt:u64 || groupBitmap:u64 || contiguousOriginalBytes:u64 || finalReceipt:LP32`, followed by HMAC(statusKey,payload). State codes are 1 uploading, 2 verifying, 3 received, 4 cancelled, 5 expired, 6 failed. Cleanup is 0 not applicable, 1 pending, 2 complete; cancelled/expired/failed require 1 or 2, other states require 0. Only authenticated cleanup=2 confirms remote partial cleanup. Every durable state/range/cleanup mutation increments the same revision; no-op/replayed ingest returns its original persisted ack revision. Group bit `i` is integer bit `1 << i`; out-of-range bits must be zero. Require recomputed contiguous prefix from the manifest partition to equal the payload. Received must include matching final receipt; other states must not. Revision may not decrease from the locally observed high-water mark; challenge/operation cannot be replayed from another query. Authenticated response includes current state, not a cached revoke result bearing an old challenge.

Local cancellation is a monotonic intent independent of receiver revision. Even a fresh uploading status or valid late ack must not change it to uploading. An authenticated already-committed **final receipt** may resolve the cancel race to received. Replay of a prior final receipt is fine because received is immutable. A cancelled/expired generation rejects every ingest before key derivation/range commit; it cannot return an old accepted ack as if current acceptance were legal. Expiry stops new commits under the lock, not halfway through a commit; receipt already committed wins. Cancellation and expiry do not mean deleting a received original.

## G3 — receiver commit, crash recovery and publication

Use a single receiver writer process initially; route tus and sealed mutation/finalization/cancellation through the **same job lock**. A process-start exclusive storage lock prevents a second writer opening this storage. No claim of replica-safe locking. Do not hold the mutation lock while an untrusted socket slowly fills quarantine: stream first with quota/time limits, then recheck current generation/state/expiry under the lock before commit. One process may initially admit one encrypted group body at a time, bounding quarantine and crypto memory; reject excess with retryable backpressure. Reserve storage at setup, including plaintext groups + assembled original + bounded quarantine, not just declared original bytes. Existing demo 20-job/8-GiB budgets must account for this amplification. Quota failures never publish an ack.

1. Validate method, content encoding/type, header and computed manifest partition before allocation. Enforce wire limit independent of Content-Length and for chunked bodies; reject mismatched lengths, trailing bytes, stalled uploads and excess connections. Parse incrementally into native-private quarantine files (0700 directories/0600 files). Do not log bodies, secrets or selected names. Unknown receiver/job/generation/binding fails closed; unauthenticated input cannot create a job. Each listener is provisioned with its canonical service origin and receiver identity: require both to equal the stored manifest binding. Do not infer this authority from an untrusted Host or forwarded header, accept another listener/port as an alias, or resolve a redirect target into a new binding.
2. For each bounded frame, use CryptoKit/Node authenticated open. Node `decipher.update` output is untrusted until `final` succeeds [S6]. Keep it in bounded memory/private quarantine; never expose it to content/viewer/tus, mark ranges, or invoke media tooling. Require exact manifest frame hash/length. A late invalid frame deletes the whole uncommitted group quarantine. Public framing is only routing/limits until authentication succeeds.
3. Under the common lock recheck authorization epoch, generation, state and expiry. If group already committed with same wire hash, return its persisted ack without rewriting; conflicting wire hash conflicts even if alternative ciphertext decrypts to identical bytes. Reject overlapping or out-of-partition writes. Sync verified plaintext group temp, rename to its deterministic immutable group object, **fsync the parent directory**, then transact SQLite range row + wire hash + ack bytes + incremented revision. Configure/verify `journal_mode=WAL`, `synchronous=FULL` and transaction boundaries explicitly. Only return ack after commit. Group file persistence precedes DB visibility; SQLite rollback does not roll back the filesystem.
4. Startup repair runs before serving mutation: remove unreferenced quarantine/renamed orphans (no ack was issued before their DB commit); retain referenced objects; verify referenced sizes/hash or checksum metadata before claiming healthy status. A committed range whose file is absent/corrupt is a storage-integrity failure, not an empty range or automatic `ensureUpload` recreation. Freeze that job, refuse new accepted status/receipt and expose recovery-required through authenticated control. Never silently lower a previously acknowledged prefix or synthesize the missing bytes. Repair from exact retained native packets requires an explicit recovery workflow/new generation; receipt-bearing corruption is an incident, not cancellation.
5. Compute contiguous accepted ORIGINAL offset from the durable committed-group map starting at zero. Do not use last group received, wire length or filesystem size of an out-of-order assembly. Exact retry returns persisted ack; revisions and receipts survive process restart. Request disconnects must release quarantine resources and eventually the lock after storage processing; response delivery is not the lock lifetime.
6. After all groups commit, the receiver itself durably schedules finalization; it must not require JS or an iPhone `/complete` call. Stream concatenate groups in canonical original order into a new private original temp; verify total size and original whole-file SHA-256, sync, rename to the common original-store path and fsync its directory. Under the common job lock recheck cancellation and atomically store the one final receipt, immutable original reference, terminal received state, revision and durable finalization/delivery-event record. An external crash between rename and receipt leaves an orphan that can be verified and finalized or safely rebuilt, never a visible unreceipted original. The receipt row is published only after the original is durable. Keep groups until publication is durable; garbage collection is idempotent.
7. If cancel wins before that transaction, no receipt can subsequently publish. If receipt wins first, cancellation returns that same authenticated receipt. Hash mismatch becomes terminal failed with no publication. Finalization worker and cancellation use the same lock; hashing may occur outside it but publication must recheck state. The last ingest response may wait for finalization and carry the receipt, or carry ack only; the durable worker finishes independently and status later returns the receipt. Timeout/lost final response leaves native `verifying/reconciling`, not false success. Receiver restart resumes unfinished finalization from durable state without JS.

Extend the existing common `Jobs` receipt/publication boundary for tus too: do not create sealed-only finality while Android publishes through a weaker, divergent success path. A migration adds immutable transport/generation/binding fields and explicit durability checks, preserving existing receipts as legacy. The completed original stays at a common receiver-owned content reference; viewer/content no longer assume every original came from a tus file path. A sealed envelope must never be appended to `/files/:id`, nor may its offsets become tus original offsets.

Generation master keys persist encrypted at rest using a desktop OS credential-store wrapping key, with protected backups/rotation policy; the DB stores a key reference/wrapped master, not an unprotected general control credential. Startup without the wrapping key is blocked, not reset-to-empty. Partial plaintext and completed originals require private filesystem permissions and a documented retention policy. Content/viewer routes enforce received state even if an orphan original happens to exist on disk.

## G4 — native ledger, launch and protected data

Use one stable versioned session identifier, e.g. `footage.sealed.background.v1`, across native launches, not one per job/task. `sessionSendsLaunchEvents = true`; file-backed uploads only. Cookies/cache/shared credential storage disabled. Set network/cellular policy from explicit user settings and reasonable expected byte counts, but `isDiscretionary = false` is not an immediate-execution guarantee. Work created while already in background may be treated as discretionary [S1].

Durable ledger owns job/manifest binding/key reference, group files/digests/seal intents, task associations, authenticated ranges/revisions, final receipt and cancellation/revoke operation IDs. Use transactional native SQLite with explicit sync policy or equivalently proven journaling; the existing `.atomic` JSON alone is not proof of all task-creation crash windows. All access uses one native serial owner; events/commands cannot interleave cancellation with a post-cancel `resume`.

Scheduling/recovery protocol:

1. Sync each sealed group file/rename/directory and durable sealed row. Persist the complete manifest and generation secret before any daemon task is created.
2. Persist a random non-secret local correlation UUID with the sealed group row, then create a **suspended** upload task from that immutable file; assign that UUID as its task description. Persist `(sessionID, taskIdentifier, job, generation, group, wireHash)` before `resume`. Then resume and record scheduling state; a crash after resume but before recording it remains reconcilable. Task descriptions/URLs contain no key/capability/filename/selected URI.
3. Native startup (ordinary and background) opens the ledger/Keychain and reconstructs the stable session **before JS**. Call `getAllTasks` and join by session/task ID and correlation ID. Existing bound task wins; never enqueue a duplicate just because an in-memory task pointer vanished. Suspended bound tasks may resume only if not cancelled/expired and files match. Unknown or duplicate tasks are cancelled; their remote outcome remains uncertain and is reconciled before replacement. A task created before its mapping transaction crashed is an orphan, cancelled and reconciled, not blindly adopted by URL alone.
4. Ledger-bound but missing task means response uncertain. Query authenticated status, recover committed groups/final receipt, otherwise retry the same sealed file after applying local cancellation/expiry. A lost response never authorizes advancing offsets or resealing. Missing key/envelope produces blocked recovery; no plaintext or foreground fallback. Complete cancellation tombstones are reconciled before any scheduling on startup.
5. Delegate maintains bounded **per-task** response buffers and exact binding, not the probe's single shared `bytes`. On complete, verify response cryptography/context and durably apply it before notifying observers. If process dies before persistence, status reconciliation recovers it. App lock, suspension, SIGSTOP, OS jetsam/termination and user force-quit are distinct conditions. No automatic restart promise after user force-quit; user relaunch reconciles the same job, never creates a second upload.

Protection policy: original staging stays `.complete`, backup-excluded; do not silently set staged plaintext to after-first-unlock to make B's refill easier. Ciphertext spool, minimal ledger and its WAL/SHM/journals/directories use `completeUntilFirstUserAuthentication`, backup-excluded, with native-private permissions. Keep the full canonical manifest, filename, selected URI and display metadata in a separate `.complete` record. The minimal after-first-unlock ledger contains only the bound receiver/origin, IDs/digests, original size/hash, partition, key references, tasks and outcome/recovery data needed while locked; native callbacks must not need the private display record. Keys/control credentials needed for locked native event verification/revoke use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` [S4/S5]; record that at-rest policy explicitly. No secret in JS snapshots/events/logs/task descriptions or public protocol metadata. After reboot, before first unlock neither keys nor this ledger/spool are available: **unsupported execution interval**, not a promised upload/relaunch path. Handle protected-data-unavailable without deleting state or reporting empty/failed-received. After first unlock, event processing can proceed on later locks without opening the staged original. File protection of daemon-owned copies must be verified on actual devices; simulator SIGSTOP is not screen-lock evidence.

### Expo 58 background event handoff

Version-locked published sources were independently downloaded and their archive SHA-512 matched `package-lock.json`: `expo@58.0.21`, `expo-modules-core@58.0.28`, `expo-file-system@58.0.13` [S7]. `ExpoAppDelegate` forwards the background-session callback; the subscriber manager calls every responding subscriber and aggregates completions on main. A missing completion hangs aggregation; a duplicate can decrement it too early. Registration and runtime lifetime are therefore correctness/security boundaries, not just bridge plumbing.

- Native subscriber initializes/retrieves the same runtime during native launch; event handling must work with the React runtime never initialized. Validate generated module-provider/subscriber registration in an actual Expo build.
- For an unowned session identifier, call this subscriber's supplied completion exactly once on main, promptly. Do not recreate, invalidate or steal another module's session.
- For the owned identifier, durably drain task events and snapshot reconciliation state. Save a once-token for each supplied completion; never overwrite a pending handler. Reconnect the stable session. Once `urlSessionDidFinishEvents` arrives **and all prior event processing is durably recorded**, consume the token and invoke completion exactly once on main [S2]. Async worker results must be drained before token consumption. Multiple jobs/tasks completing in one wake do not multiply that callback.
- If storage/protected data is unavailable, persist a safe deferred/uncertain marker when possible; otherwise retain existing durable pre-event state and reconcile `getAllTasks`/receiver later. Complete after the event queue is safely drained/deferred, not after unbounded network retry/finalization or waiting for JS. Never turn a processing deadline into received/cancelled confirmation. Test callback-after-drain ordering, unknown identifiers, duplicate delivery and no handler leak.

The Expo filesystem example demonstrates bookkeeping, not a substitute for this ledger or permission to depend on JS acknowledgments. Its timeout is not a guarantee of OS background execution time. No background mode or unbounded background assertion is added merely to keep sealing code alive.

## G5 — cancellation, replay retention and truthful UI

1. Persist local cancel intent and revoke operation identity **before** cancelling tasks; stop sealing/resuming/retrying and scheduling immediately under the native owner. Cancel all matching daemon tasks (including duplicates found by enumeration). A callback queued before Cancel cannot escape this fence.
2. Use nonredirecting authenticated `/revoke` with fresh challenge. Offline/unavailable control means `cancellationUnconfirmed` / shared `cancelled { cleanupPending: true }`, not remote cleanup complete. Continue native opportunistic revoke and explicit relaunch retry using the same operation ID; do not re-upload to obtain cancellation.
3. Receiver durably tombstones the generation/state under the common lock before acknowledging revoke. Incoming quarantined packets recheck tombstone at commit; a previously acknowledged packet cannot resurrect it. Idempotent cleanup removes only unreceived partial/group/quarantine objects, with synced directory updates and retryable cleanup state. Revoke response confirms cancelled state, but `cleanupPending` stays true until receiver cleanup and local spool cleanup are both confirmed. No local file deletion while daemon references remain.
4. Final receipt already committed wins, and UI reports received with that receipt, even if Cancel was tapped while its response was lost. Received-original remote deletion is a separate future permission/operation, never a claim of this cancellation API.
5. Receiver accepts no new packet past manifest expiry; client schedules no retries past that expiry. Keep durable minimal job/generation tombstones indefinitely in v1 (bounded by enrolled-device/job quotas), retaining terminal receipt identity. Bulk partials/keys may be collected after expiry plus a proposed 30-day reconciliation period; no finite cleanup timer makes a deleted identity creatable again. Retry lifetime never extends manifest expiry. Device revocation or master deletion does not permit an old setup replay. Authenticated terminal reconciliation requires retaining the outcome keys through that period; after key retention expires, return an authenticated control-level expiry/refusal, never fabricate a new receipt/key for the old generation.

A T3 delivery record and dispatch consent are independent from transfer cancellation. Received does not mean thread delivery or agent invocation. Pin environment/project/thread/workspace and immutable message/dispatch consent IDs when explicitly confirmed; never follow the active thread, retry a different target or start an agent merely because intake completed. Keep viewer authority read-only and separate from control/device credentials; no viewer session on the background upload session. Android must retain no-redirect tus behavior while moving to authenticated pairing and the same bound final outcome.

## How it works end to end

1. User pairs a phone with an independently authenticated desktop and explicitly selects standalone intake or a precise authorized T3 destination.
2. Native copies/hashes the original, fixes immutable identity/destination and gets a durable per-generation master over nonredirecting authenticated setup. It fully seals bounded frames into immutable groups while active/unlocked.
3. Native durably binds and resumes the whole batch. Background URLSession may redirect encrypted packets, but holds no reusable control authority. The daemon needs neither JS nor the plaintext original.
4. Receiver bounds/parses/quarantines, authenticates all frames, durably commits original ranges and authenticates acknowledgments. Native only credits verified original ranges; gaps, timeouts and forged success stay uncertain.
5. Receiver assembles/hash-verifies and durably publishes exactly one original receipt, even with no phone/JS code running. Native gets a final receipt in an outcome or later authenticated reconciliation. It may remain verifying until a permitted native wake/reopen; it cannot infer finality from all bytes sent.
6. Read-only viewing and separately consented thread delivery use that same verified original. No transcode, fake destination or automatic T3/Cardboard action occurs.

## Implementation slices and go/no-go checklist

Each slice ends in behavioral evidence and review before integration. No default CI/CD re-enable or production route activation.

| Gate / order | Build and prove | Exit criterion |
| --- | --- | --- |
| **G0 — this review** | Review R1 correction, canonical proposal and selected A. | Parent accepts/revises this contract explicitly. This independent recommendation is not user authorization to deploy. |
| **G1 — pairing first** | Synthetic private HTTPS enrollment on native iPhone + Android, no global trust, negative redirect/key/hostname/replay/rotation/revoke tests. | No setup/control secret before independently authenticated exact-origin trust; actual supported private-host/ATS behavior recorded. Keep real uploads disabled otherwise. |
| **G2 — codec + crypto slice** | Pure Swift/Node vectors for manifest, frame/AAD/HKDF and all outcomes; fuzz truncated/oversized/trailing/overflow input, invalid tags, wrong destination/generation/range, response forgery and cross-domain MACs. | Both implementations agree byte-for-byte; no unauthenticated publication/progress; nonce crash-intent/retry invariants pass. Fixed version limits recorded. |
| **G3 — durable receiver slice** | Synthetic multi-group out-of-order ingress, duplicate/conflict/replay; crash at each sync/rename/DB/response boundary, key loss, missing/corrupt file, receiver restart and cancel/finalize races. Common receipt migration/tus regressions. | Same receipt across retries/restarts; original bytes/hash exact; status never advances on incomplete commit; no cancelled resurrection or second success ledger. |
| **G4 — native runtime slice** | Full-preseal bounded-memory pipeline, stable session ledger, crash before/after task binding/resume, `getAllTasks`, key/envelope loss, disk pressure, protected-data gating, cancellation-before-resume and stale status. | Complete batch can run without plaintext/JS after queueing; no duplicate identities or forged progress. Memory/disk/task budgets measured, not inferred from frame input size. |
| **G5 — actual Expo lifecycle** | Built Expo 58 with subscriber cold launch before JS, multi-task completion, Home/natural suspension, controlled OS termination vs force-quit, no-JS receipt/reconciliation, network loss, redirects/fake outcomes and receiver restart. | Background **whole-job** original commit + durable matching receipt, correct event completion exactly once/main-thread/after durable drain. Not only a resumed foreground test or one chunk. |
| **G6 — shared app acceptance** | Same UI/API, bound outcomes and explicit standalone/T3 destinations on Android tus + iOS sealed. Viewer capability separation, offline cancel, already-received race, immutable dispatch consent. | Both actual builds retain original fidelity/receipts and truthful state. T3 delivery/dispatch remains separately gated; no live dispatch in these tests. |
| **G7 — physical release evidence** | Later, with explicit authorization, real iPhone **and** Android: approved synthetic files, lock/unlock, no USB execution dependency, first-unlock/reboot limits, long jobs, OEM scheduling/network changes, measured storage/memory and cancellation. | Build/OS/device-scoped evidence meets the required iPhone background + Android behavior; no force-quit automatic-restart claim. This review uses no physical devices or personal media. |

**NO-GO conditions:** unproven independent pairing, redirectable secrets/plaintext, plaintext fallback, nonce reseal after uncertainty, accepting status/header/wire counts as committed original progress, no durable final receipt, no-JS lifecycle depending on the bridge, or Android regression. A failed gate must block activation—not become a caveat appended to a shipped success claim.

### Verification performed for this review

- Read the complete probe source (`Probe.swift`, `listeners.mjs`, `run.py`, `verify.py`), evidence and integration sources identified above. Inspected all 43 safe-summary cases of the recorded `b29f1a5d-f4b5-42d8-8821-07375fe84b5a` run, including stopped-process/socket ownership, hash and cleanup assertions. No raw keys/media/origins were copied into the repository.
- Reran `python3 scripts/ios-background-probe/verify.py <ignored-run>/safe-summary.json`: PASS, 43 cases. It validates the recorded run, not a fresh Simulator execution, pairing or security certification.
- Added `node --test scripts/ios-background-probe/listeners.test.mjs`: actual listeners, fresh disposable certificates and generated bytes, no global trust edits or npm install. Reproduced R1 before the fix; after the proof-only ordering fix, rejected ciphertext/header/range/hash/cross-job/truncated inputs publish no original. Exact replay preserves bytes/ack, alternative ciphertext conflicts, fake public-context ack fails HMAC, and captured packet relay succeeds only after the real receiver commit. Temporary material is deleted on exit. These tests do not test iOS networking or certify production parsing/lifecycle.
- Rechecked Node syntax, recorded verifier integrity assumptions, public-history preflight and diff whitespace checks. No full Simulator rebuild or production build was necessary for this review. No real device, selected media, existing credential, live T3/Cardboard, EAS/cloud/account/billing operation or push was performed.

## Gotchas

- App lock != suspended process != SIGSTOP != jetsam != force-quit. The recorded daemon proof supports exactly its stated Simulator condition, not all five.
- File-backed background URLSession automatically follows redirects; final-URL checks happen too late to protect plaintext [S1]. Pinning is defense in depth, not a rescue for A.
- Sealing after first unlock is not a promise to read `.complete` plaintext while locked. The chosen full-preseal design deliberately avoids needing to.
- A final receipt authenticates byte identity and chosen intake, not camera provenance, codec fidelity judgments or completed T3 delivery. HMAC is not public attestation.
- Authenticated old status is not necessarily fresh. Challenge + monotonic revision + irrevocable local cancel fence are all needed.
- Success is a durable original outcome, not a task finishing, ack count reaching total, server HTTP 200, file size, or encrypted wire bytes.

## Primary sources and evidence

Primary platform/package sources were retrieved independently on 2026-11-06. Apple DocC JSON for the listed pages was also fetched directly for readable source text; published Expo archives were checked against the lockfile, not guessed latest docs. Raw downloads remain outside tracked files.

- **[S1] Apple:** [Downloading files in the background](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background): separate process, stable identifier/reassociation, file-only uploads, automatic redirects, batching/rate limiter and discretionary background starts. [Build robust and resumable file transfers, WWDC23](https://developer.apple.com/videos/play/wwdc2023/10006/): retries may restart a nonresumable task, background scheduling is system-controlled.
- **[S2] Apple:** [urlSessionDidFinishEvents](https://developer.apple.com/documentation/foundation/urlsessiondelegate/urlsessiondidfinishevents(forbackgroundurlsession:)): reassociation, event-drain completion and main-thread UIKit handler. [DTS: background session force-quit limits](https://developer.apple.com/forums/thread/740564).
- **[S3] Apple:** [Performing manual server trust authentication](https://developer.apple.com/documentation/foundation/performing-manual-server-trust-authentication): hostname/trust evaluation, app pinning, ATS cannot be loosened by a trust callback, rotation. Custom trust feasibility must still be tested for the production private-origin policy.
- **[S4] Apple:** [completeUntilFirstUserAuthentication](https://developer.apple.com/documentation/foundation/fileprotectiontype/completeuntilfirstuserauthentication), contrasted with staged plaintext `.complete` policy.
- **[S5] Apple:** [kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly): background access after initial unlock; no migration to another device.
- **[S6] Apple/Node:** [AES.GCM](https://developer.apple.com/documentation/cryptokit/aes/gcm), [Nonce](https://developer.apple.com/documentation/cryptokit/aes/gcm/nonce), [CryptoKit streaming discussion](https://developer.apple.com/forums/thread/679889); [Node 22 Crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html), especially HKDF, GCM `setAuthTag`/`final`, tag length and `timingSafeEqual`. AEAD/HKDF/HMAC are established primitives; the wire protocol and storage contract here still need implementation review.
- **[S7] Published Expo 58 sources:** [expo 58.0.21](https://registry.npmjs.org/expo/-/expo-58.0.21.tgz) `ios/Expo/ExpoAppDelegate.swift:124–130`; [expo-modules-core 58.0.28](https://registry.npmjs.org/expo-modules-core/-/expo-modules-core-58.0.28.tgz) `ios/AppDelegates/ExpoAppDelegateSubscriberManager.swift:163–188`; [expo-file-system 58.0.13](https://registry.npmjs.org/expo-file-system/-/expo-file-system-58.0.13.tgz) `ios/Legacy/FileSystemBackgroundSessionHandler.swift`. Sources demonstrate callback infrastructure, not Footage integration.
- **Repository evidence:** [bounded transport proof](../evidence/ios-background-transport-probe.md), [original blocker](../evidence/ios-background-origin-blocker.md), [existing runtime walkthrough](engineering-walkthrough.md), receiver `src/{server,jobs,contracts,viewer-access}.ts` and `test/receiver.test.ts`, Android native owner/store, foreground branch Swift owner/model/HTTP/module. Installed `@tus/file-store` source was inspected for write/offset behavior; its stream completion is not a promised fsync transaction.

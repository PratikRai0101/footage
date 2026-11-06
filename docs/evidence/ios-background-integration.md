# Native outcome context and durable receiver integration

## Scope

This isolated G2/G3/G4 integration closes the locked-manifest API mismatch recorded in [iOS background runtime evidence](ios-background-runtime.md). Outcome verification, status, cancellation, and cold reassociation no longer open the full canonical manifest. The original and manifest retain `.complete` protection. Production upload activation remains **NO-GO**.

The standalone native app sends a generated multi-group original through production `BackgroundRuntime` and actual `SealedIngest`. G3 publishes the existing `Jobs` original receipt. The listener does not decrypt packets, assemble originals, mint acknowledgments, or invent finality itself.

The private test adapter injects synthetic control authority and an ephemeral explicit wrapping provider. It does not implement or prove G1 pairing. No production route, default provider, Expo subscriber, bridge, module registration, package, UI, or Android behavior changes.

## Minimal context API

Swift `SealedProtocol.OutcomeContext.fromManifest(_:)` and Node `OutcomeContext.fromManifest(m)` extract a validated immutable record while the complete manifest is available. Both constructors are private. There is no arbitrary-field factory or JS bridge API.

The canonical local-storage record is bounded to 1,024 bytes. Its fields, in order, are:

```text
FTCTX001 || receiver32 || origin:LP16 || job16 || generation16 || device16
|| enrollmentEpoch:u64 || manifestDigest32 || destinationDigest32
|| originalBytes:u64 || originalSHA256:32 || expiresAt:u64
|| frameBytes:u32 || framesPerGroup:u16 || frameCount:u32
```

All integers use the existing G2 big-endian encoding. The partition constants remain 8 MiB and eight frames. The count must equal the partition derived from the bounded original length. Origin validation, UTF-8, fixed field sizes, length limits, and trailing-byte rejection use the existing codec rules. UUIDs and expiry retain their binary domains. The existing shared receipt adapter still rejects incompatible UUIDs and receipt timestamps beyond year 9999.

`authentication(master:)` returns HMAC-SHA256 over `"footage/sealed-v1/context-storage" || canonicalContext` using the native generation master. `restore` requires that authentication and the retained master before parsing. This is storage authentication, not a new network envelope or public attestation. It prevents replacing the saved original hash or destination digest while retaining the old manifest digest and a genuine receipt.

The native ledger stores context bytes and authentication with its minimal saved identities. On durable load, `BackgroundRuntime` authenticates the context and compares receiver, exact origin, job, generation, device, manifest digest, original length/hash, expiry, and group count to the saved ledger fields. It also verifies a restored receipt and its shared profile before exposing a `received` snapshot. Ledger updates cannot replace that context or its authentication. Invalid records fail closed. The ledger version is now 2. Version 1 records are refused, not migrated by reading private storage while locked or replaced with empty jobs.

The context contains no filename, selected URI, destination IDs, or frame-hash list. The full manifest and original remain in the separate `.complete` directory. Context, ledger, ciphertext, and generation key retain their previous after-first-unlock policy. No weaker plaintext protection is introduced.

Swift `Keys(master:outcome:)` and Node `GenerationKeys.forOutcomes(master, context)` derive acknowledgment, receipt, and status keys from the exact original manifest digest. Existing full-manifest constructors remain. Body-key derivation, sealing, group authentication, and setup still require the complete manifest. Accessing `Keys.manifest` now throws when only outcome material exists. The corresponding Node getter also rejects that access.

The existing acknowledgment, receipt, and status verifiers now consume `keys.outcome`. They are not duplicated. Original receipt size/hash come from the authenticated context, never from another caller identity. Network `FTQUERY1`, `FTSTAT01`, outcomes, setup, and all KDF domains remain byte-identical. Swift `Query.encode(_:)` has a context overload. Its existing manifest overload remains nonthrowing. Swift query decoding adds `decode(_:outcome:)`; Node query encoding/decoding accept either validated type.

### Handoff to the G1 control owner

`BackgroundControl` now requires these native signatures:

```swift
func setup(_ manifest: SealedProtocol.Manifest) throws -> Data
func status(_ context: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data
func revoke(_ context: SealedProtocol.OutcomeContext, query: SealedProtocol.Query) throws -> Data
```

Setup is unchanged. Status and revoke must use the installed paired authority and the context's immutable receiver/origin/device/epoch/job/generation/digests. They cannot reopen private display data to resolve a destination or follow current UI selection. Any local authorization reference needed for these operations must be captured during authorized setup and remain available after first unlock. The receiver still authorizes against its own saved complete manifest and current scopes. A destination digest alone does not grant permission.

The adapter must retain exact-origin nonredirecting HTTPS, native credential storage, masks `0x01`, `0x02`, and `0x04`, response bounds, and fresh challenged queries. No installed-credential implementation is supplied here. Pairing and desktop OS wrapping remain owned by G1.

## Executed native and receiver behavior

Runner: `python3 scripts/test/ios-background-integration/run.py`. It builds the production G2/G4 sources into a standalone Swift 6 app with warnings as errors. It creates its own iPhone 16 Simulator on iOS 26.2, using Xcode 27.2 build 27B52. The same runtime sources also compile for the iPhoneOS SDK at the iOS 17 deployment target. These are not physical-device execution results.

The generated original is **67,121,209 bytes**, split into two fully presealed groups. Their exact saved ciphertext bodies total **67,121,933 bytes**. All bytes are native-owned. The app has no React runtime or JS data path.

The run establishes these facts:

- After preparation, the test sets the private directory's POSIX permissions to zero. A real `Data(contentsOf:)` read of the canonical manifest fails with `NSFileReadNoPermissionError`. The original and manifest retain `.complete` protection. This injects access denial; it does not certify physical screen lock.
- Explicit app termination and relaunch reconstruct the ledger and stable URLSession. Both task identifiers, correlation IDs, job, and generation remain unchanged. There is no duplicate native job or replacement task batch.
- Destination-scoped XCTest presses Home. The app records its background transition. The runner SIGSTOPs that exact owned app PID and observes the owned `nsurlsessiond` receiver socket before releasing the paused listener.
- While the app stays stopped, actual G3 authenticates and durably commits both groups, hashes the assembled original, and publishes the shared `Jobs` receipt without a phone completion call. Independent streaming of G3's receiving original matches that receipt's size and SHA-256. Each receiving wire hash matches its saved native packet. Background requests have no Authorization or Cookie header.
- The first real acknowledgment is returned with canonical framing and a corrupted HMAC. The final response is destroyed after actual G3 receipt publication. After SIGCONT and explicit XCTest activation, native callbacks reject the forged HMAC before any cancel command. Native state is blocked with zero confirmed bytes and no receipt. That activation occurs after durable receiver publication, not to continue a foreground upload.
- A cold native offline cancel persists its operation and cleanup-pending intent before stopping tasks. It does not report remote cleanup or discard the job.
- The runner stops only its own receiver process and reopens the same `Jobs` database and wrapped generation key. The exact authoritative receipt survives that restart. A mutated saved group is rejected by actual G3. An explicit exact-packet retry returns an outcome and preserves the same receipt and one job identity.
- A further cold native restore sends the challenged revoke query through the injected control adapter. G3 returns its already-committed receipt. Native reaches `received`, with all original bytes confirmed and the exact same receipt ID, job ID, original length, and independently computed receiving SHA-256. The receipt wins the offline cancel race. The private manifest read still fails with permission denial.

The test controller supplies setup/status/revoke through a private filesystem mailbox, not a listener route with bearer authority. Its explicit synthetic mapping checks the fixed device, owner, epoch, permission, credential, and standalone intake. The HTTPS listener exposes only exact `POST /sealed/v1/ingest`; other paths, query variants, and credential-bearing ingest requests are refused. Generated credentials and wrapping keys remain in ignored private artifacts. The listener calls only G3's public setup, ingest, and status APIs. It supplies no alternate decryption or receipt implementation.

Cold app termination can abort old sockets while the same daemon tasks reconnect. The runner checks those actual rejection causes and never counts rejected bodies as committed groups. Socket observation occurs before listener release, so a fast loopback transfer cannot make that observation race completion.

This proves explicit receiver reopen and exact-packet retry. G3 still has no periodic retry supervisor or production shutdown drain. The listener's process lifetime does not establish those missing service guarantees.

## Regression checks

The full existing `python3 scripts/test/ios-background-runtime/run.py` run passes **37 native cases**, including the original 32 cases with the former protected-manifest deferral expectation replaced by successful minimal-context verification. New cases cover access-denied acknowledgment/status/revoke, cold reassociation, minimal-context final receipt validation, substituted context authentication, changed saved original identity, and a forged restored received state. The latter failures occur before any restored success snapshot or new scheduling.

The full runner also repeats the existing consumed/encrypted/published abrupt-exit recovery checks and the separate 134,230,073-byte, three-group daemon regression. That older listener still publishes acknowledgments only, so its native outcome correctly remains `verifying`, not `received`.

The Swift/Node differential runner compares canonical context bytes and storage authentication in addition to all existing manifest, HKDF, AEAD, setup/query, acknowledgment, receipt, and status vectors. Both implementations verify the same outcome bytes using full and minimal material. Tests reject byte substitutions, truncation, trailing bytes, invalid partition fields, a changed manifest digest, mismatched expiry, body derivation without the full manifest, incompatible receipt UUIDs, and out-of-profile receipt timestamps. Root codec tests cover sparse/max partitions and verify that private display fields are absent from the context.

The native per-task 4 KiB response bound, oversized fake-success rejection, late callback cancellation fence, receipt-wins race, and durable event-drain checks remain enabled. No warning is suppressed.

Executed repository checks include `npm test` with 104 tests, root typecheck and lint, both codec/ingest test-tool typechecks, the actual Swift/Node codec runner, combined G1/G2/G4 Swift 6 warnings-as-errors compilation, Python and listener syntax checks, diff whitespace checks, and public-history preflight after local commits.

The final durable integration run is recorded in ignored `artifacts/ios-background-integration/2f60c4b7-0f1c-4239-900c-59ed6be4ca93/safe-summary.json`. The full runtime regression is recorded in ignored `artifacts/ios-background-runtime/3188b845-7f86-42a6-bf99-44680d0e5f99/safe-summary.json`.

Raw logs, generated keys, receipts, database files, and certificates remain under ignored `artifacts/ios-background-integration/`. The safe summary contains equality assertions and workload sizes, not credentials, local paths, network addresses, or device identifiers. The runner stops its listener, deletes its disposable Simulator, and restores only its own injected permission change for cleanup. It never uses the parent's Simulator, another AVD, physical devices, personal media, or existing credentials.

## Remaining gates

- G1 authenticated native pairing/control and the desktop OS wrapping backend are not proven here. The synthetic adapter is not a production substitute.
- G5 actual Expo subscriber registration, cold launch before JS, OS event handoff, deadlines, and multiple background wakes still require a built Expo app. Standalone no-JS execution does not prove Expo integration.
- Physical iPhone lock, first-unlock/reboot behavior, daemon-owned copy protection, natural OS termination, local-network denial, and resource budgets remain unverified. There is no automatic restart guarantee after force-quit.
- Android paired execution and the shared cross-platform app acceptance gate remain open. No Android source or behavior changes.
- G3 production service supervision, OS wrapping, retained-key cleanup, storage repair, and production routing remain gated. No new production G3 defect was needed to complete this isolated proof.

HMAC authenticates the shared-key holder boundary. The native client also holds that key; none of these receipts is public third-party attestation.

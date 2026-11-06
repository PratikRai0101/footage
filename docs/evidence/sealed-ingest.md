# Isolated durable sealed receiver evidence

## Scope

`apps/server/src/sealed-ingest.ts` implements the isolated G3 receiver component against the accepted G0 reconciliation and the existing G1 and G2 APIs. No pairing or sealed-protocol implementation changed. No production route instantiates this component. Normal `createReceiver` refuses a database containing sealed jobs because that entry point has no wrapping provider or paired authority.

This evidence covers synthetic receiver behavior on macOS with Node 22.23.1. It does not establish a completed G3 activation gate, iPhone background execution, Android native execution, Expo lifecycle behavior, physical-device behavior, or an OS wrapping backend. G1 and G4 through G7 remain open. No UI, native source, workflow, account, cloud build, live T3 action, or Cardboard action changed.

## Public component API

`SealedIngest.open(config)` requires an existing `Jobs` owner, its storage directory, the paired receiver authority, an authenticated context-bound wrapping store, and a synchronous current-destination access check. There is no default wrapping provider or permissive authorization callback. The production OS provider remains absent. Test code supplies fresh AES-GCM wrapping keys only in temporary private storage.

- `setup(manifestBytes, credential)` authorizes permission `0x01` for the manifest's owning device and destination. Exact retries return the same wrapped, independently random generation master. Changed bindings conflict. Setup validates the seven-day lifetime and the common job UUID profile before accepting packets.
- `ingest(request)` accepts an encrypted body without control credentials. It returns a bounded G2 outcome only after full authentication and durable commit. Unknown jobs cannot create authority.
- `status(jobId, queryBytes, credential, revoke = false)` authorizes `0x02`, or `0x04` for revoke. It returns the current authenticated state with the caller's operation and challenge. It does not cache an old response for a new challenge.
- `reconcileAuthority()` is a trusted local sweep after pairing revocation or target-access changes. It cancels only unreceived jobs under the common lock. Commit and final publication recheck authority even if the sweep has not run.

The integration converts the pairing identity and device bytes to canonical lowercase manifest hex. The configured exact origin must match. The codec validates the enrollment epoch as u64. Standalone intake bytes convert to a schema-valid hyphenated UUID before pairing scope comparison. T3 environment and project strings remain exact and case-sensitive. No request Host, forwarding header, redirect target, active thread, or caller-supplied filesystem path supplies authority.

## Common job and original publication

`Jobs.exclusive` owns the mutation queue used by the existing tus HTTP routes and sealed operations. A separate SQLite rollback-journal database holds an exclusive OS file lock for the owner's lifetime. A second owner fails, and process death releases the lock. This is one cooperative receiver writer, not replica-safe storage.

The authoritative result remains the existing `jobs` row. New fields record transport, the common original content reference, and sealed binding and range state. Existing rows default to legacy tus, and their receipts acquire no invented binding. New sealed receipts include receiver, generation, manifest digest, and destination digest. New receipt IDs use UUIDv4. The common receipt constructor rejects timestamps outside UTC years 1970 through 9999 before an original can publish.

`originals.ts` supplies both transports' publication path. It streams the verified original into a private temporary file, checks length and whole SHA-256, syncs the file, renames it, and syncs its parent directory. New directories and their parent links are synced too. Only then does `Jobs.publish` atomically commit the receipt, received state, content reference, and one `original_events` intake event. The event does not dispatch anything.

Tus retains its HTTP paths, request headers, capability behavior, resume offsets, completion call, and legacy receipts. Its new success path copies and verifies the tus original into the same durable common store. `content.ts` and the existing viewer enforce received state and refuse storage-integrity incidents. Their content path uses the stored reference rather than assuming every original is a tus file. A sealed packet never enters the tus store.

## Ingest ordering and recovery

The body parser enforces the wire cap while reading, including chunked requests without Content-Length. It checks the 128-byte header and manifest partition before frame allocation. G2 bounds each authenticated frame to 8 MiB. A deadline destroys stalled input. The component admits one encrypted body at a time, including its finalization. Additional bodies receive retryable backpressure. The explicit test-only adapter also caps connections and header time.

Authenticated frames remain in a private 0600 quarantine file under a 0700 directory. A bad final frame discards the complete uncommitted group. No valid prefix becomes an accepted range. Slow network reads do not hold `Jobs.exclusive`.

Under that lock, commit rechecks the current immutable generation, terminal state, epoch, target access, and expiry. An exact replay returns its persisted ack and original revision. Alternative ciphertext conflicts, even when its plaintext is identical. Seal IDs cannot repeat across committed groups.

The durable group order is file sync, rename, parent-directory sync, then SQLite range, wire hash, plaintext hash, ack bytes, and revision. Jobs configures and verifies WAL and `synchronous=FULL`. Socket response delivery does not define commit or lock lifetime.

The final group records `verifying` durably. The receiver concatenates groups in original order and publishes without a phone completion call. It continues after a response disconnect. Startup resumes a durable unfinished finalization without a client request.

Startup removes unreferenced quarantine and renamed objects. It verifies committed group length and checksum, ack authentication, seal uniqueness, and any received original and receipt. Missing or corrupt referenced storage freezes the job. Stored ranges and the receipt remain intact, but ingest and authenticated control refuse new accepted outcomes with a recovery-required error. Startup never recreates an empty replacement upload. A missing, locked, or replaced wrapping key blocks startup before repair.

Cancellation commits its tombstone before deletion. Cleanup stays pending during an in-flight quarantine or finalizer, or when storage is unavailable. Repeated cleanup is idempotent. A committed receipt wins a later cancel. Replay after cancel or expiry cannot restart the generation.

## Executed checks

`npm test` passes 103 tests: 77 server tests, 20 mobile presentation tests, and six device-tool tests. The server tests include 32 new sealed-ingest tests and three new common receiver tests. Existing codec, pairing, tus, and viewer tests remain enabled.

The sealed receiver suite uses actual owned loopback listeners, generated enrollments and credentials, file streams, and SQLite databases. Its HTTP adapter is test-only. It is not production TLS or onboarding evidence.

The tests cover:

- An original of 64 MiB plus 173 bytes, generated one frame at a time. The last group arrives first. Its bitmap bit survives restart while its contiguous original prefix remains zero. The first group triggers automatic finality. An independent streamed receiving hash matches the staged original identity, and the same authoritative receipt survives restart.
- Exact replay, conflicting valid ciphertext, late-frame tamper, truncation, trailing bytes, whole-original hash mismatch, and forged outcomes. A real chunked full group plus one extra byte exceeds the 64 MiB plus 544-byte wire cap and commits no range.
- Immutable setup, wrapped-master persistence, exact scope conversion, operation-specific permissions, unknown jobs, expiry, revoked epochs, removed target access, fresh status challenges, stale revisions, permanent tombstones, and admission quotas.
- Stalled bodies, excess simultaneous bodies, disconnected uploads, a lost final response, both deterministic cancel-versus-publication outcomes, and pending cleanup after storage failure.
- Missing groups, corrupt groups, missing originals, corrupt persisted acks, wrapping-key loss, and normal startup's refusal to bypass the explicit sealed owner.
- Actual rename failure and actual SQLite trigger failures. A failure in the intake-event insert rolls back the receipt, content reference, received revision, and event together. Startup collects the orphan and resumes publication.
- Nine actual child-process SIGKILL boundaries: group sync, group rename, group-directory sync, range DB commit, original sync, original rename, original-directory sync, publication DB commit, and before response. Reopen either discards the uncommitted object or resumes from the committed range. Receipt-bearing crashes preserve the exact receipt ID. A subsequent restart preserves that same result.

`npm run typecheck`, `npm run lint`, `npx --no-install tsc -p scripts/test/sealed-ingest/tsconfig.json`, and `git diff --check` pass. Public-history preflight runs after the final commit because it requires a clean committed tree. The existing G2 Swift implementation was not changed, and no native build or device run was needed for these receiver tests.

Generated packets and credentials live in private temporary directories and are removed by the fixtures. No whole 4 GiB fixture is allocated. No memory or throughput claim follows from the frame bound. SIGKILL tests prove process-crash behavior, not physical power-loss behavior or storage hardware guarantees.

## Limits and parent reconciliation before activation

The following conservative choices are explicit and require parent acceptance or further integration work. They do not revise the architecture contract silently.

- This component supports one immutable generation per job identity. It rejects changed setup bindings, including replacement generations. There is no same-job supersession API or old-generation adoption workflow. A future replacement operation must retain the old generation's tombstone and keys rather than overwrite this state.
- Admission retains the demo limits of 20 lifetime job identities, 100 pre-registration cancellation identities, and an 8 GiB reservation budget. Sealed reservation includes two originals plus 64 MiB quarantine per job. Tus now accounts for its common-original copy too. Pending cleanup retains its reservation. A maximum 4 GiB sealed original cannot fit this conservative 8 GiB budget with quarantine overhead. The binary 4 GiB limit is unchanged; admission can reject it with 507.
- Setup checks available filesystem space against conservative outstanding reservations. This is logical admission accounting, not filesystem block preallocation or protection from another process consuming disk. Later I/O failure still refuses an ack or receipt.
- Received groups, outcome keys, and tombstones are retained. There is no timed key deletion, retention UI, repair API, or automatic destructive GC. Missing committed storage requires explicit recovery, not replay-based repair under the same identity.
- Transient finalization failures leave a durable verifying job. Exact packet retry or receiver reopen retries that work. This isolated component has no periodic background retry scheduler. Production needs a receiver-owned service lifetime and shutdown drain, not a phone completion call.
- Frozen jobs refuse success rather than invent a new signed recovery state unsupported by G2. The production authenticated control adapter must distinguish that refusal from confirmed cancellation or cleanup.
- Filesystem durability checks ran on macOS only. Unsupported directory sync fails closed. Windows filesystem behavior, power-loss testing, a real OS wrapping backend, production HTTPS connection admission, and local revocation notification wiring remain activation gates.
- Existing storage directories must already be private real directories. Legacy receipt documents remain supported, but an insecure old storage directory requires an explicit operator permission migration before startup. Existing regular database files are restricted to 0600 when opened.

No real upload route or default provider is enabled by this slice. The cross-platform whole-job background-upload requirement remains unchanged.

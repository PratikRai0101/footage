# Sealed protocol codec evidence

## Scope

G2 now has isolated production codecs in `apps/server/src/sealed-protocol.ts` and `apps/mobile/modules/footage-transfer/ios/SealedProtocol.swift`. Native names are under `SealedProtocol`. Neither module registers a route, schedules a task, changes shared contracts, or connects to the UI. The cross-platform app and actual whole-job iPhone background upload requirements remain unchanged. Production activation remains blocked by G1 and G3–G7.

The implementation follows the complete [sealed background upload contract](../architecture/sealed-background-upload.md), including the parent G0 correction. A full group is **64 MiB + 544 bytes**, not +512.

## APIs and enforced boundaries

- `Manifest` validates and owns canonical private bytes, their digest, the destination digest, and the deterministic original partition. Its setup-time validator checks the seven-day expiry bound. Destination codecs reject unknown variants, invalid UTF-8, non-NFC text, oversized IDs, and trailing bytes. Origin validation accepts only the specified exact HTTPS representation, including canonical DNS A-labels, IPv4, IPv6, and an explicit port.
- `Binding` matches the locally provisioned receiver and exact origin to the immutable manifest. Public group headers are exactly 128 bytes. They contain no original hash, filename, frame hashes, or destination details.
- `GenerationKeys` in Node and `Keys` in Swift support fresh random masters and derive separate body, acknowledgment, receipt, and status keys. No bearer is an input to the key derivation. Setup decoding binds the digest and expiry. Authentication of the setup transport remains G1's responsibility.
- `SealSession.consume` requires an explicit consumed-intent persistence callback before issuing a single-use `ConsumedSealIntent`. A callback failure burns that frame in the session. `seal` burns the token before validation or encryption, checks the staged frame hash and length, and uses a random nonce and random seal ID. There is no production nonce override or deterministic key default.
- `VerifiedGroup.authenticate` reads at most one bounded frame at a time. It checks the exact partition, authenticates AEAD, checks each plaintext frame hash, rejects duplicate seal IDs within the group, and hashes all wire bytes. Only full-group success returns a verified original range. Its write interface is explicitly private quarantine, not content publication. Any late error discards the whole quarantine. Node never passes `decipher.update` output to that interface before `final` succeeds.
- `VerifiedAck`, `VerifiedReceipt`, and `VerifiedStatus` have private constructors. Node also gives these types private nominal fields, so a public field bag cannot impersonate a verified result. HMAC verification uses constant-time Node comparison or CryptoKit verification. Acknowledgments require the exact saved group index, wire hash, manifest, and original range. They are not final receipts.
- Receipt verification obtains original size and hash from the immutable manifest. `toOriginalReceipt` produces the existing shared original receipt fields, including a UUID and UTC ISO8601 timestamp, without accepting another caller-supplied original identity. Receiver, generation, manifest, and destination bindings remain on the verified wrapper. There is no second receipt store.
- Status and revoke use the contract's common query and authenticated status codecs. Verification requires the expected operation and challenge, a nondecreasing revision, matching expiry, valid cleanup state, and the recomputed contiguous original prefix. Out-of-range bitmap bits and invalid received-receipt combinations fail. Sparse groups cannot advance progress through a hole. An ingest envelope requires HTTP 200 and complete canonical bytes; headers and wire counts cannot authenticate progress.

The negotiated limits remain fixed: 8 MiB frames, eight frames per group, at most 512 frames and 64 groups, a 1-byte to 4 GiB original, a 64 KiB manifest, and 4 KiB outcomes. Wire integers remain UInt64 or BigInt until checked against bounded sizes and indices. Public header fields cannot relax the manifest limits.

## Executed checks

The offline runner uses the actual Apple CryptoKit implementation, not a JavaScript replacement or a source-text assertion. Swift compilation uses Swift 6 and treats warnings as errors.

- `npx --no-install tsx scripts/test/sealed-protocol/run.ts` passed. Four generated manifest/destination/digest vectors, frame headers and AAD, all four HKDF domains, AEAD seal/open, setup/query, acknowledgments, receipts, ingest envelopes, and 36 status/revoke records agreed byte-for-byte. Production-random packets were opened in both directions.
- Both Node and Swift passed truncation sweeps, oversized length prefixes, trailing bytes, original u64 overflow, invalid partitions, wrong receiver/origin/job/generation/manifest/destination/range/frame, altered ciphertext/tags, incorrect staged hashes, cross-domain MACs, forged status, stale challenges/revisions, cleanup validation, and sparse bitmap-prefix checks. Correctly re-MACed but semantically invalid records were rejected too.
- Both suites processed a complete eight-frame group and checked the exact 64 MiB + 544 wire length. A valid first frame followed by an invalid final frame returned no verified group and discarded private quarantine. Repeated opening of exact saved ciphertext passed. Reusing a consumed seal token, resealing after a persistence error, and resealing after a hash-validation error failed.
- `npx --no-install tsc -p scripts/test/sealed-protocol/tsconfig.json` passed, including the differential runner. Node unit type checks also prove that verified results cannot be constructed from field bags or public constructors.
- The same production Swift source compiled against the iPhoneOS SDK for `arm64-apple-ios15.1`, using Swift 6 and warnings as errors. This is a codec compilation check, not an app or device execution claim.
- `npm test` passed all 62 root tests: 36 server tests, 20 mobile presentation tests, and six device-tool tests. The server total includes ten new sealed protocol tests.
- Root `npm run typecheck` and `npm run lint` passed. The lint command checks the existing mobile app. Diff whitespace checks passed. The public-history preflight requires a clean committed worktree and is repeated after the final commit.

Only synthetic bytes and fresh temporary test keys were used. Raw vector files and native binaries are temporary and are not committed. No device, personal media, existing credential, cloud build, live T3/Cardboard operation, or workflow change was used.

## Remaining integration requirements

These checks do not prove a durable consumed-intent ledger, uniqueness across process restart, rollback protection, file sync/rename ordering, immutable saved-packet retention, receiver publication, or cancellation races. G3 and G4 must supply those owners. A recreated `SealSession` is not permission to reseal a consumed frame. The durable ledger must reject reused seal identities across the entire generation and abandon uncertain generations after authenticated reconciliation. Retries use saved exact ciphertext only.

Quarantine adapters must keep plaintext private and discard failed groups. Only G3's durable commit can authorize an acknowledgment or final receipt. Codec signers do not certify filesystem or database persistence. The runtime must enforce local cancellation before scheduling or applying a late acknowledgment/status; pure verification does not mutate runtime state. A matching immutable final receipt may resolve the cancellation race as specified. Fresh challenges must be generated for each control attempt, while revoke retains its operation identity across retries.

The binary timestamp and UUID domains are broader than the existing shared receipt validators. The codecs preserve u64 timestamps and 16-byte UUID fields. The shared-receipt adapter explicitly rejects timestamps beyond year 9999 and UUIDs outside the existing schema's domain. G3 must mint schema-compatible UUIDs and timestamps, or the contract needs an explicit domain reconciliation before activation. No wire field was silently narrowed.

There is no Simulator lifecycle, screen-lock, physical-device, or actual background-upload evidence in this slice. No foreground substitute was added. HMAC authenticates a shared-key holder, not public third-party attestation.

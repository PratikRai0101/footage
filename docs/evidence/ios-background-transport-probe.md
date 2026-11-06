# iOS background transport proof

Research date: 2026-11-06. Standalone Simulator prototype, not a production security certification or an integrated Footage feature.

## Decision

**Reject A. Recommend B for protocol review, not production integration yet.**

A background session with exact-origin TLS challenge checks and a certificate pin worked for HTTPS on the tested configuration. It did not stop HTTPS-to-HTTP redirects. A numerical loopback receiver accepted the complete original under an explicit restrictive ATS configuration. There is no TLS challenge on the HTTP connection to enforce the origin check.

B passed the bounded proof. CryptoKit sealed a generated chunk, Node decrypted and hash-verified it, and native code accepted only a matching authenticated acknowledgment. A foreign redirect sink received ciphertext without the key or general authority. Its forged acknowledgment matched the public context but failed authentication. A 64 MiB sealed upload continued through the system daemon while the app was backgrounded and stopped.

This changes the old boundary. **B permits redirect disclosure of encrypted chunks and public framing, not original plaintext or reusable write authority. It does not reject redirects.** Explicit review of that change is required before any app or receiver integration. A promise that the server never redirects, stripping Authorization, or inspecting the final URL would not repair A.

The foreground foundation on `t3/ios-foreground-upload-slice`, including `f91b1ab`, `2f08c55`, `9bdf06c`, and `1d5d530`, remains separate. This research did not merge or activate it. Production app, Android, receiver, UI, package lock, workflows, and account settings are unchanged.

## Probe and scope

The rerunnable sources are in `scripts/ios-background-probe/`:

- `Probe.swift` is a standalone UIKit shell around Foundation, Security, and CryptoKit. It never calls `beginBackgroundTask` and does not use JavaScript.
- `listeners.mjs` uses Node built-in HTTP, HTTPS, and crypto. Four owned listeners bind only loopback and choose unused ports. They provide HTTP/1.1, not HTTP/2 or HTTP/3.
- `run.py` generates a short-lived CA and two different leaf certificates, creates its own Simulator, builds the small native app, runs 43 cases, and deletes its resources in `finally`.
- `verify.py` asserts the sanitized results. `project.pbxproj` is the standalone build template, not an Expo project.

The completed run used an iPhone 16 Simulator, iOS 26.2 build 23C52, Xcode 27.2 build 27B52, the iPhoneSimulator27.2 SDK, arm64, and Node 22.23.1. Generated data was either 65,536 repeated test bytes or cryptographically generated random bytes. There was no media access, physical device, existing credential, cloud endpoint, T3 message, or Cardboard operation.

Raw outputs are ignored under `artifacts/ios-background-transport/`. The final verified run is `b29f1a5d-f4b5-42d8-8821-07375fe84b5a/safe-summary.json` within that directory. That identifier names a local artifact directory, not an upload capability. Certificates, private keys, synthetic payloads, receiver files, build products, socket observations, and unsanitized logs remain ignored. The report contains no developer-home paths, selected URIs, private LAN addresses, or credentials.

A first direct `swiftc` build lacked working background-daemon access. Adding guessed entitlements also failed. Those runs are excluded from transport evidence. The Xcode-built, ad-hoc-signed app passed positive file-backed background uploads before redirect results counted. The runner now fails if either trusted TLS upload baseline fails. Every listener also passed an independent reachability control with certificate verification before the native tests.

## A: TLS challenges did not make the transport HTTPS-only

### ATS was tested first

The app's Info.plist contained `NSAllowsArbitraryLoads = false` and `NSAllowsLocalNetworking = false`. It contained no exception domains or insecure-load allowance. Nevertheless, direct background PATCH requests to HTTP numerical loopback and HTTP `localhost` each delivered all 65,536 bytes and received HTTP 204. The matching SHA-256 was:

```text
c0258020dcc175789c8ea95afc0cc5f25a5a07296d6395d3bf3b09f85b92b87a
```

Apple's ATS documentation distinguishes local resources from ordinary domains. Its current `NSAllowsLocalNetworking` page describes IP restrictions starting in iOS 17 but also notes default local-load allowances in newer systems [2]. The observed loopback behavior is the evidence here. This report does not resolve that documentation ambiguity or claim every private host behaves identically.

Testing a routable private address would require another isolated network arrangement. None was used. One working HTTP numerical loopback redirect is already enough to reject A's all-origin confidentiality claim. The test does not establish physical-device ATS behavior.

### Background trust checks were real, not failed-connectivity protection

The trust handler required exact HTTPS host and port, a matching leaf DER SHA-256, and successful `SecTrustEvaluateWithError`. It rejected any other origin even if the certificate matched. The two modes were:

1. Custom anchor, before installing the generated CA. The handler set only that generated root as the anchor and evaluated trust.
2. Normal system anchor evaluation, after `simctl keychain <owned-device> add-root-cert` added the generated CA to the disposable Simulator only. The handler still checked exact origin and leaf pin.

Before that installation, the normal-anchor baseline correctly failed trust evaluation. After installation, the same normal-anchor upload succeeded with a byte-for-byte hash match. This is controlled default trust, not a claim about a publicly issued certificate. No macOS, system, pre-existing Simulator, or physical-device trust changed.

Each redirect case ran in both modes with both file-backed PATCH uploads and bodyless metadata GET download tasks. Each also ran with and without a generated synthetic Authorization header. GET used `downloadTask`, not an unsupported background data task. Metadata denotes the request class here; no production metadata parser was exercised. These combinations account for 32 redirect cases.

| Redirect target | Result in both anchor modes and all request/header combinations |
| --- | --- |
| HTTPS, different leaf certificate, different port | A second trust challenge reported trusted chain, wrong origin, and wrong pin. Handler cancelled with error -999. No sink request body arrived. |
| HTTPS, same leaf certificate, different port | A second challenge reported trusted chain and matching pin, but wrong origin. Handler cancelled with error -999. No sink request body arrived. A leaf pin alone would have accepted this certificate. |
| HTTP, numerical loopback, different port | Redirect followed. PATCH delivered the full 65,536-byte original with matching SHA-256. GET reached the sink. HTTP 204 completed normally. No second trust challenge existed. |
| HTTP, localhost, different port | Same disclosure as numerical loopback. |

Background redirect-veto callback count was zero throughout. The foreground ephemeral control invoked the veto once, stopped at HTTP 307, and sent nothing to the sink. These observations match Apple's documented background limitations [1].

Authorization was absent at the foreign HTTP sink in these runs, even when present at the chosen receiver. That prevented neither original disclosure nor a foreign HTTP 204 with fabricated `Upload-Offset`. Header stripping is not the security boundary, and this result is not a general guarantee about other headers or redirect paths.

Fresh sessions and separate HTTP/1.1 listeners made the HTTPS challenge tests observable without HTTP/2 coalescing. They do not prove pin callbacks occur on every request, cached connection, coalesced connection, or future OS. A fails even without those complications, so additional pinning work cannot rescue this candidate.

## B: sealed immutable chunks passed the bounded proof

### Mechanism actually tested

A separate ephemeral foreground session performed a nonredirecting, exact-origin, pinned HTTPS setup request. It acquired a fresh random 256-bit job secret from the selected receiver. The secret did not derive from an Authorization bearer. Setup accepted a secret only on HTTP 200 at its exact requested URL, and its delegate rejected redirects. The separate foreground control verified veto behavior, not a redirected setup endpoint. The probe used generated trust material, not an existing pairing credential.

CryptoKit HKDF-SHA256 derived separate 256-bit body and acknowledgment keys using the job ID as salt and different protocol labels. CryptoKit AES-256-GCM sealed each bounded generated chunk with its automatic random nonce. Node's AES-GCM and HKDF implementations interoperated with CryptoKit [5, 6, 10].

The test framing was:

```text
uint32 big-endian header length
JSON { v, job, offset, length, sha256 }
GCM combined representation = nonce[12] || ciphertext || tag[16]
AAD = "probe-v1|job|original-offset|original-length|original-sha256"
ACK = "probe-v1/ack|job|original-offset|original-length|original-sha256|wire-sha256"
MAC = HMAC-SHA256(ack-key, ACK)
```

The PATCH URL was a fixed route. It carried no bearer, key, cookie, delete token, or authority-bearing query. The receiver looked up the job key, validated lengths, authenticated the complete GCM body, checked plaintext length and SHA-256, and only then wrote plaintext and advanced its in-memory confirmed offset. It re-read the written test file and checked its hash before acknowledging.

A captured request is therefore usable only to replay that authentic immutable chunk to its job. It cannot create another job, alter the bytes or offset, or delete a job. The probe supports only offset zero and one chunk per job. Its receiver is a test process, not a durable server implementation.

### Positive and adversarial observations

- The ordinary 65,536-byte sealed upload completed with HTTP 200. Native and receiver SHA-256 matched: `5971d6fe6a648d10683706c76a9e54ee83b2863568f49e627ef4d615a2b032f2`. Native accepted plaintext offset 65,536 only after checking the exact acknowledgment context and HMAC.
- Another 65,536-byte job redirected to the foreign HTTP numerical-loopback sink. The sink received the complete 65,722-byte encrypted envelope, with wire SHA-256 `2a28c1678dc3c753e814afc927ce537ebab8443aad82577b087e228bdef1ad87`. It received no Authorization, cookie, or secret-bearing query.
- Before scheduling, native code asserted that the envelope contained neither the complete original plaintext nor the raw master, body, or acknowledgment key, nor the base64 master key. The sink's envelope hash matched the native envelope hash. These byte checks supplement the established AES-GCM construction; they are not a standalone cryptographic proof.
- The sink reconstructed the exact expected public acknowledgment context, returned HTTP 200, a random invalid HMAC, and a fabricated `Upload-Offset`. Native recorded `ackContextMatched = true`, `ackMACVerified = false`, and accepted offset **zero**. Transport success did not become accepted progress.
- The selected receiver implementation subsequently decrypted the captured envelope with its job secret. It recovered 65,536 bytes with the original hash `40b9dfc38bf0c58c99c50ef1606ac4f86c1f718264c7833b6d93cc25b8668f3e`. This was a test-only control operation, not native reconciliation or a new client receipt. Native progress for the redirected attempt remained zero.
- Flipping a ciphertext byte, changing the offset, changing the length, or replacing the job ID with another existing job each failed authentication or validation. None advanced confirmed progress. The other job remained at zero.
- Replaying the identical authentic envelope returned the same acknowledgment and did not append plaintext twice. Conflicting wire bytes cannot replace an already accepted chunk.

AES-GCM authentication happens before plaintext publication. Node may internally produce bytes from `decipher.update`, but the probe does not write or commit them until `decipher.final` succeeds. Apple specifically warns about releasing unauthenticated plaintext from streaming GCM [5].

The prototype deliberately exposes job ID, byte range, and original SHA-256 in its framing. Encryption does not hide size, timing, or that fingerprint. Production review should move the plaintext hash into the authenticated setup manifest or encrypted content where possible. Do not describe this as hiding all metadata.

### Actual background continuation

The long job used 67,108,864 random original bytes and a 67,109,053-byte envelope. The receiver and native original SHA-256 matched:

```text
7528535757753395c2a09feb6ef0af4bc8b236642b9bc9ab919c2faff540da52
```

After the listener began reading, the runner launched Settings on the owned Simulator. The probe recorded `applicationDidEnterBackground`. The runner then sent SIGSTOP to that probe process only and confirmed its stopped `T` state with `ps`. No debugger or UIKit execution-grace API kept the transfer code running.

At the stop, the receiver had read 2,818,048 body bytes. Two seconds later it had read 5,193,728 bytes while the app remained stopped. It eventually read the complete envelope, decrypted it, wrote and re-hashed the generated plaintext, and produced the acknowledgment before the runner resumed the app. That is 64,291,005 additional body bytes while the app could execute no instructions.

The owned Simulator's launch service listed `nsurlsessiond`. `lsof` showed that daemon, not the stopped app, owned the established connection to the receiver. Receiver reads were throttled during the body, not merely before the final response. The host's observed maximum socket buffer was 8,388,608 bytes, with TCP automatic send and receive limits each 4,194,304 bytes. The post-stop body exceeded those kernel-buffer limits by a wide margin. This was not a tiny upload already held entirely in kernel buffers followed by a delayed response.

After SIGCONT, native code verified the authenticated response and accepted plaintext offset 67,108,864. The wire byte count never became the original byte count. There is no throughput claim.

This proves Simulator daemon continuation under a real background transition plus deliberately enforced process suspension. It does not prove natural OS suspension timing, background relaunch, jetsam recovery, physical screen lock, reboot recovery, or user force-quit behavior. There was no OS-style kill experiment. Force-quit is not promised to restart automatically; Apple treats it as a request to stop background work [4].

## Smallest proposed production design

B is the smallest candidate here that survived the confidentiality and scoped-authority tests. It requires a separate encrypted upload protocol, not a flag on existing tus PATCH requests. The following is a design proposal, not implemented production behavior.

### Immutable job and authority

The existing native preparation can retain ownership of staged original bytes, whole-file hash, durable job ID, and selected destination. Before any background task, a nonredirecting native setup request must authenticate the exact receiver and bind an immutable manifest. Bind receiver identity, exact origin, job ID, generation, original length and hash, protocol version, chunk bounds, and selected destination identity. Return a fresh job secret, limits, expiration, and authenticated job identity. Never derive that secret from the reusable bearer or copy either value into a redirectable request.

Certificate onboarding remains unfinished. The experiment's bundled generated CA and Simulator trust installation are test arrangements, not a user onboarding solution. For a public CA endpoint, require normal hostname and chain validation plus the selected receiver binding. For a private desktop, require an independently authenticated pairing fingerprint or public key, app-scoped trust, hostname policy, explicit confirmation, rotation, and revocation. Blind trust-on-first-use over HTTP, accepting any self-signed certificate, or installing a global CA silently is not acceptable. Apple's manual-trust guidance explains both tightening trust and ATS restrictions on loosening it [3]. The local custom-anchor success here does not prove that arbitrary private names work under ATS on every device. This setup path needs its own proof before production.

Background descriptors contain only an opaque non-secret job ID, protocol context, and an immutable sealed file. Keep authentication credentials, setup keys, cancellation authority, and deletion authority in native storage behind nonredirecting operations. A separate background session disables cookies, shared credential storage, and cache. It must never inherit Android's or the foreground owner's reusable bearer headers.

Suggested domain types and states are:

```swift
struct ReceiverBinding { let exactOrigin: URL; let peerKeyID: Data }
struct OriginalIdentity { let byteCount: UInt64; let sha256: Data }
struct ChunkRange { let originalOffset: UInt64; let originalLength: UInt32 }
struct JobManifest {
	let id: UUID; let generation: UUID
	let receiver: ReceiverBinding; let original: OriginalIdentity
	let protocolVersion: UInt16; let destinationIdentityDigest: Data
}
struct SealedChunk {
	let jobID: UUID; let generation: UUID; let range: ChunkRange
	let file: URL; let wireSHA256: Data
}
// No general capability, key, Authorization header, or server-supplied redirect URL here.
struct BackgroundTaskBinding {
	let sessionID: String; let taskID: Int; let chunk: SealedChunk
}
// Construct these only after cryptographic verification and manifest/range checks.
struct VerifiedChunkAck {
	let jobID: UUID; let generation: UUID; let manifestDigest: Data
	let range: ChunkRange; let wireSHA256: Data; let receiverVersion: UInt64
}
struct VerifiedOriginalReceipt {
	let jobID: UUID; let generation: UUID; let manifestDigest: Data
	let original: OriginalIdentity; let receiverVersion: UInt64
}
enum ChunkState {
	case sealed(SealedChunk), scheduled(BackgroundTaskBinding)
	case responseUncertain, authenticated(VerifiedChunkAck)
}
enum JobOutcome {
	case transferring, reconciling, verifying
	case received(VerifiedOriginalReceipt)
	case cancelRequested, cancelledRemotely, cancellationUnconfirmed
}
```

Production constructors must validate ranges, overflow, origin normalization, identity lengths, and protocol limits. Authentication wrappers must not be constructible from arbitrary HTTP status or JS data. The manifest digest binds the selected receiver and destination. These types are ownership boundaries, not a complete wire schema.

### Chunking, retries, and progress

- Pick bounded chunks, initially review an 8 MiB maximum rather than the probe's 64 MiB stress chunk. Limit staged ciphertext, task count, memory, response size, per-job bytes, lifetime, and server quarantine storage. Reject framing before allocating declared large lengths. The probe permits at most a 4,096-byte header, a 64 MiB plaintext chunk, and a 4,096-byte upload response. It is not hardened against arbitrary traffic on its control endpoints.
- Use a specified canonical binary or unambiguous encoded context, not the prototype's ad hoc strings. Authenticate protocol version, receiver and manifest identity, generation, chunk index, original offset and length, and intended total. Domain-separate body, acknowledgment, receipt, and cancellation keys.
- Persist each sealed envelope and task binding before enqueue. Retry the exact saved ciphertext and nonce. Never reseal different bytes with a reused nonce. CryptoKit's nonce must be unique for each encryption call [6]. Review either crash-safe nonce allocation or per-chunk HKDF keys with a strict one-seal invariant. Bound encryptions per key and document key rotation.
- Authenticate and validate a complete chunk in quarantine before committing its plaintext range. Deduplicate identical retries. Reject conflicting content for a range, cross-job envelopes, expired generations, and cancelled jobs. A replay may recover the original acknowledgment but cannot reset cancellation, replace bytes, or create write authority for another range.
- Map wire task progress to transport activity only. Advance accepted original progress only for authenticated committed ranges. Use the highest contiguous authenticated original offset, not `countOfBytesSent`, ciphertext length, or an untrusted `Upload-Offset`.
- On lost response, redirect, timeout, or crash, retain `responseUncertain`. Reconcile through a native nonredirecting authenticated request, or validate a strictly bounded receiver MAC acknowledgment with exact manifest, range, ciphertext digest, and generation. Reconciliation needs a fresh challenge or monotonic version so old authenticated status cannot undo cancellation or fabricate current state.
- After all ranges, the receiver must re-hash the assembled original and durably commit it before issuing a final authenticated receipt for the exact job, destination, size, hash, and generation. A matching chunk acknowledgment is not that receipt. The client's shared HMAC secret proves the receiver-key-holder boundary, not public third-party attestation.
- Cancellation first records local intent, prevents more scheduling, and cancels outstanding daemon tasks. It then revokes the receiver job through a nonredirecting authenticated operation and reconciles races with already committed chunks. Retain cancellation tombstones beyond the retry lifetime. Offline cancellation remains unconfirmed. Do not claim remote deletion from a local `cancel()` return or a redirected response.

### Native lifecycle and cross-platform compatibility

Use a small number of stable background session identifiers and reconnect at native launch before JS. Store durable native mappings from session and task ID to job, generation, and chunk. On startup, reconcile `getAllTasks` against the ledger, including crash windows before or after `resume`. Missing tasks or responses are uncertain, not automatically received or safe to discard.

The native owner must prepare sealed files and schedule subsequent chunks without JS. Preseal and enqueue enough bounded work before suspension to continue usefully. A fully presealed first version avoids depending on background encryption of a locked original, but costs additional disk. A bounded window needs native event-driven refill and must tolerate Apple's scheduling and wake-rate limits. Out-of-order authenticated chunks require a committed-range map rather than one unverified server offset. Prove whole-job multi-chunk scheduling before presenting the feature as complete. Apple recommends few sessions and batching rather than wake-per-small-chunk scheduling [1]. A fixed immediate execution deadline is not promised.

Retain ciphertext, manifest, ledger, and any original needed for later sealing with an explicit file-protection policy. Files needed after the first unlock require `completeUntilFirstUserAuthentication`; the probe uses the equivalent Data writing option for its sealed file [7]. Store job secrets in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` if locked background acknowledgment verification is required [8]. That is an explicit at-rest policy decision. Do not silently weaken staged-original protection. Never place keys in task descriptions, JS events, URLs, logs, or ciphertext headers. Keep keys until uncertain transfers and remote cancellation settle, then remove them under a reviewed retention policy. Nothing works before the first unlock after reboot under this policy.

The app delegate stores the completion callback for `application(_:handleEventsForBackgroundURLSession:completionHandler:)`, reconnects the named native session, persists and reconciles events, and calls the callback exactly once on the main thread after `urlSessionDidFinishEvents` and necessary state processing [1, 9]. Native code must own that work even if the React runtime never starts.

Version-matched published Expo sources were fetched without installing dependencies. Their archive SHA-512 integrity matched `package-lock.json`:

- `expo@58.0.21`, `ios/Expo/ExpoAppDelegate.swift:124-130`, forwards the background-session event to the subscriber manager [11].
- `expo-modules-core@58.0.28`, `ios/AppDelegates/ExpoAppDelegateSubscriberManager.swift:163-188`, calls subscribers and aggregates their completion handlers [12]. Each subscriber must complete unowned identifiers too, without stealing another module's session.
- `expo-file-system@58.0.13`, `ios/Legacy/FileSystemBackgroundSessionHandler.swift`, is an example of a native subscriber and bounded completion bookkeeping [13]. Its handler is not a transport-security fix or a substitute for Footage's durable job owner.

The versioned Expo documentation endpoints returned HTTP 403 during this research. These lifecycle statements come from the exact published native sources, not guessed latest-version docs. Integration must register an app-delegate subscriber through the local Expo module configuration and validate actual launch ordering in a built Expo 58 app. The standalone probe does not implement cold-launch event reconnection or durable key storage.

Keep the shared app contract in original-byte units with native job ownership and matching receipts. Preserve Android's current no-redirect tus path. Add a separately negotiated sealed-chunk receiver endpoint for iOS, with no silent plaintext fallback if unsupported. After authentication and whole-file verification, that endpoint can publish the same receiver-owned original and receipt model. Ciphertext wire offsets must never be passed to ordinary tus storage as original offsets. No production protocol, server route, UI fork, or Android change was made here.

## Independent review follow-up

An independent live-listener test found a research-harness ordering defect after the recorded run. The `/sealed` family and `/verify-captured` ran mutating synthetic adversarial checks before authenticating the actual input. Submitting an otherwise authentic packet with the test's ciphertext byte already flipped let the synthetic check flip it back and commit the authentic original; the actual request then returned 400. This violated “rejected input causes no commit,” though it neither disclosed plaintext/keys nor authorized different original content. The recorded run's internal negative checks started from authentic input, so they did not exercise this boundary.

The proof listener now authenticates incoming bytes without side effects before running those synthetic checks. Production ingest must not run such self-checks at all. The regression first reproduced the failure, then passed after the proof-only correction:

```sh
node --test scripts/ios-background-probe/listeners.test.mjs
```

The test uses actual owned loopback listeners, generated bytes and fresh temporary certificates, with no machine trust changes. Rejected ciphertext, length/offset/hash, cross-job and truncated inputs publish no original file. Exact replay preserves the file and ack; alternative ciphertext cannot replace a committed range. A fake acknowledgment with the exact public context fails HMAC, while relaying an authentic captured packet produces a valid acknowledgment only after the receiver commits it. Both direct ingest and captured-input control paths are covered. Temporary material is removed on exit.

The full Simulator run was not repeated for this ordering-only change. The 43-case safe summary and daemon-continuation measurements above remain historical evidence of the pre-correction run; re-running `verify.py` checks that artifact, not new iOS behavior. The correction does not turn this research listener into a production server or the verifier into security certification.

## Remaining approval and acceptance work

1. Approve the encrypted-content and chunk-scoped-authority model explicitly. Review pairing, canonical framing, key derivation, nonce policy, replay, authenticated status, cancellation, quotas, and parser limits with a security reviewer.
2. Prove authenticated private-desktop onboarding and key rotation without global trust changes. Test real supported OS versions and ATS behavior without relying on loopback exemptions.
3. Implement durable native and receiver state, whole-file receipts, multi-chunk automatic scheduling, and recovery from uncertain outcomes. The test receiver writes verified plaintext but does not fsync a durable commit or persist its job map. The probe's keys and accepted progress are in memory.
4. Build the actual Expo lifecycle integration. Test no-JS launch, process death and relaunch, task enumeration, reboot and first unlock, disk pressure, cancellation races, and receiver restarts. Do not infer those results from the standalone app.
5. Test Home, natural suspension, physical lock, network changes, stalled uploads, malicious redirects, and fake acknowledgments on approved physical devices later. Test HTTP/2 and cached trust as defense-in-depth, not as the confidentiality boundary. Distinguish OS termination from user force-quit in product copy and tests.
6. Re-run shared Android and iOS acceptance with the unchanged app design. Receipt persistence and T3 delivery are separate acceptance steps. This task performed neither dispatch nor production deployment.

## Reproduction and cleanup evidence

From the repository root, with Xcode, Python, Node, and openssl available:

```sh
python3 scripts/ios-background-probe/run.py
# Recheck a completed run without rebuilding or creating another Simulator:
python3 scripts/ios-background-probe/verify.py artifacts/ios-background-transport/<run>/safe-summary.json
```

The runner checks for at least 6 GiB free. It creates no checkout, installs no npm dependencies, runs no Pods or React Native build, and starts no public listener. A complete run creates its own Simulator and deletes it, including the generated trusted root, on cleanup. Do not terminate the runner with SIGKILL if cleanup is expected to execute.

The final run's verifier printed:

```text
PASS: 43 cases; live baselines; ATS downgrade disclosure; TLS challenge controls; sealed content/authority; forgery/tamper/replay; stopped-app daemon continuation.
```

The verifier also rejected three deliberately corrupted summaries: fabricated foreign progress, missing daemon socket ownership, and a wrong original hash. Both cleanup assertions passed. The listener process exited, and the owned Simulator no longer appeared in `simctl list devices`. The existing Footage Simulator was not operated on. Disk was rechecked after cleanup with approximately 35 GiB available. Node syntax checks and Python compilation passed. `git diff --check` and `scripts/public-repo-preflight.py` passed after the probe commit. The history check scans all reachable branches and prints no matched values; it is a pattern check, not a guarantee that every kind of secret can be detected.

Local probe commit: `0181426` (`research: add isolated iOS background transport probes`). The findings are committed separately immediately after it. No push or integration into `main` is authorized by this report.

## Primary sources

Sources were retrieved on 2026-11-06. Local observations above are experiments, not statements attributed to Apple or Expo.

1. Apple, [Downloading files in the background](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background). Separate transfer process, automatic redirects without the veto callback, file-only background uploads, stable session identifiers, and scheduling limits.
2. Apple, [NSAllowsLocalNetworking](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking) and [NSAppTransportSecurity](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity). Local and IP exceptions and ATS policy. The empirical counterexample is limited to the named Simulator configuration.
3. Apple, [Performing manual server trust authentication](https://developer.apple.com/documentation/foundation/performing-manual-server-trust-authentication). Custom trust, additional pinning, ATS restrictions, and certificate rotation.
4. Apple Developer Technical Support, [URLSession background does not always resume](https://developer.apple.com/forums/thread/740564), and Apple, [Defer networking](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/EnergyGuide-iOS/DeferNetworking.html). User force-quit cancels background activity and requires manual relaunch.
5. Apple, [AES.GCM](https://developer.apple.com/documentation/cryptokit/aes/gcm), [Cryptography and your apps](https://developer.apple.com/videos/play/wwdc2019/709/), and Apple DTS, [CryptoKit streaming discussion](https://developer.apple.com/forums/thread/679889). Established authenticated encryption and the risk of releasing unverified plaintext.
6. Apple, [AES.GCM.Nonce](https://developer.apple.com/documentation/cryptokit/aes/gcm/nonce). Nonces must not be reused across encryption calls.
7. Apple, [FileProtectionType.completeUntilFirstUserAuthentication](https://developer.apple.com/documentation/foundation/fileprotectiontype/completeuntilfirstuserauthentication). File access after the first unlock, including later locks.
8. Apple, [kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly). Background-accessible, device-bound Keychain policy after first unlock.
9. Apple, [urlSessionDidFinishEvents(forBackgroundURLSession:)](https://developer.apple.com/documentation/foundation/urlsessiondelegate/urlsessiondidfinishevents(forbackgroundurlsession:)). Reassociation, completion callback timing, and main-thread requirement.
10. Node.js, [Crypto API](https://nodejs.org/docs/latest-v22.x/api/crypto.html). AES-GCM decipher authentication, HKDF, HMAC, random bytes, and hashes. Version 22 built-in implementation used by the receiver.
11. Expo's published [expo 58.0.21 package metadata](https://registry.npmjs.org/expo/58.0.21) and [source archive](https://registry.npmjs.org/expo/-/expo-58.0.21.tgz), file `ios/Expo/ExpoAppDelegate.swift`.
12. Expo's published [expo-modules-core 58.0.28 metadata](https://registry.npmjs.org/expo-modules-core/58.0.28) and [source archive](https://registry.npmjs.org/expo-modules-core/-/expo-modules-core-58.0.28.tgz), file `ios/AppDelegates/ExpoAppDelegateSubscriberManager.swift`.
13. Expo's published [expo-file-system 58.0.13 metadata](https://registry.npmjs.org/expo-file-system/58.0.13) and [source archive](https://registry.npmjs.org/expo-file-system/-/expo-file-system-58.0.13.tgz), file `ios/Legacy/FileSystemBackgroundSessionHandler.swift`.

# Isolated paired control and macOS wrapping evidence

This slice closes the missing native credential-bearing control capability and supplies a real macOS OS wrapping provider. Both remain unused by production routes, Expo registration, the bridge, and UI. It does not enable uploads or pass the whole G1 or background-app acceptance gates. iPhone background execution and Android support remain requirements.

## Native interface ready for the runtime adapter

`PairingClient.swift`, `PairingControl.swift`, and their Kotlin counterparts own the interface. No method exports a credential, signing key, generation master, or HTTP response to JavaScript.

- `nativeIdentity()` verifies the installed signed record again and returns native receiver, exact origin, device, epoch, expiry, and permission metadata. It does not return scopes that the signed record never contained.
- `PairingControlBinding` holds raw receiver32, canonical origin, device16, enrollment epoch, job16, generation16, manifest digest32, explicit standalone intake16, and job expiry. Construction validates widths and origin. Kotlin copies input and output arrays.
- `confirmStandaloneAfterNativeConfirmation(binding)` requires an installed pairing and matching identity, origin, device, epoch, and expiry. It adds an immutable native job confirmation. Repeating the exact confirmation is idempotent. A changed destination, generation, digest, expiry, or installed authority cannot replace that job's confirmation.
- `control(operation, binding, canonicalBody)` checks the job's frozen installed signed record, immutable confirmation, operation permission, and body binding before networking. Setup requires the exact manifest digest and matching receiver, origin, device, epoch, job, generation, standalone destination, and expiry. Other operations require an exact bounded `FTQUERY1` job, generation, digest, operation UUID, and challenge record without trailing bytes.
- `control(operation, job, canonicalBody)` reconstructs the confirmation from private native storage and performs the same checks. Status and revoke recovery therefore require only a native job ID and G2 query. They never open a full display manifest, selected original, or `.complete` file.
- `listDestinations()` requires `0x10` in the installed record and uses the installed origin. It returns bounded bytes only to its native caller.

The parent can build the setup binding from the new minimal `OutcomeContext` plus its already native-confirmed standalone intake. Cancellation and status can use the job-ID overload instead, without adding destination details to that context. IDs convert at the adapter boundary between raw bytes and G2 canonical lowercase hex. Enrollment epoch stays u64. No `BackgroundControl`, `Background*.swift`, or `SealedProtocol.swift` file changes are part of this slice.

The setup body must come from the native G2 canonical manifest constructor. This owner checks its immutable authorization prefix, digest, and expiry; it is not a second complete G2 parser. The parent remains responsible for response authentication through G2. A successful HTTP exchange returns bytes, not accepted progress, cleanup confirmation, a trusted viewer grant, or a receipt.

Standalone intake is the only confirmable destination in this slice. There is no fabricated T3 target, caller filesystem path, active-target lookup, or T3 dispatch. Receiver `PairingAuthority.authorize` remains authoritative for intake scopes and own-job access. The native signed record has no scope list, so native confirmation does not claim that an intake is receiver-authorized. An out-of-scope setup fails at the receiver.

## Fixed transport and private storage

Both transports use compiled POST paths. Setup uses permission `0x01`, status `0x02`, revoke `0x04`, view `0x08`, and destination listing `0x10`. Callers cannot pass a URL, origin override, Authorization header, or credential. The transports reject every redirect, including same-origin, alternate-port HTTPS, and HTTP redirects. They disable cookie, cache, and shared HTTP credential use. Swift retains the previously proven Security.framework trust evaluation unchanged.

Bodies cap at 64 KiB before a request. Setup and destination-list replies cap at 64 KiB. Status, revoke, and view replies cap at 4 KiB. The cap applies while streaming without Content-Length as well as at the response header. Pairing requests and replies retain their 16 KiB limit. Swift also rejects Content-Encoding. Kotlin has bounded HTTP headers and chunk parsing.

The installed Keychain item and immutable per-job confirmations use `AfterFirstUnlockThisDeviceOnly` and do not synchronize. The current installation retains the existing native signing key and authenticated pairing material. Each job freezes its original trust, public device key, permission mask, signed installed reply, and control credential with its minimal binding. It does not copy the private signing key. Fresh recovery nonces permit idempotent confirmation only when the authority digest is unchanged; the original snapshot is not replaced. Future pairing changes, including replacement or loss of the current installation, do not affect that job's original control authority. Receiver revocation and expiry still deny that original authority. Loss of the job's private snapshot blocks control, and loss of the current installation blocks new jobs and destination listing.

Android keeps confirmations in private, no-backup, AES-GCM-authenticated files bound to the exact job ID. It uses the existing non-exportable AndroidKeyStore wrapping key. Exclusive file creation, file sync, and directory sync precede confirmation success. An interrupted write remains corrupt and blocked, not permission to choose a new destination. Native state and confirmation reads now have streaming file bounds. Missing keys and state never cause automatic signing-key creation.

Signed rotation remains an uninstalled candidate. There is no silent P-256 replacement, pin learning after a TLS failure, credential rotation, or old-job adoption. Explicit native re-pair and rotation activation UX remain unfinished. Before-first-unlock execution and physical protected-data behavior remain unproven.

## Wire additions requiring parent reconciliation

The accepted design fixes setup, status, and revoke paths and request schemas. It assigns view and list permission bits but does not define their complete wire API. This slice makes the following explicit, default-off transport choices rather than using an arbitrary request API:

- View is `POST /sealed/v1/view` with the existing bound `FTQUERY1` request and a 4 KiB response cap.
- Listing is `POST /pair/v1/destinations` with `"FTLIST01" || device16 || enrollmentEpoch:u64 || freshNonce32` and a 64 KiB response cap.

These are additional interface definitions, not already accepted G2 response schemas or activated receiver endpoints. Their production receiver adapters and native reply validation require parent reconciliation before exposure. The test adapter authenticates the actual enrolled credential and permission for both. Setup, status, and revoke retain the accepted wire bodies and paths unchanged. No limit, redirect rule, or trust requirement is relaxed.

## macOS OS wrapping provider

`apps/server/src/desktop-key-store.ts` exports `DesktopKeyStore.initialize(config)` and `DesktopKeyStore.load(config)`. There is no default provider. Initialization is an explicit local operator action. Normal load only reads the existing item and never generates or replaces a key. Duplicate initialization fails. Neither API creates a network pairing offer or approves a phone.

`desktop-key-store-helper.swift` uses Security.framework and CryptoKit. Its fixed service is `com.footage.desktop.wrapping.v1`; the production account is `production`. Test accounts must be `test.<new lowercase UUID>` and require `allowTestKeychain: true` at the TypeScript boundary. Only exact test accounts have a deletion operation. There is no production deletion, key-export operation, arbitrary service selection, or secret-bearing command-line argument.

The 32-byte OS wrapping master stays inside the helper. AES-256-GCM authenticates the versioned namespace and exact caller context. PairingAuthority identity and device contexts and SealedIngest generation contexts all use the same provider. The database holds only wrapped records. The helper emits ciphertext on stdout. Unwrapped record material uses a separate inherited private pipe, file descriptor 3, not stdout, stderr, arguments, environment, logs, or temporary plaintext files. Wrap input uses private stdin. The OS wrapping master is never returned through any pipe.

The one-request helper protocol limits total input to 128 KiB, namespace to 80 bytes, context to 1,024 bytes, plaintext to 64 KiB, and ciphertext to 64 KiB plus the GCM overhead. It rejects trailing data, unknown operations, malformed namespaces, missing contexts, and oversized inputs. The provider bounds outputs and applies a deadline. Helper installation must be an absolute, non-symlink executable path with no group-writable or world-writable ancestor. It checks owners too. A denied or inaccessible Keychain query returns a generic failure with no OS error description or secret material.

The provider supports macOS only. Linux and Windows fail closed; no backend or in-memory production fallback is invented. Changed helper signing or Keychain access policy can deny access and requires explicit local operator resolution. The tests do not lock the user's login Keychain, modify existing access policies, or claim a locked/denied physical OS test. All non-success Security.framework statuses fail closed in code.

## Actual executed proof

The macOS Keychain test explicitly opts in and creates a new UUID item in the helper's own namespace. It instantiates real `PairingAuthority`, `Jobs`, and `SealedIngest` owners with that provider. It verifies enrolled control authorization, setup, reopen, the same receiver identity, and the same wrapped generation master. Wrong context and modified ciphertext fail. Missing and deliberately replaced test items block both owners without resetting their databases. The test checks that credential, receiver private key, and generation master bytes do not occur in the databases. It also exercises helper input limits and unsafe helper-file refusal. Cleanup deletes only the exact item created by that test.

Executed commands include:

```sh
mkdir -p artifacts/desktop-key-store
chmod 700 artifacts/desktop-key-store
xcrun swiftc -swift-version 6 -warnings-as-errors \
  apps/server/src/desktop-key-store-helper.swift \
  -o artifacts/desktop-key-store/helper
FOOTAGE_TEST_KEYCHAIN=1 npm test
python3 scripts/pairing-control-probe/run.py
python3 scripts/pairing-control-probe/jvm.py
python3 scripts/pairing-probe/run.py
python3 scripts/pairing-probe/jvm.py
npm run typecheck
npm run lint
npx --no-install tsc -p scripts/pairing-control-probe/tsconfig.json
npx --no-install tsc -p scripts/test/sealed-ingest/tsconfig.json
```

The root run passes 104 tests, including the opted-in actual Keychain test, 78 server tests total, 20 mobile presentation tests, and six tooling tests. Typecheck, lint, focused listener typecheck, the actual bidirectional Swift/Node G2 vectors, combined production G1/G2/G4 Swift 6 warnings-as-errors iPhoneOS compilation, and diff whitespace checks pass. Public-history preflight runs after the committed evidence update because it requires a clean tree.

The actual iPhone source runner passes 28 cases on its own disposable iPhone 16 Simulator, iOS 26.2, arm64, Xcode 27.2 build 27B52. It compiles production pairing and G2 Swift sources without Expo or React. Every case first enrolls through actual PairingAuthority with explicit local synthetic approval. The owner then reads its installed Keychain authority, confirms a standalone job, and performs real fixed native control requests. The positive case also recovers the installed credential and reconstructs a new owner before setup and job-ID-only status, revoke, and view requests.

The cases prove these behaviors:

- Setup, status, revoke, view, and list carry the authentic enrolled credential to the chosen receiver. No cookie or shared Basic credential is sent.
- A verified rotation candidate cannot replace a job's confirmed receiver. The old pinned job still uses the old receiver. Another case explicitly enrolls a second synthetic device and switches the current native installation. The original job still authenticates as its original device from its frozen private snapshot. Losing only the current installation likewise does not erase an existing job's authority.
- Missing private job confirmation, unconfirmed destination, changed confirmation, stale epoch, wrong port binding, HTTP origin, wrong body, oversized body, and malformed query fail before the corresponding request.
- Wrong leaf key, hostname, CA chain, expired leaf, and future leaf receive zero control requests or control-body bytes. Enrollment completed earlier with the original authentic certificate, then the owned listener changed its TLS context.
- Same-origin, alternate-port HTTPS, and HTTP redirect sinks receive zero credential headers and zero body bytes. The authentic initial receiver necessarily receives the request before sending a redirect.
- A setup-only permission cannot issue status. Receiver scope denial and revocation refuse setup. An actually signed installed record that expires after enrollment is rejected before control.
- Chunked replies without Content-Length exceed the 64 KiB control and 4 KiB outcome limits and are rejected. HTTP Basic challenges do not consult shared credentials. Synthetic HTTP success bytes do not produce a received outcome.

The original pairing probe also passes all 17 cases on a fresh owned Simulator after this transport change. One earlier run correctly rejected an offer because first launch consumed its two-minute lifetime. Both Simulator runners now warm the app before minting test offers. The production expiry is unchanged. One externally timed-out control run left an owned Simulator; it was shut down and deleted by its recorded ID before the successful rerun. No parent Simulator was used or modified.

Kotlin compiles all production Pairing sources, including the AndroidKeyStore vault, against Android 36 with Kotlin 2.3.0 and warnings as errors. JDK 21 executes the same 28 native-owner control cases. The original 17 JVM pairing cases pass too. This is actual Kotlin authorization and JSSE networking evidence with a test-only in-memory vault, not AndroidKeyStore or Android app execution evidence. No AVD is started.

## Remaining gates

Native scanner and receiver/origin confirmation UI, standalone destination confirmation UI, trusted desktop enrollment approval UI, explicit key-loss recovery and rotation activation, production HTTPS adapters, and native reply validation for the view/list additions remain disabled or unfinished. The parent must connect the new native owner to minimal OutcomeContext and BackgroundControl. This slice does not replace that owner with a foreground workaround.

Actual shared Expo 58 lifecycle registration, no-JS cold launch, locked physical iPhone recovery, LAN private-host onboarding, local-network denial, AndroidKeyStore runtime, actual Android networking, and physical-device acceptance remain gates. The desktop backend is macOS-only. G3 live receiver runtime proof belongs to its separate owner; this slice proves its direct OS-backed setup and restart API, not an integrated whole-job native receipt run.

All data is synthetic. Raw keys, QR records, databases, certificates, native results, and build logs stay under ignored private artifacts or removed temporary directories. Owned listeners stop and owned Simulators are deleted. No global CA, existing personal credential, physical phone, personal media, cloud build, account, workflow, T3 action, Cardboard action, push, or extra checkout is used.

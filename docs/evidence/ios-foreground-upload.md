# iOS foreground original upload

## Verified scope

The Release app uploaded a generated original through the real iPhone Files picker and native Expo module on an owned iPhone 16 Simulator running iOS 26.2. JavaScript and assets were embedded. The receiver and all fault listeners ran on loopback. No physical phone, personal media, account credentials, cloud build, or T3 integration was used.

The approved layout, typography, and palette are unchanged. Review adds only "Keep Footage open while uploading." Swift owns staging, hashing, transport, persistence, and lifecycle checkpoints. The three-argument `prepare(uri, name, endpoint)` contract is unchanged. Upload original is the explicit confirmation before staging or sending.

The fixture is a generated 12-second, 1280 × 720 H264/AAC test pattern, 12,741,748 bytes. Its SHA-256 is `38687a69e1f04a027dc9d6354208000f158f8448203af5c072eb1e286c60f73e`.

The built UI displayed the native matching receipt and real staged metadata. An independent hash of the receiving file matched the fixture and receipt. Full-frame playback of the staged file showed moving frames. See [build fingerprints and sanitized assertions](ios-foreground-upload.json).

## Native checks

The Simulator test app compiles the same production `TransferModel`, `TransferHTTP`, and `TransferOwner` sources. It calls native commands and snapshots, not a replacement uploader. It uses the existing receiver unchanged.

- A lost second PATCH response left 2,097,152 bytes confirmed locally and 4,194,304 accepted remotely. After process termination and relaunch, Continue used the same job. Its first resumed PATCH started at 4,194,304, as confirmed by HEAD. Native receipt and independent file hash matched.
- A real app transition stopped a throttled upload. Receiver file size stopped growing, `executionActive` became false, and manual continuation completed the same job.
- Offline cancellation retained cleanup-pending and its staged copy. Explicit retry confirmed server cleanup before removing the local copy. A received receipt was not revoked by Cancel.
- A deliberately mismatching receipt did not produce received state. Cancellation then recovered the receiver's already committed matching receipt. Commit won the late cancellation.
- New preparation cancellation remained distinct from error and did not revive an earlier received outcome after relaunch. The generated source remained unchanged.
- Native tests covered origin validation, atomic job/settings roundtrip, receipt validation, corrupt storage refusal without overwrite, and crash-orphan cleanup without deleting the retained original.
- Oversized metadata was rejected. Response buffering is limited to 64 KiB. Original copy/hash and chunk creation use 64 KiB reads; PATCH bodies are file-backed, at most 2 MiB each.

## Redirect boundary

Actual production-owner metadata and file requests received HTTP 307 to an owned listener on another port. The sink recorded **zero requests and zero original bytes**. Successful receiver responses also carried a foreign Location header, which never became authority.

A separate file-backed request through the same production `TransferHTTP` class repeated the 307 test with no Authorization header at all. It also rejected the redirect. Production-owner tests used only newly generated local test-job capabilities, never account credentials.

This is implementation proof for foreground `URLSessionConfiguration.ephemeral`, not the earlier standalone feasibility probe. Background URLSession remains excluded. Native requests use locally constructed paths under the validated immutable origin; server Location and uploadPath values cannot choose another destination.

## Reproduce locally

Use an isolated Simulator named `Footage Foreground Acceptance`. Build and install the Release app using `npm run ios:build`. Generate the fixture under ignored `artifacts/ios-foreground/` with FFmpeg's `testsrc2` and sine inputs, H264/AAC, 12 seconds, and 1280 × 720 pixels. The exact fixture hash can vary with the installed encoder.

Start `node_modules/.bin/tsx scripts/test/ios-receiver.ts` locally. It writes owned ephemeral loopback ports to ignored artifacts. Then run:

```sh
bash scripts/test/build-ios-owner-harness.sh
python3 scripts/test/verify-ios-owner.py --simulator <isolated-simulator-id>
```

The driver uses `agent-device@0.21.35` for real foreground transitions and refuses a Simulator with another name. The Release UI check uses the real picker, Upload original, receipt details, and full-frame playback. `scripts/record-ios-foreground.py` consolidates those local assertions without storing authority or selected URIs. Stop the owned receiver and shut down the isolated Simulator after testing.

## Local checks and limits

`npm ci`, `npm test` with 53 passing tests, `npm run typecheck`, `npm run lint`, both native Simulator builds, and `npm run preflight:public` passed. Android and receiver implementation files were not changed. Android was not built or tested.

The device contract now discriminates iOS from Android. Older Android wire output gets the schema default `platform: android`; iOS reports its actual system version and foreground scheduler without invented Android fields. Settings persist natively. No upload authority appears in snapshots. Notification permission remains Android-only.

This is not completion of background upload. UIKit resignation stops native work; persisted progress requires manual Continue. Force-quit never promises automatic restart. The upload owner does not change the idle timer or bypass manual lock. Simulator app transitions do not certify physical lock, deep suspension, Wi-Fi loss, or power behavior. No 4 GiB, HDR, broad codec/device, accessibility, or memory benchmark claim is made. T3 destination binding, thread delivery, and dispatch remain unfinished. Received-original deletion is not implemented or promised.

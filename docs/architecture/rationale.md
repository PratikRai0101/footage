# Footage: one original, one accountable handoff

Footage explores a narrow mobile product problem: sending a phone video over an unreliable connection and knowing that the receiver got the unchanged original. It is independent proof of work, not a Cardboard integration or evidence of a Cardboard defect.

## Keep the product small

One selected clip is the product. There are no tabs, editor, AI chat or recent-files dashboard. The screening-room layout keeps the real clip and its identity visible during transport. Connection loss changes the status, not the whole screen. Verification is deliberately separate from success.

Selection only grants temporary review access. Stable copying starts after Upload, because copying a large video has a disk and time cost. Native metadata and the staged preview survive normal app relaunch after preparation; an unsupported preview does not require transcoding the original.

## Put ownership where the work can continue

JavaScript commands and observes. Kotlin owns the bounded copy/hash pipeline, AtomicFile state, tus client, native scheduling and cancellation. There is no second JavaScript uploader, base64 media bridge or UI-controlled byte counter.

API 26–33 uses a foreground service with bounded CPU/Wi-Fi resources. The physical Samsung tests showed that a notification and CPU lock alone were insufficient under the recorded conditions. API 34+ uses a user-initiated transfer job. Neither mechanism is a universal process-death or power-policy guarantee.

## Reconcile, then verify

The maintained tus protocol owns resumable offsets. After interruption, the client asks the receiver where durable progress stands rather than assuming the last socket write succeeded.

SQLite owns the durable received/cancelled outcome. Completion checks full length and streaming SHA-256; only its matching receipt permits success. Cancellation can remain cleanup-pending, and a committed receipt wins over a later cancellation request. The receiver's mutation lock ends with protocol/storage work, not delivery to a dead socket.

## Separate writing from viewing

The upload capability remains native. Received jobs mint a short-lived single-use viewer code, exchanged for a bounded read-only HttpOnly session. Browser playback streams the original with ranges without monopolizing an upload lock. It does not inherit permission to upload or delete.

## Match claims to evidence

The standalone Android demo runs without Metro. Native emulator intake/recovery and real Chromium playback have independently matching bytes and hashes. Historical powered Android 13 tests add specific Home, Wi-Fi/AOD and cancellation evidence. The finished standalone UI binary now has a scoped powered Samsung pass, including WLAN interruption/recovery, continuous AOD and cancellation. Unplugged/deep-Doze checks and TalkBack remain open. There is no measured 4K memory result, HDR-fidelity claim or public-production deployment.

See [the evidence](../evidence/mobile-finish.md), [physical limits](../evidence/android13-screen-wifi.md), and [authoritative plan](../../../Cardboard_MVP_Plan.md).

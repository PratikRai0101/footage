# Final standalone APK: Samsung Android 13 check

Recorded 30 October 2026 UTC. Actual Samsung SM-N981U1 / API33, **USB-powered**, running the final standalone APK rather than the old Metro-dependent diagnostic build.

APK SHA-256: `57be77ff24f0140cd6956e49baf25dd90b8c2f2920aea3de4b59b159abf287c1`.

## Observed passes

1. **Standalone install, launch, real review and native upload.** Installed APK hash matched the host build. An eight-second generated H.264 Main/AAC 1280×720 clip, 4,161,576 bytes, reached the actual Original verified UI over ADB USB reverse. The independently read receiver bytes/hash matched the original and receipt. This first route is USB, not Wi-Fi.
2. **Home on real WLAN.** The next generated 29,080,346-byte clip used the physical phone's Wi-Fi TCP peer through the bounded streaming limiter to the unchanged primary receiver. No upload reverse was present. Native CPU/Wi-Fi resources and foreground service were observed. After Home, actual server bytes grew from 660,310 to 987,945.
3. **Actual Wi-Fi loss and same-job recovery.** Cellular fallback was disabled; Wi-Fi was then disabled. The real app displayed Your progress is saved. Re-enabling Wi-Fi resumed the same job `651a5d65-b325-41ca-a375-8a0ccc3124cf`, without restarting the receiver or creating another identity.
4. **226.5 seconds continuous screen-off AOD.** After recovery, the test put the screen to sleep. During the quiet interval it observed only host-local receiver bytes/database, with no phone/UI polling. The receiver reached verified completion while the phone still reported Dozing and the OS last-wake timestamp was unchanged. Both CPU/Wi-Fi resources were released before any requested wake. Independent full-file SHA-256 matched the source and receipt.

The long fixture's SHA-256 is `c4178a31973c7dd231384762a41e1a34e1a4e2a8d6f4258d884a8d73b69d0669`. It is generated 720p media, not personal footage, 4K or HDR. The limiter prolonged a real transfer; its configured rate is not a throughput benchmark.

## Public observations, no debug authority

The physical app is the release-mode standalone demo. The runner does not read its private AtomicFile/capability. It uses real UI, OS execution-resource state, receiver outcomes and independent file reads. The USB case observed the native received UI. For the long case, the server receipt/resource release were observed before wake. After the user unlocked the secure keyguard, the expanded native receipt ID and full SHA-256 matched that same server receipt.

The system picker initially placed the exact known fixture's filename below its visible bounds. No unrelated item was selected. The test used the known generated file only; screenshots exclude personal file lists.

## State and limits

Starting phone flags were Wi-Fi off (`0`), cellular on (`1`), power saving on (`1`), battery 50%, USB-powered. Wi-Fi initially failed to reconnect automatically, then a WLAN route became available. Final cleanup verified the original preflight flags restored: Wi-Fi `0`, cellular `1`, power saving `1`. No transfer service, CPU/Wi-Fi execution locks, test proxy or phone upload reverse remained. The next-upload origin was restored to direct private receiver port 1080.

The secure lock screen initially blocked UI follow-up; the user unlocked it normally. No keyguard bypass was attempted.

A subsequent visible cancellation case passed on this exact APK: both resources were held, Cancel stopped the upload, the receiver tombstone was retained, its partial file disappeared, native UI confirmed cleanup, both resources released, and no receipt was issued. The first cancellation runner attempt failed before upload while locating a settings label; it remains a separate harness failure. An explicit fresh repeat passed (`cancel-repeat.json`).

A final direct-WLAN upload to port 1080 passed with cellular fallback disabled, matching independently read bytes/hash and native receipt UI. The native View received file action opened the physical phone's browser, where the generated filename and matching SHA rendered after the exchange fragment was removed. This is browser-page verification, not a separately measured browser video-decoding test. Unplugged operation and deep Doze are **not** established by this powered AOD result. Natural process-death recovery, physical API34+, cellular switching, 4K memory, HDR fidelity and general reliability remain unverified.

Raw evidence: `artifacts/android-final-device/{preflight,usb-baseline,wifi-home-screen,cancel,cancel-repeat,direct-wifi,viewer}.json`, the corresponding log, and app-only review/received/waiting screenshots. The repeatable standalone driver is `scripts/verify-physical-transfer.py`; unlike the earlier debug-only runners, it never reads native private authority. Historical failures and the earlier APK results remain separate.

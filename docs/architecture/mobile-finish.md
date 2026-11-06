# Mobile finish contract

## Checklist

- [x] Ground the existing native-owner and receiver interfaces.
- [x] Compare two implementation shapes and keep the approved screening-room direction.
- [x] Implement metadata, stable local preview, and read-only viewer-link bridge.
- [x] Replace the diagnostic form with the single-screen mobile flow.
- [x] Verify native build, real receiving-side playback, small-screen UI, and error states.
- [x] Record remaining physical-device checks without treating emulator results as phone evidence.

## Two shapes

A player-only media layer could infer duration and resolution from playback events. It would avoid native metadata code but lose those properties and the stable preview after a process restart.

The chosen Android shape inspects with the metadata retriever, persists the properties beside the staged original, and exposes a read-only local URI. On iOS/web preview-only builds, real Expo Video source/track events supply temporary duration/dimensions instead; they never overwrite native Android metadata or imply upload verification. Expo Video owns only playback. The existing Kotlin owner remains the sole transfer writer. No video bytes or original upload capability cross into JavaScript.

## Responsibilities

`VideoMetadata` reads optional duration, dimensions, and MIME type without staging the selection. Inspection failure does not prevent sending original bytes. Preparation captures the same metadata from the stable copy once, not on every snapshot.

The native bridge exposes `inspect(uri)`, `settings()`, `configure(origin, appearance)`, and `viewer()`. `viewer()` requires Received and asks the existing receiver for a short-lived, read-only link. It returns that link only for immediate browser opening. It never returns the original upload capability.

The mobile controller owns temporary selection, one pending command, snapshot observation, and the visible-action start gate. The screen renders real native state. Import, review, transfer, and result share one route without tabs. Settings are a sheet, not another product destination.

Progress, preview, and file identity remain anchored during waiting. Preparation says to keep the app open. Verification is not success. Cancellation cleanup-pending is not deletion. The receipt is the only completion signal.

Instrument Serif is bundled under OFL for display. System sans-serif controls follow the platform. Layout supports scrolling and enlarged text; primary actions remain reachable. Missing/error previews use intrinsic content height rather than clipping scaled text inside a fixed media frame. Motion stops for reduced motion. Notification copy is permission-qualified. Sharing discloses its one-use, two-minute redemption window before the share sheet.

The standalone local-demo build embeds JavaScript and assets; the separate debug client still requires Metro. Release-mode local HTTP is deliberately enabled for the private receiver, paired with native boundary validation that rejects public HTTP hosts, userinfo, paths, query/fragment and invalid ports. HTTPS remains available. Two real JVM tests cover this boundary, including a failing-before public-HTTP case. This is a private-network development build with development signing, not production distribution.

## Verification boundary

The available iPhone Duo / iOS 27.1 Simulator has now been built and driven through selection, actual playback/metadata, cancellation, themes and enlarged text. [iOS evidence](../evidence/ios-simulator.md) records the missing-metadata/misleading-upload fixes. iOS uploads are not implemented; its preview-only copy acknowledges possible system-picker imports.

The physical Samsung has now passed the [final standalone APK check](../evidence/android13-final-device.md), including powered WLAN recovery/AOD and cancellation. Emulator/browser results still cannot establish unplugged Samsung execution or deep Doze; neither can the USB-powered physical result. Existing physical evidence remains scoped to its recorded binary and conditions. [Finish evidence](../evidence/mobile-finish.md) records actual standalone emulator transfer/recovery, browser decode/seek/download, visual review fixes, source/artifact hashes and the remaining hardware limits.

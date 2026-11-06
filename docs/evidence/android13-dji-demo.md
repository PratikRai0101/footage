# Samsung DJI original and silent demo

The simplified version 0.3 UI was built, installed and driven on the physical Samsung SM-N981U1, Android 13/API33. Its APK SHA-256 is `54467bd0d1e48a02438c8d7af0e2c1f25325e5cde586c8ac8f07afd48199bc8b`. Installed bytes matched the build.

## Original and receipt

The user explicitly supplied one DJI file in `DCIM/DJI Album`. It is 386,918,637 bytes, or 368.99 MiB. The revised UI correctly displays decimal units, 386.9 MB.

Metadata confirms HEVC Main 10, 3840×2880, 25 fps, 27.904 seconds, with AAC audio. D-Log is user-described. This is not a colour-fidelity result.

Phone-original and pulled-original SHA-256 matched before recording. The native staged-file digest, receiver receipt and independently streamed receiver-file digest also matched:

`a90438545a30320a099cbacc70028d7d5160b6114898f5c56db3b62ddbeb37d1`

Recorded upload: `58d162ed-6047-4e94-b698-5e9f8bf269cd`.

Receipt: `3b6c520e-30c5-4613-b454-9d348c8501fe`.

## Actual interruption

- No rate limiter or USB upload reverse was used. Cellular fallback was disabled temporarily.
- Wi-Fi was disabled at 33,554,432 server bytes.
- The waiting UI appeared with 33.6 MB confirmed and 8% progress. The partially received server prefix reached 34,139,352 bytes.
- Wi-Fi was enabled again. Native retries later reconciled the offset and continued the same upload identity.
- Reconnection took about 56 seconds after Wi-Fi was enabled. This was not instant recovery.
- The complete receiver file and actual native Original verified state were checked. Expanded native receipt ID and full hash were also inspected after recording.
- Network, power-saving and notification-banner settings matched the pre-take values at completion. No active transfer service or upload reverse remained. No battery exemption was granted.

The initial setup failure is retained. In take 2 the phone was on a different private network and could not reach the Mac. No bytes were accepted in that attempt. The operator paused/reopened Footage while awaiting the user's network correction. After the user connected the phone correctly, the prepared original completed as a separate first receipt. That is not the controlled interruption take. See `artifacts/demo/take-2/result.json` and `artifacts/demo/dji-first-receipt.json`.

## Delivered recording

- [Short silent demo](../../artifacts/demo/deliverables/Footage-demo-silent.mp4): approximately 2:18, 1056×2160, 30 fps, H.264, no audio.
- [Full silent chapter assembly](../../artifacts/demo/deliverables/Footage-demo-full-silent.mp4): approximately 3:09, no transfer-wait time removed.
- [Separate narration script](../../artifacts/demo/deliverables/SCRIPT.md).
- Normal-speed individual clips are in `artifacts/demo/deliverables/clips/`. Original uncut phone captures remain in `artifacts/demo/take-3/`.
- The short version omits 52.45 seconds of repeated waiting. A visible title card discloses the cut. No accepted-byte progress is removed in that interval. The full recording retains the wait.
- OS status/navigation chrome is cropped for privacy. Picker lists, notification drawer and initial private viewer-link exchange are excluded. No generated narration or music.
- The browser chapter shows the actual received-file page, filename, byte count and ready original preview. It is not a sustained physical-browser playback measurement.

Only the phone screen recording is encoded or cropped. The selected DJI file is not modified.

## Checks and limits

There are 48 passing automated tests: 26 receiver, 18 mobile, two proxy and two native-origin tests. TypeScript and Expo lint pass. Native lint has no errors and four warnings.

The UI retains review-before-copy, actual native progress, cancellation/cleanup states and matching-receipt success. Main-screen jargon and repeated demo disclaimers were removed. Settings contains About Footage and platform limitations. Hash, timestamp and sharing live in expandable receipt details. The previously clipped receipt affordance is fully visible on the actual DJI received screen.

This capture is foreground and USB-powered. It does not establish unplugged operation, deep Doze, TalkBack, cellular switching, bounded measured media memory or colour fidelity. Earlier Home/AOD/cancellation tests belong to version 0.2 and are retained separately. The new shared UI has not been rebuilt/rechecked on iOS Simulator or API36 emulator. Native iOS uploading remains unimplemented.

Machine-readable evidence: [android13-dji-demo.json](android13-dji-demo.json). Export hashes and edits: `artifacts/demo/deliverables/export.json`.

Reproduce the evidence consolidation with JDK21 configured:

```sh
python3 scripts/record-demo-evidence.py
python3 scripts/export-demo.py
```

`record-dji-demo.py` drives a new physical take from the exact supplied file already selected in review. It changes network settings during the test and restores them in `finally`. An externally killed runner cannot promise cleanup; inspect its record and restore settings explicitly, as done for take 2.

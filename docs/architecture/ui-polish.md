# Quiet upload UI

User request: keep the selected dark screening-room direction, remove diagnostic/jargony copy, and make this feel like a small polished upload app before recording. The supplied reference remains the visual direction; no new concept exploration.

## Keep

One clip, actual preview and metadata, confirmed progress, preparation, waiting/recovery, cancellation, verification, matching receipt, original download/viewing, settings, appearance and accessibility. No uploader/backend rewrite.

## Subtract

- Remove DEMO and the independent-prototype/notification-permission footer from every screen.
- Remove duplicate Quality/Destination rows. Review needs the file and one sentence, not a configuration form.
- Reduce the display heading to 34/39, retain the serif, let it wrap naturally, and give the media priority.
- Keep percentage/bytes during preparation/transfer/waiting. Hide redundant 100% bars during verification and receipt.
- Use short plain status copy. Preserve the distinction between sent, checking, received and cleanup pending.
- Keep full hash, receipt timestamp, sharing and link expiry behind receipt details.
- Keep prototype/platform/network limitations and credits under About Footage in Settings, not scattered through the primary flow.
- Show decimal KB/MB/GB labels for readable, correctly defined units. Byte-level verification remains unchanged. The user-provided 368.99 MiB file is 386,918,637 bytes (386.9 MB in the revised UI).

## Main copy

- Import: Bring your footage. / Choose a video to upload in its original quality. Your original stays on your phone. / Choose a video.
- Review: Ready when you are. / Original file. No compression or conversion. / Upload video; Choose another video.
- Preparing: Preparing your clip. / Saving a local copy / Keep the app open while we prepare the file.
- Sending: Sending your clip. / Uploading original. No additional paragraph.
- Waiting: Waiting for a connection. / Your progress is saved / We’ll resume when you’re back online. Inactive native attempts instead ask for Continue.
- Checking: Checking your clip. / Verifying the original / Actual size received; checking before marking complete.
- Received: Your clip arrived. / Original verified / Actual size received. File matches the original. / View received file; Send another clip.
- Cancellation pending: Cancelled on this phone. / Uploaded data is waiting to be removed. Reconnect to finish cleanup.
- iOS: Preview only. / Uploads are available in the Android app.

Validation: contract tests, lint/typecheck, actual Android/iOS renders, physical upload with the explicitly supplied DJI file, and independent original/received hashes. Do not infer a new physical pass from the previous APK. Record silent footage only, with a separate script. D-Log is user-described; metadata confirms HEVC Main 10, 3840×2880, 25 fps, not a colour-fidelity result.

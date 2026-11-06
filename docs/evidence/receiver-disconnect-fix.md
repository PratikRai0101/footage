# Receiver recovery after a disconnected upload

Recorded 29 October 2026. The receiver deadlock is fixed. The later [phone-side screen-off fix](android13-screen-wifi.md) has separate, limited physical evidence.

## What failed

A real Wi-Fi test disabled cellular fallback and then Wi-Fi during an upload. Android entered waiting and retained its job. After Wi-Fi returned, the receiver's health endpoint responded, but that upload's GET and HEAD requests hung. The receiver retained a partial file and issued no receipt.

Two local HTTP regressions reproduced the problem without the phone:

- Abort a PATCH after a prefix reaches disk, then ask for its offset and resume the same upload.
- Abandon a HEAD request queued behind an active PATCH, finish the PATCH, then attempt another HEAD and resume.

Both tests failed before the fix because the later HEAD did not return within its test deadline. The [saved failure log](receiver-recovery-before.tap) records those failures with the workspace path redacted. The raw lifecycle trace remains under `artifacts/device-spike/receiver-lifecycle-debug.log`. Neither contains upload capabilities.

## Cause and correction

The per-upload lock included the Node response adapter's delivery promise. The installed adapter could wait forever for `response.end` on a socket that had already been destroyed. A queued request could also reach the handler after its response's close event had already occurred, then wait for an event that would not recur.

`apps/server/src/server.ts` now:

1. Skips requests whose client disconnected while they waited for the upload lock.
2. Calls the maintained tus implementation's public `handleWeb` interface using `NodeRequest`.
3. Awaits protocol and storage completion before releasing the upload lock.
4. Sends the small protocol response only if the Node response is still live. It does not wait for delivery to a dead socket.

Incoming video data still streams through the maintained tus implementation. This does not replace the upload protocol, reset offsets, create a new job, or allocate a whole video as a buffer. Only outgoing tus control responses are buffered. The existing per-upload serialization and cancellation/completion outcome rules remain in place.

`srvx` 0.11.22 is declared directly because the integration imports its request adapter. The implementation does not patch `node_modules` or force an incompatible adapter major version into tus.

## Local verification

All 15 receiver integration tests pass. Three specifically cover disconnect recovery: content-length PATCH abort, chunked PATCH abort matching the Java client's framing, and an abandoned queued HEAD. Each resumes from the persisted prefix and reaches verified completion.

Run from the repository root:

```sh
npm test
npm run typecheck
npm run lint
```

For the focused regressions:

```sh
cd apps/server
npx tsx --test --test-name-pattern='aborted PATCH|abandoned HEAD' test/receiver.test.ts
```

Temporary lifecycle logging was removed after diagnosis. [The current test log](server-tests.tap) records the suite result.

## Phone verification and limits

[The Wi-Fi record](android13-wifi-recovery.json) preserves the original failure, deployment, repeated interruption, final integrity, and qualifications.

The fixed receiver was deployed with the existing partial upload retained. The deadlocked old process required a forced stop after graceful shutdown did not finish. That restart applied the code change. The subsequent controlled Wi-Fi loss and recovery occurred without another receiver restart.

On the same Samsung Android 13 phone:

- The receiver observed the phone's Wi-Fi address as its TCP peer. No USB upload forward was present.
- Wi-Fi and cellular data were both disabled for the interruption.
- The native owner entered waiting.
- Wi-Fi was restored and the same upload identity advanced again.
- Server bytes also advanced while Samsung reported non-interactive AOD `Dozing`.
- The original 299,779,969-byte generated clip eventually completed under its original identity, with matching source/received SHA-256 and matching native/server receipts.

The long screen-off run later hit a 90-second no-progress deadline. Completion followed wake and network-settings restoration. A shorter repeat was terminated by the outer runner deadline and also completed afterward. Neither terminated full scenario is relabeled as a complete stress-test pass. Those results are from the receiver-only fix stage. A later [native execution-resource fix](android13-screen-wifi.md) reproduced a screen-off stall, rejected a CPU-only attempt, and passed a continuous screen-off Wi-Fi test. The earlier failed full-size scenarios remain failures.

The verified result is recovery from the receiver deadlock and observed real Wi-Fi interruption. It is not proof of uninterrupted prolonged sleep execution, deep Doze, unplugged operation, cellular transfers, 4K/HDR handling, or production readiness. Both Wi-Fi and cellular settings were independently checked as restored to their original enabled state. Personal footage was not used.

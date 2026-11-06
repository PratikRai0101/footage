# How Footage gets an original from phone to receipt

Footage is an independent Android intake prototype, not a Cardboard integration. Its core rule is that the interface observes a native transfer, and a transfer is successful only after a matching receipt.

The [editable Excalidraw canvas](../../artifacts/architecture/Footage-engineering.excalidraw) has three frames: current architecture, recovery/integrity, and proposed improvements/Cardboard fit. PNG and SVG exports are beside the canvas.

## Current architecture

### 1. React Native handles intent and presentation

Expo Router presents one clip. The user selects it, reviews its actual metadata and local preview, then confirms Upload. Selection does not start Android's stable staging copy.

`useTransfer.ts` sends commands through the Expo native module and polls a sanitized snapshot every 750 ms while active. The interface does not upload bytes, hold the write capability or invent progress. No full video or base64 payload crosses the JavaScript bridge.

The source URI is needed for local review and native preparation. It must not be logged or included in shared evidence. iOS selection/preview works, but its native transfer owner is not implemented.

### 2. Kotlin owns the staged file and transfer identity

`TransferOwner.kt` opens the selected source, copies through a 64 KiB buffer and computes SHA-256 over those same copied bytes. It checks length, syncs the file and renames the partial copy before persisting a ready job. This uses disk space approximately equal to the original's size. It is not a zero-copy pipeline.

`TransferState.kt` uses Android `AtomicFile` for the job ID, staged asset, phase, confirmed bytes, destination and native capability. There is one transfer owner, one worker executor and one active job. Returning to the interface reads that job rather than creating a second uploader.

These copy/hash loops use bounded buffers. That is a code property, not a measured bound on the entire preview/decoder/OS memory footprint.

### 3. Android scheduling is platform-specific

API26–33 uses a foreground service. The Samsung work needed bounded CPU and Wi-Fi resources in addition to its notification under the tested conditions. API34+ has a user-initiated data-transfer job path.

The attempt window is bounded. Resources are released when work ends, is cancelled or the window expires. A saved job permits explicit continuation; persistence does not guarantee the OS will run a force-stopped app. Notification visibility also depends on permission.

The new DJI recording is foreground and USB-powered. Earlier Home/AOD/cancellation evidence belongs to the prior version0.2 build. The current APK must not inherit a claim that every lifecycle case was rerun.

### 4. tus owns byte-position reconciliation

The native client uses maintained `tus-java-client` 0.5.1. The receiver uses `@tus/server` 2.4.6 and its disk store.

The app registers its job with `POST /jobs`. For that identity, `HEAD /files/:id` reports the receiver offset. `PATCH /files/:id` appends bytes at the expected offset. The Java client's HTTP method-override fallback is supported by the receiver.

Internal file-read chunks are 64 KiB. HTTP request payloads are up to 2 MiB. Those are different boundaries. UI confirmation advances after a request returns its accepted offset, not after a socket write.

After connection loss, the owner retains the staged original and job ID. A retry registers/reconciles the same identity, then resumes at the receiver's offset. It must not assume the last displayed count equals the receiver's final partial prefix. See the [official tus protocol](https://tus.io/protocols/resumable-upload).

### 5. Node and SQLite own the durable outcome

The receiver stores media bytes on disk. SQLite stores job metadata, capability hashes and outcomes. An in-process per-job mutation queue serializes registration, tus operations, completion and cancellation. It is not a multi-process distributed lock.

An important fix was to await tus protocol/storage completion, not response delivery to a disconnected socket. Otherwise an aborted request could block the job's queue and prevent the next HEAD from reconciling. Aborted content-length PATCH, chunked PATCH and queued HEAD regressions cover this boundary.

This is a single-process, trusted-private-network receiver with bounded file size, retained jobs and reserved bytes. It has no production enrollment, workspace access model, TLS deployment or automatic retention/deletion system. Its current HTTP entrypoint is not an internet-ready service.

### 6. A matching receipt gates success

After byte transfer, the owner enters Verifying and calls `POST /jobs/:id/complete`. The receiver checks the full tus size/offset and streams SHA-256 over the stored original. A mismatch fails; it cannot produce Received.

The native owner accepts a receipt only when its job ID, byte count and SHA-256 match the staged original. That is the success boundary. The hash establishes byte identity against the selected/staged source, not camera authenticity, HDR fidelity or editorial quality.

Cancellation stops local work and requests remote cleanup. Offline cleanup remains pending. If a receipt committed first, a later Cancel cannot contradict it. Deletion of an already received original is a separate, unimplemented operation.

### 7. Read-only viewing has separate authority

The native owner can request a single-use viewing code with `POST /jobs/:id/view`. The browser removes its fragment before exchanging the code for a ten-minute HttpOnly, SameSite=Strict session. The code is redeemable once within two minutes.

The viewer can read metadata, stream byte ranges and download the original. It cannot upload or delete and never receives the original write capability. Playback does not monopolize the mutation queue. Viewer grants are in memory, so receiver restart invalidates them. Trusted TLS integration is needed before a production deployment. See [viewer details](receiver-viewer.md).

## What the real DJI take established

The explicitly supplied original was 386,918,637 bytes, HEVC Main 10, 3840×2880, 25 fps and 27.904 seconds. The phone-original hash matched the independently pulled original. The staged/native identity, received file and receipt matched it too.

Wi-Fi was disabled after 33,554,432 server bytes. The UI showed 8% with saved progress. The same job later resumed and produced its own verified receipt. No transfer throttle or USB upload reverse was used; cellular fallback was temporarily disabled.

Reconnection took about 56 seconds after Wi-Fi was enabled. That is an observed weakness to investigate, not an instant-recovery result. The short video visibly discloses 52.45 seconds of omitted repeated waiting. The full version retains that wait.

There are 48 passing automated tests across receiver, mobile contracts, proxy and native origin validation. TypeScript/Expo lint pass. Device evidence is scoped; unplugged operation, deep Doze, measured 4K memory and colour fidelity remain open. [Exact evidence](../evidence/android13-dji-demo.md).

## Improve the next version in this order

1. **Make reconnect behavior observable, then reduce avoidable delay.** Add connection-ready timestamps, attempt spans, timeout causes and first accepted-byte timing. Current retries combine network timeouts with exponential delay. Investigate an Android connectivity callback, bounded jittered backoff and prompt HEAD reconciliation without duplicate requests. Do not promise a particular reduction before measuring it.
2. **Create a trustworthy destination.** Add stable HTTPS, trusted TLS/proxy handling, user/workspace authorization, access revocation, quotas, retention and received-original deletion. Private IP validation is not a production trust model. Encrypt sensitive state/media where required by the threat model.
3. **Implement native iOS and close lifecycle gaps.** Explore file-backed background URLSession uploads with durable task/job reconciliation and a transport adapter. This is new implementation, not a switch in Expo. Test real iPhone backgrounding, reboot/force-quit restrictions, notifications, storage pressure and cancellation. Extend Android tests to unplugged operation, Doze, OEM policies and accessibility.
4. **Scale only after measuring the workload.** Move original storage and durable metadata to infrastructure that supports the required concurrency and failure model. A tus-backed object store or signed multipart design needs explicit retry, part/offset, checksum and idempotent completion semantics. The current in-process queue cannot coordinate replicas. A transactional outbox can publish verified-asset events without losing them between receipt commit and worker dispatch.
5. **Add editing derivatives as independent work.** Proxy, thumbnail and transcription jobs should have their own versioned identity and readiness. A failed transcript should not mark an intact original as a failed upload or force it to be uploaded again. Introduce Redis or another queue only if those worker needs justify it. Do not put a queue into the raw-byte path or rewrite Node in Go without a demonstrated bottleneck.

Useful future measurements are preparation time, time to verified original, network-ready-to-first-acknowledged-byte, resumed bytes, time to usable derivative, cancellation cleanup latency and peak process memory. No speed or cost improvement is claimed here.

## How this could help Cardboard

Cardboard's [mobile role](https://www.cardboard.ai/careers/product-engineer-mobile) explicitly mentions huge 4K/HDR files, bad networks and background uploads. Its [hard-problems page](https://www.cardboard.ai/hard-problems) discusses asset availability and collaboration. Footage supplies a narrow experiment relevant to that work, not evidence that Cardboard's current intake is defective.

One proposed extension is verified original intake followed by independently tracked proxies, thumbnails and transcripts, then an acknowledged handoff to an editing workspace. A receipt should not silently mean every derivative is ready. This is a candidate contract, not an implemented Cardboard API connection or a claim about its internal services. Some products may prepare media incrementally before full original verification; the diagram uses a conservative sequencing proposal for this experiment.

An alternative is a trusted phone-to-Mac handoff. Cardboard [markets local Mac editing without an upload requirement](https://www.cardboard.ai/desktop), so a cloud-first upload must not be forced into that workflow. Discovery, consent, authorization and local import would need a separate design and agreed integration contract.

Cardboard already publicly describes background browser imports and phone entry through chat apps. Browser-tab backgrounding is not native mobile lifecycle proof, and Footage should not be pitched as inventing a capability Cardboard lacks. Public product descriptions also vary by platform. [Dated first-party research and cautions](../research/cardboard-architecture-fit.md).

A defensible pitch is: "I built a focused experiment around getting a large phone original to a verified destination over an interrupted connection. The next question is how to expose that asset and its derivatives to an editing workflow, with cloud and local destinations treated separately."

## Source map

- UI/controller: `apps/mobile/src/features/intake/useTransfer.ts`, `presentation.ts`, `ScreeningRoom.tsx`.
- Native owner/state: `apps/mobile/modules/footage-transfer/android/src/main/java/expo/modules/footagetransfer/TransferOwner.kt`, `TransferState.kt`.
- Scheduling: `TransferForegroundService.kt`, `TransferJobService.kt`, `FootageTransferModule.kt` in that same directory.
- Receiver/outcomes: `apps/server/src/server.ts`, `jobs.ts`, `contracts.ts`.
- Viewer/security: `viewer-access.ts`, `viewer-page.ts`, `content.ts` in `apps/server/src/`.
- Device proof: `docs/evidence/android13-dji-demo.json` and `artifacts/demo/take-3/result.json`.

The diagrams are explanations, not a design change. This work does not modify the running app, require the phone or deploy a service.

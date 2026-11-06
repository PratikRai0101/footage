# T3 handoff grounding

## Scope and recommendation

Read-only source investigation of T3 checkout:

`<local-t3-checkout>`

The inspected commit is `d53873b6a4799e87afd63c8d288ef0089f5a3748`. All source citations below are relative to that checkout. The checkout remained clean. No CLI commands that contact the runtime were executed. No runtime credentials, personal projects, or live database contents were read. Only this research note was written.

**Recommendation: keep original-video intake in Footage, outside T3 core.** Receive and verify the original on the destination host, bind it to an explicitly chosen environment, project, and thread, and retain a durable local handoff record. For large files, describe the result as a verified workspace reference, not a T3 attachment. Do not send a T3 message automatically when the upload finishes. A later, explicit request can send the reference and ask the existing agent to use `$cardboard`.

There is a hard distinction:

- Saving the file and recording its selected destination without starting an agent needs no new T3 API.
- Sending a normal T3 message through the existing APIs creates or steers an agent run. `queue` avoids interruption, but does not mean passive storage.
- Publishing an ordinary transcript message immediately, while guaranteeing no agent start now or later, has no supported operation in the inspected command and MCP contracts. If that exact behavior is mandatory, a T3 core change is required. Do not present a local handoff record as an already-published thread message.

The evidence is `message.dispatch` and its complete dispatch-mode union in `packages/contracts/src/orchestrationV2.ts:2829-2865`, `ThreadManagementService.sendToThread` in `apps/server/src/orchestration-v2/ThreadManagementService.ts:752-834`, and the queue-versus-start decision in `apps/server/src/orchestration-v2/Orchestrator.ts:5264-5286`.

## Existing host CLI and executable entry points

T3 already has a host CLI. No new CLI server needs to be invented.

- The source entry is `<checkout>/apps/server/src/bin.ts`. It dispatches normal commands through `binCli.ts` and has fast paths for `acp-mcp-bridge` and `acp-mcp-call`. See `apps/server/src/bin.ts:1-37`.
- The npm executable is `t3`, mapped to `<package>/dist/bin.mjs`. In this checkout its derived build path is `<checkout>/apps/server/dist/bin.mjs`. See `apps/server/package.json:1-23`.
- The native build path is `<checkout>/apps/server/dist-exe/t3`, with supporting files beside it. See `apps/server/scripts/cli.ts:139-153` and `apps/server/vite.config.ts:84-94`.
- Neither generated executable was present in this checkout during inspection. These are derived entry paths, not proof of a working installed binary. A source invocation needs the repository dependencies and supported Node runtime. The server package declares Node `^22.16 || ^23.11 || >=24.10` in `apps/server/package.json:89-90`.
- Always supply a subcommand. Bare `t3` runs the default server handler. See `apps/server/src/binCli.ts:61-92`.

The supported commands include:

```sh
t3 thread list --project <project-id-or-path> --base-dir <t3-home> --json
t3 thread show <thread-id> --base-dir <t3-home> --json
t3 thread send <thread-id> - --base-dir <t3-home> --json
```

These examples were not executed. `send` reads text from standard input when the message argument is `-`.

`thread list` defaults to the project containing the current directory, pages internally with a limit of 100, and excludes subagents. `thread show` defaults to the latest ten conversation messages. `thread send` always calls `t3_thread_send` with `mode: "queue"`. It does not expose attachments, a request ID, or a passive-send flag. See `apps/server/src/cli/thread.ts:246-307,499-540,614-700`.

There is **no `t3 project list` command** in this checkout. `project` exposes only `add`, `remove`, and `rename`. Use the existing MCP project-list tool or authenticated project snapshot instead. See `apps/server/src/cli/project.ts:584-587`.

### Host access is not anonymous access

`thread` reads the persisted server origin for the selected T3 home, issues a temporary full-access MCP client session as the machine owner, calls `/mcp`, and revokes the session when the command finishes. If no runtime state exists, it reports that no server is running rather than launching one. Even listing through this CLI creates and revokes an auth session, so it was not used during this read-only investigation. See `apps/server/src/cli/thread.ts:42-50,201-244`.

`--base-dir` means the T3 data home, not the selected project directory. It is equivalent to `T3CODE_HOME`. Runtime state is normally under `userdata`, with the derived filename `server-runtime.json`. Development configuration can use `dev` instead when the base directory is not explicit. Configure the home explicitly to avoid targeting another environment. See `apps/server/src/cli/config.ts:42-48,501-522` and `apps/server/src/config.ts:127-153`.

The alternate `acp-mcp-call <tool> <arguments-json>` command already exists, but requires `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION`. It is not an unauthenticated shortcut. Do not scrape these values from an existing agent. See `apps/server/src/cli/acpMcpBridge.ts:15-23` and `apps/server/src/mcp/AcpMcpStdioBridge.ts:338-350`.

## Listing, selection, and workspace binding

Existing MCP operations provide the picker data:

- `t3_project_list`: optional nonnegative offset `cursor`, optional integer `limit` from 1 to 100. Returns `projects` and nullable `nextCursor`. Pages are live and may shift. `t3_project_read` accepts `projectId`. See `apps/server/src/mcp/toolkits/project/tools.ts:45-67`.
- `t3_thread_list`: accepts `projectId`, optional statuses, title filter, settled and snoozed filters, `includeSubagents`, cursor, and limit from 1 to 100. Returns thread IDs and titles, permission modes, status, and parent relationship. See `packages/contracts/src/orchestratorMcp.ts:308-364`.
- `t3_thread_read`: accepts `threadId`, returns `projectId`, archive state, modes, and `worktreePath`. Read pages clamp to at most 100 items, 50 recent runs, and 50,000 text characters per item. Item text offsets count UTF-16 code units. See `packages/contracts/src/orchestratorMcp.ts:367-472` and `apps/server/src/mcp/toolkits/orchestrator/tools.ts:208-214`.

The normal HTTP API already exposes `GET /api/projects`, through `EnvironmentHttpApi` group `projects`, method `snapshot`. It returns `ProjectSnapshot` and accepts normal bearer authorization. The host project CLI itself uses that typed client. See `packages/contracts/src/environmentHttp.ts:721-729` and `apps/server/src/cli/project.ts:232-236,317-328`.

For a normal authenticated client, `ORCHESTRATION_V2_WS_METHODS.subscribeShell` and `getThreadProjection` provide current thread state. Do not invent a REST thread-list or message-send endpoint. The exact existing method strings are `orchestration.subscribeShell`, `orchestration.getThreadProjection`, and `orchestration.dispatchCommand`. See `packages/contracts/src/orchestrationV2.ts:3125-3143,3241-3261`.

Proposed Footage checks, not existing T3 guarantees:

1. Let the user choose only from an administrator-configured project allowlist. Do not expose every project or its absolute host path to a paired phone.
2. Persist the destination environment ID, project ID, thread ID, and resolved workspace root with the upload record. Never select by title alone.
3. Before finalization and before a later send, re-read the thread. Reject a missing or archived target, a project mismatch, or an unexpected worktree change.
4. Use the thread's worktree when present, otherwise its registered project root. A path in the project root is not necessarily a path in the thread's worktree.
5. Generate the destination filename and reject path traversal, symlinks out of the allowed root, and non-regular files. Verify actual byte count and a digest before announcing success. Preserve the original bytes.

T3 has existing `AssetResource` variants `workspace-file` and `media-file`, but these are read or preview resources, not upload destinations or transcript-message attachment types. Their path limit is 1,024 characters. Workspace-file resolution checks real paths and rejects escape from the workspace. Media-file has different absolute-path behavior and should not be used to bypass intake confinement. See `packages/contracts/src/assets.ts:12-32`, `apps/server/src/assets/AssetAccess.ts:288-315,531-583`.

## Normal attachment contracts and runtime behavior

The supported ordinary file path is a signed upload followed by a separate message dispatch.

### Exact limits

- `ChatFileAttachment` is `type: "file"`, with `id`, `name`, `mimeType`, and `sizeBytes`. The byte count must be from 1 through **52,428,800**, inclusive. This is 50 MiB, not 50 MB. A video uses this file variant. There is no normal video variant with a larger limit. See `packages/contracts/src/chatAttachment.ts:13-17,159-174`.
- Normal images have a 10 MiB per-image limit. Total image bytes per message or question response cannot exceed 80 MiB. The general provider attachment-count limit is 100. These are different from the narrower MCP send-tool limit. See `packages/contracts/src/chatAttachment.ts:13-23,146-154,215-230`.
- The MCP `t3_thread_send_attachments` tool accepts **1 through 8** attachments, optional `threadId`, and optional message text up to 120,000 characters. It accepts only the known image and file types through `McpAttachmentInput`. It returns `threadId`, `messageId`, `runId`, and run status. It exposes neither send mode nor retry key. See `apps/server/src/mcp/toolkits/attachment/tools.ts:47-73` and `apps/server/src/mcp/toolkits/attachment/input.ts:1-10`.
- Attachment names are nonempty, at most 255 characters. File MIME types are nonempty, at most 100 characters. Upload files must be at least one byte. `ChatAttachmentId` is at most 128 characters and matches ASCII letters, digits, underscore, and hyphen. See `packages/contracts/src/chatAttachment.ts:32-38,159-172` and `packages/contracts/src/assets.ts:100-110`.

### Exact upload sequence

Existing MCP tool `t3_attachment_prepare_upload` accepts `{ upload: AttachmentCreateUploadUrlInput }`. For an original video within the limit, the upload object has `type: "file"`, `name`, `mimeType`, and `sizeBytes`. It returns `AttachmentCreateUploadUrlResult`, containing `attachmentId`, `relativeUrl`, and numeric `expiresAt`. The normal RPC equivalent is `attachments.createUploadUrl`. See `apps/server/src/mcp/toolkits/attachment/tools.ts:33-39`, `packages/contracts/src/assets.ts:90-122`, and `apps/server/src/ws.ts:2763-2764`.

Check the live environment's `attachmentUploads` capability before offering normal uploads. This source advertises it as true, but the contract makes the flag optional. See `packages/contracts/src/environment.ts:78` and `apps/server/src/environment/ServerEnvironment.ts:221`.

The signed URL is itself an upload credential and must not be logged. It expires **10 minutes after issue**. POST the raw bytes, not multipart data, to the returned relative URL on the same environment origin. The route prefix is `/api/attachments/upload`. A supplied `Content-Length` must equal the signed size. The server streams to a temporary `.part`, checks the actual byte count, renames on success, and returns **204**. Invalid or expired tokens return **404**. Length mismatch returns **400**. The inspected route has no chunk-offset, resumable-upload, checksum, or upload-status contract. See `packages/contracts/src/assets.ts:88`, `apps/server/src/http.ts:464-502`, and `apps/server/src/assets/AttachmentUpload.ts:35,95-117,122-147,153-220`.

A completed upload does **not** send a message or start an agent. Pending uploads are eligible for cleanup after 24 hours. Partial uploads are eligible after one hour. Sweeping is opportunistic when URLs are issued, with a 15-minute sweep interval, not a guaranteed deletion timer. See `apps/server/src/attachmentStore.ts:25-27,276-303` and `apps/server/src/assets/AttachmentUpload.ts:38-39,79-92`.

Sending claims pending files into thread-owned attachment storage and validates the stored byte count. Existing attachments must belong to the target thread. Claiming is separate from upload completion. See `apps/server/src/orchestration-v2/AttachmentClaims.ts:57-114`, `apps/server/src/mcp/toolkits/attachment/handlers.ts:17-35,82-113`, and `apps/server/src/orchestration-v2/ThreadMessageIntake.ts:169-181`.

### Attachment send is not passive or retry-safe through MCP

`t3_thread_send_attachments` generates a fresh command ID and message ID on every call and invokes `ThreadMessageIntake.sendToThread` with `mode: "auto"`. That can steer an active run, or start a new run when idle. Its own description explicitly says each call is a new message without a retry key. An accepted attachment does not prove provider consumption. See `apps/server/src/mcp/toolkits/attachment/tools.ts:47-53` and `apps/server/src/mcp/toolkits/attachment/handlers.ts:99-130`.

For retry-safe attachment delivery after an explicit user action, the existing normal client RPC can dispatch `message.dispatch` with stable caller-supplied `commandId` and `messageId`, attachment metadata, and `dispatchMode: { type: "queue_after_active" }`. It still starts a run when the thread is idle. The handler goes through `ThreadMessageIntake.dispatchCommand`, which claims uploads and releases unused claim copies on replay. This is existing T3 behavior, not a new API. See `packages/contracts/src/orchestrationV2.ts:2829-2865`, `apps/server/src/ws.ts:1859-1906`, and `apps/server/src/orchestration-v2/ThreadMessageIntake.ts:137-166`.

Do not exploit the forward-compatible `ChatUnknownAttachment` decoder by inventing a large-video type. The normal MCP tool excludes that decoder, and compatibility decoding does not implement storage, rendering, or provider support. See `packages/contracts/src/chatAttachment.ts:176-190,208-213` and `apps/server/src/mcp/toolkits/attachment/input.ts:7-10`.

## Retry-safe text-reference delivery

`t3_thread_send` accepts `OrchestratorMcpThreadSendInput`:

```text
threadId
message                         nonempty, at most 120,000 characters
mode?                           auto | queue | steer | restart
clientRequestId?                nonempty, at most 256 characters
```

It returns `OrchestratorMcpThreadSendResult`, containing `threadId`, `messageId`, `runId`, run status, and delivery classification. See `packages/contracts/src/orchestratorMcp.ts:43-51,474-492`.

For this operation, the server derives IDs from the **MCP request namespace, operation name, and clientRequestId**. An omitted key becomes a random key. Outside-client namespaces are `client:<auth-session-id>`. Reconnects using the same auth session preserve the namespace. A new auth session does not. The same key must identify one immutable request and destination, not just the same filename. See `apps/server/src/mcp/OrchestratorMcpService.ts:742-810,1493-1495,2830-2879` and `apps/server/src/auth/McpOAuth.ts:535-552`.

The orchestrator stores durable command receipts. Replaying an accepted command ID for the same thread returns its original sequence and stored events. A previously rejected command remains rejected. Reusing that command ID for another thread is refused. The replay check does not compare the full payload, so Footage must forbid a retry key with changed content. See `apps/server/src/orchestration-v2/Orchestrator.ts:11718-11780`. Events, receipts, projections, and effects commit through the event sink transaction. See `apps/server/src/orchestration-v2/EventSink.ts:639-694`.

`mode: "queue"` is the safe existing choice when an explicit send must not interrupt the current turn. It is **not** a guarantee that no agent runs. When no blocking run exists, the orchestrator starts the turn. `auto` can steer. `restart` explicitly restarts. See `apps/server/src/orchestration-v2/ThreadManagementService.ts:763-784` and `apps/server/src/orchestration-v2/Orchestrator.ts:5264-5286`.

The stock `t3 thread send` CLI supplies no `clientRequestId` and creates a new temporary auth session for each invocation. It cannot provide retry-safe delivery across repeated CLI invocations. Adding a flag alone would not solve the namespace change. See `apps/server/src/cli/thread.ts:218-227,614-637`.

A host adapter can instead use either:

- One approved, persistent MCP client auth session plus `t3_thread_send` with an immutable `clientRequestId`, if sends are text-only and explicit.
- The normal client RPC `message.dispatch` with persisted `commandId` and `messageId`, if ordinary attachments or IDs independent of MCP auth-session renewal are required.

Persist the handoff record before network dispatch. Mark an uncertain response as unknown, not failed, and retain the media. Retry the identical IDs with the identical payload. Query thread state and match the returned or derived message ID. MCP `t3_thread_read` exposes message IDs and pagination. The normal client can read the thread projection. Do not resend with a fresh ID merely because a response was lost. See `packages/contracts/src/orchestratorMcp.ts:441-472` and `packages/contracts/src/orchestrationV2.ts:3241-3245`.

There is no receipt-status endpoint asserted here. Receipt replay and the existing thread reads are the grounded recovery mechanisms. MCP key-based recovery across auth-session replacement needs the previous namespace or the stored message ID and reconciliation. Do not claim global idempotency for `clientRequestId` alone.

## Authentication and configuration

Keep T3 credentials on the host, never on the phone. Phone pairing and upload authorization belong to the proposed Footage intake service. Limit that service to configured destinations and generated media paths. Its privileged host account must be able to write the destination files. The selected T3 environment must run on that host, or files need an explicit transfer to that environment's host before the path can be used.

Two existing T3 auth contracts must not be mixed:

1. **MCP outside-client auth.** `/mcp` supports OAuth. The user approves read-only or a writable permission ceiling. Credential exchange requires HTTPS or localhost. Sessions last 30 days. Read-only clients cannot upload or send, and a writable caller cannot target a thread whose runtime or interaction mode exceeds its ceiling. See `docs/user/outside-agents.md:9-57,90-95,122-127`, `apps/server/src/auth/EnvironmentAuth.ts:72-96,1264-1305`, and `apps/server/src/mcp/McpToolAccess.ts:75-90,132-166`.
2. **Normal client bearer auth.** `t3 auth session issue` already issues scoped bearer tokens for headless or remote clients. `--scope` is repeatable and replaces the broad default scope list. A host adapter using ordinary HTTP and RPC needs `orchestration:read` for discovery and reads, and `orchestration:operate` for upload signing and dispatch. See `apps/server/src/cli/auth.ts:159-192`, `apps/server/src/cli/authScopes.ts:4-10`, `packages/contracts/src/auth.ts:30-31`, and `apps/server/src/auth/rpcAuthorization.ts:41-58,158-161`.

Normal client RPC uses the existing typed Effect RPC WebSocket protocol, not an invented JSON message-send HTTP request. The client implementation uses `WsRpcGroup` with JSON RPC serialization. The existing ticket endpoint is `POST /api/auth/websocket-ticket`; use the established connection code rather than putting bearer secrets in logs or browser URLs. See `packages/contracts/src/environmentHttp.ts:559-566`, `packages/client-runtime/src/rpc/protocol.ts:1-6`, and `packages/client-runtime/src/rpc/session.ts:207-240`.

MCP client tokens are deliberately rejected outside `/mcp`, and `/mcp` rejects ordinary sessions without the MCP subject. A normal bearer token is not interchangeable with an OAuth MCP token. See `apps/server/src/auth/EnvironmentAuth.ts:72-77,619-625,1264-1283`.

Required deployment configuration therefore includes the allowed T3 origin and environment identity, T3 data home for owner-CLI discovery if used, executable path if used, configured project allowlist, destination workspace policy, the correct host-held credential type, and a durable Footage upload and delivery ledger. Credential provisioning and all live compatibility checks remain unperformed in this investigation.

## Design comparison

### A. Normal small attachments plus explicit large workspace references

Use the existing attachment upload API only for files within its documented bounds. Upload completion remains storage-only. Keep a pending Footage record until the user explicitly requests a T3 send or agent action. For larger originals, stream into a confined host workspace location and record environment, thread, relative path, original name, MIME hint, byte count, SHA-256, and upload ID in the Footage ledger. The digest and immutable upload record are proposed Footage guarantees, not existing T3 attachment fields.

A later ordinary text message can describe that verified file. Do not put a signed preview URL into the durable record as the only reference. Asset URLs expire, and the actual provider needs host filesystem access. T3 composer `FileContextRecord` binds to `attachmentId`; it is not an arbitrary verified-workspace-file record. See `packages/contracts/src/composerContext.ts:87-106` and `packages/contracts/src/assets.ts:90-122`. T3 asset URLs have a one-hour default TTL in `apps/server/src/assets/AssetAccess.ts:75,523`.

This design needs Footage implementation and host configuration, but no T3 checkout changes. It cannot honestly promise an immediate passive message inside the T3 transcript. In the no-core version, the accurate completion state is "Original received; ready for this thread", not "Posted to thread".

### B. Extend T3 core

A core change is justified only if passive transcript publication, a first-class large-media object, or a T3-owned durable intake queue is mandatory. A proposed passive-message command would need explicit semantics for `runId: null`, timeline visibility, inclusion in a future provider turn, edits and deletion, and permission checks. Reuse the existing command receipt and event sink instead of writing directly to SQLite.

A first-class large-media reference additionally needs a contract, root and identity validation, retention and cleanup ownership, preview and download rules, provider behavior, and web, desktop, and mobile rendering. Retry-safe attachment MCP sends would need stable IDs and an explicit delivery mode rather than the current fresh-ID `auto` path. None of these are existing contracts.

Do not increase the global 50 MiB constant to solve phone intake. That changes the normal attachment contract across transports, clients, providers, and retention paths. The smallest core proposal, if required, is passive reference publication, not a new general-purpose upload API or an unbounded attachment type.

## Hard blockers and remaining checks

- Immediate ordinary-message publication with a guarantee of no agent start is unsupported in the inspected contracts. This is the main requirement decision.
- The stock host send CLI is not retry-safe across process retries. The attachment MCP send has neither a retry key nor a queue-only mode.
- A same-host path is useless to an agent running in another environment, container, or inaccessible workspace. Environment and filesystem mapping must be explicit.
- Normal upload URLs expire in ten minutes and have no resumable contract. They cannot carry originals larger than 50 MiB through the supported API.
- Provider acceptance is not proof of video understanding or successful editing. Preserve the original and use the separate Cardboard workflow after the user requests it.
- No installed CLI, running server version, credentials, allowed projects, or target thread was inspected. Source compatibility does not prove the live instance runs this commit. Verify those during authorized integration.
- Upload retry and interruption handling for multi-gigabyte originals are Footage work. Do not claim T3 implements them.
- No Cardboard app, CLI, timeline, or skill files were changed. The later `$cardboard` edit request remains separate from upload completion.

# Run Footage

## iPhone Simulator

```sh
npm ci
npm run ios:build
```

Install `artifacts/ios-simulator/Footage.app` on an iOS Simulator. This is an embedded-JavaScript, ad-hoc-signed Simulator build, not a physical iPhone distribution build. Open Settings → Connect computer. An unconnected app deliberately shows Preview only.

## Connect a Mac

Start the private receiver on the computer that will hold the originals:

```sh
npm run receiver:paired -- --host "$(scutil --get LocalHostName).local" --init
```

`--init` explicitly creates the wrapping key in macOS Keychain and provisions a private TLS certificate. Use it **once**. Later starts omit `--init` and use the same host/storage. A missing wrapping key is an error, not permission to reset saved uploads. The default private data directory is `apps/server/data/paired`. The OS wrapping backend currently supports macOS only.

In the receiver terminal:

1. Type `pair`. A private, two-minute `Connect.footage` file is exported under the data directory.
2. Transfer that file directly to your phone using a trusted channel, such as AirDrop. Do not post it or obtain it from an untrusted website.
3. In Footage Settings, tap Connect computer and select that file. Confirm the exact computer and destination in the native alert.
4. Type the displayed `approve <request>` command in the receiver terminal, only for the phone you are connecting.
5. Choose a video, review it and tap Upload original.

Keep Footage open during preparation. It makes a stable native copy, hashes and encrypts it, then queues file-backed background transfers. Once prepared, the system can continue the transfer without React running. Force-quitting does not promise automatic restart; reopen Footage to reconcile the same job. Success requires the exact original's hash-matched receipt.

The paired service admits originals up to **1 GiB**, subject to disk/quota. The larger binary protocol limit is not a promise of admission. Both computer and phone need network access to the chosen HTTPS host; allow iOS local-network access when requested. Simulator loopback evidence is not physical LAN certification.

View received file opens a read-only, app-scoped-trust viewer. Share links are one-use and expire after two minutes; opening them outside Footage requires the receiving browser to trust the receiver's HTTPS certificate. No global certificate authority is installed by Footage.

Changing a connection cannot redirect an active upload. Finish or confirm cancellation first. Completed originals and receipts are archived natively before a new upload occupies the active slot.

## Choose and send to a T3 thread

T3 must run on this **same computer**, so the chosen agent workspace can access the verified original. Provision a writable **outside-client MCP credential** yourself and save only the raw token on one line in a private file (`chmod 600`), without JSON or a `Bearer` prefix. A normal T3 bearer is not an MCP token. Do not put a token in command arguments or the phone.

Start the receiver with an explicit environment, project and thread:

```sh
npm run receiver:paired -- \
  --host "$(scutil --get LocalHostName).local" \
  --mcp http://127.0.0.1:T3_PORT/mcp \
  --token-file /path/to/private-mcp-credential \
  --environment ENVIRONMENT_ID --project PROJECT_ID \
  --thread THREAD_ID_A --thread THREAD_ID_B
```

Replace the placeholders with the T3 instance you authorize. The receiver reads that environment/project/thread, rejects an archived or mismatched target, and resolves the actual thread worktree or registered project root. It does not discover credentials, choose an active thread, create a project, or increase T3's attachment cap.

Repeat `--thread` for the threads you authorize (up to 16 retained destinations). Each is resolved against the real T3 environment/project/thread/workspace, not an active-thread guess. Export a fresh connection file with `pair` and connect either phone. **Settings → Choose destination** browses this authenticated, pre-authorized catalog. New destinations require a fresh explicit enrollment grant; the list is not itself permission to expand scopes. Existing uploads retain their original intake mapping; changing CLI arguments or the next phone destination cannot repoint them.

After upload, terminal commands are:

- `jobs`: show job IDs and original outcomes.
- `deliver JOB_ID`: stream the verified original into the chosen workspace's `.footage-originals/`, recheck its hash and retain a durable delivery record. **No agent starts.**
- `send JOB_ID`: explicitly publish that workspace reference using `t3_thread_send`, `mode: queue` and a persisted retry identity. This can start or queue agent work. It is not passive transcript storage.
- `quit`: stop admissions and drain receiver storage work before closing.

On **both phones**, a matching received original exposes **Send to thread**. A separate native confirmation names that original's frozen destination and warns that agent work can start. Verification details also offers **Save to thread without starting agent**. Cancel the confirmation to do nothing. An uncertain send stays unconfirmed; Retry send uses the same original/request identity, even after changing the next destination or reopening the app.

Upload/verification never automatically starts T3 or Cardboard. The message asks the agent to inspect the original with `$cardboard`; paid media generation is not authorized. The desktop `deliver`/`send` commands remain available as explicit operator alternatives.

If a send response is lost, retry `send` for the **same job**. Do not change the token or destination. The same immutable message/request identity is replayed. Changing the MCP credential namespace during an uncertain send blocks automatic retry until the old message is reconciled. Live T3 authentication/delivery must be verified against your chosen instance; repository tests use an owned contract fixture and do not claim a message was sent to your account.

## Android

The normal Android 0.6 app uses **the same paired connection-file and phone-side T3 flow** described above. Its native owner fully preseals G2 groups, wraps job authority in AndroidKeyStore and uses the existing OS service/job scheduler. Neither video bytes nor credentials are uploaded through JS.

For an explicitly unpaired legacy setup only, the native tus uploader remains available with the original private receiver:

```sh
npm run server
npm run android:demo
```

Enter that receiver address in Android Settings. The Android uploader and iPhone uploader use different native transports; there is no JS video uploader. Current paired HTTPS/AndroidKeyStore, background upload and phone handoff were exercised on an owned API36 emulator; physical-device/hardware-backed storage acceptance remains separate. A paired saved job cannot silently switch to the legacy receiver. Existing older Android evidence remains version-scoped.

## Local checks

```sh
npm test
npm run typecheck
npm run lint
python3 scripts/test/ios-background-runtime/run.py --unit-only
python3 scripts/test/sealed-android/run.py
```

The optional actual macOS wrapping test needs the native helper built first and `FOOTAGE_TEST_KEYCHAIN=1`; it creates/deletes only its own recorded test item. GitHub CI/CD remains disabled. Before pushing, commit the intended files and run `npm run preflight:public` from a clean tree.

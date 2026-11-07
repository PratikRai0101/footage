# Evidence scope and privacy

Records are specific to the app version, device and conditions named in each file. Earlier Android or iOS results do not certify a rebuilt binary.

Public copies redact personal phone serials, developer home paths and recorded private LAN addresses. Original media, raw captures, runtime credentials, app binaries and the private pre-public Git backup are excluded from this repository. Historical source hashes describe the originally recorded build; privacy-redacted source text is not claimed to be byte-identical to those private snapshots.

Current **0.5 ordinary-app** connection, background upload, receipt, archival/relaunch and read-only viewer acceptance is in `normal-app-0.5.md` / `.json`. T3 workspace delivery/explicit retry-safe send is implemented and tested against an owned MCP contract fixture, not a live account. Android 0.5 builds; current device acceptance and paired T3 parity remain outstanding. `full-frame-ios-rebuild.md` is the historical 0.4 preview-only rebuild, not the current feature status.

Run `npm run preflight:public` before publishing. It checks reachable Git history and reports filenames/categories without printing matched values. Pattern checks cannot guarantee the absence of every possible secret.

Physical-device recording scripts require an explicitly supplied device and host. `verify-physical-transfer.py` additionally requires `FOOTAGE_AUTHORIZED_ANDROID_SERIAL` to match its required `--serial` argument. Never choose or drive a personal phone implicitly.

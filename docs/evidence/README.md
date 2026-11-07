# Evidence scope and privacy

Records are specific to the app version, device and conditions named in each file. Earlier Android or iOS results do not certify a rebuilt binary.

Public copies redact personal phone serials, developer home paths and recorded private LAN addresses. Original media, raw captures, runtime credentials, app binaries and the private pre-public Git backup are excluded from this repository. Historical source hashes describe the originally recorded build; privacy-redacted source text is not claimed to be byte-identical to those private snapshots.

Current **0.6 shared-app** paired uploads, phone-side T3 selection/send, background completion, cancellation and lost-reply/cold-reopen acceptance are in `mobile-parity-0.6.md` / `.json`. Runs used an owned iOS Simulator, Android emulator and local MCP fixture—not physical phones or live T3 accounts. `normal-app-0.5.md` and `full-frame-ios-rebuild.md` remain historical, version-scoped records.

Run `npm run preflight:public` before publishing. It checks reachable Git history and reports filenames/categories without printing matched values. Pattern checks cannot guarantee the absence of every possible secret.

Physical-device recording scripts require an explicitly supplied device and host. `verify-physical-transfer.py` additionally requires `FOOTAGE_AUTHORIZED_ANDROID_SERIAL` to match its required `--serial` argument. Never choose or drive a personal phone implicitly.

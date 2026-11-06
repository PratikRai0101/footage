# Evidence scope and privacy

Records are specific to the app version, device and conditions named in each file. Earlier Android or iOS results do not certify a rebuilt binary.

Public copies redact personal phone serials, developer home paths and recorded private LAN addresses. Original media, raw captures, runtime credentials, app binaries and the private pre-public Git backup are excluded from this repository. Historical source hashes describe the originally recorded build; privacy-redacted source text is not claimed to be byte-identical to those private snapshots.

The current foreground-native iPhone upload slice is documented in `ios-foreground-upload.md`. The earlier UI rebuild is in `full-frame-ios-rebuild.md`. Background iOS uploads and T3 delivery remain unfinished.

Run `npm run preflight:public` before publishing. It checks reachable Git history and reports filenames/categories without printing matched values. Pattern checks cannot guarantee the absence of every possible secret.

Physical-device recording scripts require an explicitly supplied device and host. `verify-physical-transfer.py` additionally requires `FOOTAGE_AUTHORIZED_ANDROID_SERIAL` to match its required `--serial` argument. Never choose or drive a personal phone implicitly.

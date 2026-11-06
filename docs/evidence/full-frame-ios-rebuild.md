# Full-frame iPhone rebuild: 0.4.0 (4)

The approved full-screen composition and serif/charcoal/warm-white treatment are now running in the real app, not just HTML studies.

- **Target:** dedicated iPhone 17 Pro Simulator, iOS 26.2. No physical phone.
- **Build:** unsigned Release arm64 Simulator `.app`, embedded JavaScript/assets, no Metro. Artifact: `artifacts/ios-simulator/Footage.app`.
- **Checked:** actual Files picker; generated clip metadata; full-frame playback; moving video pixels; close control below the status area and at least 44pt; return to the same selected original; About/platform disclosure; larger text after cold launch; restored standard text size.
- **Fixture:** generated 8-second 1280×720 H264/AAC video. No unrelated media was inspected.
- **Evidence:** [`full-frame-ios-rebuild.json`](full-frame-ios-rebuild.json). Local captures and logs: `artifacts/rebuild/`.
- **Recheck saved evidence:** `python3 scripts/verify-iphone-rebuild.py`.

The first runtime renders exposed a too-dark/incomplete backdrop and a removed React Native style alias. Those attempts remain in local capture history. The final renderer uses full-canvas dimensions, supported absolute-fill styles and number-typed gradient stops. An ESLint rule rejects the actual old API mistake, with passing and failing regression cases. Playback uses one player and a native modal, not two decoders.

The Android test session and receiver were stopped when the user requested iPhone-only iteration. Its unvalidated test APK was removed; the pre-existing AVD and historical version-0.3 evidence were preserved. No Android runtime pass is claimed for this rebuild.

**Limits:** iPhone upload and T3 destination/delivery are still unimplemented. No uploaded/received receipt is invented in this iOS build. Appearance modes, VoiceOver, physical iPhone behavior, 4K/HDR fidelity and whole-pipeline memory are not newly certified by this record. The Simulator GUI app is not installed here; the actual CoreSimulator instance runs headlessly and is driven through local automation.

Git history covers both the app and receiver, retaining Expo's original initial commit. This rebuild was recorded before GitHub publication; the user subsequently approved the public `PratikRai0101/footage` repository. Build/media artifacts and runtime credentials stay out of Git, and public evidence redacts private device/network identifiers.

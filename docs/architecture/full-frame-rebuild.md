# Full-frame rebuild

The user approved C's photographic layout with A's Instrument Serif, charcoal and warm-white palette. Keep the approved copy lean. Do not add onboarding paragraphs, badges or non-working T3 controls.

## Work units

- [x] Inspect Git ownership and restore dependencies.
- [x] Preserve the original Expo scaffold commit and establish one app/server repository.
- [ ] Implement the full-frame canvas and full-frame playback.
- [ ] Carry existing upload, recovery, receipt and settings controls into the canvas.
- [ ] Run tests, build locally and inspect the running app.
- [ ] Commit verified units. GitHub creation/publication requires confirmation.

## Existing ownership

`useTransfer` commands the native transfer owner and observes sanitized snapshots. Kotlin owns copying, original bytes, retries and stored job identity. The receiving server owns accepted offsets and matching receipts. This visual rebuild does not move those responsibilities into React or change the upload protocol.

`ScreeningRoom` owns layout/actions. `Preview` owns one local video player, metadata events, pause-on-background behavior and fullscreen presentation. `SettingsSheet` retains the existing receiving-address, appearance and disclosure controls. Native iOS upload is still unimplemented.

## Preview shape

Two approaches were compared:

1. Separate background and fullscreen players. Rejected: duplicate 4K decoders, divergent playback state and unnecessary resource ownership.
2. One player/view, cropped while paused behind the interface, contained during native fullscreen playback. Selected: the same original and lifecycle owner, with no new native dependency.

The preview exposes a render-state union to the foreground: sample, loading, still, ready with `playFullFrame`, or unavailable with a message. Only ready offers a play action. The native view is inaccessible behind foreground controls. Fullscreen switches to contain before presentation; leaving or backgrounding pauses playback. The existing source-load metadata path remains.

Use the already-installed SVG module for readability gradients. Keep the photographic canvas dark in both appearance modes; adapt the controls and settings sheet to the existing preference. Long content scrolls; primary actions stay at the bottom. No font-size cap to hide large-text failures.

## Supported feature boundary

T3 thread selection and dispatch have not been implemented or configured. Do not put sample thread labels or a dead `Send to thread` button in the running app. Preserve the real received-file action until the grounded host adapter exists. The complete approved studies remain under ignored local `artifacts/design-t3/`; they are not evidence of implemented T3 delivery.

## Git findings

Initially the workspace root was not a repository. `apps/mobile` contained only Expo's initial commit `ff4fc2e`, with no remote. Its original metadata was preserved under ignored `artifacts/git-history/`; that commit is the parent of the new workspace baseline. The application and server now share root history. No accessible Footage/Cardboard-named GitHub repository was found, and no GitHub repository was created or pushed. Do not invent historical micro-commits.

## API grounding

Expo package: SDK 58, `expo-video ~58.0.13`. Fetched the SDK 58 index, SDK 58 video documentation and Expo documentation index before changing APIs. `VideoView.enterFullscreen()` returns a promise; `onFullscreenExit`, `contentFit` and native controls are supported. Keep `textureView` for the layered Android canvas, disable screen/background playback ownership as before.

Static-design approval is recorded in local `artifacts/design-t3/HYBRID-REVIEW-R2.md`. New native screenshots/build results belong to the rebuilt version only, not previous Samsung lifecycle evidence.

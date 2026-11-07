# Completion plan

Status is based on working code and recorded checks, not mockups. No percentage is assigned: finishing the screen is not finishing the upload-to-thread workflow.

## Working

- Approved full-frame interface, serif typography and restrained colors.
- Actual iPhone Simulator picker, metadata and full-frame playback.
- Android native original preparation, resumable transfer, cancellation and matching receipts, under the versions/conditions named in evidence.
- Desktop receiver: resumable storage, original byte/hash verification, durable outcomes and a read-only browser viewer.
- Public repository and small commits. GitHub CI/CD is disabled; checks run locally before pushes.

## Next verified units

1. **Native iPhone background upload.** A foreground upload core has passed Simulator tests on a separate implementation branch, but foreground-only behavior does not meet the requirement and is not merged into `main`. Build on that work without substituting manual continuation for real background transfer. Preserve native staging/hash, durable identity, confirmed progress, truthful cancellation and matching receipts. Keep the design and copy lean.
2. **Authorized desktop connection and T3 destination selection.** Keep credentials on the desktop; expose only allowed environments/projects/threads. Pin exact identities when the user confirms upload. Never choose a later active thread on the user's behalf.
3. **Large original available to the chosen thread.** Validate the selected thread/workspace, make the verified original available there and retain a durable delivery record. No attachment-limit bypass, private database edits or fake thread publication.
4. **Explicit, retry-safe T3 dispatch.** User confirmation starts an agent turn without interrupting active work. Reconcile uncertain responses using the same immutable message identity; no duplicate messages or byte reupload. Cardboard editing remains a separate user request.
5. **Full end-to-end acceptance.** iPhone select/review/upload/background continuation/interruption/reopen/receipt/thread delivery, wrong or unavailable target, cancellation cleanup and a separately requested Cardboard inspection/edit. Verify both iPhone and Android builds of the shared app; do not create an iPhone-only fork. Run on actual built apps and preserve build-scoped evidence.

## Separate unfinished background requirement

A standalone native probe proved Apple's background URLSession follows redirects without calling the redirect-veto delegate. Another origin received the complete generated payload. The foreground control honored the veto. See `evidence/ios-background-origin-blocker.md`.

**Corrected requirement:** background upload remains mandatory. The foreground-only milestone was an assistant-selected tradeoff, not user approval to remove that requirement. Keep its tested code as a foundation on a separate branch; do not activate it on `main` or present it as the finished iPhone feature.

The [standalone background proof](evidence/ios-background-transport-probe.md) rejected TLS/ATS pinning alone: an HTTP downgrade still disclosed the generated original. Sealed upload content and authenticated acknowledgments passed the bounded proof, including daemon-owned transfer while the test app was stopped. This is not integrated app behavior, durable multi-chunk recovery, pairing, or final-receipt acceptance.

The [independent security/architecture review and implementation contract](architecture/sealed-background-upload.md) conditionally accepts B's fundamentals for isolated implementation slices, not activation. It compares full presealed groups against bounded native refill and selects full preseal with bounded authenticated frames aggregated into larger immutable file-backed tasks. The review found and corrected a research-listener self-test ordering defect; live regression tests now prove rejected packets cannot publish an original. The historical Simulator proof was not rerun for that proof-only change.

The model allows encrypted content to follow redirects, not original plaintext or reusable authority. Do not describe background URLSession as rejecting redirects when it does not. The received original must still match the original bytes and hash. The parent accepted the corrected contract for isolated implementation (G0). Gates G1–G7 (pairing, canonical codec/crypto, durable common receiver receipts, native ledger, actual Expo no-JS lifecycle, shared-app acceptance and physical iPhone/Android evidence) remain required before real-upload activation/completion.

A server promise not to redirect, checking the final response URL, or merely stripping Authorization is not an adequate fix for original-file disclosure. Any different transport/authority design must be explicitly reviewed and verified before integration. Force-quit must never be presented as a guaranteed automatic restart.

## Background architecture gate

- [x] Ground: existing native ownership, SQLite/tus outcomes and receipt boundary; see `architecture/engineering-walkthrough.md` and the upload-core branch.
- [x] Sketch: independent proof review and [design contract](architecture/sealed-background-upload.md) recorded, including caller-first interfaces, canonical framing/limits, pairing, native lifecycle, cancellation and durable common receiver outcomes. Both full presealed groups and bounded native refill evaluated; full preseal selected as the proposed first slice.
- [x] Agree: parent accepts the corrected [G0 contract](architecture/sealed-background-upload.md#g0-acceptance--parent-integration-review). **GO for isolated implementation; NO-GO for real-upload activation** until its gates pass. Corrected group overhead, QR bounds and enrollment proof-of-possession are recorded before parallel implementation. This is not production approval, a foreground-only substitution or a weakening of confidentiality or authority.
- [ ] Implement the usable app: native components are integrated, but normal iPhone uploads remain disabled. The verified engine is not the finished product.

### Current integrated result

- Paired encrypted transfers, macOS Keychain wrapping, supervised durable receiver publication and shared original receipts work in the recorded native/Expo tests. The explicit paired service admits up to 1 GiB, subject to remaining capacity.
- Real paired Expo OS wakes process receipts without JS. Exact-ID AppDelegate routing and enumeration drain ordering are fixed.
- Remote setup/status/revoke no longer block the serialized event owner. One actual held-control run completed UIKit handoff while the TLS response remained pending; later fixture-ordering failures remain documented, not relabelled success.
- Parent independently reran **105 root tests**, **50 native cases**, the three routing-plugin tests, typecheck and lint after integrating the final fix. The root run opted into the fresh-item macOS Keychain test. No new full Expo build was run by the parent for that merge.

### Product work still unfinished

- Normal native installation, iOS bridge/snapshot/command activation and user-facing connection/confirmation flow. The current ordinary build remains preview-only; there is no release acceptance claim.
- Private LAN/local-network denial, AndroidKeyStore and current shared-app acceptance, physical iPhone/Android testing. JVM networking and Simulator process experiments do not certify those conditions.
- T3 destination selection, workspace delivery and explicit retry-safe dispatch. Reserved view/list interfaces still have no activated reply schemas.
- Retention/repair and replacement-generation workflows. Six early test-only Keychain entries remain unresolved because their exact IDs were not retained; current fixtures track/delete their own exact items.

Historical version-scoped checks and exact limitations remain in the linked evidence and architecture contract. No agents remain running after the nonblocking-control handoff.
- [ ] Scrap when needed: reject a design if concrete failures contradict its model; do not paper over them with unverified success states. The TLS/ATS-only candidate is already rejected.

## Delivery discipline

Use small coherent commits, run local tests/typecheck/lint and the public-history preflight, then push. Leave the parent worktree clean. Isolated implementation work is reviewed and integrated before it is represented as shipped. Do not re-enable GitHub automation or change account billing.

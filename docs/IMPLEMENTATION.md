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

Next, prove a safe background transport against real receiving listeners before adopting it. Both original-file confidentiality and write authority must stay within the chosen receiver. Test different-origin HTTPS redirects, HTTPS-to-HTTP downgrade, the same certificate on another origin, and actual background continuation. Do not describe background URLSession as rejecting redirects when it does not.

A server promise not to redirect, checking the final response URL, or merely stripping Authorization is not an adequate fix for original-file disclosure. Any different transport/authority design must be explicitly reviewed and verified before integration. Force-quit must never be presented as a guaranteed automatic restart.

## Delivery discipline

Use small coherent commits, run local tests/typecheck/lint and the public-history preflight, then push. Leave the parent worktree clean. Isolated implementation work is reviewed and integrated before it is represented as shipped. Do not re-enable GitHub automation or change account billing.

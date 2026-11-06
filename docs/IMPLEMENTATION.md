# Completion plan

Status is based on working code and recorded checks, not mockups. No percentage is assigned: finishing the screen is not finishing the upload-to-thread workflow.

## Working

- Approved full-frame interface, serif typography and restrained colors.
- Actual iPhone Simulator picker, metadata and full-frame playback.
- Android native original preparation, resumable transfer, cancellation and matching receipts, under the versions/conditions named in evidence.
- Desktop receiver: resumable storage, original byte/hash verification, durable outcomes and a read-only browser viewer.
- Public repository and small commits. GitHub CI/CD is disabled; checks run locally before pushes.

## Next verified units

1. **Native iPhone foreground upload.** Stage/hash natively after confirmation; persist the same job/file/destination; upload without redirects; reconcile server progress; recover after interruption; cancel truthfully; show success only for a matching receipt. Keep the design and copy lean.
2. **Authorized desktop connection and T3 destination selection.** Keep credentials on the desktop; expose only allowed environments/projects/threads. Pin exact identities when the user confirms upload. Never choose a later active thread on the user's behalf.
3. **Large original available to the chosen thread.** Validate the selected thread/workspace, make the verified original available there and retain a durable delivery record. No attachment-limit bypass, private database edits or fake thread publication.
4. **Explicit, retry-safe T3 dispatch.** User confirmation starts an agent turn without interrupting active work. Reconcile uncertain responses using the same immutable message identity; no duplicate messages or byte reupload. Cardboard editing remains a separate user request.
5. **Full end-to-end acceptance.** iPhone select/review/upload/interruption/reopen/receipt/thread delivery, wrong or unavailable target, cancellation cleanup and a separately requested Cardboard inspection/edit. Run on the actual built app and preserve build-scoped evidence.

## Separate unfinished background requirement

A standalone native probe proved Apple's background URLSession follows redirects without calling the redirect-veto delegate. Another origin received the complete generated payload. The foreground control honored the veto. See `evidence/ios-background-origin-blocker.md`.

**Implementation decision:** ship the foreground-native upload as the next bounded milestone, not as completion of background transfer. This preserves the existing no-redirect/origin boundary and lets the core workflow advance safely. Save progress and offer continuation after suspension/relaunch; never claim an automatic restart after force-quit. Keep the app-open requirement clear and concise.

Background original uploads remain unfinished until a different transport/authority design is explicitly agreed and verified. A server promise not to redirect, checking the final response URL, or merely stripping Authorization is not an adequate fix for original-file disclosure. Do not weaken that boundary to get a green result.

## Delivery discipline

Use small coherent commits, run local tests/typecheck/lint and the public-history preflight, then push. Leave the parent worktree clean. Isolated implementation work is reviewed and integrated before it is represented as shipped. Do not re-enable GitHub automation or change account billing.

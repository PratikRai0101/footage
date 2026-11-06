import type { MediaInfo, Snapshot } from '../../../modules/footage-transfer/src/contracts';

export type SelectedClip = { key: number; uri: string; name: string; bytes: number | null; media: MediaInfo; inspecting: boolean };
export type Draft = { kind: 'none' } | { kind: 'review'; clip: SelectedClip } | { kind: 'submitted'; clip: SelectedClip; previousId: string | null };
export type SavedSnapshot = Extract<Snapshot, { id: string }>;
export type Clip = { uri: string | null; name: string; bytes: number | null; media: MediaInfo };
export type Stage =
  | { kind: 'import' }
  | { kind: 'review'; clip: SelectedClip }
  | { kind: 'preparing'; clip: Clip; copiedBytes: number | null }
  | { kind: 'preparation_failed'; clip: Clip | null; message: string }
  | { kind: 'preparation_cancelled'; clip: Clip | null }
  | { kind: 'saved'; clip: Clip; snapshot: SavedSnapshot };
export type Command = 'choose' | 'upload' | 'resume' | 'cancel' | 'viewer' | 'cleanup';
type Action = { label: string; command: Command };
export type Copy = { title: string; label: string | null; body: string | null; tone: 'normal' | 'warning' | 'error'; primary: Action | null; secondary: Action | null };

export function canChoose(snapshot: Snapshot): boolean {
  return snapshot.kind === 'empty' || snapshot.kind === 'received' || snapshot.kind === 'preparation_failed' || snapshot.kind === 'preparation_cancelled' || (snapshot.kind === 'cancelled' && !snapshot.cleanupPending);
}

export function present(snapshot: Snapshot, draft: Draft): Stage {
  if (draft.kind === 'review') return { kind: 'review', clip: draft.clip };
  if (draft.kind === 'submitted' && (snapshot.kind === 'empty' || ('id' in snapshot && snapshot.id === draft.previousId))) {
    return { kind: 'preparing', clip: draft.clip, copiedBytes: null };
  }
  switch (snapshot.kind) {
    case 'empty': return { kind: 'import' };
    case 'preparing': return { kind: 'preparing', clip: draft.kind === 'submitted' ? draft.clip : { uri: null, name: snapshot.name, bytes: null, media: { durationMs: null, width: null, height: null, mimeType: null } }, copiedBytes: snapshot.copiedBytes };
    case 'preparation_cancelled': return { kind: 'preparation_cancelled', clip: draft.kind === 'submitted' ? draft.clip : null };
    case 'preparation_failed': return { kind: 'preparation_failed', clip: draft.kind === 'submitted' ? draft.clip : null, message: snapshot.message };
    default: return { kind: 'saved', clip: { uri: snapshot.localUri, name: snapshot.name, bytes: snapshot.bytes, media: snapshot.media }, snapshot };
  }
}

export function copyFor(stage: Stage, mode: 'transfer' | 'preview' = 'transfer'): Copy {
  const choose: Action = { label: 'Choose a video', command: 'choose' };
  const cancel: Action = { label: 'Cancel upload', command: 'cancel' };
  const normal = { tone: 'normal', primary: null, secondary: null } satisfies Pick<Copy, 'tone' | 'primary' | 'secondary'>;
  if (mode === 'preview' && (stage.kind === 'import' || stage.kind === 'review')) {
    return { ...normal, title: stage.kind === 'import' ? 'Choose an original.' : 'Ready to preview.', label: 'Preview only', body: null, primary: stage.kind === 'import' ? choose : { label: 'Choose another video', command: 'choose' } };
  }
  switch (stage.kind) {
    case 'import': return { ...normal, title: 'Choose an original.', label: null, body: 'Your original stays on your phone.', primary: choose };
    case 'review': return { ...normal, title: 'Ready to upload.', label: null, body: 'Original · No compression or conversion', primary: { label: 'Upload original', command: 'upload' }, secondary: { label: 'Choose another video', command: 'choose' } };
    case 'preparing': return { ...normal, title: 'Preparing your clip.', label: 'Saving a local copy', body: 'Keep the app open while we prepare the file.', secondary: { label: 'Cancel preparation', command: 'cancel' } };
    case 'preparation_cancelled': return { ...normal, title: 'Your original stays with you.', label: 'Preparation cancelled', body: 'Nothing was uploaded. Your original is unchanged.', primary: choose };
    case 'preparation_failed': return { ...normal, title: 'Let’s try that again.', label: 'Could not prepare this video', body: stage.message, tone: 'error', primary: choose };
    case 'saved': {
      const value = stage.snapshot;
      switch (value.kind) {
        case 'ready': return { ...normal, title: 'Your clip is ready.', label: value.executionActive ? 'Connecting…' : 'Ready to upload', body: value.executionActive ? null : 'Tap Continue to start uploading.', primary: value.executionActive ? null : { label: 'Continue upload', command: 'resume' }, secondary: cancel };
        case 'uploading': return { ...normal, title: 'Sending your clip.', label: 'Uploading original', body: null, secondary: cancel };
        case 'waiting': return { ...normal, title: 'Waiting for a connection.', label: 'Your progress is saved', body: value.executionActive ? 'We’ll resume when you’re back online.' : 'Reconnect, then tap Continue.', tone: 'warning', primary: value.executionActive ? null : { label: 'Continue upload', command: 'resume' }, secondary: cancel };
        case 'verifying': return { ...normal, title: 'Checking your clip.', label: 'Verifying the original', body: `All ${formatBytes(value.bytes)} received. Checking the file before marking it complete.`, secondary: cancel };
        case 'received': return { ...normal, title: 'Original verified.', label: 'File matches the original.', body: null, primary: { label: 'View received file', command: 'viewer' }, secondary: { label: 'Send another clip', command: 'choose' } };
        case 'cancelled': return { ...normal, title: 'Your original stays with you.', label: value.cleanupPending ? 'Cancelled on this phone' : 'Upload cancelled', body: value.cleanupPending ? 'Uploaded data is waiting to be removed. Reconnect to finish cleanup.' : 'Uploaded data was removed. Your original is unchanged.', tone: value.cleanupPending ? 'warning' : 'normal', primary: value.cleanupPending ? { label: 'Retry cleanup', command: 'cleanup' } : choose };
        case 'failed': return { ...normal, title: 'This clip needs attention.', label: 'Upload not completed', body: value.message, tone: 'error', primary: value.retryable ? { label: 'Try again', command: 'resume' } : null, secondary: cancel };
        default: { const exhaustive: never = value; return exhaustive; }
      }
    }
    default: { const exhaustive: never = stage; return exhaustive; }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 ** 2) return `${(bytes / 1000).toFixed(1)} KB`;
  if (bytes < 1000 ** 3) return `${(bytes / 1000 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1000 ** 3).toFixed(2)} GB`;
}
export function mediaLine(clip: Clip): string {
  const { durationMs, width, height } = clip.media;
  const seconds = durationMs === null ? null : Math.floor(durationMs / 1000);
  return [seconds === null ? 'Duration unavailable' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, width && height ? `${width} × ${height}` : 'Resolution unavailable', clip.bytes === null ? 'Size unavailable' : formatBytes(clip.bytes)].join(' · ');
}
export function fractionFor(stage: Stage): number | null {
  if (stage.kind === 'preparing') return stage.clip.bytes && stage.copiedBytes !== null ? Math.min(stage.copiedBytes / stage.clip.bytes, 1) : null;
  if (stage.kind === 'saved') return Math.max(0, Math.min(stage.snapshot.confirmedBytes / stage.snapshot.bytes, 1));
  return null;
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { snapshotSchema, unknownMedia } from '../../apps/mobile/modules/footage-transfer/src/contracts';
import { previewMetadata } from '../../apps/mobile/src/features/intake/preview-metadata';
import { canChoose, copyFor, formatBytes, fractionFor, mediaLine, present, type Draft } from '../../apps/mobile/src/features/intake/presentation';

const id = randomUUID();
const sha256 = 'a'.repeat(64);
const base = { id, name: 'generated-test.mp4', bytes: 1000, confirmedBytes: 440, sha256, localUri: 'file:///private/generated-test.original', media: { durationMs: 6016, width: 1280, height: 720, mimeType: 'video/mp4' }, executionActive: true };
const receipt = { id: randomUUID(), jobId: id, bytes: 1000, sha256, verifiedAt: '2026-10-29T15:24:21.000Z' };
const none: Draft = { kind: 'none' };
const clip = { key: 1, name: 'next-original.mp4', bytes: 2000, uri: 'content://generated-test/new', media: unknownMedia, inspecting: false };

test('review of a new clip never displays the previous received outcome', () => {
  const saved = snapshotSchema.parse({ kind: 'received', ...base, confirmedBytes: 1000, receipt });
  const stage = present(saved, { kind: 'review', clip });
  assert.equal(stage.kind, 'review');
  assert.equal(copyFor(stage).primary?.command, 'upload');
});

test('accepted preparation suppresses an old receipt until the next native snapshot arrives', () => {
  const saved = snapshotSchema.parse({ kind: 'received', ...base, confirmedBytes: 1000, receipt });
  const stage = present(saved, { kind: 'submitted', clip, previousId: id });
  assert.equal(stage.kind, 'preparing');
  assert.equal(fractionFor(stage), null);
  assert.notEqual(copyFor(stage).label, 'Original verified');
});

test('confirmed progress is unchanged when a running upload waits for the network', () => {
  const sending = present(snapshotSchema.parse({ kind: 'uploading', ...base }), none);
  const waiting = present(snapshotSchema.parse({ kind: 'waiting', ...base, message: 'Connection interrupted; retrying.' }), none);
  assert.equal(fractionFor(sending), .44);
  assert.equal(fractionFor(waiting), .44);
  assert.equal(copyFor(waiting).secondary?.command, 'cancel');
  assert.equal(copyFor(waiting).primary, null);
});

test('a stopped native attempt offers explicit visible continuation', () => {
  const stage = present(snapshotSchema.parse({ kind: 'waiting', ...base, executionActive: false, message: 'Return to continue.' }), none);
  assert.equal(copyFor(stage).primary?.command, 'resume');
});

test('all acknowledged bytes are still verifying, never received without a receipt', () => {
  const stage = present(snapshotSchema.parse({ kind: 'verifying', ...base, confirmedBytes: 1000 }), none);
  assert.equal(fractionFor(stage), 1);
  assert.equal(copyFor(stage).label, 'Verifying the original');
  assert.notEqual(copyFor(stage).primary?.command, 'viewer');
});

test('received state requires matching receipt identity, length, hash and full confirmation', () => {
  assert(snapshotSchema.safeParse({ kind: 'received', ...base, confirmedBytes: 1000, receipt }).success);
  for (const wrong of [{ ...receipt, jobId: randomUUID() }, { ...receipt, bytes: 999 }, { ...receipt, sha256: 'b'.repeat(64) }]) {
    assert.equal(snapshotSchema.safeParse({ kind: 'received', ...base, confirmedBytes: 1000, receipt: wrong }).success, false);
  }
  assert.equal(snapshotSchema.safeParse({ kind: 'received', ...base, confirmedBytes: 999, receipt }).success, false);
});

test('native snapshots cannot claim more confirmed bytes than the original', () => {
  assert.equal(snapshotSchema.safeParse({ kind: 'uploading', ...base, confirmedBytes: 1001 }).success, false);
});

test('pending cancellation does not claim deletion or permit a replacement job', () => {
  const value = snapshotSchema.parse({ kind: 'cancelled', ...base, cleanupPending: true });
  assert.equal(canChoose(value), false);
  assert.equal(copyFor(present(value, none)).primary?.command, 'cleanup');
  assert.match(copyFor(present(value, none)).body ?? '', /waiting to be removed/);
});

test('confirmed cancellation permits another clip without issuing success', () => {
  const value = snapshotSchema.parse({ kind: 'cancelled', ...base, cleanupPending: false, localUri: null });
  assert.equal(canChoose(value), true);
  assert.equal(copyFor(present(value, none)).primary?.command, 'choose');
  assert.notEqual(copyFor(present(value, none)).label, 'Original verified');
});

test('metadata uses actual duration, dimensions and bytes, including unknown fields', () => {
  assert.equal(mediaLine({ uri: base.localUri, name: base.name, bytes: 1024 ** 2, media: base.media }), '0:06 · 1280 × 720 · 1.0 MB');
  assert.equal(mediaLine({ ...clip, bytes: null, media: unknownMedia }), 'Duration unavailable · Resolution unavailable · Size unavailable');
  assert.equal(formatBytes(4 * 1024 ** 3), '4.29 GB');
});

test('preparation failure is actionable and never starts a transfer', () => {
  const value = snapshotSchema.parse({ kind: 'preparation_failed', message: 'Not enough storage for a local copy.' });
  const copy = copyFor(present(value, { kind: 'submitted', clip, previousId: null }));
  assert.equal(copy.tone, 'error');
  assert.equal(copy.primary?.command, 'choose');
  assert.match(copy.body ?? '', /storage/);
});

test('cancelled preparation never redisplays the previous receipt for a new selection', () => {
  const value = snapshotSchema.parse({ kind: 'preparation_cancelled' });
  const stage = present(value, { kind: 'submitted', clip, previousId: id });
  assert.equal(stage.kind, 'preparation_cancelled');
  assert.equal(canChoose(value), true);
  assert.equal(copyFor(stage).primary?.command, 'choose');
  assert.match(copyFor(stage).body ?? '', /Nothing was uploaded/);
  assert.notEqual(copyFor(stage).label, 'Original verified');
});

test('preview-only import does not promise an upload', () => {
  const copy = copyFor({ kind: 'import' }, 'preview');
  assert.match(copy.body ?? '', /Android/);
  assert.equal(copy.primary?.command, 'choose');
  assert.doesNotMatch(copy.body ?? '', /to send/);
});

test('preview-only review clearly limits uploads to Android', () => {
  const copy = copyFor({ kind: 'review', clip }, 'preview');
  assert.equal(copy.primary?.command, 'choose');
  assert.equal(copy.secondary, null);
  assert.match(copy.body ?? '', /Android/);
  assert.match(copy.label ?? '', /Preview only/);
  assert.doesNotMatch(copy.body ?? '', /Nothing is copied/);
});

test('playback metadata reports actual seconds and track pixels without inventing a receipt', () => {
  const media = previewMetadata({ durationSeconds: 8.016, size: { width: 1280, height: 720 }, mimeType: 'video/mp4' });
  assert.deepEqual(media, { durationMs: 8016, width: 1280, height: 720, mimeType: 'video/mp4' });
  assert.equal(mediaLine({ ...clip, media, bytes: 4161576 }), '0:08 · 1280 × 720 · 4.2 MB');
  assert.equal('receipt' in media, false);
});

test('unknown and indefinite playback metadata stays unavailable rather than displaying fake zeros', () => {
  assert.deepEqual(previewMetadata({ durationSeconds: Infinity, size: null, mimeType: null }), unknownMedia);
  assert.deepEqual(previewMetadata({ durationSeconds: NaN, size: { width: 0, height: -1 }, mimeType: null }), unknownMedia);
});

test('core upload copy is short and keeps protocol details out of the main flow', () => {
  const review = copyFor({ kind: 'review', clip });
  assert.equal(review.label, null);
  assert.equal(review.primary?.label, 'Upload video');
  assert.equal(review.body, 'Original file. No compression or conversion.');
  const sending = copyFor(present(snapshotSchema.parse({ kind: 'uploading', ...base }), none));
  assert.equal(sending.body, null);
  const verifying = copyFor(present(snapshotSchema.parse({ kind: 'verifying', ...base, confirmedBytes: 1000 }), none));
  assert.doesNotMatch(verifying.body ?? '', /SHA|acknowledged|native|receiver/);
  assert.equal(verifying.primary, null);
  const waiting = copyFor(present(snapshotSchema.parse({ kind: 'waiting', ...base, message: 'java.net.SocketTimeoutException' }), none));
  assert.equal(waiting.body, 'We’ll resume when you’re back online.');
});

test('protocol and capability fields do not become public UI snapshot state', () => {
  const value = snapshotSchema.parse({ kind: 'uploading', ...base, capability: 'private-native-only' });
  assert.equal('capability' in value, false);
});

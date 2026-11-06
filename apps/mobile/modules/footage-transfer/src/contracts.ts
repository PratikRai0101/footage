import { z } from 'zod';

export const mediaSchema = z.object({
  durationMs: z.number().int().positive().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  mimeType: z.string().nullable(),
});
export type MediaInfo = z.infer<typeof mediaSchema>;
export const unknownMedia: MediaInfo = { durationMs: null, width: null, height: null, mimeType: null };
const transferId = z.uuid().brand<'TransferId'>();
const receiptSchema = z.object({
  id: z.uuid(), jobId: transferId, bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), verifiedAt: z.iso.datetime(),
});
export type Receipt = z.infer<typeof receiptSchema>;
const jobFields = {
  id: transferId, name: z.string(), bytes: z.number().int().positive(),
  confirmedBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  localUri: z.string().nullable(), media: mediaSchema, executionActive: z.boolean(),
};
export const snapshotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }),
  z.object({ kind: z.literal('preparing'), name: z.string(), copiedBytes: z.number().nonnegative() }),
  z.object({ kind: z.literal('preparation_failed'), message: z.string() }),
  z.object({ kind: z.literal('preparation_cancelled') }),
  z.object({ kind: z.literal('ready'), ...jobFields }),
  z.object({ kind: z.literal('uploading'), ...jobFields }),
  z.object({ kind: z.literal('waiting'), ...jobFields, message: z.string() }),
  z.object({ kind: z.literal('verifying'), ...jobFields }),
  z.object({ kind: z.literal('received'), ...jobFields, receipt: receiptSchema }),
  z.object({ kind: z.literal('cancelled'), ...jobFields, cleanupPending: z.boolean() }),
  z.object({ kind: z.literal('failed'), ...jobFields, message: z.string(), retryable: z.boolean() }),
]).superRefine((value, context) => {
  if ('confirmedBytes' in value && value.confirmedBytes > value.bytes) context.addIssue({ code: 'custom', message: 'Confirmed bytes exceed the original.', path: ['confirmedBytes'] });
  if (value.kind === 'received' && (value.receipt.jobId !== value.id || value.receipt.bytes !== value.bytes || value.receipt.sha256 !== value.sha256 || value.confirmedBytes !== value.bytes)) {
    context.addIssue({ code: 'custom', message: 'The receipt must match the complete original.', path: ['receipt'] });
  }
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const deviceSchema = z.object({
  manufacturer: z.string(), model: z.string(), apiLevel: z.number().int(),
  androidVersion: z.string(), supportsTransfer: z.boolean(),
  scheduler: z.enum(['user-initiated-job', 'foreground-service']),
});
export type Device = z.infer<typeof deviceSchema>;
export const settingsSchema = z.object({ origin: z.string(), appearance: z.enum(['dark', 'light', 'system']) });
export type Settings = z.infer<typeof settingsSchema>;


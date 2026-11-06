import { z } from 'zod';

export const jobIdSchema = z.uuid().brand<'JobId'>();
export type JobId = z.infer<typeof jobIdSchema>;
export const capabilitySchema = z.string().regex(/^[a-f0-9]{64}$/);
export const viewerCodeSchema = capabilitySchema.brand<'ViewerCode'>();
export const viewerSessionSchema = capabilitySchema.brand<'ViewerSession'>();
export const viewerExchangeSchema = z.object({ code: viewerCodeSchema }).strict();
export const registrationSchema = z.object({
  id: jobIdSchema,
  name: z.string().min(1).max(240),
  bytes: z.number().int().positive().max(4 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Registration = z.infer<typeof registrationSchema>;

export const receiptSchema = z.object({
  id: z.uuid(),
  jobId: jobIdSchema,
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  verifiedAt: z.iso.datetime(),
});
export type Receipt = z.infer<typeof receiptSchema>;

export const storedJobSchema = registrationSchema.extend({
  tokenHash: z.string(),
  status: z.enum(['uploading', 'received', 'cancelled', 'failed']),
  receipt: receiptSchema.nullable(),
});
export type StoredJob = z.infer<typeof storedJobSchema>;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

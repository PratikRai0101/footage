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

const hex32 = z.string().regex(/^[a-f0-9]{64}$/);
export const receiptBindingSchema = z.object({
  receiver: hex32, generation: z.string().regex(/^[a-f0-9]{32}$/),
  manifestDigest: hex32, destinationDigest: hex32,
}).strict();

export const sealedStateSchema = z.object({
  manifest: z.string(), wrappedMaster: z.string(), revision: z.string().regex(/^[0-9]+$/),
  state: z.enum(['uploading', 'verifying', 'received', 'cancelled', 'expired', 'failed']),
  cleanup: z.union([z.literal(0), z.literal(1), z.literal(2)]), frozen: z.boolean(),
  groups: z.array(z.object({
    index: z.number().int().min(0).max(63), wireHash: hex32, plaintextHash: hex32,
    ack: z.string(), sealIds: z.array(z.string().regex(/^[a-f0-9]{32}$/)).max(8),
  }).strict()).max(64),
  receiptEnvelope: z.string().nullable(),
}).strict();
export type SealedState = z.infer<typeof sealedStateSchema>;

export const receiptSchema = z.object({
  id: z.uuid(),
  jobId: jobIdSchema,
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  verifiedAt: z.iso.datetime(),
  binding: receiptBindingSchema.optional(),
});
export type Receipt = z.infer<typeof receiptSchema>;

export const storedJobSchema = registrationSchema.extend({
  tokenHash: z.string(),
  status: z.enum(['uploading', 'received', 'cancelled', 'failed']),
  receipt: receiptSchema.nullable(),
  transport: z.enum(['tus', 'sealed-v1']).default('tus'),
  contentReference: z.literal('original').optional(),
  storageFault: z.boolean().optional(),
  cleanupPending: z.boolean().optional(),
  sealed: sealedStateSchema.optional(),
});
export type StoredJob = z.infer<typeof storedJobSchema>;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

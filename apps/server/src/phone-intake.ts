import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { GenerationKeys } from './sealed-protocol.js';

export const phoneDestinationSchema = z.object({ id: z.uuid(), title: z.string().min(1).max(120), kind: z.enum(['inbox', 'thread']) }).strict();
export type PhoneDestination = z.infer<typeof phoneDestinationSchema>;
export const handoffOperationSchema = z.enum(['status', 'deliver', 'send']);
export type HandoffOperation = z.infer<typeof handoffOperationSchema>;
export const handoffSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unavailable') }).strict(),
  z.object({ kind: z.literal('not_delivered'), title: z.string() }).strict(),
  z.object({ kind: z.literal('ready'), title: z.string() }).strict(),
  z.object({ kind: z.literal('unknown'), title: z.string() }).strict(),
  z.object({ kind: z.literal('sent'), title: z.string(), messageId: z.string().min(1) }).strict(),
]);
export type Handoff = z.infer<typeof handoffSchema>;
const purposes = { status: 0, deliver: 1, send: 2 };
/** A viewer/status query cannot be replayed as consent to start an agent. */
export function verifyHandoffRequest(bytes: Buffer, keys: GenerationKeys, operation: HandoffOperation): void {
  const context = keys.outcome;
  if (bytes.length !== 121 || bytes.toString('ascii', 0, 8) !== 'FTHAND01' || bytes[8] !== purposes[operation]
    || bytes.subarray(9, 25).toString('hex') !== context.fields.job || bytes.subarray(25, 41).toString('hex') !== context.fields.generation
    || bytes.subarray(41, 73).toString('hex') !== context.digest) throw new Error('Handoff binding rejected.');
  const mac = createHmac('sha256', keys.derive('status')).update('footage/handoff-request/v1').update(bytes.subarray(0, 89)).digest();
  if (!timingSafeEqual(mac, bytes.subarray(89))) throw new Error('Handoff authentication rejected.');
}

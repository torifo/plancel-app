/**
 * DomainEvent — append-only domain event log (SDD §10.2).
 *
 * SDD §10.2 lists the type union with a trailing "| ...", signaling more
 * types will be added later (e.g. by Wave 2/3 tasks). Per Task 1.1 scope we
 * enumerate exactly the 8 named types from the SDD as a strict enum;
 * widening this list is a deliberate single-source-of-truth change made in
 * a later task, not an implicit "any string" escape hatch.
 */
import { z } from "zod";
import { correlationIdSchema, isoDateTimeSchema, ulidSchema } from "./common.ts";

export const domainEventTypes = [
  "reservation.created",
  "reservation.confirmed",
  "reservation.auto_to_cancel",
  "reservation.cancelled",
  "reservation.voided",
  "policy.provided",
  "plan.settled",
  "policy.applied_from_template",
] as const;

export const domainEventTypeSchema = z.enum(domainEventTypes);

export type DomainEventType = z.infer<typeof domainEventTypeSchema>;

export const domainEventSchema = z.object({
  id: ulidSchema,
  type: domainEventTypeSchema,
  entity_id: ulidSchema,
  payload: z.unknown(),
  caused_by: ulidSchema.nullable(),
  correlation_id: correlationIdSchema,
  occurred_at: isoDateTimeSchema,
});

export type DomainEvent = z.infer<typeof domainEventSchema>;

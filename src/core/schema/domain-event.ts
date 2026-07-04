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

const domainEventShape = z.object({
  id: ulidSchema,
  type: domainEventTypeSchema,
  entity_id: ulidSchema,
  payload: z.unknown(),
  caused_by: ulidSchema.nullable(),
  correlation_id: correlationIdSchema,
  occurred_at: isoDateTimeSchema,
});

// zod's `z.unknown()` structurally satisfies `undefined extends unknown`, so
// zod always infers unknown-typed object fields as optional (`payload?:
// unknown`) regardless of `.optional()` — a known zod v3 limitation. Payload
// is always present on a persisted DomainEvent (SDD §10.2), so we override
// the inferred type to make it a required property, then re-type the schema
// itself (`z.ZodType<DomainEvent>`) so `.parse()`/`.safeParse()` return the
// corrected, required-payload type everywhere the schema is used. This does
// not change runtime validation — only the static TS type.
export type DomainEvent =
  & Omit<z.infer<typeof domainEventShape>, "payload">
  & { payload: unknown };

export const domainEventSchema: z.ZodType<DomainEvent> = domainEventShape as unknown as z.ZodType<
  DomainEvent
>;

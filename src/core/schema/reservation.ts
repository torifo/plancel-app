/**
 * Reservation (SDD §3.2). `cancellation_policy` accepts "unknown" (§3.3, FR-003).
 */
import { z } from "zod";
import { cancellationPolicyOrUnknownSchema } from "./cancellation-policy.ts";
import { isoDateTimeSchema, ulidSchema } from "./common.ts";

export const reservationStatusSchema = z.enum([
  "candidate",
  "confirmed",
  "to_cancel",
  "cancelled",
  "done",
  "voided",
]);
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;

export const reservationSourceSchema = z.enum(["mcp", "line", "manual"]);
export type ReservationSource = z.infer<typeof reservationSourceSchema>;

export const reservationSchema = z.object({
  id: ulidSchema,
  plan_id: ulidSchema.nullable(),
  event_id: ulidSchema.nullable(),
  service_name: z.string().min(1),
  provider: z.string().nullable(),
  starts_at: isoDateTimeSchema,
  ends_at: isoDateTimeSchema.nullable(),
  location: z.string().nullable(),
  amount_jpy: z.number().min(0).nullable(),
  status: reservationStatusSchema,
  cancellation_policy: cancellationPolicyOrUnknownSchema,
  policy_template_id: ulidSchema.nullable(),
  source: reservationSourceSchema,
  raw_input_ref: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});

export type Reservation = z.infer<typeof reservationSchema>;

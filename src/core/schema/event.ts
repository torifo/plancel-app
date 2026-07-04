/**
 * Event — non-exclusive bundle of Plans/Reservations (SDD §3.0).
 */
import { z } from "zod";
import { dateRangeSchema, isoDateTimeSchema, ulidSchema } from "./common.ts";

export const eventSchema = z.object({
  id: ulidSchema,
  title: z.string().min(1),
  date_range: dateRangeSchema,
  notes: z.string().nullable(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});

export type Event = z.infer<typeof eventSchema>;

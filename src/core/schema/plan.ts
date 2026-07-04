/**
 * Plan — exclusive candidate group (SDD §3.1).
 */
import { z } from "zod";
import { dateRangeSchema, isoDateTimeSchema, ulidSchema } from "./common.ts";

export const planStatusSchema = z.enum(["open", "settled", "closed"]);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const planSchema = z.object({
  id: ulidSchema,
  event_id: ulidSchema.nullable(),
  title: z.string().min(1),
  date_range: dateRangeSchema,
  confirm_quota: z.number().int().min(1),
  status: planStatusSchema,
  reservation_ids: z.array(ulidSchema),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});

export type Plan = z.infer<typeof planSchema>;

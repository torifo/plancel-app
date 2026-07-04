/**
 * ParseJob — multi-LLM parse pipeline bookkeeping (SDD §3.5, §10.4).
 *
 * `attempts[].output` is a partial Reservation; it is defined structurally
 * (rather than via reservationSchema.partial()) because parser output is
 * pre-validation and may contain arbitrary/incomplete shapes that still need
 * to be captured for replay (SDD §10.4).
 */
import { z } from "zod";
import { correlationIdSchema, isoDateTimeSchema, ulidSchema } from "./common.ts";
import { reservationSchema } from "./reservation.ts";

export const fieldConflictSchema = z.object({
  field: z.string().min(1),
  options: z.array(
    z.object({
      parser: z.string().min(1),
      value: z.unknown(),
    }),
  ),
});

export type FieldConflict = z.infer<typeof fieldConflictSchema>;

export const parseAttemptSchema = z.object({
  parser: z.string().min(1),
  raw_response: z.string(),
  output: reservationSchema.partial().nullable(),
  validation_errors: z.array(z.string()),
  correlation_id: correlationIdSchema,
});

export type ParseAttempt = z.infer<typeof parseAttemptSchema>;

export const parseJobStatusSchema = z.enum(["parsed", "needs_review", "resolved", "failed"]);
export type ParseJobStatus = z.infer<typeof parseJobStatusSchema>;

export const parseJobInputTypeSchema = z.enum(["text", "image"]);
export type ParseJobInputType = z.infer<typeof parseJobInputTypeSchema>;

export const parseJobSchema = z.object({
  id: ulidSchema,
  input_type: parseJobInputTypeSchema,
  raw_input: z.string(),
  attempts: z.array(parseAttemptSchema),
  status: parseJobStatusSchema,
  conflicts: z.array(fieldConflictSchema),
  created_at: isoDateTimeSchema,
});

export type ParseJob = z.infer<typeof parseJobSchema>;

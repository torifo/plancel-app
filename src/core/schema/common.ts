/**
 * Shared primitives used across entity schemas (SDD §3).
 */
import { z } from "zod";

/** Crockford Base32, 26 chars — matches src/lib/ulid.ts output. */
export const ulidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a valid ULID");

/**
 * ISO 8601 datetime string (date + time). Non-"Z" offsets are accepted on
 * input but normalized to canonical UTC ("Z") form on output, so every
 * persisted datetime (starts_at, ends_at, created_at, updated_at,
 * occurred_at, last_used_at) is directly lexicographically comparable —
 * stores rely on this for chronological index ordering (e.g. the
 * pending_cancel index in kv-store.ts / in-memory-store.ts).
 */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true, message: "must be an ISO 8601 datetime string" })
  .transform((v, ctx) => {
    try {
      return Temporal.Instant.from(v).toString({ smallestUnit: "millisecond" });
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a valid instant" });
      return z.NEVER;
    }
  });

/** ISO 8601 date string, strict "YYYY-MM-DD" (no slashes, no time component). */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO 8601 date string (YYYY-MM-DD)")
  .refine((v) => {
    try {
      Temporal.PlainDate.from(v);
      return true;
    } catch {
      return false;
    }
  }, "must be a valid calendar date");

/** `{ start, end }` range of ISO date strings, or null when not applicable. */
export const dateRangeSchema = z
  .object({
    start: isoDateSchema,
    end: isoDateSchema,
  })
  .nullable();

/** A correlation id used to tie logs, ParseAttempts, and DomainEvents together. */
export const correlationIdSchema = z.string().min(1);

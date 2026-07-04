/**
 * Shared primitives used across entity schemas (SDD §3).
 */
import { z } from "zod";

/** Crockford Base32, 26 chars — matches src/lib/ulid.ts output. */
export const ulidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a valid ULID");

/** ISO 8601 datetime string (date + time). Offsets are accepted. */
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true, message: "must be an ISO 8601 datetime string" });

/** ISO 8601 date string (no time component required, e.g. "2026-07-04"). */
export const isoDateSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 date/datetime string");

/** `{ start, end }` range of ISO date strings, or null when not applicable. */
export const dateRangeSchema = z
  .object({
    start: isoDateSchema,
    end: isoDateSchema,
  })
  .nullable();

/** A correlation id used to tie logs, ParseAttempts, and DomainEvents together. */
export const correlationIdSchema = z.string().min(1);

/**
 * Reading and normalising the timestamps this ledger stores.
 *
 * `startsAt` / `endsAt` are plain strings in the record schema (`z.string()`),
 * loose on purpose so an existing record can never fail to parse and vanish from
 * the list. The cost of that looseness is that two readers can disagree about the
 * same string: `Temporal.Instant.from` rejects an offset-less "2026-08-05T10:00"
 * while the browser's `Date.parse` reads it as device-local time, and it accepts
 * an hour-only "+09" offset that `Date.parse` refuses outright. Whoever is
 * stricter then hides a row the other still shows.
 *
 * So writes normalise instead: every timestamp entering the store is turned into
 * one canonical instant string here, and readers can be strict.
 */

import { z } from "zod";

/**
 * The instant a stored timestamp means, or null when it says nothing readable.
 *
 * An offset-less value is read as JST rather than rejected — it is what a model
 * writes when a confirmation mail prints a bare 「8月5日 10:00」, and the reading
 * a Japanese booking intends. A date with no time at all lands at midnight JST.
 */
export function toInstantOrNull(value: unknown): Temporal.Instant | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    try {
      return Temporal.PlainDateTime.from(value).toZonedDateTime("Asia/Tokyo").toInstant();
    } catch {
      return null;
    }
  }
}

/** The canonical form of a stored timestamp, or null when it is unreadable. */
export function normalizeInstant(value: unknown): string | null {
  return toInstantOrNull(value)?.toString({ smallestUnit: "millisecond" }) ?? null;
}

/**
 * Canonical form for a REQUIRED timestamp: an unreadable value is kept as it came
 * rather than dropped. Losing a start would take the reservation out of every
 * list; leaving it visible and wrong is the recoverable failure.
 */
export function normalizeRequiredInstant(value: string): string {
  return normalizeInstant(value) ?? value;
}

/**
 * What a write may hand us as a timestamp: anything `toInstantOrNull` reads.
 *
 * Writes used to take any non-empty string and `normalizeRequiredInstant` kept
 * the unreadable ones as they came (issue #2). A model writing 「10月27日 19時」
 * then landed on the phone as `NaN/NaN(undefined)`, and "2026/10/27 19:00" was
 * worse: the browser's `Date.parse` reads it, so the row looked normal while the
 * server sorted it last and never computed its cancellation deadline. The
 * leniency belongs to READS of legacy rows only; a new value is refused here,
 * and the message says what shape is accepted so the caller can rewrite it.
 */
export const INSTANT_FORMAT_HINT =
  "日時として読めません。ISO 8601 で渡してください（例 2026-10-27T19:00:00+09:00。" +
  "オフセットが無ければ JST とみなします）";

export const readableInstantSchema = z.string().min(1, INSTANT_FORMAT_HINT).refine(
  (v) => toInstantOrNull(v) !== null,
  { message: INSTANT_FORMAT_HINT },
);

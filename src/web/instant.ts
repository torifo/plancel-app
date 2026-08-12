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

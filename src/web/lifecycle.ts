/**
 * When a web-ledger reservation is over.
 *
 * The web ledger has no `done` status and is not getting one. Being over is a
 * fact about the date, so it is derived here instead of stored (ADR-11): every
 * record already in KV becomes correct the day this ships, there is no migration
 * and no cron rewriting a status it cannot take back, and correcting a date puts
 * the reservation back in the ledger by itself. What the owner did about it —
 * confirmed, never decided, meant to cancel — is what `status` already says.
 */
import { endOfJstDay } from "./policy.ts";

/** Just the two fields the rule reads; callers need not pass a whole record. */
export interface FinishableReservation {
  startsAt: string;
  endsAt: string | null;
}

/**
 * Epoch ms, or null for absent/unparseable. The store keeps these as plain
 * strings (`z.string()`, not a datetime), and `endsAt` arrives from an LLM, so
 * unreadable input has to fall back rather than throw: a list render or a LINE
 * reply must not die on one bad field.
 */
function msOrNull(iso: string | null): number | null {
  if (iso === null || iso === "") return null;
  try {
    return Temporal.Instant.from(iso).epochMilliseconds;
  } catch {
    return null;
  }
}

/**
 * The instant a reservation stops being upcoming: the END of the JST day it ends
 * on. This is the reading the ledger already gives a cancellation deadline
 * (`boundaryMs`), so the app does not carry two different rules about when a day
 * is over.
 *
 * `endsAt` is the checkout when the parser found one; without it, the start's own
 * day is all we know. An `endsAt` BEFORE the start is a bad parse rather than a
 * shorter reservation, so the later of the two wins — a broken end date must
 * never hide something that has not happened yet. For the same reason a start
 * that cannot be read at all leaves the reservation permanently upcoming: wrong
 * and visible beats wrong and filed away.
 *
 * Deliberately late rather than early. A 19:00 dinner stays in the ledger until
 * midnight and a 10:00 checkout keeps the trip there for the rest of that day.
 * Late leaves a finished row in view for a few hours; early files an ongoing trip
 * into history.
 */
export function finishedAtMs(r: FinishableReservation): number {
  const start = msOrNull(r.startsAt);
  const end = msOrNull(r.endsAt);
  if (start === null) return end === null ? Number.POSITIVE_INFINITY : endOfJstDay(end);
  return endOfJstDay(end === null ? start : Math.max(start, end));
}

/** Is this reservation over as of `nowMs`? The boundary instant is not yet. */
export function isFinished(r: FinishableReservation, nowMs: number): boolean {
  return nowMs > finishedAtMs(r);
}

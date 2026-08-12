/**
 * iCal subscription feed — the calendar integration that works for
 * EVERYONE (Google, iCloud, TimeTree via the OS calendar), no OAuth
 * (spec §3). `GET /calendar/<secret>.ics` renders the user's CONFIRMED
 * reservations; calendar apps poll it on their own schedule (Google up
 * to ~24h, iCloud 15min+ — the Google API push path covers immediacy).
 *
 * Model notes: an event runs to the reservation's `endsAt` (a stay's checkout)
 * and falls back to a flat hour when there is none — see `eventEndInstant`.
 * `startsAt` without a UTC offset is interpreted as Asia/Tokyo.
 */
import type { WebReservation } from "../store.ts";
import { listReservations } from "../store.ts";
import { describePolicy } from "../policy.ts";
import { toInstantOrNull } from "../instant.ts";
import { findUserByIcsSecret } from "../users.ts";
import { listSharedReservations } from "../sharing.ts";

/**
 * "2026-08-01T19:00:00+09:00" | "2026-08-01T19:00" → Instant (JST default).
 *
 * Kept as this module's name for the same reading the store normalises with, so
 * a feed and the ledger can never disagree about what a timestamp meant.
 */
export function startsAtToInstant(startsAt: string): Temporal.Instant | null {
  return toInstantOrNull(startsAt);
}

/**
 * When the event ends: the checkout (`endsAt`) when it reads and lands after the
 * start, otherwise an hour after the start.
 *
 * A three-night stay used to publish as a one-hour event on its first afternoon,
 * because this ledger kept no end at all until 2026-08-12. An `endsAt` at or
 * before the start is a bad parse rather than a shorter stay, and the hour
 * fallback beats an event that ends before it begins — some calendar clients
 * reject that outright instead of showing something odd.
 */
export function eventEndInstant(
  r: Pick<WebReservation, "endsAt">,
  start: Temporal.Instant,
): Temporal.Instant {
  const end = r.endsAt === null ? null : startsAtToInstant(r.endsAt);
  return end !== null && Temporal.Instant.compare(end, start) > 0 ? end : start.add({ hours: 1 });
}

function icsUtc(instant: Temporal.Instant): string {
  return instant.toString({ smallestUnit: "second" }).replace(/[-:]/g, "");
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

export function buildIcs(reservations: WebReservation[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//plancel//reservation ledger//JA",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:plancel",
    "X-WR-TIMEZONE:Asia/Tokyo",
  ];
  for (const r of reservations) {
    if (r.status !== "confirmed") continue;
    const start = startsAtToInstant(r.startsAt);
    if (start === null) continue;
    const end = eventEndInstant(r, start);
    const stamp = startsAtToInstant(r.updated_at) ?? start;
    const desc = [
      r.plan !== null ? `プラン: ${r.plan}` : null,
      r.amount !== null ? `金額: ¥${r.amount.toLocaleString("ja-JP")}` : null,
      // Never the raw policy: a custom stage table would print as JSON.
      `キャンセル規定: ${describePolicy(r.policy)}`,
      "plancel で管理されている予約",
    ].filter((x): x is string => x !== null).join("\\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(r.id)}@plancel`,
      `DTSTAMP:${icsUtc(stamp)}`,
      `DTSTART:${icsUtc(start)}`,
      `DTEND:${icsUtc(end)}`,
      `SUMMARY:${icsEscape(r.service)}`,
      // LOCATION lets calendar apps offer their own maps link for the venue.
      ...(r.location !== null ? [`LOCATION:${icsEscape(r.location)}`] : []),
      `DESCRIPTION:${desc}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

const FEED_RE = /^\/calendar\/([A-Za-z0-9_-]+)\.ics$/;

export function isCalendarFeedPath(pathname: string): boolean {
  return FEED_RE.test(pathname);
}

export async function handleCalendarFeed(kv: Deno.Kv, req: Request): Promise<Response> {
  const m = new URL(req.url).pathname.match(FEED_RE);
  const secret = m?.[1];
  if (secret === undefined) return new Response("not found", { status: 404 });
  const user = await findUserByIcsSecret(kv, secret);
  if (user === null) return new Response("not found", { status: 404 });
  // The subscription feed carries the user's OWN confirmed reservations plus
  // the confirmed ones shared WITH them (buildIcs drops non-confirmed).
  const own = await listReservations(kv, user.ledgerId);
  const shared = (await listSharedReservations(kv, user.id)).map((s) => s.reservation);
  const body = buildIcs([...own, ...shared]);
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "private, max-age=300",
    },
  });
}

/**
 * iCal subscription feed — the calendar integration that works for
 * EVERYONE (Google, iCloud, TimeTree via the OS calendar), no OAuth
 * (spec §3). `GET /calendar/<secret>.ics` renders the user's CONFIRMED
 * reservations; calendar apps poll it on their own schedule (Google up
 * to ~24h, iCloud 15min+ — the Google API push path covers immediacy).
 *
 * Model notes: reservations have no end time → events are a flat 1 hour.
 * `startsAt` without a UTC offset is interpreted as Asia/Tokyo.
 */
import type { WebReservation } from "../store.ts";
import { listReservations } from "../store.ts";
import { findUserByIcsSecret } from "../users.ts";

/** "2026-08-01T19:00:00+09:00" | "2026-08-01T19:00" → Instant (JST default). */
export function startsAtToInstant(startsAt: string): Temporal.Instant | null {
  try {
    return Temporal.Instant.from(startsAt);
  } catch {
    try {
      return Temporal.PlainDateTime.from(startsAt).toZonedDateTime("Asia/Tokyo").toInstant();
    } catch {
      return null;
    }
  }
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
    const stamp = startsAtToInstant(r.updated_at) ?? start;
    const desc = [
      r.plan !== null ? `プラン: ${r.plan}` : null,
      r.amount !== null ? `金額: ¥${r.amount.toLocaleString("ja-JP")}` : null,
      `キャンセル規定: ${r.policy}`,
      "plancel で管理されている予約",
    ].filter((x): x is string => x !== null).join("\\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${icsEscape(r.id)}@plancel`,
      `DTSTAMP:${icsUtc(stamp)}`,
      `DTSTART:${icsUtc(start)}`,
      `DTEND:${icsUtc(start.add({ hours: 1 }))}`,
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
  const body = buildIcs(await listReservations(kv, user.ledgerId));
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "cache-control": "private, max-age=300",
    },
  });
}

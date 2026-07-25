/**
 * Minimal Google Calendar v3 client (fetch-injected, promise-thin).
 *
 * plancel only ever touches the secondary calendar it created itself —
 * that is what the `calendar.app.created` scope enforces server-side.
 */
import type { WebReservation } from "../store.ts";
import { startsAtToInstant } from "./ics.ts";

const BASE = "https://www.googleapis.com/calendar/v3";
export const PLANCEL_CALENDAR_SUMMARY = "plancel";

export class GcalError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface GcalDeps {
  fetchFn: typeof fetch;
  accessToken: string;
}

async function call(
  deps: GcalDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown> | null> {
  const res = await deps.fetchFn(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${deps.accessToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new GcalError(res.status, `gcal ${method} ${path}: http ${res.status}`);
  return json as Record<string, unknown> | null;
}

/** Returns a live calendar id: verifies the stored one, creates if needed. */
export async function ensureCalendar(deps: GcalDeps, current: string | null): Promise<string> {
  if (current !== null) {
    try {
      await call(deps, "GET", `/calendars/${encodeURIComponent(current)}`);
      return current;
    } catch (err) {
      if (!(err instanceof GcalError && (err.status === 404 || err.status === 410))) throw err;
    }
  }
  const created = await call(deps, "POST", "/calendars", { summary: PLANCEL_CALENDAR_SUMMARY });
  const id = created?.id;
  if (typeof id !== "string") throw new GcalError(500, "calendar insert returned no id");
  return id;
}

export function eventBody(r: WebReservation): Record<string, unknown> {
  const start = startsAtToInstant(r.startsAt);
  if (start === null) throw new GcalError(400, `unparseable startsAt: ${r.startsAt}`);
  const desc = [
    r.plan !== null ? `プラン: ${r.plan}` : null,
    r.amount !== null ? `金額: ¥${r.amount.toLocaleString("ja-JP")}` : null,
    `キャンセル規定: ${r.policy}`,
    "plancel で管理されている予約",
  ].filter((x): x is string => x !== null).join("\n");
  return {
    summary: r.service,
    description: desc,
    // Google Calendar renders `location` with its own maps link.
    ...(r.location !== null ? { location: r.location } : {}),
    start: { dateTime: start.toString({ smallestUnit: "second" }) },
    end: { dateTime: start.add({ hours: 1 }).toString({ smallestUnit: "second" }) },
    extendedProperties: { private: { plancelId: r.id } },
  };
}

/** Insert or patch; a 404/410 on patch falls back to insert. Returns event id. */
export async function upsertEvent(
  deps: GcalDeps,
  calendarId: string,
  eventId: string | null,
  r: WebReservation,
): Promise<string> {
  const cal = encodeURIComponent(calendarId);
  if (eventId !== null) {
    try {
      await call(deps, "PATCH", `/calendars/${cal}/events/${encodeURIComponent(eventId)}`, {
        ...eventBody(r),
      });
      return eventId;
    } catch (err) {
      if (!(err instanceof GcalError && (err.status === 404 || err.status === 410))) throw err;
    }
  }
  const created = await call(deps, "POST", `/calendars/${cal}/events`, eventBody(r));
  const id = created?.id;
  if (typeof id !== "string") throw new GcalError(500, "event insert returned no id");
  return id;
}

/** Idempotent: 404/410 (already gone) is success. */
export async function deleteEvent(
  deps: GcalDeps,
  calendarId: string,
  eventId: string,
): Promise<void> {
  try {
    await call(
      deps,
      "DELETE",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
  } catch (err) {
    if (err instanceof GcalError && (err.status === 404 || err.status === 410)) return;
    throw err;
  }
}

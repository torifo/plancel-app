/**
 * How the remote MCP shows the ledger to the model (issues #5, #6).
 *
 * The web API speaks to the phone's UI: canonical UTC instants, every row,
 * internal ids. A model reading that said 「10時」 for a 19:00 JST dinner,
 * re-derived cancellation deadlines from stage hours (twice-converted, often
 * wrong), and paid ~340 characters per row for history it never needed. This
 * module is the one place that turns an API body into what the model should
 * read: +09:00 timestamps, the deadline the server already computes for
 * notifications, policy in words, finished/cancelled rows hidden unless asked.
 */
import { z } from "zod";
import { readableInstantSchema, toInstantOrNull } from "../web/instant.ts";
import { isFinished } from "../web/lifecycle.ts";
import {
  boundaryMs,
  describePolicy,
  endOfJstDay,
  freeDeadlineMs,
  pctAt,
  stagesOf,
  type WebPolicy,
} from "../web/policy.ts";
import { type WebKind, type WebStatus, webStatusSchema } from "../web/store.ts";

/** The row shape this module reads — the API's reservation, loosely. */
export interface ApiReservation {
  id: string;
  plan: string | null;
  service: string;
  startsAt: string;
  endsAt: string | null;
  amount: number | null;
  location: string | null;
  notes?: string | null;
  timeTentative?: boolean;
  trip?: string | null;
  booked?: boolean;
  kind?: WebKind | null;
  from?: string | null;
  to?: string | null;
  bookedBy?: string | null;
  policy: WebPolicy;
  status: WebStatus;
  shared?: { ownerDisplayName: string; role: string };
}

export interface ModelReservation {
  id: string;
  service: string;
  plan: string | null;
  status: WebStatus;
  /** +09:00 form, e.g. 2026-12-20T19:00:00+09:00 (a legacy unreadable value stays as is). */
  startsAt: string;
  endsAt: string | null;
  amount: number | null;
  location: string | null;
  /** The outing this belongs to (things that are all used), or null. */
  trip: string | null;
  /** True when the start time is a guess; the day is still firm. */
  timeTentative: boolean;
  /** Free-text note: what the fixed fields cannot hold. */
  notes: string | null;
  /** False for an idea not yet arranged: nothing exists to cancel. */
  booked: boolean;
  /** Chosen (confirmed) but not booked yet — the thing left to do is to book it. */
  needsBooking: boolean;
  /** What it is: stay / meal / flight / train / bus / car / activity / other, or null. */
  kind: WebKind | null;
  /** Where it leaves from and arrives (transport), or is picked up and returned. */
  from: string | null;
  to: string | null;
  /** Who made the booking — the person to ask about it. */
  bookedBy: string | null;
  /** What is still unsettled about this reservation, in words to relay. Empty when nothing is. */
  needsCheck: string[];
  policy: WebPolicy;
  /** The policy in words, as the app screen shows it (「7日前まで無料 → …」). */
  policyText: string;
  /** Free-cancellation deadline (+09:00), or null when there is none to watch. */
  freeUntil: string | null;
  /**
   * When the first cancellation fee STARTS (the instant after `freeUntil`), and
   * at what rate. It used to carry the deadline itself under the name `at`, and
   * a model asked 「いつからかかる」 answered a day early (rehearsal, 2026-11-11).
   */
  nextCharge: { from: string; pct: number } | null;
  /**
   * The whole fee table as dates: through `until` (inclusive) cancelling costs
   * `pct`%. The last band ends at the start. `policyText` is the app's short
   * wording and names only each band's far edge — 「2日前まで無料 → 当日100%」
   * is 100% from the day before — so dates are what a model should quote.
   */
  feeSchedule: { until: string; pct: number; yen: number | null }[] | null;
  /**
   * What cancelling right now would cost: the rate in force and, when the
   * amount is known, the yen figure. Null when the policy is unknown.
   */
  feeNow: { pct: number; yen: number | null } | null;
  /** Already over (the day it ends has passed). */
  finished: boolean;
  shared?: { ownerDisplayName: string; role: string };
}

const TOKYO = "Asia/Tokyo";

const jstOfMs = (ms: number): string =>
  Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(TOKYO).toString({
    smallestUnit: "second",
    timeZoneName: "never",
  });

/** A stored instant in +09:00 form. Unreadable text is returned untouched. */
export function jst(value: string): string {
  const i = toInstantOrNull(value);
  return i === null ? value : jstOfMs(i.epochMilliseconds);
}

/**
 * When the first fee starts: the boundary of the last free stage, and the rate
 * of the stage after it. Null when nothing is free to lose (unknown, always
 * free, or paid from the outset).
 */
function nextCharge(policy: WebPolicy, startsAt: string): { from: string; pct: number } | null {
  const stages = stagesOf(policy);
  const start = toInstantOrNull(startsAt);
  if (stages === null || start === null) return null;
  const lastFree = stages.reduce<number>((acc, s, i) => (s.pct === 0 ? i : acc), -1);
  if (lastFree < 0) return null;
  const first = stages[lastFree + 1];
  if (first === undefined) return null;
  // The boundary is the last free millisecond of its day; the fee starts on the next.
  const from = boundaryMs(start.epochMilliseconds, stages[lastFree]!.h) + 1;
  return { from: jstOfMs(from), pct: first.pct };
}

/** Each band of the policy as "through this instant, this rate". */
function feeSchedule(
  r: ApiReservation,
): { until: string; pct: number; yen: number | null }[] | null {
  const stages = stagesOf(r.policy);
  const start = toInstantOrNull(r.startsAt);
  if (stages === null || start === null) return null;
  return stages.map((s) => ({
    until: jstOfMs(boundaryMs(start.epochMilliseconds, s.h)),
    pct: s.pct,
    yen: r.amount === null ? null : Math.round(r.amount * s.pct / 100),
  }));
}

/**
 * An end as the model should read it. An end given as a bare date is stored as
 * midnight JST of that day; shown with its time it reads as "ends at 0:00",
 * which is the END of the day before. Only the day of an end matters to the
 * ledger, so a midnight end goes back out as the date it came in as.
 */
function jstEnd(value: string): string {
  const shown = jst(value);
  return shown.endsWith("T00:00:00+09:00") ? shown.slice(0, 10) : shown;
}

/** The fee if cancelled at `nowMs` — the question 「いまキャンセルしたらいくら」. */
function feeNow(r: ApiReservation, nowMs: number): { pct: number; yen: number | null } | null {
  const start = toInstantOrNull(r.startsAt);
  if (start === null) return null;
  const pct = pctAt(r.policy, start.epochMilliseconds, nowMs);
  if (pct === null) return null;
  return { pct, yen: r.amount === null ? null : Math.round(r.amount * pct / 100) };
}

/**
 * What is still open about a reservation — the list a model reads back when
 * asked 「まだ決まっていないことは？」. Nothing here is an error; each line is
 * something the family has not found out or done yet.
 */
function needsCheck(r: ApiReservation, booked: boolean): string[] {
  if (r.status === "cancelled") return [];
  const out: string[] = [];
  if (!booked) out.push("まだ予約していない");
  if (r.timeTentative === true) out.push("時刻が仮");
  // An unbooked idea has no policy to learn yet.
  if (booked && r.policy === "unknown") out.push("キャンセル規定が不明");
  if (r.amount === null) out.push("金額が未入力");
  if (r.kind === "stay" && r.endsAt == null) out.push("終了日（チェックアウト日）が未入力");
  return out;
}

export interface TripSummary {
  trip: string;
  count: number;
  /** First and last day of the trip's reservations (JST dates). */
  from: string | null;
  to: string | null;
  /** Money in confirmed reservations. */
  confirmedYen: number;
  /**
   * Confirmed, plus the most the undecided rest could add: every candidate on
   * its own, and of each undecided plan only its dearest alternative.
   */
  expectedYen: number;
}

/** Sums up each trip among `rows` (cancelled and to-be-cancelled rows left out). */
export function summarizeTrips(rows: ApiReservation[]): TripSummary[] {
  const byTrip = new Map<string, ApiReservation[]>();
  for (const r of rows) {
    if (r.trip == null || r.status === "cancelled" || r.status === "to_cancel") continue;
    const key = foldName(r.trip);
    byTrip.set(key, [...(byTrip.get(key) ?? []), r]);
  }
  return [...byTrip.values()].map((rs) => {
    const days = rs.flatMap((r) => [r.startsAt, r.endsAt]).map((v) =>
      v == null ? null : toInstantOrNull(v)?.epochMilliseconds ?? null
    ).filter((ms): ms is number => ms !== null);
    const day = (ms: number) => jstOfMs(ms).slice(0, 10);
    const confirmedYen = rs.filter((r) => r.status === "confirmed").reduce(
      (sum, r) => sum + (r.amount ?? 0),
      0,
    );
    const open = rs.filter((r) => r.status === "candidate");
    const settledPlans = new Set(
      rs.filter((r) => r.status === "confirmed" && r.plan !== null).map((r) => r.plan),
    );
    const dearest = new Map<string, number>();
    let solo = 0;
    for (const r of open) {
      if (r.plan === null) solo += r.amount ?? 0;
      else if (!settledPlans.has(r.plan)) {
        dearest.set(r.plan, Math.max(dearest.get(r.plan) ?? 0, r.amount ?? 0));
      }
    }
    return {
      trip: rs[0]!.trip!,
      count: rs.length,
      from: days.length ? day(Math.min(...days)) : null,
      to: days.length ? day(Math.max(...days)) : null,
      confirmedYen,
      expectedYen: confirmedYen + solo + [...dearest.values()].reduce((a, b) => a + b, 0),
    };
  });
}

export function presentReservation(r: ApiReservation, nowMs: number): ModelReservation {
  const booked = r.booked !== false;
  // Nothing is held, so nothing can be lost by cancelling: no deadline, no fee.
  const deadline = booked ? freeDeadlineMs(r.policy, r.startsAt) : null;
  return {
    id: r.id,
    service: r.service,
    plan: r.plan,
    status: r.status,
    startsAt: jst(r.startsAt),
    // `== null`: a row mirrored before the field existed has no `endsAt` at all,
    // and `undefined` would drop the key from the JSON the model reads.
    endsAt: r.endsAt == null ? null : jstEnd(r.endsAt),
    amount: r.amount,
    location: r.location,
    trip: r.trip ?? null,
    timeTentative: r.timeTentative ?? false,
    notes: r.notes ?? null,
    booked,
    needsBooking: !booked && r.status === "confirmed",
    kind: r.kind ?? null,
    from: r.from ?? null,
    to: r.to ?? null,
    bookedBy: r.bookedBy ?? null,
    needsCheck: needsCheck(r, booked),
    policy: r.policy,
    policyText: describePolicy(r.policy),
    freeUntil: deadline === null ? null : jstOfMs(deadline),
    nextCharge: booked ? nextCharge(r.policy, r.startsAt) : null,
    feeSchedule: feeSchedule(r),
    feeNow: booked ? feeNow(r, nowMs) : { pct: 0, yen: 0 },
    finished: isFinished(r, nowMs),
    ...(r.shared !== undefined ? { shared: r.shared } : {}),
  };
}

export const listFilterSchema = z.object({
  status: z.array(webStatusSchema).optional().describe(
    "この状態だけ（candidate/confirmed/to_cancel/cancelled）。省略時は cancelled 以外",
  ),
  from: readableInstantSchema.optional().describe(
    "この日時以降に始まる予約（ISO 8601、日付だけでも可）",
  ),
  to: readableInstantSchema.optional().describe("この日時まで（日付だけならその日いっぱい）"),
  q: z.string().optional().describe(
    "店名・プラン名・旅行名・場所・メモに含まれる語（空白・全角半角・大小は同一視）",
  ),
  trip: z.string().optional().describe("この旅行名の予約だけ（空白・全角半角・大小は同一視）"),
  includeFinished: z.boolean().default(false).describe("終わった予約も含める（既定 false）"),
  sort: z.enum(["startsAt", "deadline"]).default("startsAt").describe(
    '並び順: "startsAt"（開始が早い順）/ "deadline"（無料キャンセル期限が近い順、期限なしは最後）',
  ),
  limit: z.number().int().min(1).max(200).default(50).describe("最大件数（既定 50）"),
});
export type ListFilter = z.infer<typeof listFilterSchema>;

export interface ModelList {
  /** Rows in the ledger before filtering. */
  total: number;
  count: number;
  truncated: boolean;
  /**
   * Rows left out because they are over or cancelled — why `total` can exceed
   * `count` with no filter given. `includeFinished` / `status` bring them back.
   */
  hidden: { finished: number; cancelled: number };
  /**
   * Shown rows whose policy is unknown. They sort last by deadline, yet they are
   * the ones nobody is watching — the count keeps them from being overlooked.
   */
  policyUnknown: number;
  /** One line per trip among the shown rows: dates, count, money. Absent when none has a trip. */
  trips?: TripSummary[];
  reservations: ModelReservation[];
}

/** Fold a name for matching: NFKC, lower-case, no whitespace at all. */
export const foldName = (s: string): string =>
  s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

const msOf = (value: string | undefined): number | null =>
  value === undefined ? null : toInstantOrNull(value)?.epochMilliseconds ?? null;

export function presentList(rows: ApiReservation[], f: ListFilter, nowMs: number): ModelList {
  const fromMs = msOf(f.from);
  const toRaw = msOf(f.to);
  // A date-only `to` means the whole of that day.
  const toMs = toRaw === null ? null : f.to!.includes("T") ? toRaw : endOfJstDay(toRaw);
  const q = f.q === undefined ? null : foldName(f.q);
  const trip = f.trip === undefined ? null : foldName(f.trip);
  const out: ModelReservation[] = [];
  const shownRows: ApiReservation[] = [];
  const hidden = { finished: 0, cancelled: 0 };
  for (const r of rows) {
    if (f.status !== undefined) {
      if (!f.status.includes(r.status)) continue;
    } else if (r.status === "cancelled") {
      hidden.cancelled++;
      continue;
    }
    const v = presentReservation(r, nowMs);
    // Over is over whatever status was asked for: a status filter used to bring
    // September's rows back into a December list (found 2026-11-11).
    if (v.finished && !f.includeFinished) {
      hidden.finished++;
      continue;
    }
    const startMs = toInstantOrNull(r.startsAt)?.epochMilliseconds ?? null;
    if (fromMs !== null && (startMs === null || startMs < fromMs)) continue;
    if (toMs !== null && (startMs === null || startMs > toMs)) continue;
    if (
      q !== null &&
      ![
        r.service,
        r.plan ?? "",
        r.trip ?? "",
        r.location ?? "",
        r.notes ?? "",
        r.from ?? "",
        r.to ?? "",
        r.bookedBy ?? "",
      ].some((s) => foldName(s).includes(q))
    ) {
      continue;
    }
    if (trip !== null && foldName(r.trip ?? "") !== trip) continue;
    out.push(v);
    shownRows.push(r);
  }
  const startKey = (v: ModelReservation) =>
    toInstantOrNull(v.startsAt)?.epochMilliseconds ?? Number.MAX_SAFE_INTEGER;
  const deadlineKey = (v: ModelReservation) =>
    v.freeUntil === null
      ? Number.MAX_SAFE_INTEGER
      : toInstantOrNull(v.freeUntil)!.epochMilliseconds;
  out.sort((a, b) =>
    f.sort === "deadline"
      ? deadlineKey(a) - deadlineKey(b) || startKey(a) - startKey(b)
      : startKey(a) - startKey(b) || a.id.localeCompare(b.id)
  );
  const limited = out.slice(0, f.limit);
  const trips = summarizeTrips(shownRows);
  return {
    total: rows.length,
    count: limited.length,
    truncated: limited.length < out.length,
    hidden,
    policyUnknown:
      limited.filter((v) => v.policy === "unknown" && v.status !== "cancelled" && v.booked).length,
    ...(trips.length > 0 ? { trips } : {}),
    reservations: limited,
  };
}

/**
 * The live row that is the same booking: same place (spacing aside) at the
 * same instant, not cancelled. A model that timed out retries its create;
 * this is what keeps the retry from making a second reservation (issue #5).
 */
export function findDuplicate(
  rows: ApiReservation[],
  service: string,
  startsAt: string,
): ApiReservation | null {
  const at = toInstantOrNull(startsAt)?.epochMilliseconds;
  if (at === undefined) return null;
  const name = foldName(service);
  return rows.find((r) =>
    // A reservation shared WITH this user belongs to someone else's ledger.
    r.shared === undefined &&
    r.status !== "cancelled" && foldName(r.service) === name &&
    toInstantOrNull(r.startsAt)?.epochMilliseconds === at
  ) ?? null;
}

/**
 * The live row for the same place on the same JST day, whatever the time. A
 * check-in filed with a tentative time and filed again with the real one is the
 * same stay; the exact-instant check above cannot see that (first real Codex
 * run, 2026-11-12).
 */
export function findSameDay(
  rows: ApiReservation[],
  service: string,
  startsAt: string,
): ApiReservation | null {
  const at = toInstantOrNull(startsAt)?.epochMilliseconds;
  if (at === undefined) return null;
  const day = endOfJstDay(at);
  const name = foldName(service);
  return rows.find((r) => {
    const start = toInstantOrNull(r.startsAt)?.epochMilliseconds;
    return r.shared === undefined && r.status !== "cancelled" && foldName(r.service) === name &&
      start !== undefined && endOfJstDay(start) === day;
  }) ?? null;
}

/** Next steps for the API's error codes, for a caller with no table of its own. */
export const API_ERROR_HINTS: Record<string, string> = {
  "not found": "その予約IDは台帳にありません。list_reservations で確認してください。",
  user_not_found:
    "相手は plancel に未登録です。先に登録してもらってください（メールアドレスかユーザーIDの完全一致）。",
  cannot_share_with_self: "自分自身には共有できません。",
  forbidden:
    "この操作は予約のオーナーだけができます（共有された予約では確定・キャンセル・削除・招待は不可）。",
  invalid: "入力の形式が違います。issues の path と message を見て直してください。",
  "invalid facility name": "施設名が空か長すぎます（100文字まで）。",
  "rate limited": "続けて呼びすぎました。少し待ってからもう一度。",
};

/** Rewrites an API body for the model: rows in JST with deadlines, errors with a next step. */
export function presentResponse(body: unknown, nowMs: number): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const o = { ...(body as Record<string, unknown>) };
  if (typeof o.reservation === "object" && o.reservation !== null) {
    o.reservation = presentReservation(o.reservation as ApiReservation, nowMs);
  }
  if (Array.isArray(o.reservations)) {
    o.reservations = (o.reservations as ApiReservation[]).map((r) => presentReservation(r, nowMs));
  }
  if (
    typeof o.error === "string" && o.hint === undefined && API_ERROR_HINTS[o.error] !== undefined
  ) {
    o.hint = API_ERROR_HINTS[o.error];
  }
  return o;
}

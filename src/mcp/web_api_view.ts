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
import { type WebStatus, webStatusSchema } from "../web/store.ts";

/** The row shape this module reads — the API's reservation, loosely. */
export interface ApiReservation {
  id: string;
  plan: string | null;
  service: string;
  startsAt: string;
  endsAt: string | null;
  amount: number | null;
  location: string | null;
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
  feeSchedule: { until: string; pct: number }[] | null;
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
  policy: WebPolicy,
  startsAt: string,
): { until: string; pct: number }[] | null {
  const stages = stagesOf(policy);
  const start = toInstantOrNull(startsAt);
  if (stages === null || start === null) return null;
  return stages.map((s) => ({
    until: jstOfMs(boundaryMs(start.epochMilliseconds, s.h)),
    pct: s.pct,
  }));
}

/** The fee if cancelled at `nowMs` — the question 「いまキャンセルしたらいくら」. */
function feeNow(r: ApiReservation, nowMs: number): { pct: number; yen: number | null } | null {
  const start = toInstantOrNull(r.startsAt);
  if (start === null) return null;
  const pct = pctAt(r.policy, start.epochMilliseconds, nowMs);
  if (pct === null) return null;
  return { pct, yen: r.amount === null ? null : Math.round(r.amount * pct / 100) };
}

export function presentReservation(r: ApiReservation, nowMs: number): ModelReservation {
  const deadline = freeDeadlineMs(r.policy, r.startsAt);
  return {
    id: r.id,
    service: r.service,
    plan: r.plan,
    status: r.status,
    startsAt: jst(r.startsAt),
    // `== null`: a row mirrored before the field existed has no `endsAt` at all,
    // and `undefined` would drop the key from the JSON the model reads.
    endsAt: r.endsAt == null ? null : jst(r.endsAt),
    amount: r.amount,
    location: r.location,
    policy: r.policy,
    policyText: describePolicy(r.policy),
    freeUntil: deadline === null ? null : jstOfMs(deadline),
    nextCharge: nextCharge(r.policy, r.startsAt),
    feeSchedule: feeSchedule(r.policy, r.startsAt),
    feeNow: feeNow(r, nowMs),
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
    "店名・プラン名・場所に含まれる語（空白・全角半角・大小は同一視）",
  ),
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
  const out: ModelReservation[] = [];
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
      ![r.service, r.plan ?? "", r.location ?? ""].some((s) => foldName(s).includes(q))
    ) {
      continue;
    }
    out.push(v);
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
  return {
    total: rows.length,
    count: limited.length,
    truncated: limited.length < out.length,
    hidden,
    policyUnknown: limited.filter((v) => v.policy === "unknown" && v.status !== "cancelled").length,
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

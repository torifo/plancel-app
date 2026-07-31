/**
 * Web ledger cancellation policy — the stage model and ALL of its math
 * (owner 2026-07-27: 「7日前しか選べないのは致命的。5日前とかが選べないとまずい」).
 *
 * A policy is either one of the four legacy preset NAMES (production records
 * already hold these strings) or an explicit stage table
 * `{ stages: [{ h, pct }, …] }` — `h` = whole hours before the start, `pct` =
 * the fee percentage that applies from that boundary inward. The presets are
 * just names for three common tables (`PRESET_STAGES`), so consumers read
 * stages through `stagesOf` and never branch on the name.
 *
 * Invariants, enforced by the schema rather than by callers:
 *   - 1〜8 stages; each `h` a whole number of hours ≥ 0, each `pct` in [0,100]
 *   - one stage at h=0 — the rate that applies right up to the start. The form
 *     always submits it; a table without it is REJECTED rather than completed
 *     with an invented 100% stage.
 *   - stored canonical: `h` descending, one stage per `h`, and collapsed to the
 *     preset NAME when the table equals a preset table (legacy readers, the
 *     LINE summary and the UI labels keep working unchanged).
 *
 * The client mirror lives in web/index.html (single-file app, no imports):
 * PRESET_STAGES / stagesOf / freeDeadline / maxLoss / pctNow / describePolicy
 * MUST stay in lockstep with this module.
 */
import { z } from "zod";

const HOUR_MS = 3_600_000;
/** A boundary further out than a year is a data error, not a policy. */
const MAX_HOURS = 24 * 366;
/** Stage cap: real policies use 2〜4 stages; 8 is also the form's row limit. */
export const MAX_STAGES = 8;

export const webPolicyStageSchema = z.object({
  /** Whole hours before the reservation start (0 = at the start). */
  h: z.number().int().min(0).max(MAX_HOURS),
  /** Fee % charged for cancelling from this boundary inward. */
  pct: z.number().min(0).max(100),
});
export type WebPolicyStage = z.infer<typeof webPolicyStageSchema>;

/** The preset names — pre-2026-07-27 records hold one of these as a string. */
export const webPolicyPresetSchema = z.enum(["unknown", "none", "free24", "staged"]);
export type WebPolicyPreset = z.infer<typeof webPolicyPresetSchema>;

/** Stage tables the preset names stand for ("unknown" has none by design). */
export const PRESET_STAGES: Record<
  Exclude<WebPolicyPreset, "unknown">,
  readonly WebPolicyStage[]
> = {
  none: [{ h: 0, pct: 0 }],
  free24: [{ h: 24, pct: 0 }, { h: 0, pct: 100 }],
  staged: [{ h: 168, pct: 0 }, { h: 72, pct: 30 }, { h: 24, pct: 50 }, { h: 0, pct: 100 }],
};

export const webCustomPolicySchema = z.object({
  stages: z.array(webPolicyStageSchema).min(1).max(MAX_STAGES),
}).superRefine((policy, ctx) => {
  if (policy.stages.some((s) => s.h === 0)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: "stages must end at h=0 (当日の料率), which the caller must state explicitly",
    path: ["stages"],
  });
});

/** What a client may send. `webPolicySchema` additionally canonicalizes it. */
export const webPolicyInputSchema = z.union([webPolicyPresetSchema, webCustomPolicySchema]);
export type WebPolicy = z.infer<typeof webPolicyInputSchema>;

/** The stored/validated policy: parsing also normalizes and collapses it. */
export const webPolicySchema = webPolicyInputSchema.transform(normalizePolicy);

/**
 * Canonical stage order: `h` descending, one stage per `h`. Duplicate
 * boundaries keep the LAST of the caller's entries (a later row overrides an
 * earlier one with the same boundary), and a stage charging the same rate as
 * the next (inner) one is dropped as redundant — anything earlier already
 * falls into the inner stage's rate. Canonical form is therefore unique, so
 * re-saving an untouched form re-saves the same value.
 */
export function normalizeStages(stages: readonly WebPolicyStage[]): WebPolicyStage[] {
  const byBoundary = new Map<number, WebPolicyStage>();
  for (const s of [...stages].sort((a, b) => b.h - a.h)) {
    // Map.set keeps the first insertion position and replaces the value, so
    // the order stays descending while the later duplicate wins.
    byBoundary.set(s.h, { h: s.h, pct: s.pct });
  }
  const ordered = [...byBoundary.values()];
  return ordered.filter((s, i) => ordered[i + 1]?.pct !== s.pct);
}

const sameStages = (a: readonly WebPolicyStage[], b: readonly WebPolicyStage[]) =>
  a.length === b.length && a.every((s, i) => s.h === b[i]?.h && s.pct === b[i]?.pct);

/** Preset name whose table equals `stages`, else null. */
function presetNameOf(stages: readonly WebPolicyStage[]): WebPolicyPreset | null {
  for (const [name, preset] of Object.entries(PRESET_STAGES)) {
    if (sameStages(stages, preset)) return name as WebPolicyPreset;
  }
  return null;
}

/** Normalizes a custom table and collapses it to a preset name when it is one. */
export function normalizePolicy(policy: WebPolicy): WebPolicy {
  if (typeof policy === "string") return policy;
  const stages = normalizeStages(policy.stages);
  return presetNameOf(stages) ?? { stages };
}

/** The stages of any policy — null ONLY for "unknown". */
export function stagesOf(policy: WebPolicy): WebPolicyStage[] | null {
  if (typeof policy !== "string") return normalizeStages(policy.stages);
  if (policy === "unknown") return null;
  return [...PRESET_STAGES[policy]];
}

/** No paid stage at all: cancelling stays free right up to the start. */
export function isAlwaysFree(policy: WebPolicy): boolean {
  const stages = stagesOf(policy);
  return stages !== null && stages.every((s) => s.pct === 0);
}

/** JST is a fixed +09:00 (no DST), so day arithmetic is a plain shift. */
const JST_OFFSET_MS = 9 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;

/** The last instant of the JST day containing `ms` (…23:59:59.999+09:00). */
function endOfJstDay(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_MS - 1 - JST_OFFSET_MS;
}

/**
 * When a stage's boundary actually falls (epoch ms).
 *
 * A cancellation deadline is a DATE, not a time of day: 「7日前まで無料」 means
 * you have all of that day, whether the reservation is at 15:00 or 19:00 (owner,
 * 2026-07-31: 「時間が何時に登録されてもキャンセル期限は23:59または次の日の0:00が
 * 一般」). Subtracting `h` hours from the start therefore only picks the DAY; the
 * boundary itself sits at the end of it. Reading a 15:00 check-in literally used
 * to expire 「今日まで無料」 at 15:00 and call the rest of the day 無料期間は終了.
 *
 * `h: 0`（当日）is the exception: its band ends at the reservation, not at the
 * end of the reservation's day, or the 当日 rate would start after the start.
 */
export function boundaryMs(startsAtMs: number, h: number): number {
  if (h <= 0) return startsAtMs;
  return endOfJstDay(startsAtMs - h * HOUR_MS);
}

/**
 * The FREE-cancellation deadline (epoch ms), or null when the policy has no
 * free window to lose: "unknown", always-free, or paid from the outset.
 *
 * The free window ends at the LAST pct==0 stage's boundary — free24
 * (「前日まで無料」) is the end of the day before, 「5日前まで無料」 the end of the
 * fifth day out. (2026-07-25 fix: the old first-paid-stage reading was off by
 * one stage on both sides.)
 */
export function freeDeadlineMs(policy: WebPolicy, startsAt: string): number | null {
  const stages = stagesOf(policy);
  if (stages === null) return null; // unknown
  if (!stages.some((s) => s.pct > 0)) return null; // free throughout
  const lastFree = [...stages].reverse().find((s) => s.pct === 0);
  if (lastFree === undefined) return null; // paid from the outset
  return boundaryMs(Temporal.Instant.from(startsAt).epochMilliseconds, lastFree.h);
}

/** Worst-case cancellation fee (放置損失): amount × the highest stage %. */
export function maxLossYen(policy: WebPolicy, amount: number | null): number {
  if (amount === null || amount === 0) return 0;
  const stages = stagesOf(policy);
  if (stages === null) return 0; // unknown
  return Math.round(amount * Math.max(...stages.map((s) => s.pct)) / 100);
}

/**
 * Fee % for cancelling at `atMs`; null only for "unknown".
 *
 * Compares against real boundary instants (`boundaryMs`) rather than raw hours
 * left, so the rate changes when the DATE changes — the same reading the
 * deadline uses. Taking hours-before-start literally would raise the fee at the
 * check-in time of day, hours before the deadline it is paired with.
 */
export function pctAt(policy: WebPolicy, startsAtMs: number, atMs: number): number | null {
  const stages = stagesOf(policy);
  if (stages === null) return null;
  // Stages descend, so the first boundary still ahead is the one in effect.
  // Past the innermost boundary (the start) the innermost rate stands.
  const reached = stages.filter((s) => atMs <= boundaryMs(startsAtMs, s.h));
  return (reached[0] ?? stages.at(-1))?.pct ?? 0;
}

/** 「5日前」「前日」「当日」「36時間前」 — a boundary as users say it. */
function boundaryLabel(h: number): string {
  if (h === 0) return "当日";
  if (h === 24) return "前日";
  if (h % 24 === 0) return `${h / 24}日前`;
  return `${h}時間前`;
}

/**
 * Human Japanese label — 「5日前まで無料 → 3日前まで30% → 当日100%」, the way
 * cancellation tables are actually written (a stage's `h` is the INNER edge of
 * its band, i.e. core `until_offset_hours`). Everything user-facing goes
 * through this (ICS / Google Calendar descriptions, the form preview): a raw
 * custom policy would print as JSON.
 */
export function describePolicy(policy: WebPolicy): string {
  const stages = stagesOf(policy);
  if (stages === null) return "不明";
  if (isAlwaysFree(policy)) return "いつでも無料";
  const parts: string[] = [];
  const lastFree = [...stages].reverse().find((s) => s.pct === 0);
  if (lastFree !== undefined) parts.push(`${boundaryLabel(lastFree.h)}まで無料`);
  for (const s of stages) {
    if (s.pct === 0) continue;
    parts.push(s.h === 0 ? `当日${s.pct}%` : `${boundaryLabel(s.h)}まで${s.pct}%`);
  }
  return parts.join(" → ");
}

/** The parsed-policy stage shape this module reads (core `PolicyStage`, loosely). */
interface CoreStageLike {
  until_offset_hours?: number;
  fee_percent?: number;
  fee_fixed_jpy?: number | null;
}

/**
 * Forces the free window implied by 「N日前から◯%」 onto a parsed table.
 *
 * `freeAt` is what the SOURCE TEXT implies (src/parse/policy-phrasing.ts), and
 * it decides the free boundary outright, because a model's own answer for it
 * cannot be trusted: llama-3.3-70b reports 「7日前から20%」 as free until 7日前,
 * i.e. free during a day the facility charges for, and that is the one error
 * this ledger exists to prevent.
 *
 * Idempotent by construction: a table that already carries the right boundary
 * comes back unchanged, so running it over a correct answer costs nothing.
 *
 * A paid stage sitting exactly ON the new boundary is dropped rather than
 * reconciled: it says the facility charges at an instant the text calls free,
 * and moving it inward would invent a boundary nobody wrote. Its band then
 * absorbs into the next rate inward, which over-warns and never under-warns.
 * This can only happen when the text names its boundary in hours (a day-named
 * boundary lands 24h outside every stage the model produced).
 */
function withFreeWindowFrom(stages: WebPolicyStage[], freeAt: number): WebPolicyStage[] {
  if (freeAt > MAX_HOURS) return stages;
  const paid = stages.filter((s) => s.pct > 0 && s.h < freeAt);
  if (paid.length === 0) return stages; // nothing left to charge for — leave it alone
  return normalizeStages([{ h: freeAt, pct: 0 }, ...paid]);
}

/**
 * The ONE conversion from a parsed core cancellation policy
 * (src/core/schema/cancellation-policy.ts) into a web policy — shared by
 * /api/parse and the LINE registration path. Arbitrary stages are PRESERVED
 * (offsets rounded to whole hours); an exact preset match collapses to the
 * preset name.
 *
 * `freeAt` (hours before the start, implied by the source text) is applied
 * last and overrides whatever free boundary the model produced — see
 * `withFreeWindowFrom`.
 *
 * "unknown" is returned only when the policy cannot be expressed in this model:
 * no policy / no stages, a stage carrying a fixed-yen fee (dropping the ¥ fee
 * would make the loss math lie), an out-of-range boundary, or more stages than
 * the table allows. Callers report that so the user completes it in the web UI.
 *
 * The parameter is `unknown` because /api/parse maps merged, unvalidated LLM
 * output; a typed `CancellationPolicyOrUnknown` is assignable as-is.
 */
export function fromCoreStages(policy: unknown, freeAt?: number | null): WebPolicy {
  if (policy === null || typeof policy !== "object") return "unknown";
  const raw = (policy as { stages?: unknown }).stages;
  if (!Array.isArray(raw) || raw.length === 0) return "unknown";
  const stages: WebPolicyStage[] = [];
  for (const entry of raw as CoreStageLike[]) {
    if (entry === null || typeof entry !== "object") return "unknown";
    if ((entry.fee_fixed_jpy ?? 0) !== 0) return "unknown"; // a ¥ fee has no % form
    const h = Math.max(0, Math.round(entry.until_offset_hours ?? 0));
    const pct = entry.fee_percent ?? 0;
    if (!Number.isFinite(h) || h > MAX_HOURS || !Number.isFinite(pct)) return "unknown";
    stages.push({ h, pct: Math.min(100, Math.max(0, pct)) });
  }
  const innermost = normalizeStages(stages).at(-1);
  if (innermost === undefined) return "unknown";
  // The innermost stage's rate already applies down to the start (see `pctAt`),
  // so stating it at h=0 restates this policy — it invents no 100% stage. The
  // second pass then drops the now-redundant boundary.
  const restated = normalizeStages([...stages, { h: 0, pct: innermost.pct }]);
  const normalized = freeAt === undefined || freeAt === null
    ? restated
    : withFreeWindowFrom(restated, freeAt);
  if (normalized.length > MAX_STAGES) return "unknown";
  return presetNameOf(normalized) ?? { stages: normalized };
}

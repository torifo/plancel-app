/**
 * CancellationPolicy boundary + loss calculation (Task 2.2, SDD §3.3, §6
 * trigger 1, requirements.md US-003 / FR-003).
 *
 * All functions here are pure: they take instants directly (`startsAt`,
 * `at`) rather than a `Clock`, so callers inject time by reading a `Clock`
 * once and passing the resulting `Temporal.Instant` in. No I/O, no direct
 * system-clock access (FR-008; see src/core/clock/).
 *
 * ## Semantic interpretation of `until_offset_hours` (documented decision)
 *
 * SDD §3.3: `until_offset_hours` is the LATEST moment at which cancelling
 * still costs that stage's rate — 「7日前まで30%」 is `{until_offset_hours:
 * 168, fee_percent: 30}` — and stages are stored farthest-first (descending).
 * A stage's rate therefore covers everything from its own boundary OUTWARD,
 * up to the next (farther) stage's boundary. Concretely, define:
 *
 *   boundary = the end of the JST calendar day selected by
 *              `startsAt - until_offset_hours`, except offset 0 which is the
 *              reservation start itself. The offset selects a date; it is not
 *              a literal N*24-hour deadline.
 *
 * - The applicable stage is the FIRST stage (farthest-first) whose boundary
 *   has not passed yet. Fees are monotonically non-decreasing as the offset
 *   decreases, so that is also the cheapest rate still available.
 * - A free window is an explicit `fee_percent: 0` stage, never implied by
 *   the absence of stages. 「7日前まで無料 → 3日前まで30% → 当日100%」 is
 *   `[{168,0},{72,30},{0,100}]`; a table whose outermost stage charges means
 *   the policy charges from the moment of booking, and says so.
 * - Boundary-exact convention: at the boundary instant that stage's rate
 *   still applies (the comparison is `<=`), i.e. the boundary is the last
 *   instant at its own rate. 「7日前まで無料」 is free through 7日前 23:59:59.
 * - Inside the innermost boundary — and after `starts_at` — the innermost
 *   stage's rate continues to apply. There is no implicit "beyond 100%" stage.
 *
 * This is the same reading as `src/web/policy.ts` (`pctAt` /
 * `freeDeadlineMs`) and the same one `src/parse/llm.ts` instructs the model
 * to produce. Until 2026-07-30 this module read the array one band out of
 * step with both — the same table meant 30% here and 50% in the ledger — and
 * the two never met only because nothing in the deployed process writes core
 * Reservations. `deno task line` standalone and the local-core MCP do.
 *
 * ## Fee amount convention (documented decision)
 *
 * When a stage has both `fee_percent` and a non-null `fee_fixed_jpy`, the
 * two are not mutually exclusive (SDD §3.3: "percent と排他ではなく併記可").
 * This module treats them as two independent ways to compute a fee floor
 * and takes `max(percentDerived, fee_fixed_jpy)` as the effective loss —
 * i.e. whichever is more expensive for the customer applies. This is a
 * reasonable, conservative reading (never under-warn the user about a
 * fixed minimum cancellation fee) but is not spelled out verbatim in the
 * SDD, so it is called out here explicitly.
 */

import type { CancellationPolicy, PolicyStage } from "../schema/mod.ts";

/** A `CancellationPolicy`, or the literal `"unknown"` (SDD §3.3). */
export type CancellationPolicyOrUnknown = CancellationPolicy | "unknown";

/** Result of resolving the fee schedule at a specific instant. */
export type PolicyResolution =
  | {
    policyKnown: true;
    /** The stage in effect — `null` only for a policy with no stages at all.
     * A free window is a `fee_percent: 0` stage, so it reports that stage. */
    stage: PolicyStage | null;
    feePercent: number;
    feeFixedJpy: number | null;
  }
  | { policyKnown: false };

/** Result of locating the next fee-increasing boundary. */
export type NextBoundary = {
  at: Temporal.Instant;
  fromStage: PolicyStage | null;
  toStage: PolicyStage;
};

/** Result of estimating the JPY loss now vs. after the next boundary. */
export type LossEstimate =
  | {
    policyKnown: true;
    nowJpy: number | null;
    afterNextBoundaryJpy: number | null;
  }
  | { policyKnown: false; nowJpy: null; afterNextBoundaryJpy: null };

function isUnknown(policy: CancellationPolicyOrUnknown): policy is "unknown" {
  return policy === "unknown";
}

/**
 * When a stage's boundary actually falls. A cancellation deadline is a DATE:
 * 「7日前まで無料」 lasts all of that day whatever time the reservation is at,
 * so subtracting the offset only picks the day and the boundary sits at the end
 * of it (`src/web/policy.ts` `boundaryMs` is the same rule). `0` is the
 * exception — its band ends at the reservation itself.
 */
function boundaryInstant(startsAt: Temporal.Instant, offsetHours: number): Temporal.Instant {
  if (offsetHours <= 0) return startsAt;
  return startsAt.subtract({ hours: offsetHours })
    .toZonedDateTimeISO("Asia/Tokyo")
    .withPlainTime({ hour: 23, minute: 59, second: 59, millisecond: 999 })
    .toInstant();
}

/**
 * The stage in effect at instant `at`, per the boundary convention documented
 * at the top of this module. Returns `null` only for a policy with no stages at
 * all — a free window is a `fee_percent: 0` stage, not a missing one.
 */
function stageAt(
  stages: PolicyStage[],
  startsAt: Temporal.Instant,
  at: Temporal.Instant,
): PolicyStage | null {
  // Farthest-first, and a rate covers its boundary outward, so the first
  // boundary not yet passed is the one in effect. Inside the innermost boundary
  // (and past the start) the innermost rate stands.
  const reached = stages.filter((s) =>
    Temporal.Instant.compare(at, boundaryInstant(startsAt, s.until_offset_hours)) <= 0
  );
  return reached[0] ?? stages.at(-1) ?? null;
}

/** Effective fee amount for a stage (see fee-amount convention above), or 0 for the free window. */
function feeAmountJpy(stage: PolicyStage | null, amountJpy: number): number {
  if (stage === null) return 0;
  const percentDerived = amountJpy * (stage.fee_percent / 100);
  if (stage.fee_fixed_jpy === null) return percentDerived;
  return Math.max(percentDerived, stage.fee_fixed_jpy);
}

/**
 * Resolves the applicable cancellation fee stage at instant `at`, for a
 * reservation starting at `startsAt`. Handles `"unknown"` policies by
 * returning `{ policyKnown: false }` rather than throwing.
 */
export function resolvePolicyAt(
  policy: CancellationPolicyOrUnknown,
  startsAt: Temporal.Instant,
  at: Temporal.Instant,
): PolicyResolution {
  if (isUnknown(policy)) return { policyKnown: false };

  const stage = stageAt(policy.stages, startsAt, at);
  return {
    policyKnown: true,
    stage,
    feePercent: stage?.fee_percent ?? 0,
    feeFixedJpy: stage?.fee_fixed_jpy ?? null,
  };
}

/**
 * Finds the next instant at which the fee increases, for the §6 trigger-1
 * "24h before a boundary" notification. Returns `null` when there is no
 * further boundary (already inside the innermost band, or the policy is
 * unknown or has no stages).
 *
 * Standing exactly ON a boundary returns that same instant: the rate holds
 * through it and rises immediately after, so "the next change is now" is the
 * honest answer. The 24h window in notify/trigger.ts is half-open and ends at
 * the boundary, so this does not fire a notification at that instant.
 */
export function nextBoundary(
  policy: CancellationPolicyOrUnknown,
  startsAt: Temporal.Instant,
  at: Temporal.Instant,
): NextBoundary | null {
  if (isUnknown(policy)) return null;

  const currentStage = stageAt(policy.stages, startsAt, at);

  // A rate covers its own boundary OUTWARD, so a stage is left at the moment
  // its boundary is crossed going in: the next fee change is the CURRENT
  // stage's boundary, and what follows is the next stage in the
  // (farthest-first) array. 「7日前まで無料 → 3日前まで30%」 rises at 7日前, not
  // at 3日前.
  const reachedIndex = policy.stages.findIndex((s) =>
    Temporal.Instant.compare(at, boundaryInstant(startsAt, s.until_offset_hours)) <= 0
  );
  if (reachedIndex === -1) return null; // already inside the innermost band
  const leaving = policy.stages[reachedIndex];
  const candidate = policy.stages[reachedIndex + 1];
  if (leaving === undefined || candidate === undefined) return null;

  return {
    at: boundaryInstant(startsAt, leaving.until_offset_hours),
    fromStage: currentStage,
    toStage: candidate,
  };
}

/**
 * Estimates the JPY loss if cancelling right now (`at`) vs. if cancelling
 * right after the next fee boundary is crossed. `amountJpy` should be the
 * reservation's `amount_jpy`; if it is `null` (amount unknown), both
 * results are `null` since no concrete yen figure can be computed (SDD §6
 * trigger 1: the concrete-amount line is conditional on `amount_jpy` being
 * present).
 */
export function estimateLoss(
  policy: CancellationPolicyOrUnknown,
  startsAt: Temporal.Instant,
  amountJpy: number | null,
  at: Temporal.Instant,
): LossEstimate {
  if (isUnknown(policy)) {
    return { policyKnown: false, nowJpy: null, afterNextBoundaryJpy: null };
  }
  if (amountJpy === null) {
    return { policyKnown: true, nowJpy: null, afterNextBoundaryJpy: null };
  }

  const now = resolvePolicyAt(policy, startsAt, at);
  const nowJpy = now.policyKnown ? feeAmountJpy(now.stage, amountJpy) : null;

  const boundary = nextBoundary(policy, startsAt, at);
  const afterNextBoundaryJpy = boundary ? feeAmountJpy(boundary.toStage, amountJpy) : null;

  return { policyKnown: true, nowJpy, afterNextBoundaryJpy };
}

/**
 * The instant until which cancellation is free (for the "無料キャンセル:
 * ◯月◯日まで" one-liner, SDD §3.3). Returns `null` when the policy is
 * `"unknown"`, when it has no stages, or when every stage is fee-free (an
 * edge case where the policy structurally never charges anything).
 *
 * Convention: a free window is an explicit fee-free stage, so the deadline
 * is the boundary of the LAST such stage — everything from there outward is
 * free, and the next boundary inward starts charging. 「7日前まで無料 →
 * 3日前まで30%」 gives start−168h. Returns null when nothing is ever charged
 * (there is no deadline to warn about) and when the outermost stage already
 * charges (the policy charges from the outset, so there is no free window to
 * lose). The boundary instant itself is still free.
 */
export function freeCancellationDeadline(
  policy: CancellationPolicyOrUnknown,
  startsAt: Temporal.Instant,
): Temporal.Instant | null {
  if (isUnknown(policy)) return null;

  const charged = (s: PolicyStage) => s.fee_percent > 0 || (s.fee_fixed_jpy ?? 0) > 0;
  if (!policy.stages.some(charged)) return null;
  const lastFree = [...policy.stages].reverse().find((s) => !charged(s));
  if (lastFree === undefined) return null;

  return boundaryInstant(startsAt, lastFree.until_offset_hours);
}

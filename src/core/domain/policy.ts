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
 * SDD §3.3: "until_offset_hours: 予約開始の何時間前まで。例: 168 = 7日前"
 * and stages are stored farthest-first (descending `until_offset_hours`).
 * Each stage's fee is in effect from the moment its offset threshold is
 * reached (looking backward from `starts_at`) until the *next* (closer)
 * stage's threshold is reached. Concretely, define:
 *
 *   remainingHours = hours from `at` to `startsAt` (can be negative once
 *                    `at` is at or after `startsAt`)
 *
 * - If `remainingHours` is greater than the farthest stage's
 *   `until_offset_hours` (or there are no stages), cancellation is free:
 *   no stage applies yet (`stage: null`, 0 fee). This is the "無料キャンセル"
 *   window described in §3.3's UI summary line.
 * - Otherwise the applicable stage is the *last* stage (in the
 *   farthest-first array) whose `until_offset_hours >= remainingHours`.
 *   Because stages are fee-monotonic-non-decreasing as offset decreases,
 *   this is always the stage with the smallest `until_offset_hours` that
 *   still covers `remainingHours`.
 * - Boundary-exact convention: at the exact instant `remainingHours ===
 *   stage.until_offset_hours`, the **new** (that stage's, higher-or-equal)
 *   fee already applies — the comparison above uses `>=`, i.e. the
 *   boundary instant belongs to the stage it defines, not the previous
 *   (lower-fee) one. This matches "10日前ちょうど" being the instant the
 *   10-day stage begins.
 * - After `starts_at` (`remainingHours < 0`), the last-defined stage
 *   (closest to start, i.e. `until_offset_hours` closest to 0) continues to
 *   apply — there is no implicit "beyond 100%" stage. If the policy's last
 *   stage is `until_offset_hours: 0`, this is effectively "100% forever
 *   after start" as expected; a policy author who wants that must include
 *   such a stage explicitly. This function does not special-case "past
 *   start" beyond that.
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
    /** The stage in effect, or `null` if still in the free window before any stage applies. */
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

/** Hours from `at` to `startsAt` (positive before start, negative after). */
function remainingHours(startsAt: Temporal.Instant, at: Temporal.Instant): number {
  return at.until(startsAt, { largestUnit: "hours" }).total("hours");
}

/**
 * The stage in effect at `remainingHours` hours before `startsAt`, per the
 * boundary convention documented at the top of this module. Returns `null`
 * if no stage applies yet (free window).
 */
function stageAt(stages: PolicyStage[], hoursBefore: number): PolicyStage | null {
  let current: PolicyStage | null = null;
  for (const stage of stages) {
    if (hoursBefore <= stage.until_offset_hours) {
      current = stage;
    }
  }
  return current;
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

  const hoursBefore = remainingHours(startsAt, at);
  const stage = stageAt(policy.stages, hoursBefore);
  return {
    policyKnown: true,
    stage,
    feePercent: stage?.fee_percent ?? 0,
    feeFixedJpy: stage?.fee_fixed_jpy ?? null,
  };
}

/**
 * Finds the next instant at which the fee increases (the next stage
 * boundary strictly after `at`), for the §6 trigger-1 "24h before a
 * boundary" notification. Returns `null` when there is no further boundary
 * (already in/at the last stage, or the policy is unknown or has no
 * stages).
 */
export function nextBoundary(
  policy: CancellationPolicyOrUnknown,
  startsAt: Temporal.Instant,
  at: Temporal.Instant,
): NextBoundary | null {
  if (isUnknown(policy)) return null;

  const hoursBefore = remainingHours(startsAt, at);
  const currentStage = stageAt(policy.stages, hoursBefore);

  // Stages farther from start have larger until_offset_hours; the "next"
  // boundary (closer to start, strictly greater fee) is the stage with the
  // largest until_offset_hours that is still strictly less than
  // hoursBefore (i.e. not yet reached).
  let candidate: PolicyStage | null = null;
  for (const stage of policy.stages) {
    if (stage.until_offset_hours < hoursBefore) {
      if (candidate === null || stage.until_offset_hours > candidate.until_offset_hours) {
        candidate = stage;
      }
    }
  }
  if (candidate === null) return null;

  const boundaryInstant = startsAt.subtract({ hours: candidate.until_offset_hours });
  return { at: boundaryInstant, fromStage: currentStage, toStage: candidate };
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
 * Convention: stages only ever describe the fee schedule *from* their
 * boundary onward — the free window itself is implicit (the period before
 * the farthest stage's boundary, per `resolvePolicyAt`'s `stage: null`
 * case). So the deadline is the boundary of the first stage (farthest
 * first) whose fee is non-zero (by `fee_percent` or `fee_fixed_jpy`);
 * validation guarantees fees are monotonically non-decreasing, so once a
 * non-zero fee is found no earlier stage can undercut it. The boundary
 * instant itself is the first *charged* instant (matches the
 * boundary-exact convention in `resolvePolicyAt`), so cancellation is free
 * strictly before it.
 */
export function freeCancellationDeadline(
  policy: CancellationPolicyOrUnknown,
  startsAt: Temporal.Instant,
): Temporal.Instant | null {
  if (isUnknown(policy)) return null;

  const firstCharged = policy.stages.find(
    (stage) => stage.fee_percent > 0 || (stage.fee_fixed_jpy ?? 0) > 0,
  );
  if (firstCharged === undefined) return null;

  return startsAt.subtract({ hours: firstCharged.until_offset_hours });
}

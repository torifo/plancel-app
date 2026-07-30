import { assertEquals } from "jsr:@std/assert@1";
import type { CancellationPolicy } from "../../schema/mod.ts";
import {
  estimateLoss,
  freeCancellationDeadline,
  nextBoundary,
  resolvePolicyAt,
} from "../policy.ts";

const STARTS_AT = Temporal.Instant.from("2026-07-15T18:00:00Z");

// docs/design-review.html §02 / task 2.2 example: ¥8,000, 「7日前まで無料 →
// 3日前まで30% → 前日まで50% → 当日100%」. The free window is a stage of its
// own: before 2026-07-30 it was implied by the absence of one, which read a
// band out of step with the ledger and with what the parser produces.
const SDD_EXAMPLE_POLICY: CancellationPolicy = {
  stages: [
    { until_offset_hours: 168, fee_percent: 0, fee_fixed_jpy: null }, // 7 days: free
    { until_offset_hours: 72, fee_percent: 30, fee_fixed_jpy: null }, // 3 days
    { until_offset_hours: 24, fee_percent: 50, fee_fixed_jpy: null }, // 1 day
    { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null }, // 当日
  ],
};
const AMOUNT_JPY = 8000;

function hoursBefore(h: number): Temporal.Instant {
  return STARTS_AT.subtract({ hours: h });
}

Deno.test("resolvePolicyAt: the free window is the outermost stage, not a missing one", () => {
  const result = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, hoursBefore(240)); // 10 days out
  assertEquals(result, {
    policyKnown: true,
    stage: SDD_EXAMPLE_POLICY.stages[0] ?? null,
    feePercent: 0,
    feeFixedJpy: null,
  });
});

Deno.test("resolvePolicyAt: mid-stage (5 days out -> 30% stage)", () => {
  // 5日前 is inside 「3日前まで30%」: that rate covers 72h outward to 168h.
  const result = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, hoursBefore(120));
  assertEquals(result.policyKnown, true);
  if (result.policyKnown) {
    assertEquals(result.feePercent, 30);
    assertEquals(result.stage?.until_offset_hours, 72);
  }
});

Deno.test("resolvePolicyAt: last stage after starts_at (100% persists)", () => {
  const result = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, STARTS_AT.add({ hours: 5 }));
  assertEquals(result.policyKnown, true);
  if (result.policyKnown) {
    assertEquals(result.feePercent, 100);
  }
});

Deno.test("resolvePolicyAt: a boundary instant is the last one at its own rate", () => {
  // Exactly 168h before start: 「7日前まで無料」 means 7日前 itself is still free.
  const atBoundary = hoursBefore(168);
  const result = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, atBoundary);
  assertEquals(result.policyKnown, true);
  if (result.policyKnown) {
    assertEquals(result.stage?.until_offset_hours, 168);
    assertEquals(result.feePercent, 0);
  }

  // A second past it, the free window is over and 30% applies.
  const justInside = atBoundary.add({ seconds: 1 });
  const inside = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, justInside);
  assertEquals(inside.policyKnown, true);
  if (inside.policyKnown) assertEquals(inside.feePercent, 30);

  // Exactly 72h: 「3日前まで30%」 — the boundary still carries 30%, not 50%.
  const atSecondBoundary = hoursBefore(72);
  const second = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, atSecondBoundary);
  assertEquals(second.policyKnown, true);
  if (second.policyKnown) assertEquals(second.feePercent, 30);

  const justInsideSecond = atSecondBoundary.add({ seconds: 1 });
  const after = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, justInsideSecond);
  assertEquals(after.policyKnown, true);
  if (after.policyKnown) assertEquals(after.feePercent, 50);
});

Deno.test("resolvePolicyAt: unknown policy returns a clearly-typed unknown result", () => {
  const result = resolvePolicyAt("unknown", STARTS_AT, hoursBefore(240));
  assertEquals(result, { policyKnown: false });
});

Deno.test("resolvePolicyAt: empty stages policy is always free", () => {
  const result = resolvePolicyAt({ stages: [] }, STARTS_AT, hoursBefore(1));
  assertEquals(result, { policyKnown: true, stage: null, feePercent: 0, feeFixedJpy: null });
});

Deno.test("nextBoundary: from the free window points at the first charged stage", () => {
  // Free until 7日前, so the rise is AT 7日前 — the free stage's own boundary.
  const boundary = nextBoundary(SDD_EXAMPLE_POLICY, STARTS_AT, hoursBefore(240));
  assertEquals(boundary?.at.toString(), hoursBefore(168).toString());
  assertEquals(boundary?.fromStage?.fee_percent, 0);
  assertEquals(boundary?.toStage.fee_percent, 30);
});

Deno.test("nextBoundary: mid-schedule points at the next (closer) stage", () => {
  const boundary = nextBoundary(SDD_EXAMPLE_POLICY, STARTS_AT, hoursBefore(120)); // in 30% stage
  assertEquals(boundary?.at.toString(), hoursBefore(72).toString());
  assertEquals(boundary?.toStage.fee_percent, 50);
  assertEquals(boundary?.fromStage?.fee_percent, 30);
});

Deno.test("nextBoundary: null once in the last stage", () => {
  const boundary = nextBoundary(SDD_EXAMPLE_POLICY, STARTS_AT, hoursBefore(12)); // in 100% stage
  assertEquals(boundary, null);
});

Deno.test("nextBoundary: unknown policy returns null", () => {
  assertEquals(nextBoundary("unknown", STARTS_AT, hoursBefore(240)), null);
});

Deno.test("estimateLoss: SDD example numbers in the free window (free now, ¥2,400 after boundary)", () => {
  const result = estimateLoss(SDD_EXAMPLE_POLICY, STARTS_AT, AMOUNT_JPY, hoursBefore(192)); // 8 days out, still >168h
  assertEquals(result, { policyKnown: true, nowJpy: 0, afterNextBoundaryJpy: 2400 });
});

Deno.test("estimateLoss: in the 30% stage, now vs. after next (50%) boundary", () => {
  const result = estimateLoss(SDD_EXAMPLE_POLICY, STARTS_AT, AMOUNT_JPY, hoursBefore(100)); // between 168h and 72h
  assertEquals(result, { policyKnown: true, nowJpy: 2400, afterNextBoundaryJpy: 4000 });
});

Deno.test("estimateLoss: amountJpy null yields null loss figures", () => {
  const result = estimateLoss(SDD_EXAMPLE_POLICY, STARTS_AT, null, hoursBefore(100));
  assertEquals(result, { policyKnown: true, nowJpy: null, afterNextBoundaryJpy: null });
});

Deno.test("estimateLoss: unknown policy yields policyKnown false and null figures", () => {
  const result = estimateLoss("unknown", STARTS_AT, AMOUNT_JPY, hoursBefore(100));
  assertEquals(result, { policyKnown: false, nowJpy: null, afterNextBoundaryJpy: null });
});

// Fixed-fee policy: 「48時間前まで無料、以降 10% または ¥3,000」. The percent
// component is dominated by the fixed floor (documented
// max(percentDerived, fee_fixed_jpy) convention).
const FIXED_FEE_POLICY: CancellationPolicy = {
  stages: [
    { until_offset_hours: 48, fee_percent: 0, fee_fixed_jpy: null },
    { until_offset_hours: 0, fee_percent: 10, fee_fixed_jpy: 3000 },
  ],
};

Deno.test("estimateLoss: fixed fee dominates a smaller percent-derived amount", () => {
  const result = estimateLoss(FIXED_FEE_POLICY, STARTS_AT, AMOUNT_JPY, hoursBefore(1));
  // percent-derived = 8000 * 10% = 800; fixed = 3000 -> max = 3000
  assertEquals(result, { policyKnown: true, nowJpy: 3000, afterNextBoundaryJpy: null });
});

Deno.test("resolvePolicyAt: fixed fee stage reports both percent and fixed", () => {
  const result = resolvePolicyAt(FIXED_FEE_POLICY, STARTS_AT, hoursBefore(1));
  assertEquals(result, {
    policyKnown: true,
    stage: FIXED_FEE_POLICY.stages[1] ?? null,
    feePercent: 10,
    feeFixedJpy: 3000,
  });
});

// Mixed policy: percent-only farthest stage, then a fixed-fee-dominant
// closer stage.
const MIXED_POLICY: CancellationPolicy = {
  stages: [
    { until_offset_hours: 168, fee_percent: 0, fee_fixed_jpy: null },
    { until_offset_hours: 24, fee_percent: 20, fee_fixed_jpy: null },
    { until_offset_hours: 0, fee_percent: 20, fee_fixed_jpy: 5000 },
  ],
};

Deno.test("estimateLoss: mixed policy picks fixed floor only where defined", () => {
  const farStage = estimateLoss(MIXED_POLICY, STARTS_AT, AMOUNT_JPY, hoursBefore(100));
  assertEquals(farStage, { policyKnown: true, nowJpy: 1600, afterNextBoundaryJpy: 5000 });

  const closeStage = estimateLoss(MIXED_POLICY, STARTS_AT, AMOUNT_JPY, hoursBefore(1));
  // percent-derived = 1600; fixed = 5000 -> max = 5000
  assertEquals(closeStage, { policyKnown: true, nowJpy: 5000, afterNextBoundaryJpy: null });
});

Deno.test("freeCancellationDeadline: SDD example deadline is 168h (7 days) before start", () => {
  const deadline = freeCancellationDeadline(SDD_EXAMPLE_POLICY, STARTS_AT);
  assertEquals(deadline?.toString(), hoursBefore(168).toString());
});

Deno.test("freeCancellationDeadline: unknown policy is null", () => {
  assertEquals(freeCancellationDeadline("unknown", STARTS_AT), null);
});

Deno.test("freeCancellationDeadline: the last fee-free stage is the deadline", () => {
  // FIXED_FEE_POLICY is free down to 48h and charged inside it, so 48h before
  // the start is the last free instant.
  assertEquals(
    freeCancellationDeadline(FIXED_FEE_POLICY, STARTS_AT)?.toString(),
    hoursBefore(48).toString(),
  );
});

Deno.test("freeCancellationDeadline: empty stages policy is null", () => {
  assertEquals(freeCancellationDeadline({ stages: [] }, STARTS_AT), null);
});

Deno.test("freeCancellationDeadline: policy whose every stage is fee-free is null (never charges)", () => {
  const allFree: CancellationPolicy = {
    stages: [{ until_offset_hours: 24, fee_percent: 0, fee_fixed_jpy: null }],
  };
  assertEquals(freeCancellationDeadline(allFree, STARTS_AT), null);
});

// 期限跨ぎ (crossing a deadline) with VirtualClock: advance a virtual clock
// across a stage boundary and confirm the resolved fee changes.
Deno.test("VirtualClock crossing the 72h boundary changes the resolved stage", async () => {
  const { VirtualClock } = await import("../../clock/mod.ts");
  const clock = new VirtualClock(hoursBefore(73));

  const before = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, clock.now());
  assertEquals(before.policyKnown, true);
  if (before.policyKnown) assertEquals(before.feePercent, 30);

  clock.advance("PT2H"); // now 71h before start, past the 72h boundary

  const after = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, clock.now());
  assertEquals(after.policyKnown, true);
  if (after.policyKnown) assertEquals(after.feePercent, 50);
});

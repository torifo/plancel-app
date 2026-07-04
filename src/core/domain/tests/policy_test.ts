import { assertEquals } from "jsr:@std/assert@1";
import type { CancellationPolicy } from "../../schema/mod.ts";
import {
  estimateLoss,
  freeCancellationDeadline,
  nextBoundary,
  resolvePolicyAt,
} from "../policy.ts";

const STARTS_AT = Temporal.Instant.from("2026-07-15T18:00:00Z");

// docs/design-review.html §02 / task 2.2 example: ¥8,000, free until 7 days
// out (the free window is implicit — no stage — before the farthest
// stage's boundary), then 30% until 3 days out, 50% until 1 day out, 100%
// from 1 day out onward.
const SDD_EXAMPLE_POLICY: CancellationPolicy = {
  stages: [
    { until_offset_hours: 168, fee_percent: 30, fee_fixed_jpy: null }, // 7 days
    { until_offset_hours: 72, fee_percent: 50, fee_fixed_jpy: null }, // 3 days
    { until_offset_hours: 24, fee_percent: 100, fee_fixed_jpy: null }, // 1 day
  ],
};
const AMOUNT_JPY = 8000;

function hoursBefore(h: number): Temporal.Instant {
  return STARTS_AT.subtract({ hours: h });
}

Deno.test("resolvePolicyAt: free window before the farthest stage", () => {
  const result = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, hoursBefore(240)); // 10 days out
  assertEquals(result, { policyKnown: true, stage: null, feePercent: 0, feeFixedJpy: null });
});

Deno.test("resolvePolicyAt: mid-stage (5 days out -> 30% stage)", () => {
  const result = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, hoursBefore(120));
  assertEquals(result.policyKnown, true);
  if (result.policyKnown) {
    assertEquals(result.feePercent, 30);
    assertEquals(result.stage?.until_offset_hours, 168);
  }
});

Deno.test("resolvePolicyAt: last stage after starts_at (100% persists)", () => {
  const result = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, STARTS_AT.add({ hours: 5 }));
  assertEquals(result.policyKnown, true);
  if (result.policyKnown) {
    assertEquals(result.feePercent, 100);
  }
});

Deno.test("resolvePolicyAt: boundary-exact instant belongs to the new (entered) stage", () => {
  // Exactly 168h (7 days) before start: convention says the 168h stage's
  // fee (30%) already applies at this instant, not the free window before it.
  const atBoundary = hoursBefore(168);
  const result = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, atBoundary);
  assertEquals(result.policyKnown, true);
  if (result.policyKnown) {
    assertEquals(result.stage?.until_offset_hours, 168);
    assertEquals(result.feePercent, 30);
  }

  // Exactly 72h (3 days) before start: the 50% stage boundary itself already
  // carries the 50% fee (not the preceding 30% stage).
  const atSecondBoundary = hoursBefore(72);
  const second = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, atSecondBoundary);
  assertEquals(second.policyKnown, true);
  if (second.policyKnown) {
    assertEquals(second.feePercent, 50);
  }

  // One second before the 72h boundary: still the previous (30%) stage.
  const justBefore = atSecondBoundary.subtract({ seconds: 1 });
  const before = resolvePolicyAt(SDD_EXAMPLE_POLICY, STARTS_AT, justBefore);
  assertEquals(before.policyKnown, true);
  if (before.policyKnown) {
    assertEquals(before.feePercent, 30);
  }
});

Deno.test("resolvePolicyAt: unknown policy returns a clearly-typed unknown result", () => {
  const result = resolvePolicyAt("unknown", STARTS_AT, hoursBefore(240));
  assertEquals(result, { policyKnown: false });
});

Deno.test("resolvePolicyAt: empty stages policy is always free", () => {
  const result = resolvePolicyAt({ stages: [] }, STARTS_AT, hoursBefore(1));
  assertEquals(result, { policyKnown: true, stage: null, feePercent: 0, feeFixedJpy: null });
});

Deno.test("nextBoundary: from free window points at the farthest stage", () => {
  const boundary = nextBoundary(SDD_EXAMPLE_POLICY, STARTS_AT, hoursBefore(240));
  assertEquals(boundary?.at.toString(), hoursBefore(168).toString());
  assertEquals(boundary?.fromStage, null);
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

// Fixed-fee policy: a flat ¥3,000 cancellation fee from 48h out, with a
// smaller percent-derived component that should be dominated by the fixed
// floor (documented max(percentDerived, fee_fixed_jpy) convention).
const FIXED_FEE_POLICY: CancellationPolicy = {
  stages: [
    { until_offset_hours: 48, fee_percent: 10, fee_fixed_jpy: 3000 },
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
    stage: FIXED_FEE_POLICY.stages[0] ?? null,
    feePercent: 10,
    feeFixedJpy: 3000,
  });
});

// Mixed policy: percent-only farthest stage, then a fixed-fee-dominant
// closer stage.
const MIXED_POLICY: CancellationPolicy = {
  stages: [
    { until_offset_hours: 168, fee_percent: 20, fee_fixed_jpy: null },
    { until_offset_hours: 24, fee_percent: 20, fee_fixed_jpy: 5000 },
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

Deno.test("freeCancellationDeadline: single fixed-fee stage deadline is its own boundary", () => {
  // FIXED_FEE_POLICY has one stage (48h, 10%/¥3000) — free before it, charged
  // from its boundary onward, so the deadline is that boundary itself.
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

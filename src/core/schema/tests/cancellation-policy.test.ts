import { assertEquals } from "jsr:@std/assert@1";
import {
  cancellationPolicyOrUnknownSchema,
  cancellationPolicySchema,
} from "../cancellation-policy.ts";
import { validPolicy } from "./fixtures.ts";

Deno.test("cancellationPolicySchema accepts a valid staged policy", () => {
  const result = cancellationPolicySchema.safeParse(validPolicy);
  assertEquals(result.success, true);
});

Deno.test("cancellationPolicySchema accepts an empty stages array", () => {
  const result = cancellationPolicySchema.safeParse({ stages: [] });
  assertEquals(result.success, true);
});

Deno.test("cancellationPolicySchema rejects non-descending until_offset_hours", () => {
  const result = cancellationPolicySchema.safeParse({
    stages: [
      { until_offset_hours: 24, fee_percent: 0, fee_fixed_jpy: null },
      { until_offset_hours: 48, fee_percent: 50, fee_fixed_jpy: null },
    ],
  });
  assertEquals(result.success, false);
});

Deno.test("cancellationPolicySchema rejects equal (non-strictly-descending) offsets", () => {
  const result = cancellationPolicySchema.safeParse({
    stages: [
      { until_offset_hours: 24, fee_percent: 0, fee_fixed_jpy: null },
      { until_offset_hours: 24, fee_percent: 50, fee_fixed_jpy: null },
    ],
  });
  assertEquals(result.success, false);
});

Deno.test("cancellationPolicySchema rejects decreasing fee_percent as offset decreases", () => {
  const result = cancellationPolicySchema.safeParse({
    stages: [
      { until_offset_hours: 168, fee_percent: 50, fee_fixed_jpy: null },
      { until_offset_hours: 24, fee_percent: 10, fee_fixed_jpy: null },
    ],
  });
  assertEquals(result.success, false);
});

Deno.test("cancellationPolicySchema rejects decreasing fee_fixed_jpy as offset decreases", () => {
  const result = cancellationPolicySchema.safeParse({
    stages: [
      { until_offset_hours: 168, fee_percent: 0, fee_fixed_jpy: 5000 },
      { until_offset_hours: 24, fee_percent: 0, fee_fixed_jpy: 1000 },
    ],
  });
  assertEquals(result.success, false);
});

Deno.test("cancellationPolicySchema rejects fee_percent above 100", () => {
  const result = cancellationPolicySchema.safeParse({
    stages: [{ until_offset_hours: 24, fee_percent: 150, fee_fixed_jpy: null }],
  });
  assertEquals(result.success, false);
});

Deno.test("cancellationPolicySchema rejects fee_percent below 0", () => {
  const result = cancellationPolicySchema.safeParse({
    stages: [{ until_offset_hours: 24, fee_percent: -1, fee_fixed_jpy: null }],
  });
  assertEquals(result.success, false);
});

Deno.test("cancellationPolicyOrUnknownSchema accepts the literal 'unknown'", () => {
  const result = cancellationPolicyOrUnknownSchema.safeParse("unknown");
  assertEquals(result.success, true);
});

Deno.test("cancellationPolicyOrUnknownSchema accepts a valid policy object too", () => {
  const result = cancellationPolicyOrUnknownSchema.safeParse(validPolicy);
  assertEquals(result.success, true);
});

Deno.test("cancellationPolicyOrUnknownSchema rejects other strings", () => {
  const result = cancellationPolicyOrUnknownSchema.safeParse("nope");
  assertEquals(result.success, false);
});

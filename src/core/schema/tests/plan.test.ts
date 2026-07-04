import { assertEquals } from "jsr:@std/assert@1";
import { planSchema } from "../plan.ts";
import { validPlan } from "./fixtures.ts";

Deno.test("planSchema accepts a valid Plan", () => {
  const result = planSchema.safeParse(validPlan);
  assertEquals(result.success, true);
});

Deno.test("planSchema rejects bad status", () => {
  const result = planSchema.safeParse({ ...validPlan, status: "archived" });
  assertEquals(result.success, false);
});

Deno.test("planSchema rejects missing required field (confirm_quota)", () => {
  const { confirm_quota: _q, ...rest } = validPlan;
  const result = planSchema.safeParse(rest);
  assertEquals(result.success, false);
});

Deno.test("planSchema rejects confirm_quota below 1", () => {
  const result = planSchema.safeParse({ ...validPlan, confirm_quota: 0 });
  assertEquals(result.success, false);
});

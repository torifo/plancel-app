import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import type { Reservation } from "../../core/schema/mod.ts";
import { validateParsedOutput } from "../validate.ts";

const NOW = new VirtualClock("2026-07-04T00:00:00Z");

Deno.test("validateParsedOutput: null output fails with no output error", () => {
  const result = validateParsedOutput(null, NOW);
  assertEquals(result.ok, false);
  assertEquals(result.errors, ["no output produced"]);
});

Deno.test("validateParsedOutput: missing service_name and starts_at fails", () => {
  const result = validateParsedOutput({}, NOW);
  assertEquals(result.ok, false);
  assertEquals(result.errors.includes("missing required field: service_name"), true);
  assertEquals(result.errors.includes("missing required field: starts_at"), true);
});

Deno.test("validateParsedOutput: minimal valid output passes", () => {
  const result = validateParsedOutput(
    { service_name: "○○旅館", starts_at: "2026-08-01T15:00:00Z" },
    NOW,
  );
  assertEquals(result.ok, true);
  assertEquals(result.errors, []);
  assertEquals(result.warnings, []);
});

Deno.test("validateParsedOutput: past starts_at is a warning, not a failure", () => {
  const result = validateParsedOutput(
    { service_name: "○○旅館", starts_at: "2026-01-01T00:00:00Z" },
    NOW,
  );
  assertEquals(result.ok, true);
  assertEquals(result.warnings, ["starts_at is in the past; requires confirmation"]);
});

Deno.test("validateParsedOutput: negative amount_jpy fails", () => {
  const result = validateParsedOutput(
    { service_name: "○○", starts_at: "2026-08-01T15:00:00Z", amount_jpy: -100 },
    NOW,
  );
  assertEquals(result.ok, false);
  assertEquals(result.errors.includes("amount_jpy must be >= 0"), true);
});

Deno.test("validateParsedOutput: cancellation stage with negative until_offset_hours fails", () => {
  const output: Partial<Reservation> = {
    service_name: "○○",
    starts_at: "2026-08-01T15:00:00Z",
    cancellation_policy: {
      stages: [{ until_offset_hours: -1, fee_percent: 100, fee_fixed_jpy: null }],
    },
  };
  const result = validateParsedOutput(output, NOW);
  assertEquals(result.ok, false);
  assertEquals(
    result.errors.some((e) => e.includes("cancellation deadline exceeds starts_at")),
    true,
  );
});

Deno.test("validateParsedOutput: cancellation_policy 'unknown' is always accepted", () => {
  const result = validateParsedOutput(
    { service_name: "○○", starts_at: "2026-08-01T15:00:00Z", cancellation_policy: "unknown" },
    NOW,
  );
  assertEquals(result.ok, true);
});

Deno.test("validateParsedOutput: non-monotonic cancellation stages fail (reuses schema rule)", () => {
  const output: Partial<Reservation> = {
    service_name: "○○",
    starts_at: "2026-08-01T15:00:00Z",
    cancellation_policy: {
      stages: [
        { until_offset_hours: 24, fee_percent: 50, fee_fixed_jpy: null },
        { until_offset_hours: 1, fee_percent: 10, fee_fixed_jpy: null },
      ],
    },
  };
  const result = validateParsedOutput(output, NOW);
  assertEquals(result.ok, false);
});

Deno.test("validateParsedOutput: starts_at more than 2 years ahead warns (year likely misread)", () => {
  const clock = new VirtualClock("2026-07-11T00:00:00Z");
  const result = validateParsedOutput(
    { service_name: "宿", starts_at: "2029-01-15T15:00:00+09:00" },
    clock,
  );
  assertEquals(result.ok, true);
  assertEquals(result.warnings, ["starts_at is more than 2 years ahead; year may be misread"]);
});

Deno.test("validateParsedOutput: a normal future starts_at produces no year warning", () => {
  const clock = new VirtualClock("2026-07-11T00:00:00Z");
  const result = validateParsedOutput(
    { service_name: "宿", starts_at: "2027-01-15T15:00:00+09:00" },
    clock,
  );
  assertEquals(result.ok, true);
  assertEquals(result.warnings, []);
});

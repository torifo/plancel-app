/**
 * MVP-1 end-to-end acceptance test (Task 4.2, design.md Testing Strategy).
 *
 * Runs the exact same scenario as `deno task scenario`
 * (`src/cli/scenario.ts`'s `runScenario`) but asserts on the structured
 * `ScenarioResult` instead of just eyeballing printed output — this is the
 * "1コマンドで再現できるE2Eシナリオ" from docs/SDD.md §10.1 / §10.5, wired
 * into `deno task test` so it runs in CI like any other test.
 *
 * Zero external connections: `runScenario` only touches an in-memory Store,
 * a VirtualClock, and a ConsoleNotifier whose `write` sink is captured here
 * instead of going to real stdout — no network permission is requested or
 * needed (matches `deno task test`'s existing permission set).
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { runScenario } from "../../cli/scenario.ts";

Deno.test("mvp1 scenario: seed -> confirm -> +3 days -> preview", async () => {
  const lines: string[] = [];
  const result = await runScenario(undefined, (line) => lines.push(line));

  // --- confirm side effects ---
  assert(result.siblingCancelled, "sibling ryokan should auto-move to to_cancel");
  assert(
    result.planSettledMessage.includes("残り"),
    `plan_settled message should report the remaining to_cancel count, got: ${result.planSettledMessage}`,
  );

  // --- boundary notification carries a concrete ¥ loss ---
  assert(result.feeBoundaryMessages.length > 0, "expected at least one fee_boundary_24h message");
  assert(
    result.feeBoundaryMessages.some((m) => /¥[\d,]+/.test(m)),
    `expected a fee_boundary_24h message with a concrete ¥ amount, got: ${
      JSON.stringify(result.feeBoundaryMessages)
    }`,
  );

  // --- unknown-policy digest appears in the 7-day preview ---
  const digest = result.preview.find((n) => n.trigger === "policy_unknown_digest");
  assert(digest !== undefined, "expected a policy_unknown_digest in the preview");
  assert(
    digest.reservation_ids !== undefined && digest.reservation_ids.length >= 2,
    "expected the digest to aggregate at least the unknown-policy dinner candidate and the shinkansen",
  );

  // --- day-of reminder appears within the preview horizon ---
  const reminder = result.preview.find((n) => n.trigger === "day_of_reminder");
  assert(reminder !== undefined, "expected a day_of_reminder in the 7-day preview");

  // --- the preview is chronologically sorted (trigger.ts's contract) ---
  const fireAts = result.preview.map((n) => n.fire_at);
  const sorted = [...fireAts].sort((a, b) => a.localeCompare(b));
  assertEquals(fireAts, sorted, "preview notifications should be sorted by fire_at");

  // --- the scenario's own progress log reached the terminal OK line ---
  assert(
    lines.some((l) => l.includes("scenario OK")),
    "expected the scenario's progress log to reach 'scenario OK'",
  );
});

Deno.test("mvp1 scenario: is deterministic across runs (no system clock/randomness leak)", async () => {
  const a = await runScenario();
  const b = await runScenario();

  assertEquals(a.clockAfterAdvance, b.clockAfterAdvance);
  assertEquals(a.planSettledMessage, b.planSettledMessage);
  assertEquals(a.feeBoundaryMessages, b.feeBoundaryMessages);
  assertEquals(
    a.preview.map((n) => ({ trigger: n.trigger, fire_at: n.fire_at, message: n.message })),
    b.preview.map((n) => ({ trigger: n.trigger, fire_at: n.fire_at, message: n.message })),
  );
});

/**
 * scenario — `deno task scenario` (Task 4.2, design.md Testing Strategy /
 * docs/SDD.md §10.1 "3日進めたら何が起きるか").
 *
 * The MVP-1 acceptance scenario, runnable end to end in one command and
 * doubling as an executable acceptance check (exits non-zero on any
 * assertion failure): fresh InMemoryStore + VirtualClock at `base` → seed
 * fixtures → confirm 「山海の宿 花結び」 → assert the sibling ryokan
 * auto-moved to `to_cancel` and a `plan_settled` notification landed on the
 * Outbox → advance the clock `P3D` (crossing the 宿 policy's 24h/50% fee
 * boundary, see fixtures/seed.json's doc comment) → run one cron tick and
 * print what fired → preview the next 7 days → print a human-readable
 * timeline.
 *
 * Zero external connections: InMemoryStore + VirtualClock + ConsoleNotifier
 * only (design.md: "MVP-1 の全テストは外部サービス接続ゼロで完結").
 * `src/e2e/tests/mvp1_test.ts` runs the same steps as a `Deno.test`.
 */
import { InMemoryStore } from "../core/store/mod.ts";
import { VirtualClock } from "../core/clock/mod.ts";
import { ulid } from "../lib/ulid.ts";
import { confirm } from "../core/domain/mod.ts";
import { append } from "../core/eventlog/mod.ts";
import { ConsoleNotifier, onEventsAppended, previewNotifications } from "../notify/mod.ts";
import { runTick } from "../cron/tick.ts";
import {
  DEFAULT_SEED_BASE,
  materializeFixtures,
  persistEntities,
  readFixtureFile,
} from "./seed_lib.ts";

/** Thrown when a scenario acceptance check fails — distinguishes it from a bug in the harness itself. */
export class ScenarioAssertionError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ScenarioAssertionError(message);
}

/** Result of `runScenario`, for programmatic callers (the e2e test). */
export interface ScenarioResult {
  base: string;
  clockAfterAdvance: string;
  siblingCancelled: boolean;
  planSettledMessage: string;
  feeBoundaryMessages: string[];
  preview: ReturnType<typeof previewNotifications>;
}

/**
 * Runs the full scenario against a fresh in-memory store, printing a
 * progress/assertion log to stdout via `log` (default `console.log`).
 * Throws `ScenarioAssertionError` (never exits the process itself) on any
 * failed acceptance check, so callers (CLI entrypoint, e2e test) each decide
 * how to react.
 */
export async function runScenario(
  base: string = DEFAULT_SEED_BASE,
  log: (line: string) => void = console.log,
): Promise<ScenarioResult> {
  const store = new InMemoryStore();
  const clock = new VirtualClock(base);
  const ids = { newUlid: () => ulid() };

  log(`=== plancel scenario — base=${base} ===\n`);

  // 1. Seed.
  const fixture = await readFixtureFile();
  const entities = materializeFixtures(fixture, base, ids);
  await persistEntities(store, clock, ids, entities);
  log(
    `[seed] events=${entities.events.length} plans=${entities.plans.length} ` +
      `reservations=${entities.reservations.length}`,
  );

  const ryokanAId = entities.idsByKey.get("res_ryokan_a");
  const ryokanBId = entities.idsByKey.get("res_ryokan_b");
  const planYadoId = entities.idsByKey.get("pl_yado");
  assert(ryokanAId !== undefined, "fixture missing res_ryokan_a");
  assert(ryokanBId !== undefined, "fixture missing res_ryokan_b");
  assert(planYadoId !== undefined, "fixture missing pl_yado");

  // 2. confirm 「山海の宿 花結び」.
  const reservation = await store.getReservation(ryokanAId);
  assert(reservation !== null, "seeded reservation res_ryokan_a not found");
  const plan = await store.getPlan(planYadoId);
  assert(plan !== null, "seeded plan pl_yado not found");
  const planReservations = await store.listReservationsByPlan(planYadoId);

  const outcome = confirm(
    { reservation, plan, planReservations },
    clock,
    { newId: () => ulid(), correlationId: "scenario:confirm" },
  );
  if (!outcome.ok) {
    throw new ScenarioAssertionError(`confirm rejected: ${outcome.error.message}`);
  }

  await append(store, outcome.events);
  for (const r of outcome.updated.reservations) await store.putReservation(r);
  if (outcome.updated.plan !== undefined) await store.putPlan(outcome.updated.plan);

  const updatedById = new Map(outcome.updated.reservations.map((r) => [r.id, r] as const));
  const snapshot = planReservations.map((r) => updatedById.get(r.id) ?? r);
  await onEventsAppended(store, outcome.events, { reservations: snapshot }, clock);

  log(`[confirm] 山海の宿 花結び (${ryokanAId}) confirmed.`);

  // 3. Assert side effects.
  const siblingAfter = await store.getReservation(ryokanBId);
  assert(siblingAfter !== null, "sibling res_ryokan_b vanished");
  assert(
    siblingAfter.status === "to_cancel",
    `expected sibling 湖畔の湯宿 蛍 to be to_cancel, got "${siblingAfter.status}"`,
  );
  log(`[assert] sibling 湖畔の湯宿 蛍 → to_cancel: OK`);

  const settledPlan = await store.getPlan(planYadoId);
  assert(settledPlan?.status === "settled", "plan 8/1の宿 did not settle");
  log(`[assert] plan 8/1の宿 → settled: OK`);

  const outboxAfterConfirm = await store.listOutboxEntries();
  const planSettledEntry = outboxAfterConfirm.find((e) => e.trigger === "plan_settled");
  assert(planSettledEntry !== undefined, "no plan_settled notification enqueued");
  log(`[assert] Outbox got plan_settled notification: OK ("${planSettledEntry.message}")`);

  // 4. Advance the clock 3 days (through the 宿 policy boundary).
  clock.advance("P3D");
  const clockAfterAdvance = clock.now().toString({ smallestUnit: "millisecond" });
  log(`\n[clock] advanced P3D → now=${clockAfterAdvance}`);

  // 5. Run one cron tick and print what fired.
  const notifier = new ConsoleNotifier({ write: log });
  const tickResult = await runTick({ store, clock, notifier });
  log(
    `[tick] computed=${tickResult.computed} enqueued=${tickResult.enqueued} ` +
      `deduped=${tickResult.deduped} delivered=${tickResult.delivered} ` +
      `failed=${tickResult.failed} retriable=${tickResult.retriable}`,
  );

  const deliveredFeeBoundary = (await store.listOutboxEntries({ status: "delivered" }))
    .filter((e) => e.trigger === "fee_boundary_24h");
  assert(
    deliveredFeeBoundary.length > 0,
    "expected the ryokan's fee_boundary_24h notification to have fired by +3 days",
  );
  log(`[assert] fee_boundary_24h fired at +3 days: OK`);
  for (const e of deliveredFeeBoundary) log(`  -> ${e.message}`);

  // 6. Preview 7 days ahead.
  const [reservations, plans] = await Promise.all([
    store.listReservations(),
    store.listPlans(),
  ]);
  const preview = previewNotifications({ reservations, plans }, clock.now());

  assert(
    preview.some((n) => n.trigger === "policy_unknown_digest"),
    "expected a policy_unknown_digest notification within the 7-day preview",
  );
  assert(
    preview.some((n) => n.trigger === "day_of_reminder"),
    "expected a day_of_reminder notification within the 7-day preview",
  );
  log(`\n[assert] policy_unknown_digest present in 7-day preview: OK`);
  log(`[assert] day_of_reminder present in 7-day preview: OK`);

  log(`\n=== 今後7日間の通知タイムライン (${preview.length}件) ===`);
  for (const n of preview) {
    log(`  ${n.fire_at}  [${n.trigger}]  ${n.message}`);
  }

  log("\n=== scenario OK ===");

  return {
    base,
    clockAfterAdvance,
    siblingCancelled: siblingAfter.status === "to_cancel",
    planSettledMessage: planSettledEntry.message,
    feeBoundaryMessages: deliveredFeeBoundary.map((e) => e.message),
    preview,
  };
}

if (import.meta.main) {
  const baseArgIdx = Deno.args.indexOf("--base");
  const base = baseArgIdx >= 0 ? Deno.args[baseArgIdx + 1] : undefined;
  try {
    await runScenario(base);
  } catch (err) {
    console.error(`\nscenario FAILED: ${err instanceof Error ? err.message : String(err)}`);
    Deno.exit(1);
  }
}

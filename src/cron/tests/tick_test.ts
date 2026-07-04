import { assertEquals } from "jsr:@std/assert@1";
import type { CancellationPolicy, Reservation } from "../../core/schema/mod.ts";
import { VirtualClock } from "../../core/clock/mod.ts";
import { InMemoryStore } from "../../core/store/mod.ts";
import type { Notifier } from "../../notify/mod.ts";
import type { PendingNotification } from "../../notify/mod.ts";
import { runTick } from "../tick.ts";

// Same example policy/shape as notify/tests/trigger_test.ts (SDD §6 example).
const STARTS_AT = "2026-07-15T18:00:00.000Z";
const EXAMPLE_POLICY: CancellationPolicy = {
  stages: [
    { until_offset_hours: 168, fee_percent: 30, fee_fixed_jpy: null },
    { until_offset_hours: 72, fee_percent: 50, fee_fixed_jpy: null },
    { until_offset_hours: 24, fee_percent: 100, fee_fixed_jpy: null },
  ],
};

function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: "01H0000000000000000000TEST",
    plan_id: null,
    event_id: null,
    service_name: "テストレストラン",
    provider: null,
    starts_at: STARTS_AT,
    ends_at: null,
    location: null,
    amount_jpy: 8000,
    status: "candidate",
    cancellation_policy: EXAMPLE_POLICY,
    policy_template_id: null,
    source: "mcp",
    raw_input_ref: null,
    notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Captures delivered notifications instead of touching stdout. */
class CapturingNotifier implements Notifier {
  delivered: PendingNotification[] = [];
  deliver(n: PendingNotification): Promise<void> {
    this.delivered.push(n);
    return Promise.resolve();
  }
}

Deno.test("runTick: computes, enqueues, and delivers a due fee-boundary notification", async () => {
  const store = new InMemoryStore();
  await store.putReservation(reservation());
  // 168h boundary is 2026-07-08T18:00Z; its 24h window opens 2026-07-07T18:00Z.
  const clock = new VirtualClock("2026-07-08T00:00:00.000Z");
  const notifier = new CapturingNotifier();

  const result = await runTick({ store, clock, notifier });

  assertEquals(result, {
    computed: 1,
    enqueued: 1,
    deduped: 0,
    delivered: 1,
    failed: 0,
    retriable: 0,
  });
  assertEquals(notifier.delivered.length, 1);
  assertEquals(notifier.delivered[0]?.trigger, "fee_boundary_24h");
});

Deno.test("runTick: a second tick in the same window dedupes and does not redeliver", async () => {
  const store = new InMemoryStore();
  await store.putReservation(reservation());
  const clock = new VirtualClock("2026-07-08T00:00:00.000Z");
  const notifier = new CapturingNotifier();

  await runTick({ store, clock, notifier });
  const second = await runTick({ store, clock, notifier });

  assertEquals(second, {
    computed: 1,
    enqueued: 0,
    deduped: 1,
    delivered: 0,
    failed: 0,
    retriable: 0,
  });
  // Still only the one delivery from the first tick.
  assertEquals(notifier.delivered.length, 1);
});

Deno.test("runTick: an empty store produces an all-zero result", async () => {
  const store = new InMemoryStore();
  const clock = new VirtualClock("2026-07-08T00:00:00.000Z");
  const notifier = new CapturingNotifier();

  const result = await runTick({ store, clock, notifier });

  assertEquals(result, {
    computed: 0,
    enqueued: 0,
    deduped: 0,
    delivered: 0,
    failed: 0,
    retriable: 0,
  });
});

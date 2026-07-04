import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { VirtualClock } from "../../core/clock/mod.ts";
import { confirm, type TransitionContext, type TransitionIds } from "../../core/domain/mod.ts";
import { append } from "../../core/eventlog/mod.ts";
import { InMemoryStore } from "../../core/store/in-memory-store.ts";
import { ulid } from "../../lib/ulid.ts";
import { ConsoleNotifier } from "../console-notifier.ts";
import type { Notifier } from "../notifier.ts";
import { Outbox } from "../outbox.ts";
import { onEventsAppended } from "../subscribe.ts";
import type { PendingNotification } from "../types.ts";
import type { Plan, Reservation } from "../../core/schema/mod.ts";

function notification(overrides: Partial<PendingNotification> = {}): PendingNotification {
  return {
    idempotency_key: "res-1:day_of_reminder:2026-07-05",
    trigger: "day_of_reminder",
    reservation_id: "res-1",
    fire_at: "2026-07-05T08:00:00.000Z",
    message: "本日ご予約があります。",
    ...overrides,
  };
}

/** A `Notifier` whose `deliver` behavior is scripted per-call for retry tests. */
class ScriptedNotifier implements Notifier {
  calls: PendingNotification[] = [];
  #shouldFail: (n: PendingNotification) => boolean;

  constructor(shouldFail: (n: PendingNotification) => boolean = () => false) {
    this.#shouldFail = shouldFail;
  }

  deliver(n: PendingNotification): Promise<void> {
    this.calls.push(n);
    if (this.#shouldFail(n)) {
      return Promise.reject(new Error("simulated delivery failure"));
    }
    return Promise.resolve();
  }
}

// --- enqueue: idempotency ----------------------------------------------------

Deno.test("Outbox.enqueue: double-enqueue of the same idempotency_key produces one entry", async () => {
  const store = new InMemoryStore();
  const outbox = new Outbox(store);
  const n = notification();

  const first = await outbox.enqueue([n]);
  assertEquals(first, { enqueued: 1, deduped: 0 });

  const second = await outbox.enqueue([n]);
  assertEquals(second, { enqueued: 0, deduped: 1 });

  const all = await store.listOutboxEntries();
  assertEquals(all.length, 1);
  assertEquals(all[0]?.status, "pending");
});

Deno.test("Outbox.enqueue: delivered/failed entries also dedupe (not just pending)", async () => {
  const store = new InMemoryStore();
  const outbox = new Outbox(store);
  const n = notification();

  await outbox.enqueue([n]);
  const notifier = new ScriptedNotifier();
  const clock = new VirtualClock("2026-07-05T08:00:00Z");
  await outbox.deliverPending(notifier, clock);

  const after = await outbox.enqueue([n]);
  assertEquals(after, { enqueued: 0, deduped: 1 });
  assertEquals(notifier.calls.length, 1); // never redelivered
});

// --- delivery + retry ---------------------------------------------------------

Deno.test("Outbox.deliverPending: successful delivery marks entry delivered with delivered_at", async () => {
  const store = new InMemoryStore();
  const outbox = new Outbox(store);
  const n = notification();
  await outbox.enqueue([n]);

  const notifier = new ScriptedNotifier();
  const clock = new VirtualClock("2026-07-05T08:00:00Z");
  const result = await outbox.deliverPending(notifier, clock);

  assertEquals(result, { delivered: 1, failed: 0, retriable: 0 });
  const entry = await store.getOutboxEntry(n.idempotency_key);
  assertEquals(entry?.status, "delivered");
  assertEquals(entry?.delivered_at, "2026-07-05T08:00:00.000Z");
  assertEquals(entry?.attempts, 0);
});

Deno.test("Outbox.deliverPending: delivered entries are never redelivered on a later pass", async () => {
  const store = new InMemoryStore();
  const outbox = new Outbox(store);
  const n = notification();
  await outbox.enqueue([n]);

  const notifier = new ScriptedNotifier();
  const clock = new VirtualClock("2026-07-05T08:00:00Z");
  await outbox.deliverPending(notifier, clock);
  const second = await outbox.deliverPending(notifier, clock);

  assertEquals(second, { delivered: 0, failed: 0, retriable: 0 });
  assertEquals(notifier.calls.length, 1);
});

Deno.test("Outbox.deliverPending: a failing notifier increments attempts and stays pending until maxAttempts", async () => {
  const store = new InMemoryStore();
  const outbox = new Outbox(store);
  const n = notification();
  await outbox.enqueue([n]);

  const notifier = new ScriptedNotifier(() => true);
  const clock = new VirtualClock("2026-07-05T08:00:00Z");

  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await outbox.deliverPending(notifier, clock, { maxAttempts: 5 });
    assertEquals(result, { delivered: 0, failed: 0, retriable: 1 });
    const entry = await store.getOutboxEntry(n.idempotency_key);
    assertEquals(entry?.status, "pending");
    assertEquals(entry?.attempts, attempt);
  }

  // 5th failing attempt reaches maxAttempts=5 and gives up.
  const finalResult = await outbox.deliverPending(notifier, clock, { maxAttempts: 5 });
  assertEquals(finalResult, { delivered: 0, failed: 1, retriable: 0 });
  const entry = await store.getOutboxEntry(n.idempotency_key);
  assertEquals(entry?.status, "failed");
  assertEquals(entry?.attempts, 5);
  assertEquals(entry?.delivered_at, null);
  assertEquals(notifier.calls.length, 5);

  // failed entries are terminal: a later pass does not retry them.
  const afterFailed = await outbox.deliverPending(notifier, clock, { maxAttempts: 5 });
  assertEquals(afterFailed, { delivered: 0, failed: 0, retriable: 0 });
  assertEquals(notifier.calls.length, 5);
});

Deno.test("Outbox.deliverPending: defaults maxAttempts to 5", async () => {
  const store = new InMemoryStore();
  const outbox = new Outbox(store);
  const n = notification();
  await outbox.enqueue([n]);
  const notifier = new ScriptedNotifier(() => true);
  const clock = new VirtualClock("2026-07-05T08:00:00Z");

  for (let i = 0; i < 4; i++) {
    await outbox.deliverPending(notifier, clock);
  }
  let entry = await store.getOutboxEntry(n.idempotency_key);
  assertEquals(entry?.status, "pending");

  await outbox.deliverPending(notifier, clock);
  entry = await store.getOutboxEntry(n.idempotency_key);
  assertEquals(entry?.status, "failed");
  assertEquals(entry?.attempts, 5);
});

Deno.test("Outbox.deliverPending: independent entries succeed/fail/retry independently", async () => {
  const store = new InMemoryStore();
  const outbox = new Outbox(store);
  const ok = notification({ idempotency_key: "ok-key", reservation_id: "res-ok" });
  const bad = notification({ idempotency_key: "bad-key", reservation_id: "res-bad" });
  await outbox.enqueue([ok, bad]);

  const notifier = new ScriptedNotifier((n) => n.reservation_id === "res-bad");
  const clock = new VirtualClock("2026-07-05T08:00:00Z");
  const result = await outbox.deliverPending(notifier, clock, { maxAttempts: 5 });

  assertEquals(result, { delivered: 1, failed: 0, retriable: 1 });
  assertEquals((await store.getOutboxEntry("ok-key"))?.status, "delivered");
  assertEquals((await store.getOutboxEntry("bad-key"))?.status, "pending");
  assertEquals((await store.getOutboxEntry("bad-key"))?.attempts, 1);
});

// --- ConsoleNotifier ----------------------------------------------------------

Deno.test("ConsoleNotifier: writes a formatted line and a structured JSON line", async () => {
  const lines: string[] = [];
  const notifier = new ConsoleNotifier({ write: (line) => lines.push(line) });
  const n = notification({ message: "残り2件が要キャンセルです。" });

  await notifier.deliver(n);

  assertEquals(lines.length, 2);
  assertMatch(lines[0]!, /day_of_reminder/);
  assertMatch(lines[0]!, /残り2件が要キャンセルです。/);

  const record = JSON.parse(lines[1]!);
  assertEquals(record.level, "info");
  assertEquals(record.component, "notify.console");
  assertEquals(record.trigger, "day_of_reminder");
  assertEquals(record.reservation_id, "res-1");
  assertEquals(record.idempotency_key, n.idempotency_key);
});

// --- subscribe glue: end-to-end with real transition events -------------------

function idSource(correlationId: string): TransitionIds {
  return { newId: () => ulid(), correlationId };
}

Deno.test("onEventsAppended: confirm on a quota=1 plan → plan.settled → enqueue → deliver via ConsoleNotifier", async () => {
  const store = new InMemoryStore();
  const clock = new VirtualClock("2026-07-01T09:00:00Z");

  const planId = ulid();
  const confirmedResId = ulid();
  const otherResId = ulid();

  const plan: Plan = {
    id: planId,
    event_id: null,
    title: "候補グループ",
    date_range: null,
    confirm_quota: 1,
    status: "open",
    reservation_ids: [confirmedResId, otherResId],
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
  };

  function makeReservation(overrides: Partial<Reservation>): Reservation {
    return {
      id: ulid(),
      plan_id: planId,
      event_id: null,
      service_name: "テスト旅館",
      provider: null,
      starts_at: "2026-08-01T15:00:00.000Z",
      ends_at: null,
      location: null,
      amount_jpy: 10000,
      status: "candidate",
      cancellation_policy: "unknown",
      policy_template_id: null,
      source: "manual",
      raw_input_ref: null,
      notes: null,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
      ...overrides,
    };
  }

  const confirmedReservation = makeReservation({ id: confirmedResId, status: "candidate" });
  const otherReservation = makeReservation({ id: otherResId, status: "candidate" });

  await store.putPlan(plan);
  await store.putReservation(confirmedReservation);
  await store.putReservation(otherReservation);

  const ctx: TransitionContext = {
    plan,
    planReservations: [confirmedReservation, otherReservation],
    reservation: confirmedReservation,
  };
  const outcome = confirm(ctx, clock, idSource("corr-1"));
  if (!outcome.ok) throw new Error(`expected ok outcome, got: ${outcome.error.message}`);

  await append(store, outcome.events);
  for (const r of outcome.updated.reservations) {
    await store.putReservation(r);
  }
  if (outcome.updated.plan) {
    await store.putPlan(outcome.updated.plan);
  }

  const settledOtherReservation = { ...otherReservation, status: "to_cancel" as const };
  await onEventsAppended(
    store,
    outcome.events,
    {
      reservations: [
        await store.getReservation(confirmedResId).then((r) => r!),
        settledOtherReservation,
      ],
    },
    clock,
  );

  const pendingEntries = await store.listOutboxEntries({ status: "pending" });
  assertEquals(pendingEntries.length, 1);
  assertEquals(pendingEntries[0]?.trigger, "plan_settled");
  assertMatch(pendingEntries[0]?.message ?? "", /残り 1 件が要キャンセルです。/);

  const lines: string[] = [];
  const notifier = new ConsoleNotifier({ write: (line) => lines.push(line) });
  const outbox = new Outbox(store);
  const result = await outbox.deliverPending(notifier, clock);

  assertEquals(result, { delivered: 1, failed: 0, retriable: 0 });
  assertEquals((await store.listOutboxEntries({ status: "delivered" })).length, 1);
  assertMatch(lines[0]!, /plan_settled/);
  assertMatch(lines[0]!, /残り 1 件が要キャンセルです。/);

  // A second event-log publish of the same events must not double-enqueue.
  await onEventsAppended(
    store,
    outcome.events,
    {
      reservations: [
        await store.getReservation(confirmedResId).then((r) => r!),
        settledOtherReservation,
      ],
    },
    clock,
  );
  assertEquals((await store.listOutboxEntries()).length, 1);
});

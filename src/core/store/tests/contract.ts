/**
 * Shared contract test suite for `Store` implementations (Task 1.3).
 *
 * `runStoreContractTests(name, factory)` registers a set of `Deno.test`
 * cases (prefixed with `name`) that exercise the `Store` interface. Each
 * test calls `factory()` to get a fresh, isolated store instance and closes
 * it (via `store.close()`) when done, so the same suite can be run against
 * `InMemoryStore` and `KvStore` (via a temp-file-backed `Deno.openKv`)
 * without cross-test interference.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.19";
import type { CancellationPolicy } from "../../schema/cancellation-policy.ts";
import type { DomainEvent } from "../../schema/domain-event.ts";
import type { Event } from "../../schema/event.ts";
import type { OutboxEntry } from "../../schema/outbox-entry.ts";
import type { ParseJob } from "../../schema/parse-job.ts";
import type { Plan } from "../../schema/plan.ts";
import type { PolicyTemplate } from "../../schema/policy-template.ts";
import type { Reservation } from "../../schema/reservation.ts";
import type { Store } from "../store.ts";

const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ULID_B = "01BRZ3NDEKTSV4RRFFQ69G5FAV";
const ULID_C = "01CRZ3NDEKTSV4RRFFQ69G5FAV";
const ULID_D = "01DRZ3NDEKTSV4RRFFQ69G5FAV";
const ULID_PLAN = "01PRZ3NDEKTSV4RRFFQ69G5FAV";

const policy: CancellationPolicy = {
  stages: [
    { until_offset_hours: 168, fee_percent: 0, fee_fixed_jpy: null },
    { until_offset_hours: 24, fee_percent: 50, fee_fixed_jpy: null },
  ],
};

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: ULID_A,
    title: "夏の北陸旅行",
    date_range: null,
    notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: ULID_PLAN,
    event_id: null,
    title: "7/12 ディナー候補",
    date_range: null,
    confirm_quota: 1,
    status: "open",
    reservation_ids: [],
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: ULID_A,
    plan_id: null,
    event_id: null,
    service_name: "○○旅館",
    provider: "じゃらん",
    starts_at: "2026-08-01T15:00:00.000Z",
    ends_at: null,
    location: null,
    amount_jpy: 12000,
    status: "candidate",
    cancellation_policy: policy,
    policy_template_id: null,
    source: "manual",
    raw_input_ref: null,
    notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePolicyTemplate(overrides: Partial<PolicyTemplate> = {}): PolicyTemplate {
  return {
    id: ULID_A,
    service_key: "jalan:○○旅館",
    policy,
    hit_count: 1,
    last_used_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeParseJob(overrides: Partial<ParseJob> = {}): ParseJob {
  return {
    id: ULID_A,
    input_type: "text",
    raw_input: "土曜19時に○○を仮予約",
    attempts: [],
    status: "parsed",
    conflicts: [],
    created_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDomainEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: ULID_A,
    type: "reservation.created",
    entity_id: ULID_B,
    payload: { foo: "bar" },
    caused_by: null,
    correlation_id: "corr-1",
    occurred_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeOutboxEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    idempotency_key: `${ULID_A}:day_of_reminder:2026-07-05`,
    trigger: "day_of_reminder",
    reservation_id: ULID_A,
    fire_at: "2026-07-05T08:00:00.000Z",
    message: "本日ご予約があります。",
    status: "pending",
    attempts: 0,
    delivered_at: null,
    ...overrides,
  };
}

/**
 * Registers the full contract test suite against a `Store` implementation.
 * `factory` must return a fresh, isolated store for each call.
 */
export function runStoreContractTests(name: string, factory: () => Promise<Store>): void {
  async function withStore(fn: (store: Store) => Promise<void>): Promise<void> {
    const store = await factory();
    try {
      await fn(store);
    } finally {
      await store.close();
    }
  }

  Deno.test(`${name}: Event CRUD`, () =>
    withStore(async (store) => {
      assertEquals(await store.getEvent(ULID_A), null);
      const event = makeEvent();
      await store.putEvent(event);
      assertEquals(await store.getEvent(ULID_A), event);
      assertEquals(await store.listEventEntities(), [event]);
    }));

  Deno.test(`${name}: Event put is upsert (overwrite semantics)`, () =>
    withStore(async (store) => {
      await store.putEvent(makeEvent({ title: "A" }));
      await store.putEvent(makeEvent({ title: "B" }));
      const events = await store.listEventEntities();
      assertEquals(events.length, 1);
      assertEquals(events[0]?.title, "B");
    }));

  Deno.test(`${name}: Plan CRUD`, () =>
    withStore(async (store) => {
      assertEquals(await store.getPlan(ULID_PLAN), null);
      const plan = makePlan();
      await store.putPlan(plan);
      assertEquals(await store.getPlan(ULID_PLAN), plan);
      assertEquals(await store.listPlans(), [plan]);
    }));

  Deno.test(`${name}: Reservation CRUD`, () =>
    withStore(async (store) => {
      assertEquals(await store.getReservation(ULID_A), null);
      const reservation = makeReservation();
      await store.putReservation(reservation);
      assertEquals(await store.getReservation(ULID_A), reservation);
      assertEquals(await store.listReservations(), [reservation]);
    }));

  Deno.test(`${name}: PolicyTemplate CRUD`, () =>
    withStore(async (store) => {
      assertEquals(await store.getPolicyTemplate(ULID_A), null);
      const template = makePolicyTemplate();
      await store.putPolicyTemplate(template);
      assertEquals(await store.getPolicyTemplate(ULID_A), template);
      assertEquals(await store.listPolicyTemplates(), [template]);
    }));

  Deno.test(`${name}: ParseJob CRUD`, () =>
    withStore(async (store) => {
      assertEquals(await store.getParseJob(ULID_A), null);
      const job = makeParseJob();
      await store.putParseJob(job);
      assertEquals(await store.getParseJob(ULID_A), job);
      assertEquals(await store.listParseJobs(), [job]);
    }));

  Deno.test(`${name}: rejects invalid entities at the write boundary`, () =>
    withStore(async (store) => {
      // deno-lint-ignore no-explicit-any
      const invalid = { id: "not-a-ulid" } as any;
      await assertRejects(() => store.putEvent(invalid));
    }));

  Deno.test(`${name}: DomainEvent log is append-only and ULID ordered`, () =>
    withStore(async (store) => {
      const e1 = makeDomainEvent({ id: ULID_A });
      const e2 = makeDomainEvent({ id: ULID_C });
      const e3 = makeDomainEvent({ id: ULID_B });

      // Appended out of chronological order...
      await store.appendEvent(e1);
      await store.appendEvent(e2);
      await store.appendEvent(e3);

      // ...but listed back in ULID order (A < B < C).
      const all = await store.listEvents();
      assertEquals(all.map((e) => e.id), [ULID_A, ULID_B, ULID_C]);
    }));

  Deno.test(`${name}: appendEvent rejects overwriting an existing id`, () =>
    withStore(async (store) => {
      await store.appendEvent(makeDomainEvent({ id: ULID_A }));
      await assertRejects(() => store.appendEvent(makeDomainEvent({ id: ULID_A, payload: {} })));
    }));

  Deno.test(`${name}: listEvents filters by entity_id`, () =>
    withStore(async (store) => {
      await store.appendEvent(makeDomainEvent({ id: ULID_A, entity_id: ULID_B }));
      await store.appendEvent(makeDomainEvent({ id: ULID_C, entity_id: ULID_D }));
      const filtered = await store.listEvents({ entity_id: ULID_B });
      assertEquals(filtered.map((e) => e.id), [ULID_A]);
    }));

  Deno.test(`${name}: listEvents filters by after_id`, () =>
    withStore(async (store) => {
      await store.appendEvent(makeDomainEvent({ id: ULID_A }));
      await store.appendEvent(makeDomainEvent({ id: ULID_B }));
      await store.appendEvent(makeDomainEvent({ id: ULID_C }));
      const filtered = await store.listEvents({ after_id: ULID_A });
      assertEquals(filtered.map((e) => e.id), [ULID_B, ULID_C]);
    }));

  Deno.test(`${name}: plan->reservations index stays consistent on put/update`, () =>
    withStore(async (store) => {
      await store.putPlan(makePlan());
      const r1 = makeReservation({ id: ULID_A, plan_id: ULID_PLAN });
      const r2 = makeReservation({ id: ULID_B, plan_id: ULID_PLAN });
      await store.putReservation(r1);
      await store.putReservation(r2);

      let byPlan = await store.listReservationsByPlan(ULID_PLAN);
      assertEquals(new Set(byPlan.map((r) => r.id)), new Set([ULID_A, ULID_B]));

      // Moving r1 to a different plan removes it from the old plan's index.
      const otherPlanId = ULID_D;
      await store.putReservation({ ...r1, plan_id: otherPlanId });
      byPlan = await store.listReservationsByPlan(ULID_PLAN);
      assertEquals(byPlan.map((r) => r.id), [ULID_B]);

      const byOtherPlan = await store.listReservationsByPlan(otherPlanId);
      assertEquals(byOtherPlan.map((r) => r.id), [ULID_A]);
    }));

  Deno.test(`${name}: pending-cancel index adds/removes on status change`, () =>
    withStore(async (store) => {
      const r1 = makeReservation({
        id: ULID_A,
        status: "to_cancel",
        starts_at: "2026-08-02T00:00:00.000Z",
      });
      const r2 = makeReservation({
        id: ULID_B,
        status: "to_cancel",
        starts_at: "2026-08-01T00:00:00.000Z",
      });
      const r3 = makeReservation({ id: ULID_C, status: "confirmed" });
      await store.putReservation(r1);
      await store.putReservation(r2);
      await store.putReservation(r3);

      // Ordered by starts_at ascending: r2 (08-01) before r1 (08-02); r3 is
      // not to_cancel so it's excluded.
      let pending = await store.listPendingCancellations();
      assertEquals(pending.map((r) => r.id), [ULID_B, ULID_A]);

      // Transitioning r1 out of to_cancel removes it from the index.
      await store.putReservation({ ...r1, status: "cancelled" });
      pending = await store.listPendingCancellations();
      assertEquals(pending.map((r) => r.id), [ULID_B]);

      // Transitioning r3 into to_cancel adds it.
      await store.putReservation({ ...r3, status: "to_cancel" });
      pending = await store.listPendingCancellations();
      assertEquals(new Set(pending.map((r) => r.id)), new Set([ULID_B, ULID_C]));
    }));

  Deno.test(`${name}: pending-cancel index relocates entry when starts_at changes`, () =>
    withStore(async (store) => {
      const r1 = makeReservation({
        id: ULID_A,
        status: "to_cancel",
        starts_at: "2026-08-01T00:00:00.000Z",
      });
      await store.putReservation(r1);
      await store.putReservation({ ...r1, starts_at: "2026-09-01T00:00:00.000Z" });

      const pending = await store.listPendingCancellations();
      assertEquals(pending.length, 1);
      assertEquals(pending[0]?.starts_at, "2026-09-01T00:00:00.000Z");
    }));

  Deno.test(`${name}: pending-cancel index normalizes non-UTC starts_at for chronological ordering`, () =>
    withStore(async (store) => {
      // r1's raw "+09:00" string is chronologically *before* r2's raw "Z"
      // string (14:00Z vs 20:00Z) but would sort *after* it lexicographically
      // as raw text ("23:00:00+09:00" > "20:00:00.000Z" byte-for-byte). Only
      // UTC normalization before indexing yields the correct chronological
      // order.
      const r1 = makeReservation({
        id: ULID_A,
        status: "to_cancel",
        starts_at: "2026-08-01T23:00:00+09:00", // == 2026-08-01T14:00:00Z
      });
      const r2 = makeReservation({
        id: ULID_B,
        status: "to_cancel",
        starts_at: "2026-08-01T20:00:00.000Z",
      });
      await store.putReservation(r1);
      await store.putReservation(r2);

      const pending = await store.listPendingCancellations();
      assertEquals(pending.map((r) => r.starts_at), [
        "2026-08-01T14:00:00.000Z",
        "2026-08-01T20:00:00.000Z",
      ]);
      // Ordered by true chronological (UTC-normalized) time: r1 before r2.
      assertEquals(pending.map((r) => r.id), [ULID_A, ULID_B]);
    }));

  Deno.test(`${name}: Reservation put overwrite semantics preserve other entities`, () =>
    withStore(async (store) => {
      const r = makeReservation({ status: "candidate" });
      await store.putReservation(r);
      await store.putReservation({ ...r, status: "confirmed" });
      const got = await store.getReservation(r.id);
      assertEquals(got?.status, "confirmed");
      assertEquals(await store.listReservations().then((l) => l.length), 1);
    }));

  Deno.test(`${name}: OutboxEntry get/put round-trips and is keyed by idempotency_key`, () =>
    withStore(async (store) => {
      assertEquals(await store.getOutboxEntry("no-such-key"), null);
      const entry = makeOutboxEntry();
      await store.putOutboxEntry(entry);
      const got = await store.getOutboxEntry(entry.idempotency_key);
      assertEquals(got, entry);
    }));

  Deno.test(`${name}: OutboxEntry put overwrites by idempotency_key (upsert)`, () =>
    withStore(async (store) => {
      const entry = makeOutboxEntry();
      await store.putOutboxEntry(entry);
      await store.putOutboxEntry({ ...entry, status: "delivered", delivered_at: entry.fire_at });
      const got = await store.getOutboxEntry(entry.idempotency_key);
      assertEquals(got?.status, "delivered");
      assertEquals(await store.listOutboxEntries().then((l) => l.length), 1);
    }));

  Deno.test(`${name}: listOutboxEntries filters by status`, () =>
    withStore(async (store) => {
      const pending = makeOutboxEntry({ idempotency_key: "k1" });
      const delivered = makeOutboxEntry({
        idempotency_key: "k2",
        status: "delivered",
        delivered_at: "2026-07-05T08:00:00.000Z",
      });
      const failed = makeOutboxEntry({ idempotency_key: "k3", status: "failed", attempts: 5 });
      await store.putOutboxEntry(pending);
      await store.putOutboxEntry(delivered);
      await store.putOutboxEntry(failed);

      assertEquals(await store.listOutboxEntries().then((l) => l.length), 3);
      assertEquals(
        await store.listOutboxEntries({ status: "pending" }).then((l) =>
          l.map((e) => e.idempotency_key)
        ),
        ["k1"],
      );
      assertEquals(
        await store.listOutboxEntries({ status: "delivered" }).then((l) =>
          l.map((e) => e.idempotency_key)
        ),
        ["k2"],
      );
      assertEquals(
        await store.listOutboxEntries({ status: "failed" }).then((l) =>
          l.map((e) => e.idempotency_key)
        ),
        ["k3"],
      );
    }));

  Deno.test(`${name}: OutboxEntry rejects invalid records at the write boundary`, () =>
    withStore(async (store) => {
      await assertRejects(() =>
        // deno-lint-ignore no-explicit-any
        store.putOutboxEntry({ ...makeOutboxEntry(), attempts: -1 } as any)
      );
    }));
}

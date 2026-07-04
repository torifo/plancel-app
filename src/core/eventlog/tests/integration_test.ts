/**
 * Emitter <-> fold round-trip integration test (Wave 2 review).
 *
 * The unit tests in transitions_test.ts assert on the shape of individual
 * emitted events; the unit tests in eventlog.test.ts fold hand-written
 * fixture events. Neither locks the *contract between them* — that what
 * transitions.ts actually emits is exactly what fold.ts/payloads.ts expect.
 * This test builds a real event stream by calling the transition functions
 * directly, folds it, and asserts the folded state exactly matches the
 * `updated` entities the transitions returned. If a transition's payload
 * shape ever drifts from the fold's expectations, this test breaks.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../clock/mod.ts";
import type { DomainEvent, Plan, Reservation } from "../../schema/mod.ts";
import {
  confirm,
  createReservation,
  markDone,
  reportCancelled,
  selfCancel,
  type TransitionContext,
  type TransitionIds,
  type TransitionOutcome,
} from "../../domain/transitions.ts";
import { foldAll, foldReservation } from "../fold.ts";

// --- helpers -----------------------------------------------------------

function idSource(correlationId = "corr-integration"): TransitionIds {
  let n = 0;
  return {
    newId: () => `evt-${++n}`,
    correlationId,
  };
}

const AT = "2026-07-01T09:00:00Z";
function clock(): VirtualClock {
  return new VirtualClock(AT);
}

let resSeq = 0;
function reservation(overrides: Partial<Reservation> = {}): Reservation {
  resSeq++;
  return {
    id: `res-${resSeq}`,
    plan_id: null,
    event_id: null,
    service_name: `service-${resSeq}`,
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

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    event_id: null,
    title: "candidate group",
    date_range: null,
    confirm_quota: 1,
    status: "open",
    reservation_ids: [],
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function ok(outcome: TransitionOutcome) {
  assert(outcome.ok, `expected ok outcome, got error: ${!outcome.ok && outcome.error.message}`);
  return outcome;
}

function standalone(r: Reservation): TransitionContext {
  return { plan: null, planReservations: [], reservation: r };
}

// --- the round trip ------------------------------------------------------

Deno.test("emitter <-> fold round-trip: create x2 (quota=1) -> confirm -> auto_to_cancel", () => {
  const events: DomainEvent[] = [];
  const p = plan({ id: "plan-rt", confirm_quota: 1 });

  const resA0 = reservation({ id: "rt-a", plan_id: p.id, status: "candidate" });
  const resB0 = reservation({ id: "rt-b", plan_id: p.id, status: "candidate" });

  const createA = ok(createReservation(resA0, clock(), idSource()));
  events.push(...createA.events);
  const createB = ok(createReservation(resB0, clock(), idSource()));
  events.push(...createB.events);

  const planReservations = [createA.updated.reservations[0]!, createB.updated.reservations[0]!];
  const confirmOut = ok(
    confirm(
      { plan: p, planReservations, reservation: planReservations[0]! },
      clock(),
      idSource(),
    ),
  );
  events.push(...confirmOut.events);

  // sanity: quota=1 with a sibling candidate must auto-cancel the sibling.
  assertEquals(confirmOut.updated.reservations.length, 2);

  const folded = foldAll(events);

  for (const updated of confirmOut.updated.reservations) {
    assertEquals(
      folded.reservations[updated.id],
      updated,
      `folded state for ${updated.id} must exactly equal the transition's updated entity`,
    );
  }

  const foldedA = foldReservation(events.filter((e) => e.entity_id === "rt-a"));
  assertEquals(foldedA?.status, "confirmed");
  const foldedB = foldReservation(events.filter((e) => e.entity_id === "rt-b"));
  assertEquals(foldedB?.status, "to_cancel");
});

Deno.test("emitter <-> fold round-trip: create -> confirm -> markDone (standalone)", () => {
  const events: DomainEvent[] = [];
  const res0 = reservation({ id: "rt-done", plan_id: null, status: "candidate" });

  const created = ok(createReservation(res0, clock(), idSource()));
  events.push(...created.events);

  const confirmed = ok(confirm(standalone(created.updated.reservations[0]!), clock(), idSource()));
  events.push(...confirmed.events);

  const done = ok(markDone(standalone(confirmed.updated.reservations[0]!), clock(), idSource()));
  events.push(...done.events);

  const folded = foldReservation(events);
  assertEquals(folded, done.updated.reservations[0]!);
  assertEquals(folded?.status, "done");
});

Deno.test("emitter <-> fold round-trip: create -> confirm -> selfCancel -> reportCancelled (standalone)", () => {
  const events: DomainEvent[] = [];
  const res0 = reservation({ id: "rt-selfcancel", plan_id: null, status: "candidate" });

  const created = ok(createReservation(res0, clock(), idSource()));
  events.push(...created.events);

  const confirmed = ok(confirm(standalone(created.updated.reservations[0]!), clock(), idSource()));
  events.push(...confirmed.events);

  const selfCancelled = ok(
    selfCancel(standalone(confirmed.updated.reservations[0]!), clock(), idSource()),
  );
  events.push(...selfCancelled.events);

  const cancelled = ok(
    reportCancelled(standalone(selfCancelled.updated.reservations[0]!), clock(), idSource()),
  );
  events.push(...cancelled.events);

  const folded = foldReservation(events);
  assertEquals(folded, cancelled.updated.reservations[0]!);
  assertEquals(folded?.status, "cancelled");

  // Also verify the intermediate to_cancel state via foldAll on a prefix.
  const foldedAfterSelfCancel = foldReservation(events.slice(0, 3));
  assertEquals(foldedAfterSelfCancel, selfCancelled.updated.reservations[0]!);
  assertEquals(foldedAfterSelfCancel?.status, "to_cancel");
});

Deno.test("emitter <-> fold round-trip: foldAll matches updated entities across the full quota stream", () => {
  const events: DomainEvent[] = [];
  const p = plan({ id: "plan-rt2", confirm_quota: 1 });

  const resA0 = reservation({ id: "rt2-a", plan_id: p.id, status: "candidate" });
  const resB0 = reservation({ id: "rt2-b", plan_id: p.id, status: "candidate" });
  const resC0 = reservation({ id: "rt2-c", plan_id: p.id, status: "candidate" });

  const createA = ok(createReservation(resA0, clock(), idSource()));
  events.push(...createA.events);
  const createB = ok(createReservation(resB0, clock(), idSource()));
  events.push(...createB.events);
  const createC = ok(createReservation(resC0, clock(), idSource()));
  events.push(...createC.events);

  const planReservations = [
    createA.updated.reservations[0]!,
    createB.updated.reservations[0]!,
    createC.updated.reservations[0]!,
  ];
  const confirmOut = ok(
    confirm(
      { plan: p, planReservations, reservation: planReservations[1]! }, // confirm B
      clock(),
      idSource(),
    ),
  );
  events.push(...confirmOut.events);

  const folded = foldAll(events);
  for (const updated of confirmOut.updated.reservations) {
    assertEquals(folded.reservations[updated.id], updated);
  }
  assertEquals(folded.reservations["rt2-a"]?.status, "to_cancel");
  assertEquals(folded.reservations["rt2-b"]?.status, "confirmed");
  assertEquals(folded.reservations["rt2-c"]?.status, "to_cancel");
  assertEquals(folded.plans[p.id]?.status, "settled");
});

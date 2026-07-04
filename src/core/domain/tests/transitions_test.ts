import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../clock/mod.ts";
import type { Plan, Reservation } from "../../schema/mod.ts";
import {
  confirm,
  createReservation,
  markDone,
  reportCancelled,
  selfCancel,
  type TransitionContext,
  type TransitionIds,
  type TransitionOutcome,
  voidReservation,
} from "../transitions.ts";

// --- test helpers ----------------------------------------------------------

/**
 * Deterministic id source: sequential, prefixed to be human-readable in
 * assertions. Not real ULIDs, but transitions.ts never parses ids — it only
 * threads them through — so this keeps the caused_by chains easy to read.
 */
function idSource(correlationId = "corr-test"): TransitionIds {
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

// --- legal transition table ------------------------------------------------

Deno.test("confirm: standalone candidate → confirmed (no quota logic)", () => {
  const r = reservation({ status: "candidate", plan_id: null });
  const out = ok(confirm(standalone(r), clock(), idSource()));
  assert(out.ok);
  assertEquals(out.events.length, 1);
  assertEquals(out.events[0]!.type, "reservation.confirmed");
  assertEquals(out.events[0]!.caused_by, null);
  assertEquals(out.events[0]!.occurred_at, "2026-07-01T09:00:00.000Z");
  assertEquals(out.updated.reservations.length, 1);
  assertEquals(out.updated.reservations[0]!.status, "confirmed");
  assertEquals(out.updated.reservations[0]!.updated_at, "2026-07-01T09:00:00.000Z");
  assertEquals(out.updated.plan, undefined);
});

Deno.test("reportCancelled: to_cancel → cancelled", () => {
  const r = reservation({ status: "to_cancel" });
  const out = ok(reportCancelled(standalone(r), clock(), idSource()));
  assert(out.ok);
  assertEquals(out.events[0]!.type, "reservation.cancelled");
  assertEquals(out.updated.reservations[0]!.status, "cancelled");
});

Deno.test("markDone: confirmed → done", () => {
  const r = reservation({ status: "confirmed" });
  const out = ok(markDone(standalone(r), clock(), idSource()));
  assert(out.ok);
  assertEquals(out.events[0]!.type, "reservation.done");
  assertEquals(out.updated.reservations[0]!.status, "done");
});

Deno.test("selfCancel: confirmed → to_cancel (自発キャンセル, uncaused)", () => {
  const r = reservation({ status: "confirmed" });
  const out = ok(selfCancel(standalone(r), clock(), idSource()));
  assert(out.ok);
  assertEquals(out.events[0]!.type, "reservation.self_cancel");
  assertEquals(out.events[0]!.caused_by, null);
  assertEquals(out.updated.reservations[0]!.status, "to_cancel");
});

Deno.test("void: reachable from ALL non-voided states", () => {
  const states: Reservation["status"][] = [
    "candidate",
    "confirmed",
    "to_cancel",
    "cancelled",
    "done",
  ];
  for (const status of states) {
    const r = reservation({ status });
    const out = ok(voidReservation(standalone(r), clock(), idSource(), "mis-registered"));
    assert(out.ok, `void should be legal from ${status}`);
    assertEquals(out.events[0]!.type, "reservation.voided");
    assertEquals(out.updated.reservations[0]!.status, "voided");
    assertEquals(
      (out.events[0]!.payload as { previous_status: string }).previous_status,
      status,
    );
    assertEquals((out.events[0]!.payload as { reason: string }).reason, "mis-registered");
  }
});

Deno.test("void: reason is optional (defaults to null in payload)", () => {
  const r = reservation({ status: "candidate" });
  const out = ok(voidReservation(standalone(r), clock(), idSource()));
  assert(out.ok);
  assertEquals((out.events[0]!.payload as { reason: string | null }).reason, null);
});

Deno.test("createReservation: emits reservation.created, no state change", () => {
  const r = reservation({ status: "candidate" });
  const out = ok(createReservation(r, clock(), idSource()));
  assert(out.ok);
  assertEquals(out.events[0]!.type, "reservation.created");
  assertEquals(out.updated.reservations[0]!.status, "candidate");
  assertEquals((out.events[0]!.payload as { reservation: typeof r }).reservation, r);
});

// --- representative illegal transitions (SDD §4 diagram) -------------------

Deno.test("illegal: cannot confirm a cancelled reservation (cancelled → confirmed)", () => {
  const r = reservation({ status: "cancelled" });
  const out = confirm(standalone(r), clock(), idSource());
  assert(!out.ok);
  assertEquals(out.error.code, "illegal_transition");
  assertEquals(out.error.command, "confirm");
  assertEquals(out.error.from, "cancelled");
});

Deno.test("illegal: cannot confirm a done / confirmed / to_cancel / voided reservation", () => {
  for (const status of ["confirmed", "done", "to_cancel", "voided"] as const) {
    const out = confirm(standalone(reservation({ status })), clock(), idSource());
    assert(!out.ok, `confirm from ${status} must be illegal`);
    assertEquals(out.error.from, status);
  }
});

Deno.test("illegal: markDone only from confirmed", () => {
  for (const status of ["candidate", "to_cancel", "cancelled", "done", "voided"] as const) {
    const out = markDone(standalone(reservation({ status })), clock(), idSource());
    assert(!out.ok, `markDone from ${status} must be illegal`);
  }
});

Deno.test("illegal: reportCancelled only from to_cancel", () => {
  for (const status of ["candidate", "confirmed", "cancelled", "done", "voided"] as const) {
    const out = reportCancelled(standalone(reservation({ status })), clock(), idSource());
    assert(!out.ok, `reportCancelled from ${status} must be illegal`);
  }
});

Deno.test("illegal: selfCancel only from confirmed", () => {
  for (const status of ["candidate", "to_cancel", "cancelled", "done", "voided"] as const) {
    const out = selfCancel(standalone(reservation({ status })), clock(), idSource());
    assert(!out.ok, `selfCancel from ${status} must be illegal`);
  }
});

Deno.test("illegal: cannot void an already-voided reservation", () => {
  const out = voidReservation(standalone(reservation({ status: "voided" })), clock(), idSource());
  assert(!out.ok);
  assertEquals(out.error.command, "void");
  assertEquals(out.error.from, "voided");
});

// --- quota = 1 (the common case) -------------------------------------------

Deno.test("quota=1: confirming one candidate settles plan and auto-cancels the rest", () => {
  const target = reservation({ status: "candidate", plan_id: "plan-1" });
  const c2 = reservation({ status: "candidate", plan_id: "plan-1" });
  const c3 = reservation({ status: "candidate", plan_id: "plan-1" });
  const p = plan({ confirm_quota: 1, reservation_ids: [target.id, c2.id, c3.id] });

  const out = ok(confirm(
    { plan: p, planReservations: [target, c2, c3], reservation: target },
    clock(),
    idSource(),
  ));
  assert(out.ok);

  // events: confirmed, plan.settled, auto_to_cancel x2
  assertEquals(out.events.map((e) => e.type), [
    "reservation.confirmed",
    "plan.settled",
    "reservation.auto_to_cancel",
    "reservation.auto_to_cancel",
  ]);

  // plan settled
  assertEquals(out.updated.plan?.status, "settled");

  // target confirmed, siblings to_cancel
  const byId = new Map(out.updated.reservations.map((r) => [r.id, r.status]));
  assertEquals(byId.get(target.id), "confirmed");
  assertEquals(byId.get(c2.id), "to_cancel");
  assertEquals(byId.get(c3.id), "to_cancel");
});

Deno.test("quota=1: caused_by chains every auto_to_cancel to the confirmed event", () => {
  const target = reservation({ status: "candidate", plan_id: "plan-1" });
  const c2 = reservation({ status: "candidate", plan_id: "plan-1" });
  const p = plan({ confirm_quota: 1 });

  const out = ok(confirm(
    { plan: p, planReservations: [target, c2], reservation: target },
    clock(),
    idSource(),
  ));
  assert(out.ok);

  const confirmed = out.events.find((e) => e.type === "reservation.confirmed")!;
  const settled = out.events.find((e) => e.type === "plan.settled")!;
  const autos = out.events.filter((e) => e.type === "reservation.auto_to_cancel");

  assertEquals(confirmed.caused_by, null);
  assertEquals(settled.caused_by, confirmed.id);
  for (const a of autos) {
    assertEquals(a.caused_by, confirmed.id, "auto_to_cancel must chain to confirmed event");
  }
  // all events share one correlation id
  for (const e of out.events) assertEquals(e.correlation_id, "corr-test");
});

Deno.test("quota=1: a lone candidate confirm settles immediately with no auto-cancels", () => {
  const target = reservation({ status: "candidate", plan_id: "plan-1" });
  const p = plan({ confirm_quota: 1 });
  const out = ok(confirm(
    { plan: p, planReservations: [target], reservation: target },
    clock(),
    idSource(),
  ));
  assert(out.ok);
  assertEquals(out.events.map((e) => e.type), ["reservation.confirmed", "plan.settled"]);
  assertEquals(out.updated.plan?.status, "settled");
});

// --- quota = 2 -------------------------------------------------------------

Deno.test("quota=2: first confirm does NOT settle the plan", () => {
  const target = reservation({ status: "candidate", plan_id: "plan-1" });
  const c2 = reservation({ status: "candidate", plan_id: "plan-1" });
  const c3 = reservation({ status: "candidate", plan_id: "plan-1" });
  const p = plan({ confirm_quota: 2 });

  const out = ok(confirm(
    { plan: p, planReservations: [target, c2, c3], reservation: target },
    clock(),
    idSource(),
  ));
  assert(out.ok);
  assertEquals(out.events.map((e) => e.type), ["reservation.confirmed"]);
  assertEquals(out.updated.plan, undefined); // plan unchanged
  assertEquals(out.updated.reservations.length, 1);
  assertEquals(out.updated.reservations[0]!.status, "confirmed");
});

Deno.test("quota=2: second confirm reaches quota, settles, auto-cancels remaining", () => {
  // one already confirmed, two candidates (target + one other)
  const already = reservation({ status: "confirmed", plan_id: "plan-1" });
  const target = reservation({ status: "candidate", plan_id: "plan-1" });
  const c3 = reservation({ status: "candidate", plan_id: "plan-1" });
  const p = plan({ confirm_quota: 2 });

  const out = ok(confirm(
    { plan: p, planReservations: [already, target, c3], reservation: target },
    clock(),
    idSource(),
  ));
  assert(out.ok);

  assertEquals(out.events.map((e) => e.type), [
    "reservation.confirmed",
    "plan.settled",
    "reservation.auto_to_cancel",
  ]);
  const byId = new Map(out.updated.reservations.map((r) => [r.id, r.status]));
  assertEquals(byId.get(target.id), "confirmed");
  assertEquals(byId.get(c3.id), "to_cancel");
  // the already-confirmed reservation is untouched (not in the update set)
  assert(!byId.has(already.id));
  assertEquals(out.updated.plan?.status, "settled");
});

Deno.test("quota=2: confirming into an already-settled plan is rejected", () => {
  const already1 = reservation({ status: "confirmed", plan_id: "plan-1" });
  const already2 = reservation({ status: "confirmed", plan_id: "plan-1" });
  const target = reservation({ status: "candidate", plan_id: "plan-1" });
  const p = plan({ confirm_quota: 2, status: "settled" });

  const out = confirm(
    { plan: p, planReservations: [already1, already2, target], reservation: target },
    clock(),
    idSource(),
  );
  assert(!out.ok);
  assertEquals(out.error.code, "plan_already_settled");
});

Deno.test("quota reached count uses confirmed siblings even if plan.status still open", () => {
  // Defensive: plan.status open but confirmed count already == quota.
  const already1 = reservation({ status: "confirmed", plan_id: "plan-1" });
  const already2 = reservation({ status: "confirmed", plan_id: "plan-1" });
  const target = reservation({ status: "candidate", plan_id: "plan-1" });
  const p = plan({ confirm_quota: 2, status: "open" });

  const out = confirm(
    { plan: p, planReservations: [already1, already2, target], reservation: target },
    clock(),
    idSource(),
  );
  assert(!out.ok);
  assertEquals(out.error.code, "plan_already_settled");
});

// --- determinism -----------------------------------------------------------

Deno.test("determinism: identical inputs + same ids → byte-identical events", () => {
  const build = () => {
    const target = reservation({ id: "res-fixed", status: "candidate", plan_id: "plan-1" });
    const c2 = reservation({ id: "res-fixed-2", status: "candidate", plan_id: "plan-1" });
    const p = plan({ confirm_quota: 1 });
    return { target, c2, p };
  };

  const run = () => {
    const { target, c2, p } = build();
    const out = confirm(
      { plan: p, planReservations: [target, c2], reservation: target },
      new VirtualClock(AT),
      idSource("corr-fixed"),
    );
    assert(out.ok);
    return out.events;
  };

  assertEquals(JSON.stringify(run()), JSON.stringify(run()));
});

Deno.test("determinism: occurred_at comes from the injected clock only", () => {
  const r = reservation({ status: "candidate" });
  const c = new VirtualClock("2027-01-02T03:04:05.678Z");
  const out = ok(confirm(standalone(r), c, idSource()));
  assert(out.ok);
  assertEquals(out.events[0]!.occurred_at, "2027-01-02T03:04:05.678Z");
});

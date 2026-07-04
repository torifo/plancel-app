/**
 * MCP registration/read tool tests (Task 3.3). Handlers are exercised directly
 * via `invokeTool` with an injected InMemoryStore + VirtualClock — no live
 * stdio transport is needed (design.md Testing Strategy: MCP tool I/O against
 * an in-memory Store).
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { InMemoryStore } from "../../core/store/mod.ts";
import { VirtualClock } from "../../core/clock/mod.ts";
import type { CancellationPolicy, Reservation } from "../../core/schema/mod.ts";
import { ulid } from "../../lib/ulid.ts";
import type { ToolContext } from "../context.ts";
import { invokeTool, type ToolRunResult } from "../tools/shared.ts";
import { createEventTool } from "../tools/create_event.ts";
import { createReservationTool } from "../tools/create_reservation.ts";
import { createPlanTool } from "../tools/create_plan.ts";
import { addToPlanTool } from "../tools/add_to_plan.ts";
import { getPlanTool } from "../tools/get_plan.ts";
import { getEventTool } from "../tools/get_event.ts";
import { listPendingCancellationsTool } from "../tools/list_pending_cancellations.ts";

const NOW = "2026-07-01T00:00:00.000Z";

function ctx(now = NOW): ToolContext {
  return {
    store: new InMemoryStore(),
    clock: new VirtualClock(now),
    ids: { newUlid: () => ulid() },
  };
}

/** Narrows a result to success, asserting on failure with its error. */
function unwrap(
  result: ToolRunResult,
): { ok: true; data: Record<string, unknown>; warning?: string[] } {
  if (!result.ok) throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  return result;
}

const KNOWN_POLICY: CancellationPolicy = {
  stages: [
    { until_offset_hours: 168, fee_percent: 0, fee_fixed_jpy: null },
    { until_offset_hours: 24, fee_percent: 100, fee_fixed_jpy: null },
  ],
};

/** Builds a schema-valid Reservation for direct store puts. */
function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: ulid(),
    plan_id: null,
    event_id: null,
    service_name: "svc",
    provider: null,
    starts_at: "2026-08-01T12:00:00.000Z",
    ends_at: null,
    location: null,
    amount_jpy: 10000,
    status: "candidate",
    cancellation_policy: "unknown",
    policy_template_id: null,
    source: "mcp",
    raw_input_ref: null,
    notes: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

// --- create_event ----------------------------------------------------------

Deno.test("create_event: happy path persists an Event", async () => {
  const c = ctx();
  const res = unwrap(await invokeTool(createEventTool, c, { title: "夏の北陸旅行" }));
  const event = res.data.event as { id: string; title: string };
  assertEquals(event.title, "夏の北陸旅行");
  assertEquals((await c.store.getEvent(event.id))?.title, "夏の北陸旅行");
});

// --- create_plan -----------------------------------------------------------

Deno.test("create_plan: happy path, confirm_quota defaults to 1", async () => {
  const c = ctx();
  const res = unwrap(await invokeTool(createPlanTool, c, { title: "7/12 ディナー候補" }));
  const plan = res.data.plan as { id: string; confirm_quota: number; status: string };
  assertEquals(plan.confirm_quota, 1);
  assertEquals(plan.status, "open");
});

Deno.test("create_plan: validation failure lists offending field path", async () => {
  const c = ctx();
  const res = await invokeTool(createPlanTool, c, {});
  assert(!res.ok);
  assertEquals(res.error.code, "validation_error");
  const paths = res.error.issues?.map((i) => i.path) ?? [];
  assert(paths.includes("title"), `expected 'title' in ${JSON.stringify(paths)}`);
});

// --- create_reservation ----------------------------------------------------

Deno.test("create_reservation: happy path, policy defaults to unknown", async () => {
  const c = ctx();
  const res = unwrap(
    await invokeTool(createReservationTool, c, {
      service_name: "鮨処○○",
      starts_at: "2026-08-01T12:00:00.000Z",
    }),
  );
  const r = res.data.reservation as Reservation;
  assertEquals(r.status, "candidate");
  assertEquals(r.cancellation_policy, "unknown");
  assertEquals(res.warning, undefined);
  assertEquals((await c.store.getReservation(r.id))?.service_name, "鮨処○○");
  // A reservation.created event was appended.
  const events = await c.store.listEvents();
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, "reservation.created");
});

Deno.test("create_reservation: accepts an explicit unknown policy", async () => {
  const c = ctx();
  const res = unwrap(
    await invokeTool(createReservationTool, c, {
      service_name: "svc",
      starts_at: "2026-08-01T12:00:00.000Z",
      cancellation_policy: "unknown",
    }),
  );
  assertEquals((res.data.reservation as Reservation).cancellation_policy, "unknown");
});

Deno.test("create_reservation: validation failure lists missing required fields", async () => {
  const c = ctx();
  const res = await invokeTool(createReservationTool, c, { provider: "食べログ" });
  assert(!res.ok);
  const paths = res.error.issues?.map((i) => i.path) ?? [];
  assert(paths.includes("service_name"), `paths: ${JSON.stringify(paths)}`);
  assert(paths.includes("starts_at"), `paths: ${JSON.stringify(paths)}`);
});

Deno.test("create_reservation: past starts_at succeeds with a warning (not an error)", async () => {
  const c = ctx();
  const res = await invokeTool(createReservationTool, c, {
    service_name: "svc",
    starts_at: "2026-06-01T12:00:00.000Z", // before NOW
  });
  assert(res.ok);
  assert(res.warning !== undefined && res.warning.length === 1);
  assert(res.warning[0]!.includes("past"));
  // Still persisted.
  assertEquals((res.data.reservation as Reservation).status, "candidate");
});

// --- add_to_plan -----------------------------------------------------------

Deno.test("add_to_plan: inline reservation is created and linked", async () => {
  const c = ctx();
  const plan = (unwrap(await invokeTool(createPlanTool, c, { title: "宿" })).data.plan) as {
    id: string;
  };
  const res = unwrap(
    await invokeTool(addToPlanTool, c, {
      plan_id: plan.id,
      reservation: { service_name: "宿A", starts_at: "2026-08-01T12:00:00.000Z" },
    }),
  );
  const outPlan = res.data.plan as { reservation_ids: string[] };
  const r = res.data.reservation as Reservation;
  assertEquals(r.plan_id, plan.id);
  assert(outPlan.reservation_ids.includes(r.id));
  assertEquals((await c.store.listReservationsByPlan(plan.id)).length, 1);
});

Deno.test("add_to_plan: existing reservation is referenced and linked", async () => {
  const c = ctx();
  const existing = reservation({ service_name: "既存" });
  await c.store.putReservation(existing);
  const plan = (unwrap(await invokeTool(createPlanTool, c, { title: "宿" })).data.plan) as {
    id: string;
  };
  const res = unwrap(
    await invokeTool(addToPlanTool, c, { plan_id: plan.id, reservation_id: existing.id }),
  );
  assertEquals((res.data.reservation as Reservation).plan_id, plan.id);
  assert((res.data.plan as { reservation_ids: string[] }).reservation_ids.includes(existing.id));
});

Deno.test("add_to_plan: inline reservation accepts unknown policy", async () => {
  const c = ctx();
  const plan = (unwrap(await invokeTool(createPlanTool, c, { title: "宿" })).data.plan) as {
    id: string;
  };
  const res = unwrap(
    await invokeTool(addToPlanTool, c, {
      plan_id: plan.id,
      reservation: {
        service_name: "宿",
        starts_at: "2026-08-01T12:00:00.000Z",
        cancellation_policy: "unknown",
      },
    }),
  );
  assertEquals((res.data.reservation as Reservation).cancellation_policy, "unknown");
});

Deno.test("add_to_plan: missing plan returns not_found", async () => {
  const c = ctx();
  const res = await invokeTool(addToPlanTool, c, {
    plan_id: ulid(),
    reservation_id: ulid(),
  });
  assert(!res.ok);
  assertEquals(res.error.code, "not_found");
});

// --- get_plan --------------------------------------------------------------

Deno.test("get_plan: status rollup counts a mix of statuses", async () => {
  const c = ctx();
  const plan = (unwrap(await invokeTool(createPlanTool, c, { title: "宿" })).data.plan) as {
    id: string;
  };
  await c.store.putReservation(reservation({ plan_id: plan.id, status: "candidate" }));
  await c.store.putReservation(reservation({ plan_id: plan.id, status: "candidate" }));
  await c.store.putReservation(reservation({ plan_id: plan.id, status: "confirmed" }));
  await c.store.putReservation(reservation({ plan_id: plan.id, status: "to_cancel" }));

  const res = unwrap(await invokeTool(getPlanTool, c, { plan_id: plan.id }));
  const rollup = res.data.status_rollup as Record<string, number>;
  assertEquals(rollup.candidate, 2);
  assertEquals(rollup.confirmed, 1);
  assertEquals(rollup.to_cancel, 1);
  assertEquals(rollup.cancelled, 0);
  assertEquals((res.data.reservations as Reservation[]).length, 4);
});

// --- get_event -------------------------------------------------------------

Deno.test("get_event: aggregates plans + direct/linked reservations", async () => {
  const c = ctx();
  const event = (unwrap(await invokeTool(createEventTool, c, { title: "出張" })).data.event) as {
    id: string;
  };
  const plan = (unwrap(
    await invokeTool(createPlanTool, c, { title: "宿", event_id: event.id }),
  ).data.plan) as { id: string };

  await c.store.putReservation(
    reservation({ plan_id: plan.id, event_id: null, status: "candidate" }),
  );
  await c.store.putReservation(
    reservation({ plan_id: null, event_id: event.id, status: "confirmed" }),
  );
  // Unrelated reservation must be excluded.
  await c.store.putReservation(reservation({ plan_id: null, event_id: null }));

  const res = unwrap(await invokeTool(getEventTool, c, { event_id: event.id }));
  assertEquals((res.data.plans as unknown[]).length, 1);
  assertEquals((res.data.reservations as Reservation[]).length, 2);
  const rollup = res.data.status_rollup as Record<string, number>;
  assertEquals(rollup.candidate, 1);
  assertEquals(rollup.confirmed, 1);
});

// --- list_pending_cancellations --------------------------------------------

Deno.test("list_pending_cancellations: ordered by deadline, unknown last, loss present", async () => {
  const c = ctx();
  // Known policy, farther deadline (starts later).
  const far = reservation({
    service_name: "far",
    status: "to_cancel",
    starts_at: "2026-09-01T12:00:00.000Z",
    amount_jpy: 20000,
    cancellation_policy: KNOWN_POLICY,
  });
  // Known policy, sooner deadline (starts sooner) → should come first.
  const soon = reservation({
    service_name: "soon",
    status: "to_cancel",
    starts_at: "2026-08-01T12:00:00.000Z",
    amount_jpy: 10000,
    cancellation_policy: KNOWN_POLICY,
  });
  // Unknown policy → last, flagged.
  const unknown = reservation({
    service_name: "unknown",
    status: "to_cancel",
    starts_at: "2026-08-15T12:00:00.000Z",
    cancellation_policy: "unknown",
  });
  await c.store.putReservation(far);
  await c.store.putReservation(soon);
  await c.store.putReservation(unknown);

  const res = unwrap(await invokeTool(listPendingCancellationsTool, c, {}));
  const items = res.data.pending_cancellations as {
    reservation: Reservation;
    unknown_policy: boolean;
    free_cancellation_deadline: string | null;
    loss_estimate: { policy_known: boolean; now_jpy: number | null };
  }[];

  assertEquals(items.length, 3);
  assertEquals(items.map((i) => i.reservation.service_name), ["soon", "far", "unknown"]);
  // Known items carry a deadline + loss; unknown is flagged with none.
  const first = items[0]!;
  const last = items[2]!;
  assert(first.free_cancellation_deadline !== null);
  assertEquals(first.loss_estimate.policy_known, true);
  assertEquals(last.unknown_policy, true);
  assertEquals(last.free_cancellation_deadline, null);
  assertEquals(last.loss_estimate.policy_known, false);
});

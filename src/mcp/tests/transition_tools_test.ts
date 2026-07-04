/**
 * MCP state-transition + debug tool tests (Task 3.4). Handlers are exercised
 * directly via `invokeTool` with an injected InMemoryStore + VirtualClock —
 * no live stdio transport (design.md Testing Strategy).
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.19";
import { InMemoryStore } from "../../core/store/mod.ts";
import { SystemClock, VirtualClock } from "../../core/clock/mod.ts";
import type { CancellationPolicy, Plan, Reservation } from "../../core/schema/mod.ts";
import { ulid } from "../../lib/ulid.ts";
import type { ToolContext } from "../context.ts";
import { invokeTool, type ToolRunResult } from "../tools/shared.ts";
import { confirmReservationTool } from "../tools/confirm_reservation.ts";
import { reportCancelledTool } from "../tools/report_cancelled.ts";
import { voidReservationTool } from "../tools/void_reservation.ts";
import { setPolicyTool } from "../tools/set_policy.ts";
import {
  debugAdvanceClockTool,
  debugCausalChainTool,
  debugDumpStateTool,
  debugPreviewNotificationsTool,
} from "../tools/debug.ts";
import { listPendingCancellationsTool } from "../tools/list_pending_cancellations.ts";
import { serverTools } from "../server.ts";

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

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: ulid(),
    event_id: null,
    title: "宿候補",
    date_range: null,
    confirm_quota: 1,
    status: "open",
    reservation_ids: [],
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/** Seeds a quota-1 plan with two candidate reservations. */
async function seedQuotaOnePlan(
  c: ToolContext,
): Promise<{ p: Plan; a: Reservation; b: Reservation }> {
  const p = plan();
  const a = reservation({ plan_id: p.id, service_name: "A" });
  const b = reservation({ plan_id: p.id, service_name: "B" });
  await c.store.putPlan({ ...p, reservation_ids: [a.id, b.id] });
  await c.store.putReservation(a);
  await c.store.putReservation(b);
  return { p, a, b };
}

// --- confirm_reservation -----------------------------------------------------

Deno.test("confirm_reservation: quota=1 plan settles, sibling in side_effects", async () => {
  const c = ctx();
  const { p, a, b } = await seedQuotaOnePlan(c);

  const res = unwrap(await invokeTool(confirmReservationTool, c, { reservation_id: a.id }));
  assertEquals((res.data.reservation as Reservation).status, "confirmed");
  assertEquals(res.data.plan_settled, true);
  const side = res.data.side_effects as Reservation[];
  assertEquals(side.map((r) => r.id), [b.id]);
  assertEquals(side[0]?.status, "to_cancel");

  // Persisted state matches the response.
  assertEquals((await c.store.getReservation(a.id))?.status, "confirmed");
  assertEquals((await c.store.getReservation(b.id))?.status, "to_cancel");
  assertEquals((await c.store.getPlan(p.id))?.status, "settled");

  // Events: confirmed + plan.settled + auto_to_cancel, causally linked.
  const events = await c.store.listEvents();
  const types = events.map((e) => e.type);
  assert(types.includes("reservation.confirmed"));
  assert(types.includes("plan.settled"));
  assert(types.includes("reservation.auto_to_cancel"));
  const confirmed = events.find((e) => e.type === "reservation.confirmed")!;
  const auto = events.find((e) => e.type === "reservation.auto_to_cancel")!;
  assertEquals(auto.caused_by, confirmed.id);

  // Notify glue fired: a plan_settled notification landed on the Outbox.
  const outbox = await c.store.listOutboxEntries();
  assertEquals(outbox.length, 1);
  assert(outbox[0]!.idempotency_key.includes("plan_settled"));
});

Deno.test("confirm_reservation: confirming on a settled plan is rejected", async () => {
  const c = ctx();
  const { p, a } = await seedQuotaOnePlan(c);
  unwrap(await invokeTool(confirmReservationTool, c, { reservation_id: a.id }));

  // A fresh candidate added after the plan settled cannot be confirmed.
  const late = reservation({ plan_id: p.id, service_name: "late" });
  await c.store.putReservation(late);
  const res = await invokeTool(confirmReservationTool, c, { reservation_id: late.id });
  assert(!res.ok);
  assertEquals(res.error.code, "plan_already_settled");
});

Deno.test("confirm_reservation: standalone reservation, no side effects", async () => {
  const c = ctx();
  const r = reservation();
  await c.store.putReservation(r);
  const res = unwrap(await invokeTool(confirmReservationTool, c, { reservation_id: r.id }));
  assertEquals((res.data.reservation as Reservation).status, "confirmed");
  assertEquals(res.data.side_effects, []);
  assertEquals(res.data.plan_settled, false);
});

Deno.test("confirm_reservation: unknown reservation returns not_found", async () => {
  const c = ctx();
  const res = await invokeTool(confirmReservationTool, c, { reservation_id: ulid() });
  assert(!res.ok);
  assertEquals(res.error.code, "not_found");
});

// --- report_cancelled --------------------------------------------------------

Deno.test("report_cancelled: to_cancel → cancelled", async () => {
  const c = ctx();
  const r = reservation({ status: "to_cancel" });
  await c.store.putReservation(r);
  const res = unwrap(await invokeTool(reportCancelledTool, c, { reservation_id: r.id }));
  assertEquals((res.data.reservation as Reservation).status, "cancelled");
  assertEquals((await c.store.getReservation(r.id))?.status, "cancelled");
  assertEquals((await c.store.listEvents())[0]?.type, "reservation.cancelled");
});

Deno.test("report_cancelled: illegal from candidate", async () => {
  const c = ctx();
  const r = reservation({ status: "candidate" });
  await c.store.putReservation(r);
  const res = await invokeTool(reportCancelledTool, c, { reservation_id: r.id });
  assert(!res.ok);
  assertEquals(res.error.code, "illegal_transition");
});

// --- void_reservation --------------------------------------------------------

for (const status of ["candidate", "confirmed", "to_cancel", "cancelled", "done"] as const) {
  Deno.test(`void_reservation: allowed from ${status}`, async () => {
    const c = ctx();
    const r = reservation({ status });
    await c.store.putReservation(r);
    const res = unwrap(
      await invokeTool(voidReservationTool, c, { reservation_id: r.id, reason: "誤登録" }),
    );
    assertEquals((res.data.reservation as Reservation).status, "voided");
    assertEquals((await c.store.getReservation(r.id))?.status, "voided");
    const events = await c.store.listEvents();
    assertEquals(events[0]?.type, "reservation.voided");
    assertEquals(
      (events[0]?.payload as { previous_status: string }).previous_status,
      status,
    );
  });
}

Deno.test("void_reservation: voiding a voided reservation is rejected", async () => {
  const c = ctx();
  const r = reservation({ status: "voided" });
  await c.store.putReservation(r);
  const res = await invokeTool(voidReservationTool, c, { reservation_id: r.id });
  assert(!res.ok);
  assertEquals(res.error.code, "illegal_transition");
});

Deno.test("void_reservation: voided drops out of list_pending_cancellations", async () => {
  const c = ctx();
  const r = reservation({ status: "to_cancel" });
  await c.store.putReservation(r);
  let list = unwrap(await invokeTool(listPendingCancellationsTool, c, {}));
  assertEquals((list.data.pending_cancellations as unknown[]).length, 1);

  unwrap(await invokeTool(voidReservationTool, c, { reservation_id: r.id }));
  list = unwrap(await invokeTool(listPendingCancellationsTool, c, {}));
  assertEquals((list.data.pending_cancellations as unknown[]).length, 0);
});

// --- set_policy --------------------------------------------------------------

Deno.test("set_policy: resolves unknown, appends policy.provided", async () => {
  const c = ctx();
  const r = reservation({ cancellation_policy: "unknown" });
  await c.store.putReservation(r);
  const res = unwrap(
    await invokeTool(setPolicyTool, c, { reservation_id: r.id, policy: KNOWN_POLICY }),
  );
  assertEquals((res.data.reservation as Reservation).cancellation_policy, KNOWN_POLICY);
  assertEquals((await c.store.getReservation(r.id))?.cancellation_policy, KNOWN_POLICY);
  const events = await c.store.listEvents();
  assertEquals(events.length, 1);
  assertEquals(events[0]?.type, "policy.provided");
  assertEquals(
    (events[0]?.payload as { previous_policy_known: boolean }).previous_policy_known,
    false,
  );
});

Deno.test("set_policy: replaces a known policy on to_cancel", async () => {
  const c = ctx();
  const r = reservation({ status: "to_cancel", cancellation_policy: KNOWN_POLICY });
  await c.store.putReservation(r);
  const next: CancellationPolicy = {
    stages: [{ until_offset_hours: 48, fee_percent: 50, fee_fixed_jpy: null }],
  };
  const res = unwrap(await invokeTool(setPolicyTool, c, { reservation_id: r.id, policy: next }));
  assertEquals((res.data.reservation as Reservation).cancellation_policy, next);
});

Deno.test("set_policy: rejected on done (and other closed states)", async () => {
  const c = ctx();
  const r = reservation({ status: "done" });
  await c.store.putReservation(r);
  const res = await invokeTool(setPolicyTool, c, { reservation_id: r.id, policy: KNOWN_POLICY });
  assert(!res.ok);
  assertEquals(res.error.code, "illegal_transition");
});

Deno.test("set_policy: invalid policy is a validation_error", async () => {
  const c = ctx();
  const r = reservation();
  await c.store.putReservation(r);
  const res = await invokeTool(setPolicyTool, c, { reservation_id: r.id, policy: "unknown" });
  assert(!res.ok);
  assertEquals(res.error.code, "validation_error");
});

// --- debug tools -------------------------------------------------------------

Deno.test("debug tools are present only with the debug flag", () => {
  const names = (debug: boolean) => serverTools(debug).map((t) => t.name);
  const off = names(false);
  const on = names(true);
  const debugNames = [
    "debug_dump_state",
    "debug_advance_clock",
    "debug_preview_notifications",
    "debug_causal_chain",
  ];
  for (const n of debugNames) {
    assert(!off.includes(n), `${n} must be hidden without the flag`);
    assert(on.includes(n), `${n} must be registered with the flag`);
  }
  // Transition tools are always registered.
  assert(off.includes("confirm_reservation") && off.includes("set_policy"));
});

Deno.test("debug_dump_state: dumps entities and the event log", async () => {
  const c = ctx();
  const r = reservation({ status: "to_cancel" });
  await c.store.putReservation(r);
  unwrap(await invokeTool(voidReservationTool, c, { reservation_id: r.id }));
  const res = unwrap(await invokeTool(debugDumpStateTool, c, {}));
  assertEquals((res.data.reservations as Reservation[]).length, 1);
  assertEquals((res.data.event_log as unknown[]).length, 1);
});

Deno.test("debug_advance_clock: advances VirtualClock and changes preview output", async () => {
  const c = ctx();
  await c.store.putReservation(
    reservation({ status: "to_cancel", cancellation_policy: KNOWN_POLICY }),
  );

  const before = unwrap(await invokeTool(debugPreviewNotificationsTool, c, {}));
  const adv = unwrap(await invokeTool(debugAdvanceClockTool, c, { duration: "P23D" }));
  assertEquals(adv.data.now, "2026-07-24T00:00:00.000Z");
  const after = unwrap(await invokeTool(debugPreviewNotificationsTool, c, {}));

  assertEquals(after.data.as_of, "2026-07-24T00:00:00.000Z");
  assertNotEquals(
    JSON.stringify(before.data.notifications),
    JSON.stringify(after.data.notifications),
  );
});

Deno.test("debug_advance_clock: rejected on a non-virtual clock", async () => {
  const c: ToolContext = {
    store: new InMemoryStore(),
    clock: new SystemClock(),
    ids: { newUlid: () => ulid() },
  };
  const res = await invokeTool(debugAdvanceClockTool, c, { duration: "P1D" });
  assert(!res.ok);
  assertEquals(res.error.code, "not_virtual_clock");
});

Deno.test("debug_causal_chain: auto_to_cancel chains back to the confirm", async () => {
  const c = ctx();
  const { a } = await seedQuotaOnePlan(c);
  unwrap(await invokeTool(confirmReservationTool, c, { reservation_id: a.id }));
  const events = await c.store.listEvents();
  const auto = events.find((e) => e.type === "reservation.auto_to_cancel")!;

  const res = unwrap(await invokeTool(debugCausalChainTool, c, { event_id: auto.id }));
  const chain = res.data.chain as { type: string }[];
  assertEquals(chain.map((e) => e.type), ["reservation.confirmed", "reservation.auto_to_cancel"]);
});

Deno.test("debug_causal_chain: unknown event returns not_found", async () => {
  const c = ctx();
  const res = await invokeTool(debugCausalChainTool, c, { event_id: ulid() });
  assert(!res.ok);
  assertEquals(res.error.code, "not_found");
});

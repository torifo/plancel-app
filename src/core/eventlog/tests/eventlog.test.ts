import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { InMemoryStore } from "../../store/in-memory-store.ts";
import { append } from "../append.ts";
import { foldAll, foldReservation } from "../fold.ts";
import { causalChain } from "../causal-chain.ts";
import { verifyProjection } from "../verify-projection.ts";
import {
  EVT_AUTO_CANCEL_B,
  EVT_CANCELLED_B,
  EVT_CONFIRM_A,
  EVT_CREATE_A,
  EVT_CREATE_B,
  PLAN_ID,
  RES_A_ID,
  RES_B_ID,
  reservationA,
  reservationB,
  reservationLifecycleEvents,
} from "./fixtures.ts";

Deno.test("foldReservation reproduces create -> confirm -> auto_to_cancel -> cancelled", () => {
  const stateA = foldReservation(
    reservationLifecycleEvents.filter((e) => e.entity_id === RES_A_ID),
  );
  assertEquals(stateA?.status, "confirmed");
  assertEquals(stateA?.id, RES_A_ID);

  const stateB = foldReservation(
    reservationLifecycleEvents.filter((e) => e.entity_id === RES_B_ID),
  );
  assertEquals(stateB?.status, "cancelled");
  assertEquals(stateB?.id, RES_B_ID);
});

Deno.test("foldReservation intermediate states match each transition", () => {
  const bEvents = reservationLifecycleEvents.filter((e) => e.entity_id === RES_B_ID);
  assertEquals(foldReservation(bEvents.slice(0, 1))?.status, "candidate");
  assertEquals(foldReservation(bEvents.slice(0, 2))?.status, "to_cancel");
  assertEquals(foldReservation(bEvents.slice(0, 3))?.status, "cancelled");
});

Deno.test("foldAll rebuilds every reservation and derives plan open state", () => {
  const state = foldAll(reservationLifecycleEvents);
  assertEquals(state.reservations[RES_A_ID]?.status, "confirmed");
  assertEquals(state.reservations[RES_B_ID]?.status, "cancelled");
  assertEquals(state.plans[PLAN_ID]?.status, "open");
});

Deno.test("causalChain from auto_to_cancel reaches the confirmed event", () => {
  const chain = causalChain(reservationLifecycleEvents, EVT_AUTO_CANCEL_B);
  const ids = chain.map((e) => e.id);
  assertEquals(ids, [EVT_CONFIRM_A, EVT_AUTO_CANCEL_B]);
});

Deno.test("causalChain from cancelled walks through auto_to_cancel to confirmed", () => {
  const chain = causalChain(reservationLifecycleEvents, EVT_CANCELLED_B);
  assertEquals(chain.map((e) => e.id), [EVT_CONFIRM_A, EVT_AUTO_CANCEL_B, EVT_CANCELLED_B]);
});

Deno.test("causalChain from a root event (caused_by null) is a single-element chain", () => {
  const chain = causalChain(reservationLifecycleEvents, EVT_CREATE_A);
  assertEquals(chain.map((e) => e.id), [EVT_CREATE_A]);
});

Deno.test("causalChain returns [] for an unknown event id", () => {
  assertEquals(causalChain(reservationLifecycleEvents, "nonexistent"), []);
});

Deno.test("append preserves ULID order using InMemoryStore", async () => {
  const store = new InMemoryStore();
  // Append out of chronological order; listEvents must still return them
  // sorted by id (InMemoryStore's contract), and append() must not reorder
  // or drop any of them along the way.
  const shuffled = [
    reservationLifecycleEvents[2]!,
    reservationLifecycleEvents[0]!,
    reservationLifecycleEvents[4]!,
    reservationLifecycleEvents[1]!,
    reservationLifecycleEvents[3]!,
  ];
  await append(store, shuffled);

  const stored = await store.listEvents();
  assertEquals(stored.map((e) => e.id), reservationLifecycleEvents.map((e) => e.id));
  await store.close();
});

Deno.test("verifyProjection reports no mismatches for a consistent store", async () => {
  const store = new InMemoryStore();
  await append(
    store,
    [EVT_CREATE_A, EVT_CREATE_B, EVT_CONFIRM_A, EVT_AUTO_CANCEL_B, EVT_CANCELLED_B]
      .map((id) => reservationLifecycleEvents.find((e) => e.id === id)!),
  );

  const folded = foldAll(reservationLifecycleEvents);
  await store.putReservation(folded.reservations[RES_A_ID]!);
  await store.putReservation(folded.reservations[RES_B_ID]!);
  await store.putPlan({
    id: PLAN_ID,
    event_id: null,
    title: "consistency test plan",
    date_range: null,
    confirm_quota: 1,
    status: folded.plans[PLAN_ID]!.status,
    reservation_ids: [RES_A_ID, RES_B_ID],
    created_at: reservationA.created_at,
    updated_at: reservationA.updated_at,
  });

  const mismatches = await verifyProjection(store);
  assertEquals(mismatches, []);
  await store.close();
});

Deno.test("verifyProjection detects an artificially corrupted store entity", async () => {
  const store = new InMemoryStore();
  await append(store, reservationLifecycleEvents);

  const folded = foldAll(reservationLifecycleEvents);
  await store.putReservation(folded.reservations[RES_A_ID]!);
  // Corrupt B: store it as still "candidate" even though the event log says
  // "cancelled" — verifyProjection must catch this KV/event-log divergence.
  await store.putReservation({ ...reservationB, status: "candidate" });

  const mismatches = await verifyProjection(store);
  const mismatch = mismatches.find((m) => m.kind === "reservation" && m.id === RES_B_ID);
  assert(mismatch, "expected a mismatch for the corrupted reservation");
  assertEquals(mismatch?.issue, "state_mismatch");
  assertFalse(mismatches.some((m) => m.id === RES_A_ID));
  await store.close();
});

Deno.test("verifyProjection reports missing_in_store when an event's entity was never written", async () => {
  const store = new InMemoryStore();
  await append(store, reservationLifecycleEvents);
  // Deliberately never call putReservation.

  const mismatches = await verifyProjection(store);
  assert(mismatches.some((m) => m.id === RES_A_ID && m.issue === "missing_in_store"));
  assert(mismatches.some((m) => m.id === RES_B_ID && m.issue === "missing_in_store"));
  await store.close();
});

Deno.test("reservationA/reservationB fixtures round-trip through foldReservation", () => {
  const a = foldReservation([reservationLifecycleEvents[0]!]);
  assertEquals(a, reservationA);
  const b = foldReservation([reservationLifecycleEvents[1]!]);
  assertEquals(b, reservationB);
});

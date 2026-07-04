import { assertEquals } from "jsr:@std/assert@1";
import type { CancellationPolicy, DomainEvent, Reservation } from "../../core/schema/mod.ts";
import { VirtualClock } from "../../core/clock/mod.ts";
import {
  computePendingNotifications,
  notificationsForEvents,
  previewNotifications,
} from "../trigger.ts";

// SDD §6 example: ¥8,000 reservation, free until 7 days out, then 30% / 50% / 100%.
const STARTS_AT = "2026-07-15T18:00:00.000Z";
const EXAMPLE_POLICY: CancellationPolicy = {
  stages: [
    { until_offset_hours: 168, fee_percent: 30, fee_fixed_jpy: null }, // 7 days
    { until_offset_hours: 72, fee_percent: 50, fee_fixed_jpy: null }, // 3 days
    { until_offset_hours: 24, fee_percent: 100, fee_fixed_jpy: null }, // 1 day
  ],
};

let seq = 0;
function reservation(overrides: Partial<Reservation> = {}): Reservation {
  seq++;
  return {
    id: `01H000000000000000000000${String(seq).padStart(2, "0")}`.slice(0, 26),
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

function at(iso: string): VirtualClock {
  return new VirtualClock(iso);
}

// The first fee boundary (free -> 30%) is 168h before start; its 24h window
// opens 192h before start = 2026-07-07T18:00Z.
// Temporal.Instant.toString() omits trailing-zero milliseconds.
const BOUNDARY_1_OPEN = "2026-07-07T18:00:00Z";
const BOUNDARY_1_AT = "2026-07-08T18:00:00Z";

Deno.test("fee_boundary_24h: fires exactly when the 24h window opens", () => {
  const res = reservation();
  const out = computePendingNotifications({ reservations: [res], plans: [] }, at(BOUNDARY_1_OPEN));
  assertEquals(out.length, 1);
  assertEquals(out[0]?.trigger, "fee_boundary_24h");
  assertEquals(out[0]?.boundary_at, BOUNDARY_1_AT);
});

Deno.test("fee_boundary_24h: does NOT fire just before the window opens", () => {
  const res = reservation();
  const out = computePendingNotifications(
    { reservations: [res], plans: [] },
    at("2026-07-07T17:59:00.000Z"),
  );
  assertEquals(out.length, 0);
});

Deno.test("fee_boundary_24h: does NOT fire at/after the boundary itself (window exit)", () => {
  const res = reservation();
  const out = computePendingNotifications(
    { reservations: [res], plans: [] },
    at(BOUNDARY_1_AT),
  );
  // At the boundary the first window has closed; the next window (72h boundary)
  // opens later, so nothing for boundary 1.
  assertEquals(out.filter((n) => n.boundary_at === BOUNDARY_1_AT).length, 0);
});

Deno.test("fee_boundary_24h: loss amounts — SDD example ¥8,000 / 30% => ¥2,400", () => {
  const res = reservation();
  const out = computePendingNotifications({ reservations: [res], plans: [] }, at(BOUNDARY_1_OPEN));
  const n = out[0];
  assertEquals(n?.now_loss_jpy, 0);
  assertEquals(n?.after_loss_jpy, 2400);
  assertEquals(
    n?.message,
    "「テストレストラン」のキャンセル料が上がる境界が近づいています。今キャンセルすれば無料 / 明日から ¥2,400 の損。",
  );
});

Deno.test("fee_boundary_24h: idempotency key = reservation_id + trigger + boundary instant", () => {
  const res = reservation();
  const out = computePendingNotifications({ reservations: [res], plans: [] }, at(BOUNDARY_1_OPEN));
  assertEquals(out[0]?.idempotency_key, `${res.id}:fee_boundary_24h:${BOUNDARY_1_AT}`);
});

Deno.test("unknown policy produces no boundary trigger", () => {
  const res = reservation({ cancellation_policy: "unknown" });
  const out = computePendingNotifications({ reservations: [res], plans: [] }, at(BOUNDARY_1_OPEN));
  assertEquals(out.filter((n) => n.trigger === "fee_boundary_24h").length, 0);
});

Deno.test("policy_unknown_digest: aggregates all unknown reservations with a per-day key", () => {
  const a = reservation({ cancellation_policy: "unknown", service_name: "美容院" });
  const b = reservation({ cancellation_policy: "unknown", service_name: "歯科" });
  const known = reservation(); // known policy -> excluded
  // 2026-07-16 08:00 Asia/Tokyo == 2026-07-15T23:00Z; pick a later instant.
  const out = computePendingNotifications(
    { reservations: [a, b, known], plans: [] },
    at("2026-07-15T23:30:00.000Z"),
  );
  const digest = out.filter((n) => n.trigger === "policy_unknown_digest");
  assertEquals(digest.length, 1);
  assertEquals(digest[0]?.reservation_ids?.length, 2);
  assertEquals(digest[0]?.idempotency_key, "digest:policy_unknown_digest:2026-07-16");
  assertEquals(digest[0]?.reservation_id, "digest");
});

Deno.test("policy_unknown_digest: not due before the morning digest time", () => {
  const a = reservation({ cancellation_policy: "unknown" });
  // 2026-07-15T22:00Z is 2026-07-16 07:00 Tokyo, before the 08:00 digest.
  const out = computePendingNotifications(
    { reservations: [a], plans: [] },
    at("2026-07-15T22:00:00.000Z"),
  );
  assertEquals(out.filter((n) => n.trigger === "policy_unknown_digest").length, 0);
});

Deno.test("day_of_reminder: fires the morning of a confirmed reservation (Asia/Tokyo)", () => {
  // Start 2026-07-16T05:00Z == 14:00 Tokyo; morning digest 08:00 Tokyo == 2026-07-15T23:00Z.
  const res = reservation({ status: "confirmed", starts_at: "2026-07-16T05:00:00.000Z" });
  const out = computePendingNotifications(
    { reservations: [res], plans: [] },
    at("2026-07-15T23:30:00.000Z"),
  );
  const reminder = out.filter((n) => n.trigger === "day_of_reminder");
  assertEquals(reminder.length, 1);
  assertEquals(reminder[0]?.idempotency_key, `${res.id}:day_of_reminder:2026-07-16`);
});

Deno.test("day_of_reminder: only for confirmed (candidate is skipped)", () => {
  const res = reservation({ status: "candidate", starts_at: "2026-07-16T05:00:00.000Z" });
  const out = computePendingNotifications(
    { reservations: [res], plans: [] },
    at("2026-07-15T23:30:00.000Z"),
  );
  assertEquals(out.filter((n) => n.trigger === "day_of_reminder").length, 0);
});

Deno.test("no notifications for voided / cancelled / done reservations", () => {
  for (const status of ["voided", "cancelled", "done"] as const) {
    const res = reservation({ status });
    const out = computePendingNotifications(
      { reservations: [res], plans: [] },
      at(BOUNDARY_1_OPEN),
    );
    assertEquals(out.length, 0, `status ${status} should yield nothing`);
  }
});

Deno.test("notificationsForEvents: plan.settled => immediate 'remaining N' with correct N", () => {
  const planId = "01HPLAN0000000000000000000";
  const confirmed = reservation({ plan_id: planId, status: "confirmed" });
  const toCancelA = reservation({ plan_id: planId, status: "to_cancel" });
  const toCancelB = reservation({ plan_id: planId, status: "to_cancel" });
  const settled: DomainEvent = {
    id: "01HEVENT000000000000000000",
    type: "plan.settled",
    entity_id: planId,
    payload: { plan_id: planId },
    caused_by: null,
    correlation_id: "01HCORR0000000000000000000",
    occurred_at: "2026-07-10T09:00:00.000Z",
  };
  const out = notificationsForEvents(
    [settled],
    { reservations: [confirmed, toCancelA, toCancelB] },
    at("2026-07-10T09:00:00.000Z"),
  );
  assertEquals(out.length, 1);
  assertEquals(out[0]?.trigger, "plan_settled");
  assertEquals(out[0]?.remaining_to_cancel, 2);
  assertEquals(out[0]?.reservation_id, planId);
  assertEquals(out[0]?.idempotency_key, `${planId}:plan_settled:${settled.id}`);
  assertEquals(out[0]?.message, "プラン内で1件確定しました。残り 2 件が要キャンセルです。");
});

Deno.test("previewNotifications: 7-day simulation lists the single upcoming boundary", () => {
  const res = reservation();
  const asOf = Temporal.Instant.from("2026-07-01T00:00:00.000Z");
  const out = previewNotifications({ reservations: [res], plans: [] }, asOf);
  const boundaries = out.filter((n) => n.trigger === "fee_boundary_24h");
  assertEquals(boundaries.length, 1);
  assertEquals(boundaries[0]?.fire_at, BOUNDARY_1_OPEN);
  assertEquals(boundaries[0]?.after_loss_jpy, 2400);
});

Deno.test("previewNotifications: walks every boundary whose window opens in range", () => {
  const res = reservation();
  const asOf = Temporal.Instant.from("2026-07-06T00:00:00.000Z");
  const out = previewNotifications(
    { reservations: [res], plans: [] },
    asOf,
    Temporal.Duration.from("P10D"),
  );
  const fireAts = out
    .filter((n) => n.trigger === "fee_boundary_24h")
    .map((n) => n.fire_at);
  assertEquals(fireAts, [
    "2026-07-07T18:00:00Z", // free -> 30%
    "2026-07-11T18:00:00Z", // 30% -> 50%
    "2026-07-13T18:00:00Z", // 50% -> 100%
  ]);
});

Deno.test("previewNotifications: does not send / is deterministic across calls", () => {
  const res = reservation();
  const asOf = Temporal.Instant.from("2026-07-01T00:00:00.000Z");
  const a = previewNotifications({ reservations: [res], plans: [] }, asOf);
  const b = previewNotifications({ reservations: [res], plans: [] }, asOf);
  assertEquals(a, b);
});

Deno.test("previewNotifications: unknown policy => daily digest per Tokyo day, no boundaries", () => {
  const res = reservation({ cancellation_policy: "unknown" });
  const asOf = Temporal.Instant.from("2026-07-01T00:00:00.000Z");
  const out = previewNotifications({ reservations: [res], plans: [] }, asOf);
  assertEquals(out.filter((n) => n.trigger === "fee_boundary_24h").length, 0);
  const digests = out.filter((n) => n.trigger === "policy_unknown_digest");
  // asOf = 2026-07-01T00:00Z (09:00 Tokyo, past that day's 08:00 digest), so the
  // first in-range morning digest is 2026-07-02 through 2026-07-08 = 7 days.
  assertEquals(digests.length, 7);
  // keys are unique per day
  assertEquals(new Set(digests.map((n) => n.idempotency_key)).size, 7);
});

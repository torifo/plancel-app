/**
 * How the remote MCP shows the ledger to the model (issues #5, #6): JST
 * timestamps, the computed free-cancel deadline, a filtered list, and the
 * duplicate check that keeps a retried create from making a second row.
 */
import { assertEquals } from "jsr:@std/assert@^1.0.19";
import {
  findDuplicate,
  jst,
  listFilterSchema,
  presentList,
  presentReservation,
} from "../web_api_view.ts";
import type { WebReservation } from "../../web/store.ts";

const NOW = Date.parse("2026-10-13T03:00:00Z"); // 12:00 JST

function row(over: Partial<WebReservation> = {}): WebReservation {
  return {
    id: "R1",
    plan: null,
    service: "鮨 さいとう",
    startsAt: "2026-12-20T10:00:00.000Z", // 19:00 JST
    endsAt: null,
    amount: 30000,
    location: null,
    policy: "staged",
    status: "candidate",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    updated_by: "01USER",
    ...over,
  };
}

Deno.test("view: timestamps go out as +09:00, never Z", () => {
  assertEquals(jst("2026-12-20T10:00:00.000Z"), "2026-12-20T19:00:00+09:00");
  assertEquals(jst("来週の金曜"), "来週の金曜"); // a legacy row keeps its text
});

Deno.test("view: a reservation carries its deadline and policy in words, not internals", () => {
  const v = presentReservation(row(), NOW);
  assertEquals(v.startsAt, "2026-12-20T19:00:00+09:00");
  // staged: free until the end of the day 7 days before (12/13), then 30%.
  assertEquals(v.freeUntil, "2026-12-13T23:59:59+09:00");
  assertEquals(v.nextCharge, { from: "2026-12-14T00:00:00+09:00", pct: 30 });
  assertEquals(v.policyText, "7日前まで無料 → 3日前まで30% → 前日まで50% → 当日100%");
  assertEquals(v.finished, false);
  assertEquals("updated_by" in v, false);
  assertEquals("created_at" in v, false);

  const unknown = presentReservation(row({ policy: "unknown" }), NOW);
  assertEquals(unknown.freeUntil, null);
  assertEquals(unknown.nextCharge, null);
  assertEquals(unknown.policyText, "不明");

  const done = presentReservation(row({ startsAt: "2026-10-01T10:00:00.000Z" }), NOW);
  assertEquals(done.finished, true);
});

Deno.test("view: the list hides finished and cancelled rows by default, filters, sorts, limits", () => {
  const rows = [
    row({ id: "A", startsAt: "2026-12-20T10:00:00.000Z" }),
    row({ id: "B", startsAt: "2026-11-01T10:00:00.000Z", policy: "free24", status: "confirmed" }),
    row({ id: "C", startsAt: "2026-10-01T10:00:00.000Z" }), // finished
    row({ id: "D", startsAt: "2026-11-15T10:00:00.000Z", status: "cancelled" }),
    row({ id: "E", startsAt: "2026-11-20T10:00:00.000Z", policy: "unknown", service: "宿 蛍" }),
  ];
  const ids = (out: { reservations: { id: string }[] }) => out.reservations.map((r) => r.id);

  const def = presentList(rows, listFilterSchema.parse({}), NOW);
  assertEquals(ids(def), ["B", "E", "A"]);
  assertEquals(def.total, 5);
  assertEquals(def.count, 3);

  assertEquals(ids(presentList(rows, listFilterSchema.parse({ includeFinished: true }), NOW)), [
    "C",
    "B",
    "E",
    "A",
  ]);
  assertEquals(
    ids(presentList(rows, listFilterSchema.parse({ status: ["cancelled"] }), NOW)),
    ["D"],
  );
  assertEquals(ids(presentList(rows, listFilterSchema.parse({ q: "さいとう" }), NOW)), ["B", "A"]);
  assertEquals(ids(presentList(rows, listFilterSchema.parse({ q: "宿蛍" }), NOW)), ["E"]);
  assertEquals(
    ids(presentList(rows, listFilterSchema.parse({ from: "2026-11-10", to: "2026-12-31" }), NOW)),
    ["E", "A"],
  );
  // Soonest deadline first; no deadline last.
  assertEquals(ids(presentList(rows, listFilterSchema.parse({ sort: "deadline" }), NOW)), [
    "B",
    "A",
    "E",
  ]);
  const limited = presentList(rows, listFilterSchema.parse({ limit: 1 }), NOW);
  assertEquals(ids(limited), ["B"]);
  assertEquals(limited.truncated, true);
});

Deno.test("view: a duplicate is the same place at the same instant, still live", () => {
  const rows = [row({ id: "A" }), row({ id: "X", status: "cancelled" })];
  assertEquals(findDuplicate(rows, "鮨さいとう", "2026-12-20T19:00:00+09:00")?.id, "A");
  assertEquals(findDuplicate(rows, "鮨 さいとう", "2026-12-20T19:30:00+09:00"), null);
  assertEquals(findDuplicate([rows[1]!], "鮨さいとう", "2026-12-20T19:00:00+09:00"), null);
});

// ---- found by driving the December family scenario through the tools (2026-11-11) ----

Deno.test("view: feeNow is what cancelling right now would cost", () => {
  // 12/20 19:00 JST, staged, ¥30,000. On 10/13 it is still free.
  assertEquals(presentReservation(row(), NOW).feeNow, { pct: 0, yen: 0 });
  // 12/15 (5 days before): past the 7-day free window, inside the 30% band.
  const later = Date.parse("2026-12-15T03:00:00Z");
  assertEquals(presentReservation(row(), later).feeNow, { pct: 30, yen: 9000 });
  // No amount: the rate is known, the yen figure is not.
  assertEquals(presentReservation(row({ amount: null }), later).feeNow, { pct: 30, yen: null });
  // Unknown policy: nothing to say.
  assertEquals(presentReservation(row({ policy: "unknown" }), NOW).feeNow, null);
});

Deno.test("view: a status filter does not bring finished rows back, and the list says what it hid", () => {
  const rows = [
    row({ id: "A" }),
    row({ id: "C", startsAt: "2026-10-01T10:00:00.000Z" }), // finished
    row({ id: "D", startsAt: "2026-11-15T10:00:00.000Z", status: "cancelled" }),
    row({ id: "E", startsAt: "2026-11-20T10:00:00.000Z", policy: "unknown" }),
  ];
  const out = presentList(
    rows,
    listFilterSchema.parse({ status: ["candidate", "confirmed"] }),
    NOW,
  );
  assertEquals(out.reservations.map((r) => r.id), ["E", "A"]);
  // 「total 4 なのに 2 件」の理由が応答から読める。
  const def = presentList(rows, listFilterSchema.parse({}), NOW);
  assertEquals(def.hidden, { finished: 1, cancelled: 1 });
  // 規定不明は期限順で末尾に回るので、件数を別に出して埋もれさせない。
  assertEquals(def.policyUnknown, 1);
  const all = presentList(
    rows,
    listFilterSchema.parse({ includeFinished: true, status: ["candidate", "cancelled"] }),
    NOW,
  );
  assertEquals(all.reservations.length, 4);
  assertEquals(all.hidden, { finished: 0, cancelled: 0 });
});

Deno.test("view: someone else's shared reservation is not my duplicate", () => {
  const shared = row({ id: "S" }) as WebReservation & {
    shared: { ownerDisplayName: string; role: string };
  };
  shared.shared = { ownerDisplayName: "母", role: "viewer" };
  assertEquals(findDuplicate([shared], "鮨さいとう", "2026-12-20T19:00:00+09:00"), null);
});

Deno.test("view: a row stored before endsAt existed still answers endsAt: null", () => {
  const legacy = row() as Partial<WebReservation>;
  delete legacy.endsAt;
  const v = presentReservation(legacy as WebReservation, NOW);
  assertEquals("endsAt" in v && v.endsAt, null);
  assertEquals(JSON.parse(JSON.stringify(v)).endsAt, null);
});

// ---- found by the test-account rehearsal (2026-11-11) ----

Deno.test("view: the fee schedule gives dates, so a gap in the wording cannot mislead", () => {
  // 「2日前まで無料、それ以降は全額」 for 12/12 14:00. policyText reads
  // 「2日前まで無料 → 当日100%」, but the day before is already 100%.
  const v = presentReservation(
    row({
      startsAt: "2026-12-12T05:00:00.000Z",
      policy: { stages: [{ h: 48, pct: 0 }, { h: 0, pct: 100 }] },
    }),
    NOW,
  );
  assertEquals(v.feeSchedule, [
    { until: "2026-12-10T23:59:59+09:00", pct: 0 },
    { until: "2026-12-12T14:00:00+09:00", pct: 100 },
  ]);
  // When the fee STARTS — the instant after the free deadline, not the deadline.
  assertEquals(v.freeUntil, "2026-12-10T23:59:59+09:00");
  assertEquals(v.nextCharge, { from: "2026-12-11T00:00:00+09:00", pct: 100 });
  assertEquals(presentReservation(row({ policy: "unknown" }), NOW).feeSchedule, null);
});

Deno.test("view: policyUnknown counts rows still to be watched, not cancelled ones", () => {
  const rows = [
    row({ id: "A", policy: "unknown", status: "cancelled" }),
    row({ id: "B", policy: "unknown", status: "to_cancel" }),
  ];
  const out = presentList(
    rows,
    listFilterSchema.parse({ status: ["cancelled", "to_cancel"] }),
    NOW,
  );
  assertEquals(out.count, 2);
  assertEquals(out.policyUnknown, 1);
});

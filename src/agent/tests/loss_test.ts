import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { estimateLoss } from "../loss.ts";
import type { WebReservation } from "../../web/store.ts";
import type { WebPolicy } from "../../web/policy.ts";

const row = (over: Partial<WebReservation>): WebReservation => ({
  id: "r1",
  plan: null,
  service: "店",
  startsAt: "2026-10-18T19:30:00+09:00",
  endsAt: null,
  amount: 16000,
  location: null,
  policy: "unknown",
  status: "candidate",
  created_at: "2026-10-15T00:00:00Z",
  updated_at: "2026-10-15T00:00:00Z",
  updated_by: null,
  ...over,
});
const at = (iso: string) => Temporal.Instant.from(iso).epochMilliseconds;

const THREE_DAYS: WebPolicy = {
  stages: [{ h: 72, pct: 0 }, { h: 24, pct: 50 }, { h: 0, pct: 100 }],
};

Deno.test("estimate: free now, and what the next boundary will cost", () => {
  const e = estimateLoss(row({ policy: THREE_DAYS }), at("2026-10-15T11:00:00Z")); // 20:00 JST, D
  assertEquals(e.now, { pct: 0, yen: 0 });
  // 3日前まで無料: free through the end of the 15th (JST), 50% after.
  assertEquals(e.freeUntil, "2026-10-15T23:59:59+09:00");
  assertEquals(e.next?.at, "2026-10-15T23:59:59+09:00");
  assertEquals(e.next?.pct, 50);
  assertEquals(e.next?.yen, 8000);
  assertEquals(e.next?.extraYen, 8000);
  assert(e.next!.hoursFromNow > 3.9 && e.next!.hoursFromNow < 4.1);
});

Deno.test("estimate: past the free window the next step is the one after it", () => {
  const e = estimateLoss(row({ policy: THREE_DAYS }), at("2026-10-16T03:00:00Z")); // 12:00 JST, D+1
  assertEquals(e.now, { pct: 50, yen: 8000 });
  assertEquals(e.next?.pct, 100);
  assertEquals(e.next?.yen, 16000);
  assertEquals(e.next?.extraYen, 8000);
});

Deno.test("estimate: after the start there is no next boundary", () => {
  const e = estimateLoss(row({ policy: THREE_DAYS }), at("2026-10-19T00:00:00Z"));
  assertEquals(e.now.pct, 100);
  assertEquals(e.next, null);
});

Deno.test("estimate: the preset 'staged' hotel with a multi-night stay", () => {
  const e = estimateLoss(row({ policy: "staged", amount: 52000 }), at("2026-10-10T00:00:00Z"));
  assertEquals(e.now.pct, 0);
  assertEquals(e.next?.pct, 30);
  assertEquals(e.next?.yen, 15600);
});

Deno.test("estimate: unknown policy, missing amount and always-free are said, not guessed", () => {
  const unknown = estimateLoss(row({}), at("2026-10-15T11:00:00Z"));
  assertEquals(unknown.policyKnown, false);
  assertEquals(unknown.now, { pct: null, yen: null });
  assert(unknown.note!.includes("不明"));

  const noAmount = estimateLoss(
    row({ policy: THREE_DAYS, amount: null }),
    at("2026-10-15T11:00:00Z"),
  );
  assertEquals(noAmount.now.yen, null);
  assertEquals(noAmount.next?.pct, 50);
  assert(noAmount.note!.includes("金額"));

  const free = estimateLoss(row({ policy: "none" }), at("2026-10-15T11:00:00Z"));
  assertEquals(free.now, { pct: 0, yen: 0 });
  assertEquals(free.next, null);
  assertEquals(free.freeUntil, null);
});

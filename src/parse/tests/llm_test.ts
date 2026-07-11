import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { extractReservationJson } from "../llm.ts";

Deno.test("extractReservationJson: plain JSON object -> whitelisted fields", () => {
  const output = extractReservationJson(
    '{"service_name":"〇〇","starts_at":"2026-08-01T19:00:00+09:00","amount_jpy":8000}',
  );
  assertEquals(output, {
    service_name: "〇〇",
    starts_at: "2026-08-01T19:00:00+09:00",
    amount_jpy: 8000,
  });
});

Deno.test("extractReservationJson: markdown fences and prose are tolerated", () => {
  const raw =
    '以下が抽出結果です。\n```json\n{"service_name":"〇〇","starts_at":null}\n```\n以上。';
  // starts_at: null is representable at runtime (the prompt says "不明なら null");
  // Partial<Reservation> can't express it, so compare as unknown.
  assertEquals<unknown>(extractReservationJson(raw), { service_name: "〇〇", starts_at: null });
});

Deno.test("extractReservationJson: unknown keys are dropped, never persisted", () => {
  const output = extractReservationJson(
    '{"service_name":"〇〇","confidence":0.98,"reasoning":"...","id":"evil"}',
  );
  assertEquals(output, { service_name: "〇〇" });
});

Deno.test("extractReservationJson: cancellation_policy passes through (object or unknown)", () => {
  const policy = { stages: [{ until_offset_hours: 24, fee_percent: 0, fee_fixed_jpy: null }] };
  assertEquals(
    extractReservationJson(JSON.stringify({ service_name: "a", cancellation_policy: policy })),
    { service_name: "a", cancellation_policy: policy },
  );
  assertEquals(
    extractReservationJson('{"service_name":"a","cancellation_policy":"unknown"}'),
    { service_name: "a", cancellation_policy: "unknown" },
  );
});

Deno.test("extractReservationJson: no JSON object / invalid JSON / non-object -> null", () => {
  assertEquals(extractReservationJson("すみません、抽出できませんでした。"), null);
  assertEquals(extractReservationJson('{"service_name": broken'), null);
  assertEquals(extractReservationJson("[1,2,3]"), null);
});

Deno.test("reservationPromptForClock: injects today's JST date for year inference", async () => {
  const { reservationPromptForClock } = await import("../llm.ts");
  const { VirtualClock } = await import("../../core/clock/mod.ts");
  // 2026-07-10T20:00Z = 2026-07-11 05:00 JST — the JST date must win.
  const prompt = reservationPromptForClock(new VirtualClock("2026-07-10T20:00:00Z"));
  assertEquals(prompt.includes("今日の日付は 2026-07-11"), true);
  assertEquals(prompt.includes("最も近い将来"), true);
});

Deno.test("reservationPromptForClock: without a clock the date rule is omitted, not guessed", async () => {
  const { reservationPromptForClock } = await import("../llm.ts");
  const prompt = reservationPromptForClock();
  assertEquals(prompt.includes("今日の日付は"), false);
});

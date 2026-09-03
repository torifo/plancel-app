import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import { parserReviewReasons } from "../review-policy.ts";
import type { ParseInput } from "../types.ts";
import type { ValidationResult } from "../validate.ts";

const VALID: ValidationResult = { ok: true, errors: [], warnings: [] };
const input = (content: string): ParseInput => ({
  type: "text",
  content,
  correlation_id: "review-test",
});

Deno.test("parserReviewReasons: an ordinary complete parse stays on Groq", () => {
  assertEquals(
    parserReviewReasons(
      input("8/20 18:30 銀座レストラン 4名"),
      {
        service_name: "銀座レストラン",
        starts_at: "2026-08-20T09:30:00Z",
        location: "銀座",
      },
      VALID,
    ),
    [],
  );
});

Deno.test("parserReviewReasons: rule warnings and ambiguous calendar dates request review", () => {
  assertEquals(
    parserReviewReasons(
      input("予約日 7/1、利用日 8/20 18:30"),
      { service_name: "宿", starts_at: "2025-08-20T09:30:00Z" },
      { ok: true, errors: [], warnings: ["starts_at is in the past; requires confirmation"] },
    ),
    ["validation_warning", "multiple_calendar_dates"],
  );
});

Deno.test("parserReviewReasons: lodging times and omitted address request review", () => {
  assertEquals(
    parserReviewReasons(
      input("ホテル青空 東京都新宿区西新宿1-1 チェックイン15時 チェックアウト10時"),
      { service_name: "ホテル青空", starts_at: "2026-08-20T06:00:00Z" },
      VALID,
    ),
    ["checkin_checkout", "location_omitted"],
  );
});

Deno.test("parserReviewReasons: an omitted stated cancellation policy requests review", () => {
  assertEquals(
    parserReviewReasons(
      input("8/20 ホテル青空。キャンセルは7日前まで無料"),
      {
        service_name: "ホテル青空",
        starts_at: "2026-08-20T06:00:00Z",
        cancellation_policy: "unknown",
      },
      VALID,
    ),
    ["policy_omitted"],
  );
});

// ADR-15: the model is held to the days the text names.
const clock = new VirtualClock("2026-07-16T00:00:00Z");

Deno.test("date_not_in_text: a starts_at on a day the mail never names asks for a second opinion", () => {
  const reasons = parserReviewReasons(
    input("【ご予約確認】鮨さいとう 2026年8月15日(土) 19:00 2名様"),
    { service_name: "鮨さいとう", starts_at: "2026-08-16T19:00:00+09:00" },
    VALID,
    clock,
  );
  assertEquals(reasons.includes("date_not_in_text"), true);
});

Deno.test("date_not_in_text: a starts_at on a named day is fine, in either year the text allows", () => {
  const same = parserReviewReasons(
    input("8/15 19:00 鮨さいとう 2名"),
    { service_name: "鮨さいとう", starts_at: "2026-08-15T19:00:00+09:00" },
    VALID,
    clock,
  );
  assertEquals(same.includes("date_not_in_text"), false);
});

Deno.test("date_not_in_text: a text naming no day gives no opinion", () => {
  const reasons = parserReviewReasons(
    input("土曜19時に〇〇を仮予約"),
    { service_name: "〇〇", starts_at: "2026-07-18T19:00:00+09:00" },
    VALID,
    clock,
  );
  assertEquals(reasons.includes("date_not_in_text"), false);
});

Deno.test("date_not_in_text: without a clock the check is simply not made", () => {
  const reasons = parserReviewReasons(
    input("2026年8月15日 19:00"),
    { service_name: "x", starts_at: "2026-08-16T19:00:00+09:00" },
    VALID,
  );
  assertEquals(reasons.includes("date_not_in_text"), false);
});

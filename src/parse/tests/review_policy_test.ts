import { assertEquals } from "jsr:@std/assert@^1.0.19";
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

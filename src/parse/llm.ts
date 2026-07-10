/**
 * Shared LLM-parser plumbing for the real providers (Task 6.1, SDD §5).
 *
 * Both GroqParser (groq.ts) and GeminiParser (gemini.ts) send the same
 * extraction prompt and re-derive `output` from the model's raw text via
 * `extractReservationJson` — keeping that step here means the replay
 * harness (replay.ts `parseResponse`) can exercise the CURRENT extraction
 * logic against frozen raw_responses.
 *
 * NOTE: prompt wording is ultimately the human owner's call (SDD §11
 * 「プロンプト文面は人間側オーナーが最終決定する」) — the text below is a
 * working proposal, safe to edit; the replay corpus is the regression gate.
 */
import type { Reservation } from "../core/schema/mod.ts";
import type { ParseResult } from "./types.ts";

/**
 * Extraction prompt shared by all real LLM parsers. Instructs strict
 * JSON-only output matching the Reservation subset that
 * `extractReservationJson` whitelists.
 */
export const RESERVATION_PARSE_PROMPT =
  `あなたは予約情報の抽出器です。入力（予約確認メール・予約サイトの文面・スクリーンショットなど）から予約情報を抽出し、次のキーだけを持つ JSON オブジェクトを1つだけ出力してください。説明文・前置き・コードフェンスは一切出力しないこと。

{
  "service_name": string,            // 店名・施設名・サービス名（必須。見つからなければ null）
  "provider": string | null,         // 予約経路（例: "食べログ", "Booking.com"。不明なら null）
  "starts_at": string | null,        // 開始日時。タイムゾーンオフセット付き ISO 8601（例 "2026-08-01T19:00:00+09:00"）。日本の予約でオフセット不明なら +09:00 とする。不明なら null
  "ends_at": string | null,          // 終了日時。同形式。不明なら null
  "location": string | null,         // 場所・住所。不明なら null
  "amount_jpy": number | null,       // 合計金額（円・数値）。不明なら null
  "cancellation_policy": {           // キャンセル規定。記載がなければ "unknown"
    "stages": [
      {
        "until_offset_hours": number,  // 開始日時の何時間前までこの料率か（例: 前日まで=24）
        "fee_percent": number,         // キャンセル料率 0-100
        "fee_fixed_jpy": number | null // 固定額があれば円、なければ null
      }
    ]
  } | "unknown",
  "notes": string | null             // その他の特記事項。なければ null
}

規則:
- 推測で値を作らない。入力に書かれていない項目は null（cancellation_policy は "unknown"）。
- cancellation_policy.stages は until_offset_hours の降順（遠い順）で並べる。
- 金額はカンマや通貨記号を除いた数値にする。
- 出力は JSON オブジェクトそのもの1つのみ。`;

/** Field whitelist — the only keys carried from LLM output into ParseResult. */
const ALLOWED_FIELDS = [
  "service_name",
  "provider",
  "starts_at",
  "ends_at",
  "location",
  "amount_jpy",
  "cancellation_policy",
  "notes",
] as const;

/**
 * Extracts the reservation JSON from a model's raw text response.
 * Tolerates markdown code fences and surrounding prose (takes the outermost
 * `{...}` span), then keeps only whitelisted Reservation fields — everything
 * else an LLM invents is dropped, never persisted. Returns `null` when no
 * parseable JSON object is present (chain.ts then treats the attempt as
 * "no output produced" and falls through).
 */
export function extractReservationJson(raw: string): ParseResult["output"] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const field of ALLOWED_FIELDS) {
    if (field in record && record[field] !== undefined) {
      output[field] = record[field];
    }
  }
  return output as Partial<Reservation>;
}

/**
 * Uniform "the call itself failed" ParseResult. Real parsers never throw
 * (chain.ts has no try/catch around parser.parse — a thrown error would
 * abort the whole chain instead of falling through to the next parser);
 * they return this instead, which fails validation downstream.
 */
export function parserError(detail: string): ParseResult {
  return { raw_response: `error: ${detail}`, output: null };
}

/** Reads an API key from options or the environment, tolerating missing --allow-env. */
export function resolveApiKey(explicit: string | undefined, envVar: string): string | undefined {
  if (explicit !== undefined && explicit !== "") return explicit;
  try {
    return Deno.env.get(envVar) ?? undefined;
  } catch {
    return undefined;
  }
}

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
import type { Clock } from "../core/clock/mod.ts";
import type { Reservation } from "../core/schema/mod.ts";
import type { ParseResult } from "./types.ts";

/**
 * Extraction prompt shared by all real LLM parsers. Instructs strict
 * JSON-only output matching the Reservation subset that
 * `extractReservationJson` whitelists.
 *
 * plancel is a SCHEDULE ledger, not an expense tracker (owner feedback,
 * 2026-07-11): the fields that must be read correctly above all else are
 * the DATE/TIME and the PLACE. Amounts/policies matter but are secondary.
 * Pass `todayIso` (a JST calendar date like "2026-07-11") so the model can
 * resolve year-less dates like "8/1" — without it the year-inference rule
 * is omitted entirely rather than letting the model guess.
 */
export function reservationParsePrompt(todayIso?: string): string {
  const dateRules = todayIso === undefined ? "" : `
- 今日の日付は ${todayIso}（日本時間）。年が書かれていない日付（例「8/1」「1/15」）は、今日以降で最も近い将来のその日付として解釈する（過去にしない）。`;

  return `あなたは予約情報の抽出器です。入力（予約確認メール・予約サイトの文面・スクリーンショットなど）から予約情報を抽出し、次のキーだけを持つ JSON オブジェクトを1つだけ出力してください。説明文・前置き・コードフェンスは一切出力しないこと。

最重要フィールドは starts_at（日時）と location（場所）と service_name（どこの予約か）。これは予定管理台帳であり、日時・場所の誤読は金額の誤読より深刻。

{
  "service_name": string,            // 店名・施設名・サービス名（必須。見つからなければ null）
  "provider": string | null,         // 予約経路（例: "食べログ", "Booking.com"。不明なら null）
  "starts_at": string | null,        // 開始日時（宿はチェックイン日時）。タイムゾーンオフセット付き ISO 8601（例 "2026-08-01T19:00:00+09:00"）。日本の予約でオフセット不明なら +09:00 とする。不明なら null
  "ends_at": string | null,          // 終了日時（宿はチェックアウト）。同形式。不明なら null
  "location": string | null,         // 場所。住所・都道府県・市区・駅名・施設内の場所など、書かれていれば必ず抽出する。店名の繰り返しは不可。不明なら null
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
- 推測で値を作らない。入力に書かれていない項目は null（cancellation_policy は "unknown"）。${dateRules}
- 日付は書かれているものを正確に写す。曜日と日付が矛盾する場合は日付を優先する。
- 時刻が書かれていない場合、starts_at は日付のみを 00:00 として表現し、notes に「時刻不明」と書く（チェックイン時刻が明記されていればそれを使う）。
- cancellation_policy.stages は until_offset_hours の降順（遠い順）で並べる。
- 金額はカンマや通貨記号を除いた数値にする。
- 出力は JSON オブジェクトそのもの1つのみ。`;
}

/** Static prompt without the today-date rule (prefer passing a date via
 * `reservationParsePrompt(todayIso)` — kept for callers with no Clock). */
export const RESERVATION_PARSE_PROMPT = reservationParsePrompt();

/** Prompt with the year-inference rule anchored to the clock's JST date. */
export function reservationPromptForClock(clock?: Clock): string {
  if (clock === undefined) return RESERVATION_PARSE_PROMPT;
  const today = clock.now().toZonedDateTimeISO("Asia/Tokyo").toPlainDate().toString();
  return reservationParsePrompt(today);
}

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

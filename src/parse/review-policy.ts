/**
 * Decides when a valid Groq text parse still deserves a second opinion from
 * Gemini. These are deterministic signals only; model self-reported
 * confidence is intentionally ignored.
 */
import type { Clock } from "../core/clock/mod.ts";
import type { ParserReviewReason, Reservation } from "../core/schema/mod.ts";
import type { ValidationResult } from "./validate.ts";
import type { ParseInput } from "./types.ts";
import { extractDateTimes } from "./rules.ts";

const CALENDAR_DATE = /(?:20\d{2}[年\/-]\s*)?\d{1,2}(?:月|[\/-])\s*\d{1,2}(?:日)?/g;
const CHECK_IN = /チェック\s*イン|check[ -]?in/i;
const CHECK_OUT = /チェック\s*アウト|check[ -]?out/i;
const LOCATION_SIGNAL =
  /〒\s*\d{3}-?\d{4}|(?:東京都|北海道|(?:京都|大阪)府|.{2,3}県).{0,24}(?:市|区|町|村)|(?:住所|所在地|会場|アクセス)\s*[:：]/;
const CANCELLATION_SIGNAL = /キャンセル|取消|解約/;
const POLICY_DETAIL = /無料|無償|\d+\s*[%％]|\d[\d,]*\s*円|全額|有料|日前|前日|当日/;

function distinctCalendarDates(text: string): number {
  return new Set(
    [...text.normalize("NFKC").matchAll(CALENDAR_DATE)].map((match) => match[0].replace(/\s/g, "")),
  ).size;
}

/** The JST calendar day of an instant string, or null if it is not one. */
function jstDay(iso: string): string | null {
  try {
    return Temporal.Instant.from(iso).toZonedDateTimeISO("Asia/Tokyo").toPlainDate().toString();
  } catch {
    return null;
  }
}

/**
 * Reasons a valid Groq result should be checked by Gemini.
 *
 * `clock` anchors the rule-based reading of year-less dates (rules.ts) so the
 * model can be held to the days the text actually names. A model that answers
 * a day the mail never mentions is the one wrong answer a schedule ledger
 * cannot afford, and it is detectable without believing the model.
 */
export function parserReviewReasons(
  input: ParseInput,
  output: Partial<Reservation> | null,
  validation: ValidationResult,
  clock?: Clock,
): ParserReviewReason[] {
  if (input.type !== "text" || output === null) return [];

  const reasons: ParserReviewReason[] = [];
  const text = input.content.normalize("NFKC");

  if (clock !== undefined && typeof output.starts_at === "string") {
    const named = extractDateTimes(text, clock).dates;
    const answered = jstDay(output.starts_at);
    // Only when the text names at least one day: a weekday-only mail gives
    // the rules no opinion, and no opinion is not a disagreement.
    if (named.length > 0 && answered !== null && !named.includes(answered)) {
      reasons.push("date_not_in_text");
    }
  }

  if (validation.warnings.length > 0) reasons.push("validation_warning");
  if (distinctCalendarDates(text) >= 2) reasons.push("multiple_calendar_dates");
  if (CHECK_IN.test(text) && CHECK_OUT.test(text)) reasons.push("checkin_checkout");
  if (LOCATION_SIGNAL.test(text) && !output.location?.trim()) reasons.push("location_omitted");
  if (
    CANCELLATION_SIGNAL.test(text) && POLICY_DETAIL.test(text) &&
    (output.cancellation_policy === undefined || output.cancellation_policy === "unknown")
  ) {
    reasons.push("policy_omitted");
  }

  return reasons;
}

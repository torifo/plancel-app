/**
 * Decides when a valid Groq text parse still deserves a second opinion from
 * Gemini. These are deterministic signals only; model self-reported
 * confidence is intentionally ignored.
 */
import type { ParserReviewReason, Reservation } from "../core/schema/mod.ts";
import type { ValidationResult } from "./validate.ts";
import type { ParseInput } from "./types.ts";

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

/** Reasons a valid Groq result should be checked by Gemini. */
export function parserReviewReasons(
  input: ParseInput,
  output: Partial<Reservation> | null,
  validation: ValidationResult,
): ParserReviewReason[] {
  if (input.type !== "text" || output === null) return [];

  const reasons: ParserReviewReason[] = [];
  const text = input.content.normalize("NFKC");

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

/**
 * How a Japanese cancellation policy states its boundaries — the one thing the
 * stage table cannot express and the model has to be trusted with.
 *
 * 「7日前まで無料」 and 「7日前から20%」 name the same day and mean windows a day
 * apart: the first says 7日前 is still free, the second says 7日前 is already a
 * charged day, so the last free moment is 8日前. The stage table records only
 * the number, so once the text is gone the two are indistinguishable — which is
 * why both the chain order (`chainForInput`) and the import-time invariant
 * (`fromCoreStages`) read the phrasing from here rather than guessing from the
 * table.
 */

/**
 * A boundary that a fee STARTS at, with the charge that follows it — 「3日前から
 * 20%」, 「前日より50%」, 「当日以降100%」, 「36時間前から有料」.
 *
 * The charge has to follow the boundary for this to match: 「から」 on its own is
 * far too common a particle to key off, and a reservation mail is full of it
 * (「東京駅から徒歩5分」, 「10:00からチェックイン」, 「3日前から満席のため
 * キャンセル待ち」). A percentage that turns out to be a DISCOUNT
 * (「3日前から20%オフ」) is excluded for the same reason, and it matters more
 * here than it used to: a false match no longer just picks a parser, it
 * overrides the deadline the ledger shows.
 */
const FEE_FROM_BOUNDARY =
  /(?:(\d+)\s*(日|時間)前|(前日|当日))\s*(?:から|より|以降)[^。\n]{0,12}?(?:\d+\s*[%％]|\d+\s*円|全額|有料)(?!\s*(?:オフ|OFF|off|割引|引き|還元|還付|返金))/g;

/** A stated free deadline — 「7日前まで無料」「前日までキャンセル無料」「10日前まで無償」. */
const FREE_DEADLINE_STATED =
  /(?:まで|迄)[^。\n]{0,8}?(?:無料|無償)|(?:無料|無償)[^。\n]{0,8}?(?:まで|迄)/;

/**
 * The same statement written as a fee that is not charged — 「14日前までキャンセル
 * 料はかかりません」「7日前までキャンセル料は不要です」「前日18時までのキャンセルは
 * 料金をいただきません」. A policy states its free window this way as often as it
 * says 無料, and reading only 無料 is not a missed nicety: the from-boundary that
 * then overrides it always sits INSIDE the stated deadline, so the ledger's free
 * deadline moves LATER — it says still free after the facility began charging,
 * and the 24h sweep warns too late.
 *
 * The fee has to be the cancellation's own for this to match, and the deadline
 * has to be in the same clause. Both keep the guard from firing on money that is
 * merely not due yet (「事前決済のため当日のお支払いは不要です」, 「宿泊料金は当日まで
 * お支払いいただきます」): suppressing the correction there would leave a policy
 * with no 0% stage, whose free deadline is null and which the sweep never sees.
 */
const NO_FEE_DEADLINE_STATED =
  /(?:キャンセル|取消|解約)[^。\n]{0,12}?(?:料金?|チャージ|手数料)[^。\n]{0,12}?(?:かかりません|かからない|発生しません|発生いたしません|発生しない|生じません|いただきません|頂きません|頂戴しません|要しません|不要|無し|なし)/;

const DEADLINE_WORD = /まで|迄/;

const CANCELLATION_WORD = /キャンセル|取消|解約/;

/** Does one clause name a deadline for a cancellation fee that is not charged? */
function statesNoFeeDeadline(normalized: string): boolean {
  return normalized.split(/[。\n]/).some((clause) =>
    DEADLINE_WORD.test(clause) && NO_FEE_DEADLINE_STATED.test(clause)
  );
}

/**
 * The last moment that is still free, in whole hours before the start, implied
 * by a policy written as 「N日前から◯%」 — or null when the text does not state
 * itself that way.
 *
 * A boundary named in DAYS covers the whole of that day, and that day is
 * charged, so the free window ends a day earlier: 「7日前から20%」 → 192 (8日前),
 * 「当日から100%」 → 24 (前日). A boundary named in HOURS is an instant and
 * stands as written: 「36時間前から」 → 36, and 「48時間前から」 → 48, which is why
 * the unit has to come from the text rather than from whether the number
 * happens to divide by 24.
 *
 * Null when the text states a free deadline outright — 「7日前まで無料、3日前から
 * 50%」, or the same in the negative (「14日前まではキャンセル料はかかりません」, see
 * `NO_FEE_DEADLINE_STATED`). Such a text names its free window itself, and
 * shifting it off the inner 「から」 boundary would move a deadline the facility
 * spelled out. When several from-boundaries are listed the outermost wins —
 * that is the one the free window ends at.
 */
export function impliedFreeBoundaryHours(text: string): number | null {
  // NFKC first: booking sites write 「３日前から２０％」 in full width, and `\d`
  // is ASCII-only, so without this the correction silently does not apply and
  // the model's own (possibly day-optimistic) boundary stands.
  const normalized = text.normalize("NFKC");
  if (!CANCELLATION_WORD.test(normalized)) return null;
  if (FREE_DEADLINE_STATED.test(normalized) || statesNoFeeDeadline(normalized)) return null;
  let outermost: number | null = null;
  for (const m of normalized.matchAll(FEE_FROM_BOUNDARY)) {
    const named = m[3];
    const hours = named === "前日"
      ? 48 // 前日 is a charged day, so free ends the day before it
      : named === "当日"
      ? 24
      : m[2] === "日"
      ? (Number(m[1]) + 1) * 24
      : Number(m[1]);
    if (!Number.isFinite(hours) || hours < 0) continue;
    if (outermost === null || hours > outermost) outermost = hours;
  }
  return outermost;
}

/** Does this text state its fee from a boundary rather than as a deadline? */
export function statesFeeFromBoundary(text: string): boolean {
  return impliedFreeBoundaryHours(text) !== null;
}

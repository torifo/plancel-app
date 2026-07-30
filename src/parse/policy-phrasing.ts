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
 * キャンセル待ち」).
 */
const FEE_FROM_BOUNDARY =
  /(?:(\d+)\s*(日|時間)前|(前日|当日))\s*(?:から|より|以降)[^。\n]{0,12}?(?:\d+\s*[%％]|\d+\s*円|全額|有料)/g;

/** A stated free deadline — 「7日前まで無料」「前日までキャンセル無料」. */
const FREE_DEADLINE_STATED = /(?:まで|迄)[^。\n]{0,8}?無料|無料[^。\n]{0,8}?(?:まで|迄)/;

const CANCELLATION_WORD = /キャンセル|取消|解約/;

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
 * Null when the text states a free deadline outright: 「7日前まで無料、3日前から
 * 50%」 names its free window itself, and shifting it off the inner 「から」
 * boundary would move a deadline the facility spelled out. When several
 * from-boundaries are listed the outermost wins — that is the one the free
 * window ends at.
 */
export function impliedFreeBoundaryHours(text: string): number | null {
  // NFKC first: booking sites write 「３日前から２０％」 in full width, and `\d`
  // is ASCII-only, so without this the correction silently does not apply and
  // the model's own (possibly day-optimistic) boundary stands.
  const normalized = text.normalize("NFKC");
  if (!CANCELLATION_WORD.test(normalized) || FREE_DEADLINE_STATED.test(normalized)) return null;
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

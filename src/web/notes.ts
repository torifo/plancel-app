/**
 * How long a reservation's notes may be (owner 2026-11-13: 「メモの上限つけないと
 * 長すぎる気がする」). The notes keep only what has no field of its own —
 * 「夕朝食付き」「予約変更不可」 — since seats, amounts, booking numbers, fares and
 * the cancellation rule are fields shown as fields. Two hundred characters (the
 * owner's choice, 2026-11-13: 「200文字にしてください」) is a short paragraph: room
 * for a few such facts, not for a copied rule or a breakdown. Longer notes
 * already stored stay as they are (the stored shape has no limit); the screen
 * folds any note over sixty characters to three lines.
 */
export const NOTES_MAX = 200;

/** A note read out of a mail or a screenshot, cut to fit (the reader may say more than fits). */
export function clipNotes(text: string): string {
  const t = text.trim();
  return t.length > NOTES_MAX ? `${t.slice(0, NOTES_MAX - 1)}…` : t;
}

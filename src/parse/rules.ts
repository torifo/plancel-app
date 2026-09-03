/**
 * Rule-based reading of the dates in a reservation text (ADR-15).
 *
 * The models are the readers of record; this is the floor under them, and
 * the check on them. A floor because every provider can be gone at once — one
 * retired model already took the text path down for days (ADR-13) — and a
 * mail that plainly says 「8月15日(土) 19:00」 should still land in the ledger
 * with that date filled in and only the name left to type. A check because a
 * schedule ledger's worst failure is a confidently wrong date, and a model
 * answering a day the text never mentions is something these patterns can
 * catch without believing anything the model says.
 *
 * Deliberately narrow: dates and times, written the ways confirmation mails
 * write them. Names, places and money stay with the models; this never
 * guesses a weekday's date or an unstated time.
 *
 * Year-less dates follow the prompt's own rule (llm.ts): the nearest such
 * date on or after today, in JST, never in the past.
 */
import type { Clock } from "../core/clock/mod.ts";

const JST = "Asia/Tokyo";

export interface RuleDates {
  /** The first date in the text, with its time if one is attached. */
  starts_at: string | null;
  /** The second date, when the text ties it to the first as a range or a checkout. */
  ends_at: string | null;
  /** Every distinct calendar date named, as YYYY-MM-DD — for cross-checking. */
  dates: string[];
}

interface DateHit {
  index: number;
  /** Where the match (date, weekday, time) ends. */
  end: number;
  year: number | null;
  month: number;
  day: number;
  hour: number | null;
  minute: number;
}

// A date the way a Japanese mail writes it, with an optional weekday and an
// optional time close behind. The day must not run on into more digits
// (「8/150」 is not a date) and 「日」 is required after 月…日 so 「3日前」 on
// its own never counts.
const DATE =
  /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日(?!\d)|(?:(\d{4})[\/-])?(\d{1,2})\/(\d{1,2})(?![\d\/])/g;
const WEEKDAY = /^\s*\(\s*[月火水木金土日]\s*\)/;
// Up to a few separator characters, then a time. 「2名」 is not a time: the
// digits must be followed by 「:」 or 「時」.
const TIME =
  /^[\s:：、]{0,4}(午前|午後)?\s*(\d{1,2})(?::(\d{2})|\s*時\s*(?:(\d{1,2})\s*分|(半))?)(?!\d)/;
// What may sit between two dates for the second to be the end of the first.
const RANGE_BETWEEN = /^[\s]*(?:[〜~\-−―–]|から|より)[\s]*$/;
const CHECKOUT_BEFORE = /チェック\s*アウト|check[ -]?out|(?:退|返)(?:室|却)|まで/i;

function hitAt(text: string, m: RegExpExecArray): DateHit | null {
  const year = m[1] ?? m[4] ?? null;
  const month = Number(m[2] ?? m[5]);
  const day = Number(m[3] ?? m[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let end = m.index + m[0].length;
  const wd = WEEKDAY.exec(text.slice(end));
  if (wd !== null) end += wd[0].length;
  let hour: number | null = null;
  let minute = 0;
  const t = TIME.exec(text.slice(end));
  if (t !== null) {
    hour = Number(t[2]);
    minute = t[3] !== undefined ? Number(t[3]) : t[4] !== undefined ? Number(t[4]) : t[5] ? 30 : 0;
    if (t[1] === "午後" && hour < 12) hour += 12;
    if (t[1] === "午前" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) {
      hour = null;
      minute = 0;
    } else {
      end += t[0].length;
    }
  }
  return {
    index: m.index,
    end,
    year: year === null ? null : Number(year),
    month,
    day,
    hour,
    minute,
  };
}

/** The nearest year in which month/day falls on or after today (JST). */
function inferYear(month: number, day: number, clock: Clock): number {
  const today = clock.now().toZonedDateTimeISO(JST).toPlainDate();
  const thisYear = today.year;
  try {
    const candidate = Temporal.PlainDate.from({ year: thisYear, month, day });
    return Temporal.PlainDate.compare(candidate, today) >= 0 ? thisYear : thisYear + 1;
  } catch {
    // 2/29 in a non-leap year and the like: the next year that has the day.
    return thisYear + 1;
  }
}

function toIso(hit: DateHit, year: number): string | null {
  try {
    const date = Temporal.PlainDate.from({ year, month: hit.month, day: hit.day });
    const time = hit.hour === null ? "00:00" : `${pad(hit.hour)}:${pad(hit.minute)}`;
    return `${date.toString()}T${time}:00+09:00`;
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The attempt name the floor records under; never a parser in the chain config. */
export const RULES_PARSER_NAME = "rules";

/** Reads every date (with attached time) out of `text`. */
export function extractDateTimes(text: string, clock: Clock): RuleDates {
  const normalized = text.normalize("NFKC");
  const hits: DateHit[] = [];
  for (const m of normalized.matchAll(DATE)) {
    const hit = hitAt(normalized, m);
    if (hit !== null) hits.push(hit);
  }
  if (hits.length === 0) return { starts_at: null, ends_at: null, dates: [] };

  // A year stated anywhere earlier in the text carries forward: 「2026年11月3日
  // … チェックアウト 11月4日」 names one year, not a guess about the second.
  let carried: number | null = null;
  const years: number[] = hits.map((h) => {
    if (h.year !== null) carried = h.year;
    return h.year ?? carried ?? inferYear(h.month, h.day, clock);
  });

  const isos = hits.map((h, i) => toIso(h, years[i]!));
  const first = hits[0]!;
  const starts_at = isos[0] ?? null;

  let ends_at: string | null = null;
  if (hits.length >= 2 && isos[1] !== null) {
    const second = hits[1]!;
    const between = normalized.slice(first.end, second.index);
    const tied = RANGE_BETWEEN.test(between) ||
      (between.length <= 24 && CHECKOUT_BEFORE.test(between));
    // A checkout before the check-in is a carried year that should have rolled
    // over (「12月31日 … 1月1日」), not a stay that ends before it begins.
    if (tied) {
      let end = isos[1]!;
      if (starts_at !== null && end < starts_at) end = toIso(second, years[1]! + 1) ?? end;
      ends_at = end;
    }
  }

  const dates = [
    ...new Set(isos.filter((s): s is string => s !== null).map((s) => s.slice(0, 10))),
  ];
  return { starts_at, ends_at, dates };
}

/**
 * Bench — compares a parser's answer against what the text actually says
 * (ADR-13 follow-up).
 *
 * `fixtures/parse/*.json` already carries `expected`, but that is a RECORDING:
 * what the models answered the day the fixture was captured. It is the right
 * gate for replay, which checks that today's extraction code still derives the
 * same output from those frozen responses — and it is useless for judging a
 * new model, because some recorded answers are wrong. `real-restaurant-mail`
 * says the free window is 29 hours; 19:00 minus 前日20時 is 23.
 *
 * So `truth` is a separate, hand-checked field holding only what the text
 * itself determines. Comparing against it is how a model swap is decided in a
 * minute instead of an afternoon of reading JSON.
 *
 * Year-less dates are the reason `starts_at` has three forms. "8/1 19時" fixes
 * a month, a day and a time; which year it means depends on when it is read,
 * so a fixture states `starts_at_md` and the year is not compared. "土曜19時"
 * fixes only a time (`starts_at_time`).
 */
import type { Reservation } from "../core/schema/mod.ts";

export interface FixtureTruth {
  service_name?: string | null;
  /** Full instant, when the text states a year. */
  starts_at?: string | null;
  /** "MM-DDTHH:MM" — the text states month, day and time but not the year. */
  starts_at_md?: string;
  /** "HH:MM" — the text states only a time (a weekday, "来週" and so on). */
  starts_at_time?: string;
  ends_at?: string | null;
  location?: string | null;
  amount_jpy?: number | null;
  /** "168/0,72/30,0/100" or "unknown". */
  policy?: string;
  /** Why the truth is what it is, especially where a recording disagrees. */
  why?: string;
}

export interface BenchMismatch {
  field: string;
  got: string;
  want: string;
}

/** The stage table as a short comparable string; "unknown" when there is none. */
export function policyKey(policy: unknown): string {
  if (policy === "unknown" || policy === null || policy === undefined) return "unknown";
  if (typeof policy !== "object") return "unknown";
  const stages = (policy as { stages?: { until_offset_hours: number; fee_percent: number }[] })
    .stages;
  if (!Array.isArray(stages) || stages.length === 0) return "unknown";
  return stages.map((s) => `${s.until_offset_hours}/${s.fee_percent}`).join(",");
}

const show = (v: unknown): string => (v === undefined ? "(absent)" : JSON.stringify(v));

/**
 * Every way `output` disagrees with `truth`. Fields the fixture does not
 * assert are not compared: silence in `truth` means "the text does not say",
 * never "must be null".
 */
export function compareToTruth(
  output: Partial<Reservation> | null,
  truth: FixtureTruth,
): BenchMismatch[] {
  if (output === null) return [{ field: "output", got: "null", want: "an answer" }];
  const out = output as Record<string, unknown>;
  const mismatches: BenchMismatch[] = [];
  const check = (field: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got ?? null) !== JSON.stringify(want ?? null)) {
      mismatches.push({ field, got: show(got), want: show(want) });
    }
  };

  for (const field of ["service_name", "ends_at", "location", "amount_jpy"] as const) {
    if (field in truth) check(field, out[field], truth[field]);
  }
  if ("starts_at" in truth) check("starts_at", out.starts_at, truth.starts_at);
  if (truth.starts_at_md !== undefined) {
    // "2027-08-01T19:00:00+09:00" -> "08-01T19:00": the year is the reader's,
    // not the text's.
    const got = typeof out.starts_at === "string" ? out.starts_at.slice(5, 16) : null;
    if (got !== truth.starts_at_md) {
      mismatches.push({
        field: "starts_at (月日と時刻)",
        got: show(got),
        want: show(truth.starts_at_md),
      });
    }
  }
  if (truth.starts_at_time !== undefined) {
    const got = typeof out.starts_at === "string" ? out.starts_at.slice(11, 16) : null;
    if (got !== truth.starts_at_time) {
      mismatches.push({
        field: "starts_at (時刻)",
        got: show(got),
        want: show(truth.starts_at_time),
      });
    }
  }
  if (truth.policy !== undefined) {
    const got = policyKey(out.cancellation_policy);
    if (got !== truth.policy) mismatches.push({ field: "policy", got, want: truth.policy });
  }
  return mismatches;
}

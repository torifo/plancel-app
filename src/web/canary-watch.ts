/**
 * The daily provider check, hung off the existing cron (ADR-14).
 *
 * `runCanary` (src/parse/canary.ts) knows how to ask; this decides when, and
 * where the answer goes. Faults become `kind: "system"` reports, so the
 * developer reads "groq stopped answering" in the same list as "the paste
 * failed" — one place to look, which was the whole problem before.
 *
 * The cron fires every 15 minutes and the check is wanted once a day, so the
 * day is claimed BEFORE the providers are asked. A run that hangs or dies
 * therefore does not retry every quarter hour against a provider that is
 * already unhappy — but it is not written off for a whole day either. The
 * very first production run (2026-09-02 14:30 UTC) was cut off mid-flight by
 * the cron's own budget, and a claim-only marker would have silenced the
 * check until the next afternoon. A claimed-but-unfinished run is retried
 * after an hour; a finished one waits the full day.
 */
import type { Clock } from "../core/clock/mod.ts";
import type { Parser } from "../parse/mod.ts";
import { CANARY_INTERVAL_MS, type CanaryFault, runCanary } from "../parse/canary.ts";
import { recordSystemReport, type ReportsDeps } from "./reports.ts";

const MARKER: Deno.KvKey = ["canary_last"];

/** A run that started but never finished is asked again after this long. */
export const CANARY_RETRY_MS = 60 * 60 * 1000;

interface Marker {
  /** When the day was claimed. */
  startedMs: number;
  /** When the providers had all answered; absent while a run is in flight. */
  finishedMs?: number;
}

export interface CanaryWatchDeps {
  clock: Clock;
  parsers: Parser[];
  reports: ReportsDeps;
  /** Overrides the once-a-day spacing (tests). */
  intervalMs?: number;
  /** Overrides how soon an unfinished run is retried (tests). */
  retryMs?: number;
}

export interface CanarySweep {
  ran: boolean;
  checked: string[];
  /** Everything that failed, transient ones included (for the log). */
  faults: CanaryFault[];
  /** How many of those were filed as reports. */
  reported: number;
}

/** Runs the check if a day has passed, and files every fault as a report. */
export async function sweepCanary(deps: CanaryWatchDeps): Promise<CanarySweep> {
  const kv = deps.reports.kv;
  const interval = deps.intervalMs ?? CANARY_INTERVAL_MS;
  const retry = deps.retryMs ?? CANARY_RETRY_MS;
  const nowMs = deps.clock.now().epochMilliseconds;
  const last = (await kv.get<Marker>(MARKER)).value;
  const startedMs = typeof last?.startedMs === "number" ? last.startedMs : 0;
  const finishedMs = typeof last?.finishedMs === "number" ? last.finishedMs : null;
  // A finished run holds the day; an unfinished one holds only an hour.
  const wait = finishedMs !== null ? interval : retry;
  const since = finishedMs ?? startedMs;
  if (nowMs - since < wait) return { ran: false, checked: [], faults: [], reported: 0 };

  // Claimed before asking, so a run that never returns is not retried every
  // fifteen minutes; finished below, so one that never returns is retried
  // within the hour rather than tomorrow.
  await kv.set(MARKER, { startedMs: nowMs } satisfies Marker);

  const { checked, faults } = await runCanary(deps.parsers, deps.clock);
  await kv.set(MARKER, { startedMs: nowMs, finishedMs: nowMs } satisfies Marker);
  // Only the faults that will still be there tomorrow become reports. A
  // provider having a bad minute is logged and forgotten: a list that fills
  // with self-healing noise stops being read, which is the exact failure this
  // was built to end.
  const structural = faults.filter((f) => f.kind === "structural");
  for (const fault of structural) {
    await recordSystemReport(deps.reports, {
      code: "parser_unreachable",
      path: fault.parser,
      detail: fault.error,
    });
  }
  return { ran: true, checked, faults, reported: structural.length };
}

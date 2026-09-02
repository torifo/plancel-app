/**
 * The daily provider check, hung off the existing cron (ADR-14).
 *
 * `runCanary` (src/parse/canary.ts) knows how to ask; this decides when, and
 * where the answer goes. Faults become `kind: "system"` reports, so the
 * developer reads "groq stopped answering" in the same list as "the paste
 * failed" — one place to look, which was the whole problem before.
 *
 * The cron fires every 15 minutes and the check is wanted once a day, so the
 * marker is written BEFORE the providers are asked. A run that hangs or dies
 * therefore waits a day rather than retrying every quarter hour against a
 * provider that is already unhappy.
 */
import type { Clock } from "../core/clock/mod.ts";
import type { Parser } from "../parse/mod.ts";
import { CANARY_INTERVAL_MS, type CanaryFault, runCanary } from "../parse/canary.ts";
import { recordSystemReport, type ReportsDeps } from "./reports.ts";

const MARKER: Deno.KvKey = ["canary_last"];

export interface CanaryWatchDeps {
  clock: Clock;
  parsers: Parser[];
  reports: ReportsDeps;
  /** Overrides the once-a-day spacing (tests). */
  intervalMs?: number;
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
  const nowMs = deps.clock.now().epochMilliseconds;
  const last = await kv.get<{ atMs: number }>(MARKER);
  const atMs = typeof last.value?.atMs === "number" ? last.value.atMs : 0;
  if (nowMs - atMs < interval) return { ran: false, checked: [], faults: [], reported: 0 };

  // Claimed before asking: a run that never returns costs one day, not one
  // retry every fifteen minutes.
  await kv.set(MARKER, { atMs: nowMs });

  const { checked, faults } = await runCanary(deps.parsers, deps.clock);
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

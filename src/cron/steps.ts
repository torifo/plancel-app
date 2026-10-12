/** Independent cron jobs, run in order: one that throws is logged and the rest still run. */
import type { Logger } from "../lib/log.ts";

export interface CronStep {
  name: string;
  run(): Promise<unknown>;
}

/** Runs every step; returns the names of the ones that threw. */
export async function runSteps(
  steps: readonly CronStep[],
  log: Pick<Logger, "error">,
): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (err) {
      failed.push(step.name);
      log.error(`${step.name} failed`, { err: String(err) });
    }
  }
  return failed;
}

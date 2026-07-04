/**
 * Deno Deploy entrypoint (Task 4.1, SDD §6 スケジューラ).
 *
 * Registers a `Deno.cron` job that fires every 15 minutes and delegates the
 * entire tick to `runTick` (SystemClock + KvStore + ConsoleNotifier — LINE
 * arrives later, see notify/notifier.ts). Registration only happens when
 * this module is the Deploy entrypoint (`import.meta.main`) or
 * `PLANCEL_CRON_REGISTER=1` is set, so importing it from tests never
 * registers a real cron job.
 */
import { SystemClock } from "../core/clock/mod.ts";
import { KvStore } from "../core/store/mod.ts";
import { ConsoleNotifier } from "../notify/mod.ts";
import { runTick } from "./tick.ts";

const CRON_NAME = "plancel-boundary-check";
const CRON_SCHEDULE = "*/15 * * * *";

/** Opens real dependencies and runs one tick. */
export async function tick(): Promise<void> {
  const store = await KvStore.open();
  try {
    await runTick({
      store,
      clock: new SystemClock(),
      notifier: new ConsoleNotifier(),
    });
  } finally {
    await store.close();
  }
}

if (import.meta.main || Deno.env.get("PLANCEL_CRON_REGISTER") === "1") {
  Deno.cron(CRON_NAME, CRON_SCHEDULE, tick);
}

/**
 * VPS/systemd-timer entrypoint (Task 4.1, SDD §6 スケジューラ).
 *
 * Runs exactly one tick and exits — a systemd timer (or cron(8)) fires this
 * process every 15 minutes, rather than relying on `Deno.cron`'s in-process
 * scheduler (which is Deno Deploy-only). Same `runTick` core as `main.ts`.
 */
import { SystemClock } from "../core/clock/mod.ts";
import { KvStore } from "../core/store/mod.ts";
import { ConsoleNotifier } from "../notify/mod.ts";
import { runTick } from "./tick.ts";

if (import.meta.main) {
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

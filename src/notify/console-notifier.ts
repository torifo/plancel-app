/**
 * ConsoleNotifier (Task 3.2, SDD §6): the first `Notifier` implementation —
 * standard output only, no external send path — so the fire-decision +
 * Outbox pipeline can be fully debugged before wiring a real channel (LINE,
 * then Email/Resend).
 *
 * Writes two lines per notification: a human-readable formatted line, and a
 * structured JSON Line via `src/lib/log.ts` (both observability, not
 * idempotency — the Outbox already guarantees a notification is only handed
 * to `deliver` once per delivery pass). The writer is injectable so tests
 * can capture output instead of touching real stdout.
 */
import { logger } from "../lib/log.ts";
import type { Notifier } from "./notifier.ts";
import type { PendingNotification } from "./types.ts";

export interface ConsoleNotifierOptions {
  /** Sink for each emitted line. Defaults to `console.log`. */
  write?: (line: string) => void;
}

export class ConsoleNotifier implements Notifier {
  #write: (line: string) => void;
  #log: ReturnType<typeof logger>;

  constructor(options: ConsoleNotifierOptions = {}) {
    this.#write = options.write ?? ((line) => console.log(line));
    this.#log = logger("notify.console", { write: this.#write });
  }

  deliver(n: PendingNotification): Promise<void> {
    this.#write(`[notify] ${n.trigger} ${n.reservation_id}: ${n.message}`);
    this.#log.info("notification delivered", {
      trigger: n.trigger,
      reservation_id: n.reservation_id,
      idempotency_key: n.idempotency_key,
      fire_at: n.fire_at,
    });
    return Promise.resolve();
  }
}

/**
 * LineNotifier (Task 6.2, SDD §6): delivers Outbox notifications as LINE
 * push messages to a single fixed user (personal service, SDD §1).
 *
 * Contract (src/notify/notifier.ts): deliver whatever PendingNotification is
 * given; resolve on success, reject on failure so the Outbox retries. No
 * idempotency tracking here — the Outbox owns that. Push messages consume
 * the LINE free-tier quota (月200通); the fire-decision layer keeps volume
 * low by design (4 sparse triggers, idempotency-keyed).
 */
import { logger } from "../lib/log.ts";
import type { Notifier } from "../notify/notifier.ts";
import type { PendingNotification } from "../notify/types.ts";
import type { LineMessagingClient } from "./types.ts";

export interface LineNotifierOptions {
  client: LineMessagingClient;
  /** LINE userId to push to (the owner's, from LINE_ALLOWED_USER_IDS). */
  to: string;
  /** Sink for structured logs; defaults to console.log via logger(). */
  write?: (line: string) => void;
}

export class LineNotifier implements Notifier {
  #client: LineMessagingClient;
  #to: string;
  #log: ReturnType<typeof logger>;

  constructor(options: LineNotifierOptions) {
    this.#client = options.client;
    this.#to = options.to;
    this.#log = logger(
      "notify.line",
      options.write !== undefined ? { write: options.write } : {},
    );
  }

  async deliver(n: PendingNotification): Promise<void> {
    await this.#client.push(this.#to, [{ type: "text", text: n.message }]);
    this.#log.info("notification delivered", {
      trigger: n.trigger,
      reservation_id: n.reservation_id,
      idempotency_key: n.idempotency_key,
      fire_at: n.fire_at,
    });
  }
}

/**
 * EmailNotifier — Resend-backed Notifier (Task 6.3, SDD §6 implementation
 * order ③).
 *
 * Free-tier note (2026-07, recheck before deploy): Resend's free plan is
 * ~100 emails/day / 3,000 emails/month — far above plancel's notification
 * volume (4 sparse, idempotency-keyed triggers).
 *
 * Contract (notifier.ts): deliver what it is given; reject on failure so
 * the Outbox retries. No idempotency tracking here.
 */
import { logger } from "../lib/log.ts";
import type { Notifier } from "./notifier.ts";
import type { NotificationTrigger, PendingNotification } from "./types.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Human-facing subject prefix per trigger (wording is owner-tunable, SDD §11). */
const SUBJECT_BY_TRIGGER: Record<NotificationTrigger, string> = {
  fee_boundary_24h: "キャンセル料の境界が近づいています",
  plan_settled: "プラン確定 — 要キャンセルの予約があります",
  policy_unknown_digest: "キャンセル規定が不明な予約のまとめ",
  day_of_reminder: "本日の予約リマインド",
};

export interface EmailNotifierOptions {
  apiKey: string;
  /** Sender, e.g. "plancel <notify@example.com>" (Resend-verified domain). */
  from: string;
  /** Recipient address (the owner's). */
  to: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  endpoint?: string;
  /** Sink for structured logs; defaults to console.log via logger(). */
  write?: (line: string) => void;
}

export class EmailNotifier implements Notifier {
  #options: EmailNotifierOptions;
  #fetch: typeof fetch;
  #endpoint: string;
  #log: ReturnType<typeof logger>;

  constructor(options: EmailNotifierOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#endpoint = options.endpoint ?? RESEND_ENDPOINT;
    this.#log = logger(
      "notify.email",
      options.write !== undefined ? { write: options.write } : {},
    );
  }

  async deliver(n: PendingNotification): Promise<void> {
    const res = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.#options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.#options.from,
        to: [this.#options.to],
        subject: `[plancel] ${SUBJECT_BY_TRIGGER[n.trigger]}`,
        text: n.message,
      }),
    });
    if (!res.ok) {
      throw new Error(`resend delivery failed: http ${res.status}: ${await res.text()}`);
    }
    await res.body?.cancel();
    this.#log.info("notification delivered", {
      trigger: n.trigger,
      reservation_id: n.reservation_id,
      idempotency_key: n.idempotency_key,
      fire_at: n.fire_at,
    });
  }
}

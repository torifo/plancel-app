/**
 * Notification value types (Task 3.1, SDD §6, design.md Data Models).
 *
 * `PendingNotification` is the pure output of the fire-decision layer
 * (`src/notify/trigger.ts`). It carries no delivery state — enqueueing,
 * idempotency consumption, retries and the `OutboxEntry` (status / attempts
 * / delivered_at) are owned by Task 3.2 (`src/notify/outbox.ts`). This layer
 * only *decides* what should fire and hands back plain data.
 *
 * The four `trigger` kinds map 1:1 to the four SDD §6 triggers:
 *   1. `fee_boundary_24h`      — 24h before a cancellation-fee boundary
 *   2. `plan_settled`          — a plan settled → "残りN件が要キャンセル" (event-driven)
 *   3. `policy_unknown_digest` — daily digest of `policy: "unknown"` reservations
 *   4. `day_of_reminder`       — morning-of reminder for confirmed reservations
 */

/** The four notification triggers (SDD §6, design.md). */
export const notificationTriggers = [
  "fee_boundary_24h",
  "plan_settled",
  "policy_unknown_digest",
  "day_of_reminder",
] as const;

export type NotificationTrigger = (typeof notificationTriggers)[number];

/**
 * A notification the fire-decision layer says should be delivered.
 *
 * Fields `idempotency_key`, `trigger`, `reservation_id`, `fire_at`,
 * `message` are exactly the design.md `PendingNotification` contract.
 * The remaining fields are optional structured context (loss amounts,
 * boundary instant, digest membership, remaining-to-cancel count) added
 * alongside `message` per the Task 3.1 brief — `message` itself always
 * stays a human-readable Japanese string per the SDD §6 examples.
 */
export interface PendingNotification {
  /** `reservation_id (or plan/digest key) + trigger + 境界時刻(or day)` — see trigger.ts. */
  idempotency_key: string;
  trigger: NotificationTrigger;
  /**
   * The subject id. For `fee_boundary_24h` / `day_of_reminder` this is the
   * reservation id. For `plan_settled` it is the plan id. For
   * `policy_unknown_digest` (which aggregates many reservations) it is the
   * digest sentinel `"digest"`; the members are in `reservation_ids`.
   */
  reservation_id: string;
  /** ISO 8601 datetime (UTC-canonical, ms precision) at which this becomes due. */
  fire_at: string;
  /** Human-readable Japanese body (SDD §6 examples). */
  message: string;

  // --- optional structured context (not part of the core design.md shape) ---
  /** For `fee_boundary_24h`: the fee-increase boundary instant (ISO). */
  boundary_at?: string;
  /** For `fee_boundary_24h`: JPY loss if cancelling now (null when amount unknown). */
  now_loss_jpy?: number | null;
  /** For `fee_boundary_24h`: JPY loss after the boundary is crossed. */
  after_loss_jpy?: number | null;
  /** For `policy_unknown_digest`: the aggregated reservation ids. */
  reservation_ids?: string[];
  /** For `plan_settled`: how many reservations remain in `to_cancel`. */
  remaining_to_cancel?: number;
}

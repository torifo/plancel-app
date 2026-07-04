/**
 * Outbox (Task 3.2, SDD §6, design.md Data Models / KV key design).
 *
 * Two-phase delivery: `enqueue` records fire-decisions (`PendingNotification`,
 * from `notify/trigger.ts`) as `OutboxEntry` rows keyed by `idempotency_key`
 * (`outbox/<idempotency_key>`), deduping anything already present regardless
 * of its status (pending / delivered / failed all count as "already
 * queued") — repeated cron ticks or repeated domain-event publishes within
 * the same idempotency window collapse to a single entry. `deliverPending`
 * then drains `status: "pending"` entries through a `Notifier`, marking each
 * `delivered` on success or bumping `attempts` on failure (→ `failed` once
 * `maxAttempts` is reached, otherwise it stays `pending` for the next
 * delivery pass).
 *
 * Idempotency is owned here, not by `Notifier` implementations (SDD §6):
 * `Notifier.deliver` is called at most once per delivery pass per pending
 * entry, and a delivered/failed entry is never handed to `deliver` again.
 */
import type { Clock } from "../core/clock/mod.ts";
import type { OutboxEntry, Store } from "../core/store/store.ts";
import type { Notifier } from "./notifier.ts";
import type { NotificationTrigger, PendingNotification } from "./types.ts";

/** Default retry ceiling before a pending entry is given up on (→ `failed`). */
const DEFAULT_MAX_ATTEMPTS = 5;

export interface EnqueueResult {
  /** Notifications newly written as fresh `OutboxEntry` rows. */
  enqueued: number;
  /** Notifications skipped because their idempotency_key already existed. */
  deduped: number;
}

export interface DeliverPendingOptions {
  /** Attempts (post-failure) before a pending entry becomes `failed`. Default 5. */
  maxAttempts?: number;
}

export interface DeliverPendingResult {
  /** Entries successfully delivered this pass. */
  delivered: number;
  /** Entries that hit `maxAttempts` this pass and are now `failed`. */
  failed: number;
  /** Entries that failed but remain `pending` for a future retry. */
  retriable: number;
}

/** Reconstructs the `PendingNotification` a `Notifier` expects from a stored `OutboxEntry`. */
function toPendingNotification(entry: OutboxEntry): PendingNotification {
  const {
    idempotency_key,
    trigger,
    reservation_id,
    fire_at,
    message,
    boundary_at,
    now_loss_jpy,
    after_loss_jpy,
    reservation_ids,
    remaining_to_cancel,
  } = entry;
  return {
    idempotency_key,
    // `OutboxEntry.trigger` is a plain string at the Store layer (core must
    // not depend on notify's closed union, see schema/outbox-entry.ts) —
    // narrowed back here since it only ever originates from `enqueue`.
    trigger: trigger as NotificationTrigger,
    reservation_id,
    fire_at,
    message,
    ...(boundary_at !== undefined ? { boundary_at } : {}),
    ...(now_loss_jpy !== undefined ? { now_loss_jpy } : {}),
    ...(after_loss_jpy !== undefined ? { after_loss_jpy } : {}),
    ...(reservation_ids !== undefined ? { reservation_ids } : {}),
    ...(remaining_to_cancel !== undefined ? { remaining_to_cancel } : {}),
  };
}

export class Outbox {
  #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  /** Idempotently enqueues fire-decisions; an existing idempotency_key (any status) is a no-op. */
  async enqueue(notifications: PendingNotification[]): Promise<EnqueueResult> {
    let enqueued = 0;
    let deduped = 0;
    for (const n of notifications) {
      const existing = await this.#store.getOutboxEntry(n.idempotency_key);
      if (existing) {
        deduped++;
        continue;
      }
      const entry: OutboxEntry = {
        ...n,
        status: "pending",
        attempts: 0,
        delivered_at: null,
      };
      await this.#store.putOutboxEntry(entry);
      enqueued++;
    }
    return { enqueued, deduped };
  }

  /** Drains `pending` entries through `notifier`, applying retry/give-up bookkeeping. */
  async deliverPending(
    notifier: Notifier,
    clock: Clock,
    opts: DeliverPendingOptions = {},
  ): Promise<DeliverPendingResult> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const pending = await this.#store.listOutboxEntries({ status: "pending" });

    let delivered = 0;
    let failed = 0;
    let retriable = 0;

    for (const entry of pending) {
      try {
        await notifier.deliver(toPendingNotification(entry));
        await this.#store.putOutboxEntry({
          ...entry,
          status: "delivered",
          delivered_at: clock.now().toString({ smallestUnit: "millisecond" }),
        });
        delivered++;
      } catch {
        const attempts = entry.attempts + 1;
        if (attempts >= maxAttempts) {
          await this.#store.putOutboxEntry({ ...entry, attempts, status: "failed" });
          failed++;
        } else {
          await this.#store.putOutboxEntry({ ...entry, attempts });
          retriable++;
        }
      }
    }

    return { delivered, failed, retriable };
  }
}

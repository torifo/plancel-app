/**
 * runTick — the entire cron scheduler logic (Task 4.1, SDD §6 スケジューラ,
 * design.md cron component).
 *
 * Deliberately a THIN, storage/transport-agnostic layer: read the Clock →
 * call the fire-decision (`computePendingNotifications`, Task 3.1) → enqueue
 * (`Outbox.enqueue`, Task 3.2) → deliver (`Outbox.deliverPending`). All the
 * actual decision logic already has its own tests (Task 3.1/3.2); this file
 * only wires them together once per tick and only needs a smoke test.
 *
 * `main.ts` (Deno Deploy `Deno.cron`) and `vps_main.ts` (systemd-timer
 * run-once) are the two entrypoints that call this with real dependencies;
 * tests call it directly with `InMemoryStore` + `VirtualClock`.
 */
import type { Clock } from "../core/clock/mod.ts";
import type { Store } from "../core/store/mod.ts";
import { computePendingNotifications, Notifier, Outbox } from "../notify/mod.ts";
import { logger, newCorrelationId } from "../lib/log.ts";

export interface TickDeps {
  store: Store;
  clock: Clock;
  notifier: Notifier;
  /** Injectable for tests; defaults to `new Outbox(store)`. */
  outbox?: Outbox;
}

export interface TickResult {
  /** Notifications the fire-decision layer says are due this tick. */
  computed: number;
  /** Newly written outbox entries (fresh idempotency_keys). */
  enqueued: number;
  /** Skipped because their idempotency_key was already queued. */
  deduped: number;
  /** Entries successfully delivered this pass. */
  delivered: number;
  /** Entries that hit maxAttempts this pass and are now `failed`. */
  failed: number;
  /** Entries that failed but remain `pending` for a future tick. */
  retriable: number;
}

const log = logger("cron.tick");

/**
 * Runs one scheduler tick: load reservations+plans → compute due
 * notifications → enqueue → deliver. Logs a start/end JSON line (SDD §10.5)
 * tagged with a fresh correlation_id per tick.
 */
export async function runTick(deps: TickDeps): Promise<TickResult> {
  const { store, clock, notifier } = deps;
  const outbox = deps.outbox ?? new Outbox(store);
  const correlation_id = newCorrelationId();

  log.info("tick start", { correlation_id });

  const [reservations, plans] = await Promise.all([
    store.listReservations(),
    store.listPlans(),
  ]);
  const pending = computePendingNotifications({ reservations, plans }, clock);
  const { enqueued, deduped } = await outbox.enqueue(pending);
  const { delivered, failed, retriable } = await outbox.deliverPending(notifier, clock);

  const result: TickResult = {
    computed: pending.length,
    enqueued,
    deduped,
    delivered,
    failed,
    retriable,
  };
  log.info("tick end", { correlation_id, ...result });
  return result;
}

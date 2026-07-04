/**
 * Domain-event subscription glue (Task 3.2, SDD §6/§10.2, design.md
 * confirm → auto_to_cancel → notify sequence).
 *
 * Deliberately a plain function, not a global event bus: state-transition
 * code appends events to the Store and then calls `onEventsAppended` itself
 * (see design.md's sequence diagram — `E->>T: publish(events)`). This keeps
 * notification firing decoupled from the transition code's *logic* — the
 * transition functions in `core/domain` never import from `notify` — while
 * keeping the wiring simple and explicit rather than implicit/global.
 */
import type { Clock } from "../core/clock/mod.ts";
import type { DomainEvent, Reservation } from "../core/schema/mod.ts";
import type { Store } from "../core/store/store.ts";
import { Outbox } from "./outbox.ts";
import { notificationsForEvents } from "./trigger.ts";

/**
 * Call this after appending `events` to `store` (e.g. right after
 * `eventlog.append`). Computes any event-driven notifications (currently
 * `plan_settled`, see `trigger.ts`) and enqueues them onto the Outbox.
 *
 * `context.reservations` should be the post-transition reservation snapshot
 * (so plan_settled's "残りN件" count reflects the current world), matching
 * `notificationsForEvents`'s contract.
 */
export async function onEventsAppended(
  store: Store,
  events: DomainEvent[],
  context: { reservations: Reservation[] },
  clock: Clock,
): Promise<void> {
  const notifications = notificationsForEvents(events, context, clock);
  if (notifications.length === 0) return;
  const outbox = new Outbox(store);
  await outbox.enqueue(notifications);
}

/**
 * append — batch-append DomainEvents to a Store, preserving order (Task 2.3).
 */
import type { Store } from "../store/store.ts";
import type { DomainEvent } from "../schema/domain-event.ts";

/**
 * Appends `events` to `store` one at a time, in array order. `Store.appendEvent`
 * is append-only (rejects duplicate ids), so a failure partway through leaves
 * the earlier events committed and throws on the first rejected one — callers
 * that need all-or-nothing semantics should pre-validate ids are fresh.
 */
export async function append(store: Store, events: readonly DomainEvent[]): Promise<void> {
  for (const event of events) {
    await store.appendEvent(event);
  }
}

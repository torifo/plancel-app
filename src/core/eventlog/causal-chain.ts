/**
 * causalChain — walk `caused_by` links back to the root cause (Task 2.3,
 * SDD §10.2: "why is this reservation to_cancel must always be explainable
 * via the caused_by chain").
 */
import type { DomainEvent } from "../schema/domain-event.ts";

/**
 * Returns the causal chain ending at `eventId`, ordered root-first (the
 * event with `caused_by: null` comes first, `eventId`'s own event comes
 * last). Returns `[]` if `eventId` is not found in `events`. Throws if a
 * `caused_by` cycle is detected (a corrupted log), rather than looping
 * forever.
 */
export function causalChain(events: readonly DomainEvent[], eventId: string): DomainEvent[] {
  const byId = new Map(events.map((e) => [e.id, e] as const));

  const start = byId.get(eventId);
  if (!start) return [];

  const chain: DomainEvent[] = [];
  const visited = new Set<string>();
  let current: DomainEvent | undefined = start;

  while (current) {
    if (visited.has(current.id)) {
      throw new Error(`causalChain: cycle detected in caused_by chain at event ${current.id}`);
    }
    visited.add(current.id);
    chain.push(current);

    if (current.caused_by === null) break;
    current = byId.get(current.caused_by);
  }

  chain.reverse();
  return chain;
}

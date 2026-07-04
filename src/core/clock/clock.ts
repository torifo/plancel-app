/**
 * Clock abstraction (FR-008 / SDD §10.1).
 *
 * All domain logic must receive time via a `Clock` instead of reading
 * system time directly (see FR-008). This makes boundary/deadline behavior
 * deterministic and testable via `VirtualClock`.
 */

/** Supplies the current instant. Inject this instead of reading system time directly. */
export interface Clock {
  now(): Temporal.Instant;
}

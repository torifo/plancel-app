/**
 * VirtualClock: deterministic, manually-controlled clock for tests and the
 * "advance N days and see what happens" dev workflow (SDD §10.1).
 */

import type { Clock } from "./clock.ts";

export class VirtualClock implements Clock {
  #instant: Temporal.Instant;

  constructor(initial: Temporal.Instant | string) {
    this.#instant = typeof initial === "string" ? Temporal.Instant.from(initial) : initial;
  }

  now(): Temporal.Instant {
    return this.#instant;
  }

  /** Sets the clock to an absolute instant. */
  set(instant: Temporal.Instant | string): void {
    this.#instant = typeof instant === "string" ? Temporal.Instant.from(instant) : instant;
  }

  /**
   * Advances the clock by a duration, accepting either a `Temporal.Duration`
   * or an ISO-8601 duration string (e.g. "P3D", "PT15M").
   *
   * `Temporal.Instant.add` only accepts time-unit durations (it rejects
   * date units like days), so date-containing durations are applied via a
   * UTC `ZonedDateTime` round-trip instead.
   */
  advance(duration: Temporal.Duration | string): void {
    const d = typeof duration === "string" ? Temporal.Duration.from(duration) : duration;
    this.#instant = this.#instant.toZonedDateTimeISO("UTC").add(d).toInstant();
  }
}

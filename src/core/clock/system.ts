/**
 * SystemClock: the only place outside tests/log allowed to read system time.
 * Allowlisted in scripts/no_direct_date_check.ts.
 */

import type { Clock } from "./clock.ts";

export class SystemClock implements Clock {
  now(): Temporal.Instant {
    return Temporal.Now.instant();
  }
}

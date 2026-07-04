/**
 * Rule-based validation — the actual accuracy guarantee of the parse
 * pipeline (SDD §5 ルールベース検証). LLM confidence self-reporting is never
 * used; every parser output is machine-checked against these rules before
 * it is allowed to short-circuit the fallback chain (chain.ts).
 *
 * Rules (SDD §5 / §3.3):
 *   - required: service_name, starts_at
 *   - starts_at not in the past — a WARNING, not a failure (needs
 *     human confirmation, does not block the chain)
 *   - cancellation deadline <= starts_at (i.e. every stage's
 *     until_offset_hours must be >= 0 — a negative offset would place the
 *     deadline after starts_at)
 *   - amount_jpy >= 0
 *   - cancellation_policy stage monotonicity (SDD §3.3), reusing
 *     cancellationPolicySchema so the rule has a single source of truth
 */
import type { Clock } from "../core/clock/mod.ts";
import { cancellationPolicySchema, type Reservation } from "../core/schema/mod.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateParsedOutput(
  output: Partial<Reservation> | null,
  clock: Clock,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!output) {
    return { ok: false, errors: ["no output produced"], warnings: [] };
  }

  if (!isNonEmptyString(output.service_name)) {
    errors.push("missing required field: service_name");
  }

  if (output.starts_at === undefined || output.starts_at === null || output.starts_at === "") {
    errors.push("missing required field: starts_at");
  } else {
    let startsAt: Temporal.Instant | null = null;
    try {
      startsAt = Temporal.Instant.from(output.starts_at);
    } catch {
      errors.push("starts_at is not a valid ISO 8601 datetime");
    }

    if (startsAt !== null) {
      if (Temporal.Instant.compare(startsAt, clock.now()) < 0) {
        warnings.push("starts_at is in the past; requires confirmation");
      }
    }
  }

  if (output.amount_jpy !== undefined && output.amount_jpy !== null) {
    if (typeof output.amount_jpy !== "number" || output.amount_jpy < 0) {
      errors.push("amount_jpy must be >= 0");
    }
  }

  if (
    output.cancellation_policy !== undefined &&
    output.cancellation_policy !== null &&
    output.cancellation_policy !== "unknown"
  ) {
    const parsed = cancellationPolicySchema.safeParse(output.cancellation_policy);
    if (!parsed.success) {
      errors.push(
        `cancellation_policy is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    } else {
      for (const stage of parsed.data.stages) {
        if (stage.until_offset_hours < 0) {
          errors.push(
            `cancellation deadline exceeds starts_at (until_offset_hours=${stage.until_offset_hours} is negative)`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

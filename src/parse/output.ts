import type { ParseAttempt, ParseJob } from "../core/schema/mod.ts";

/** A rule-valid attempt. Warnings ask for review but do not invalidate output. */
export function isUsableParseAttempt(attempt: ParseAttempt): boolean {
  return attempt.output !== null &&
    attempt.validation_errors.every((message) => message.startsWith("warning: "));
}

/**
 * Merges rule-valid outputs in chain order. A failed reviewer can never
 * overwrite the valid primary result; a valid later reviewer may add fields.
 */
export function mergedParsedOutput(job: Pick<ParseJob, "attempts">): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const usable = job.attempts.filter(isUsableParseAttempt);
  // Preserve partial fields for the existing needs-review form when no
  // provider produced a complete result. Once one valid result exists,
  // invalid reviewer output must not contaminate it.
  const sources = usable.length > 0 ? usable : job.attempts.filter((attempt) => attempt.output);
  for (const attempt of sources) {
    for (const [key, value] of Object.entries(attempt.output!)) {
      if (value !== undefined && value !== null) merged[key] = value;
    }
  }
  return merged;
}

/** Last rule-valid output, matching the chain's later-valid-result preference. */
export function lastUsableParseOutput(
  job: Pick<ParseJob, "attempts">,
): ParseAttempt["output"] {
  return job.attempts.findLast(isUsableParseAttempt)?.output ??
    job.attempts.findLast((attempt) => attempt.output !== null)?.output ?? null;
}

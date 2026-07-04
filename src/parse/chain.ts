/**
 * Validation-driven parser fallback chain (SDD §5, FR-011, US-006).
 *
 * Flow per SDD §5:
 *   PII mask (mandatory, always first) → try parsers in configured order
 *   for the input type → first attempt that passes rule-based validation
 *   wins → but if any two attempts produced *different* values for the
 *   same field, that field becomes a FieldConflict and the job is bumped
 *   to `needs_review` even if a winner was found (a human must pick one
 *   value with a single tap — never asked to retype anything, SDD §5).
 *
 * `status` decision table:
 *   - a winner exists, no field conflicts            -> "parsed"
 *   - a winner exists, but field conflicts exist      -> "needs_review"
 *   - no winner, but some attempt produced output     -> "needs_review"
 *     (missing/invalid fields only — see missingFieldQuestions())
 *   - no winner, every attempt's output is null        -> "failed"
 *     (nothing at all could be extracted from the input)
 */
import type { Clock } from "../core/clock/mod.ts";
import type { FieldConflict, ParseAttempt, ParseJob, Reservation } from "../core/schema/mod.ts";
import { maskPii } from "./pii-mask.ts";
import type { ParseInput, Parser } from "./types.ts";
import type { ParserChainConfig } from "./config.ts";
import { validateParsedOutput } from "./validate.ts";

export interface ParseChainIds {
  ulid(): string;
  /** Returns an ISO 8601 datetime string for ParseJob.created_at. */
  nowIso(): string;
}

/**
 * Detects fields whose value differs across attempts that produced
 * non-null output. Only fields present (non-null/undefined) in more than
 * one attempt are considered — a field appearing in just one attempt is
 * not a disagreement, just partial information.
 */
function detectFieldConflicts(attempts: ParseAttempt[]): FieldConflict[] {
  const byField = new Map<string, { parser: string; value: unknown }[]>();

  for (const attempt of attempts) {
    if (!attempt.output) continue;
    for (const [field, value] of Object.entries(attempt.output)) {
      if (value === undefined || value === null) continue;
      const options = byField.get(field) ?? [];
      options.push({ parser: attempt.parser, value });
      byField.set(field, options);
    }
  }

  const conflicts: FieldConflict[] = [];
  for (const [field, options] of byField) {
    const distinctValues = new Set(options.map((o) => JSON.stringify(o.value)));
    if (distinctValues.size > 1) {
      conflicts.push({ field, options });
    }
  }
  return conflicts;
}

/**
 * Derives a human-facing list of missing/invalid field questions from
 * attempts that failed validation — used by consumers (e.g. the LINE bot,
 * Task 6.2) to ask only about what's missing, never for full re-entry.
 */
export function missingFieldQuestions(job: ParseJob): string[] {
  const questions = new Set<string>();
  for (const attempt of job.attempts) {
    for (const err of attempt.validation_errors) {
      if (err.startsWith("missing required field: ")) {
        questions.add(err.replace("missing required field: ", ""));
      }
    }
  }
  return [...questions];
}

/**
 * Runs the configured parser chain for `input.type` against `input`,
 * applying mandatory PII masking first, and returns a fully-populated
 * ParseJob (not yet persisted — callers use core/store's putParseJob).
 */
export async function runParseChain(
  input: ParseInput,
  config: ParserChainConfig,
  parsers: Parser[],
  clock: Clock,
  ids: ParseChainIds,
): Promise<ParseJob> {
  const { masked } = maskPii(input.content);
  const maskedInput: ParseInput = { ...input, content: masked };

  const chainNames = config[input.type];
  const byName = new Map(parsers.map((p) => [p.name, p]));

  const attempts: ParseAttempt[] = [];
  let winnerFound = false;

  for (const name of chainNames) {
    const parser = byName.get(name);
    if (!parser || !parser.supports(maskedInput)) continue;

    const result = await parser.parse(maskedInput);
    const validation = validateParsedOutput(result.output, clock);

    const validationMessages = [
      ...validation.errors,
      ...validation.warnings.map((w) => `warning: ${w}`),
    ];

    const output: Partial<Reservation> | null = result.output;
    attempts.push({
      parser: parser.name,
      raw_response: result.raw_response,
      output,
      validation_errors: validationMessages,
      correlation_id: input.correlation_id,
    });

    if (validation.ok) {
      winnerFound = true;
      break;
    }
  }

  const conflicts = detectFieldConflicts(attempts);
  const hasAnyOutput = attempts.some((a) => a.output !== null);

  let status: ParseJob["status"];
  if (winnerFound && conflicts.length === 0) {
    status = "parsed";
  } else if (winnerFound || hasAnyOutput) {
    status = "needs_review";
  } else {
    status = "failed";
  }

  return {
    id: ids.ulid(),
    input_type: input.type,
    raw_input: input.content,
    attempts,
    status,
    conflicts,
    created_at: ids.nowIso(),
  };
}

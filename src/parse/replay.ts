/**
 * Replay harness — regression-tests the parse chain against recorded
 * ParseJobs without any LLM connection (SDD §10.4, §10.5, Task 5.2).
 *
 * Flow: a stored `ParseJob` (raw_input + attempts[].raw_response fully
 * saved, chain.ts) is captured as a `ReplayFixture`. `FixtureParser` builds
 * one `Parser` per recorded attempt that deterministically replays its
 * `raw_response` verbatim — so `replayJob` can push the fixture's
 * `raw_input` back through the CURRENT `runParseChain`/`validateParsedOutput`
 * logic (prompt/parser code may have changed since the job was recorded,
 * but the LLM responses are frozen) and diff the fresh outcome against the
 * fixture's `expected` snapshot. `replayAll` runs this over a whole fixture
 * directory as a CI-able regression gate (see `src/cli/replay.ts`).
 */
import type { Clock } from "../core/clock/mod.ts";
import type { FieldConflict, ParseAttempt, ParseJob, ParseJobStatus } from "../core/schema/mod.ts";
import type { ParserChainConfig } from "./config.ts";
import type { ParseChainIds } from "./chain.ts";
import { runParseChain } from "./chain.ts";
import type { ParseInput, ParseInputType, Parser, ParseResult } from "./types.ts";

/** Same shape as `ParseAttempt.output` (schema-derived partial, not TS's
 * mapped `Partial<Reservation>`) so assignments type-check cleanly under
 * `exactOptionalPropertyTypes`. */
type ParsedOutput = ParseAttempt["output"];
/** Same shape as `ParseResult.output` — structurally equal to `ParsedOutput`
 * but kept distinct since `Parser.parse()` return values are checked against
 * `ParseResult`, not `ParseAttempt`, under `exactOptionalPropertyTypes`. */
type ParseResultOutput = ParseResult["output"];

/** A single recorded parser attempt, frozen for replay. */
export interface ReplayFixtureAttempt {
  parser: string;
  raw_response: string;
}

/** The expected outcome a fixture was recorded (or last verified) against. */
export interface ReplayExpected {
  status: ParseJobStatus;
  output?: ParsedOutput;
  conflicts?: FieldConflict[];
}

/** A recorded ParseJob, reduced to what replay needs: inputs, LLM responses,
 * and the expected outcome to diff fresh replays against. */
export interface ReplayFixture {
  /** Optional human-facing label (e.g. filename stem); not used for replay logic. */
  name?: string;
  raw_input: string;
  input_type: ParseInputType;
  attempts: ReplayFixtureAttempt[];
  expected: ReplayExpected;
}

/**
 * Extracts a `ReplayFixture` from a stored `ParseJob` — the recording half
 * of the harness (SDD §10.4: "記録済みデータをフィクスチャとして再実行").
 * The job's own outcome becomes `expected`; the winning attempt's output (if
 * any) is carried through so a later replay can detect output drift, not
 * just status drift.
 */
export function recordFixture(job: ParseJob): ReplayFixture {
  const winner = job.attempts.find((a) => a.validation_errors.length === 0);
  return {
    raw_input: job.raw_input,
    input_type: job.input_type,
    attempts: job.attempts.map((a) => ({ parser: a.parser, raw_response: a.raw_response })),
    expected: {
      status: job.status,
      output: winner ? winner.output : job.attempts.at(-1)?.output ?? null,
      conflicts: job.conflicts,
    },
  };
}

/**
 * Default `parseResponse`: JSON-parses `raw_response` and treats it as the
 * output directly — matches how the fixtures in `fixtures/parse/` and
 * `MockParser` record responses (Task 5.1/5.2; real LLM parsers, Task 6.1,
 * pass their own `parseResponse` to re-derive output through current
 * response-parsing logic). Falls back to `null` (unparseable response) on
 * any JSON error, which correctly fails validation downstream.
 */
function defaultParseResponse(raw_response: string): ParseResultOutput {
  try {
    return JSON.parse(raw_response) as ParseResultOutput;
  } catch {
    return null;
  }
}

/**
 * Builds a `Parser` named `attempt.parser` that always returns
 * `attempt.raw_response` verbatim for a matching input, regardless of
 * content — a fixture attempt is a frozen LLM call, not a pattern match.
 * `output` is re-derived from `raw_response` via `parseResponse` (defaults
 * to JSON-parsing it, see `defaultParseResponse`) so replay exercises
 * whatever the CURRENT response-parsing logic does with the frozen
 * response, not just the frozen output.
 */
export function FixtureParser(
  attempt: ReplayFixtureAttempt,
  parseResponse: (raw_response: string) => ParseResultOutput = defaultParseResponse,
): Parser {
  return {
    name: attempt.parser,
    supports: () => true,
    parse(_input: ParseInput): Promise<ParseResult> {
      const output = parseResponse(attempt.raw_response);
      return Promise.resolve({ raw_response: attempt.raw_response, output });
    },
  };
}

/** A single before/after divergence found by `replayJob`. */
export interface ReplayDiffChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** Outcome of replaying one fixture: identical to `expected`, or a diff. */
export interface ReplayDiff {
  identical: boolean;
  changes: ReplayDiffChange[];
}

function diffOutcome(expected: ReplayExpected, job: ParseJob): ReplayDiff {
  const changes: ReplayDiffChange[] = [];

  if (expected.status !== job.status) {
    changes.push({ field: "status", before: expected.status, after: job.status });
  }

  if (expected.output !== undefined) {
    const before = JSON.stringify(expected.output);
    const winner = job.attempts.find((a) => a.validation_errors.length === 0);
    const after = JSON.stringify(winner ? winner.output : job.attempts.at(-1)?.output ?? null);
    if (before !== after) {
      changes.push({ field: "output", before: expected.output, after: winner?.output ?? null });
    }
  }

  if (expected.conflicts !== undefined) {
    const before = JSON.stringify(expected.conflicts);
    const after = JSON.stringify(job.conflicts);
    if (before !== after) {
      changes.push({ field: "conflicts", before: expected.conflicts, after: job.conflicts });
    }
  }

  return { identical: changes.length === 0, changes };
}

/**
 * Re-runs a fixture's recorded raw_responses through the CURRENT
 * `runParseChain` (i.e. current chain config + validation logic) and diffs
 * the fresh outcome against the fixture's `expected` snapshot. No network
 * call is made — every attempt is served by a `FixtureParser` built from
 * the fixture's own recorded responses, in the fixture's original order.
 *
 * `parseResponse` (optional) lets a caller re-derive `output` from each
 * raw_response using the real (current) parser's response-parsing step, so
 * a fixture built before a prompt/parsing-logic change actually exercises
 * that change on replay rather than just replaying frozen output too. When
 * omitted, each attempt's output is `null` and only validation itself (plus
 * the chain's fallback semantics) is exercised.
 */
export async function replayJob(
  fixture: ReplayFixture,
  config: ParserChainConfig,
  clock: Clock,
  ids: ParseChainIds,
  parseResponse?: (raw_response: string) => ParseResultOutput,
): Promise<{ job: ParseJob; diff: ReplayDiff }> {
  const parsers = fixture.attempts.map((a) => FixtureParser(a, parseResponse));
  const input: ParseInput = {
    type: fixture.input_type,
    content: fixture.raw_input,
    correlation_id: `replay-${fixture.name ?? "fixture"}`,
  };

  const job = await runParseChain(input, config, parsers, clock, ids);
  const diff = diffOutcome(fixture.expected, job);
  return { job, diff };
}

/** Aggregate result of `replayAll`: counts plus a human-readable report. */
export interface ReplayAllResult {
  total: number;
  identical: number;
  changed: number;
  report: string;
}

/**
 * Runs `replayJob` over every fixture (a regression corpus, e.g.
 * `fixtures/parse/`) and produces a summary + per-fixture report line. This
 * is the function the CI-able CLI (`src/cli/replay.ts`) drives.
 */
export async function replayAll(
  fixtures: ReplayFixture[],
  config: ParserChainConfig,
  clock: Clock,
  ids: ParseChainIds,
  parseResponse?: (raw_response: string) => ParseResultOutput,
): Promise<ReplayAllResult> {
  const lines: string[] = [];
  let identical = 0;
  let changed = 0;

  for (const fixture of fixtures) {
    const label = fixture.name ?? fixture.raw_input.slice(0, 24);
    const { diff } = await replayJob(fixture, config, clock, ids, parseResponse);
    if (diff.identical) {
      identical += 1;
      lines.push(`[identical] ${label}`);
    } else {
      changed += 1;
      lines.push(`[changed]   ${label}`);
      for (const c of diff.changes) {
        lines.push(
          `            ${c.field}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`,
        );
      }
    }
  }

  const total = fixtures.length;
  lines.push(`\n${identical}/${total} identical, ${changed}/${total} changed`);

  return { total, identical, changed, report: lines.join("\n") };
}

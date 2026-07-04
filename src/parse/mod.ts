/**
 * Barrel export for the parse pipeline (Task 5.1, FR-011, SDD §5).
 */
export type { ParseInput, ParseInputType, Parser, ParseResult } from "./types.ts";
export { maskPii } from "./pii-mask.ts";
export type { PiiKind, PiiMaskResult, PiiMatch } from "./pii-mask.ts";
export { validateParsedOutput } from "./validate.ts";
export type { ValidationResult } from "./validate.ts";
export { missingFieldQuestions, runParseChain } from "./chain.ts";
export type { ParseChainIds } from "./chain.ts";
export { loadParserChainConfig, UnknownParserError, validateParserChainConfig } from "./config.ts";
export type { ParserChainConfig } from "./config.ts";
export { MockParser } from "./mock-parser.ts";
export type { MockFixture, MockFixtureMatcher, MockParserOptions } from "./mock-parser.ts";
export { FixtureParser, recordFixture, replayAll, replayJob } from "./replay.ts";
export type {
  ReplayAllResult,
  ReplayDiff,
  ReplayDiffChange,
  ReplayExpected,
  ReplayFixture,
  ReplayFixtureAttempt,
} from "./replay.ts";

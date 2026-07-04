/**
 * MockParser — canned-response Parser for tests and L4 development without
 * any real LLM connection (SDD §10.4). Real providers (Groq/Gemini) are
 * Task 6.1; this is the only Parser implementation for Task 5.1.
 */
import type { ParseInput, Parser, ParseResult } from "./types.ts";

export interface MockFixture {
  raw_response: string;
  output: ParseResult["output"];
}

export type MockFixtureMatcher = (input: ParseInput) => MockFixture | undefined;

export interface MockParserOptions {
  /** Restricts which input types this parser accepts. Defaults to all. */
  supports?: (input: ParseInput) => boolean;
}

const NO_MATCH: ParseResult = { raw_response: "", output: null };

/**
 * Builds a Parser whose responses are looked up from `fixtures`, keyed by
 * `input.content` (the exact string the parser receives, i.e. the
 * PII-masked text — see chain.ts). A function may be passed instead of a
 * Map for pattern-based matching.
 */
export function MockParser(
  name: string,
  fixtures: Map<string, MockFixture> | MockFixtureMatcher,
  options: MockParserOptions = {},
): Parser {
  const lookup: MockFixtureMatcher = typeof fixtures === "function"
    ? fixtures
    : (input) => fixtures.get(input.content);

  return {
    name,
    supports: options.supports ?? (() => true),
    parse: (input) => Promise.resolve(lookup(input) ?? NO_MATCH),
  };
}

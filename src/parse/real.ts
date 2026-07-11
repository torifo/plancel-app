/**
 * Real-provider parser registry (Task 6.1, ADR-5, SDD §5).
 *
 * The production chain: text = Groq (primary) → Gemini Flash (secondary);
 * image = Gemini Flash only (vision 固定). `parsers.config.json` declares
 * the same chain since the 2026-07-11 cutover; the replay corpus in
 * `fixtures/parse/` is the regression gate for any prompt/chain change.
 */
import type { Clock } from "../core/clock/mod.ts";
import type { Parser } from "./types.ts";
import type { ParserChainConfig } from "./config.ts";
import { GroqParser, type GroqParserOptions } from "./groq.ts";
import { GeminiParser, type GeminiParserOptions } from "./gemini.ts";

/** The intended production contents of parsers.config.json (SDD §5). */
export const REAL_CHAIN_CONFIG: ParserChainConfig = {
  text: ["groq-llama", "gemini-flash"],
  image: ["gemini-flash"],
};

export interface RealParsersOptions {
  groq?: GroqParserOptions;
  gemini?: GeminiParserOptions;
  /** Applied to both parsers unless their own options set one — anchors the
   * prompt's year-inference rule (owner feedback 2026-07-11: dates and
   * places are the first-class extraction targets). */
  clock?: Clock;
}

/** All real parser implementations, ready to hand to runParseChain. */
export function realParsers(options: RealParsersOptions = {}): Parser[] {
  const clock = options.clock;
  const groq = { ...(clock !== undefined ? { clock } : {}), ...options.groq };
  const gemini = { ...(clock !== undefined ? { clock } : {}), ...options.gemini };
  return [GroqParser(groq), GeminiParser(gemini)];
}

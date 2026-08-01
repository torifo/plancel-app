/**
 * Real-provider parser registry (Task 6.1, ADR-5, SDD §5).
 *
 * The production chain: text = Groq (primary) → targeted Gemini Flash review;
 * image = Gemini Flash only (vision 固定). `parsers.config.json` declares
 * the same chain since the 2026-07-11 cutover; review-policy.ts decides when
 * a valid Groq result still needs a second opinion. The replay corpus in
 * `fixtures/parse/` is the regression gate for any prompt/chain change.
 *
 * One input class overrides that order per call — see `chainForInput` in
 * config.ts: a policy written 「N日前から◯%」 needs the parser that reads the
 * boundary a day correctly, while Gemini's project/model quota is also needed
 * by the image path and should not be spent on every ordinary text.
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

/**
 * Real-provider parser registry (Task 6.1, ADR-5, SDD §5).
 *
 * The production chain: text = Groq (primary) → Gemini Flash (secondary);
 * image = Gemini Flash only (vision 固定). `parsers.config.json` still
 * declares the mock chain because the replay corpus in `fixtures/parse/`
 * was recorded against mock parser names — the cutover procedure is:
 * record a few real ParseJobs as fixtures (`deno task parse:live --record`),
 * then flip `parsers.config.json` to REAL_CHAIN_CONFIG's contents, and the
 * corpus becomes a real-data regression gate.
 */
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
}

/** All real parser implementations, ready to hand to runParseChain. */
export function realParsers(options: RealParsersOptions = {}): Parser[] {
  return [GroqParser(options.groq), GeminiParser(options.gemini)];
}

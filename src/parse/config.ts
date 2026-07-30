/**
 * Declarative parser chain configuration (SDD §5 方針, FR-011).
 *
 * The chain's order/composition lives in `parsers.config.json` (repo root),
 * not in code, so that replacing free-tier parsers with paid models in
 * phase 2 is a config change only. `validateParserChainConfig` is the guard
 * that keeps the config honest against whatever parsers are actually
 * registered.
 *
 * `chainForInput` is the one thing the config does NOT decide: which parser
 * leads for a single input can depend on what that input says (see below).
 */
import type { ParseInput, ParseInputType } from "./types.ts";
import { statesFeeFromBoundary } from "./policy-phrasing.ts";

export interface ParserChainConfig {
  text: string[];
  image: string[];
}

/**
 * The parser that reads 「N日前から◯%」 boundaries correctly (measured
 * 2026-07-30 against both providers — see `chainForInput`).
 */
const FEE_FROM_BOUNDARY_PARSER = "gemini-flash";

/**
 * The parser order to use for THIS input: the declared chain, except that a
 * text stating its fee from a boundary puts `FEE_FROM_BOUNDARY_PARSER` first.
 *
 * This is NOT what keeps the free-cancellation deadline correct — that is the
 * import-time invariant in `fromCoreStages`, which forces the boundary the
 * source text implies onto whatever the model returned. What the reorder buys
 * is the rest of the table: measured 2026-07-30, gemini-flash shifts the inner
 * tiers of a 「から」 policy correctly and llama-3.3-70b mostly does, so this is
 * a best-effort accuracy preference, not a correctness guarantee.
 *
 * Which is why it stays narrow. Gemini's free tier is 20 requests/day per
 * model, shared with the image path, so leading the whole text chain would
 * spend the day on ordinary mail; and Groq answering these instead costs only
 * the inner tiers, never the deadline.
 */
export function chainForInput(input: ParseInput, config: ParserChainConfig): string[] {
  const names = config[input.type];
  if (input.type !== "text" || !statesFeeFromBoundary(input.content)) return names;
  if (!names.includes(FEE_FROM_BOUNDARY_PARSER)) return names;
  return [FEE_FROM_BOUNDARY_PARSER, ...names.filter((n) => n !== FEE_FROM_BOUNDARY_PARSER)];
}

/** Raised when the config references a parser name that isn't registered. */
export class UnknownParserError extends Error {
  constructor(public readonly parserName: string, public readonly inputType: ParseInputType) {
    super(
      `unknown parser "${parserName}" referenced in chain config for input type "${inputType}"`,
    );
    this.name = "UnknownParserError";
  }
}

/** Throws UnknownParserError if any configured name isn't in `registeredNames`. */
export function validateParserChainConfig(
  config: ParserChainConfig,
  registeredNames: readonly string[],
): void {
  const known = new Set(registeredNames);
  for (const inputType of ["text", "image"] as const) {
    for (const name of config[inputType]) {
      if (!known.has(name)) {
        throw new UnknownParserError(name, inputType);
      }
    }
  }
}

/**
 * Loads and parses the chain config from disk. Defaults to
 * `parsers.config.json` at the repo root (relative to this module).
 */
export async function loadParserChainConfig(
  path: string | URL = new URL("../../parsers.config.json", import.meta.url),
): Promise<ParserChainConfig> {
  const text = await Deno.readTextFile(path);
  const parsed = JSON.parse(text) as ParserChainConfig;
  return parsed;
}

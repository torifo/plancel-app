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
 * Does this text state a cancellation fee as STARTING at a boundary
 * (「3日前から20%」「前日より50%」「当日以降100%」) rather than as a deadline to
 * cancel by (「3日前まで無料」)?
 *
 * The two phrasings put the free window a day apart: 「7日前から20%」 means the
 * 7日前 day is already charged, so the last free moment is 8日前 — while
 * 「7日前まで無料」 means 7日前 itself is still free. A match needs three things
 * — a cancellation word somewhere, a boundary, and a charge right after that
 * boundary — because 「から」 alone is far too common a particle: 「東京駅から徒歩
 * 5分」, 「10:00からチェックイン」 and even 「3日前から満席のためキャンセル待ち」
 * all carry it without stating a fee.
 */
export function statesFeeFromBoundary(text: string): boolean {
  return /キャンセル|取消|解約/.test(text) &&
    /(?:\d+\s*(?:日|時間)前|前日|当日)\s*(?:から|より|以降)[^。\n]{0,12}?(?:\d+\s*[%％]|\d+\s*円|全額|有料)/
      .test(text);
}

/**
 * The parser order to use for THIS input: the declared chain, except that a
 * text stating its fee from a boundary puts `FEE_FROM_BOUNDARY_PARSER` first.
 *
 * Both providers now get the free stage itself right (2026-07-30 prompt fix),
 * but only Gemini applies the one-day correction; llama-3.3-70b answers
 * 「7日前から20%」 with a free window running to 7日前, which hands the ledger a
 * 無料キャンセル期限 sitting inside hours the facility already charges for —
 * the one error this ledger exists to prevent. Gemini does not simply lead the
 * whole text chain because its free tier is 20 requests/day per model, shared
 * with the image path; spending it on the inputs that need it leaves Groq to
 * answer everything else, and to answer these too once Gemini is exhausted (a
 * day-optimistic boundary being better than no answer).
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

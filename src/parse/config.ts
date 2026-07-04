/**
 * Declarative parser chain configuration (SDD §5 方針, FR-011).
 *
 * The chain's order/composition lives in `parsers.config.json` (repo root),
 * not in code, so that replacing free-tier parsers with paid models in
 * phase 2 is a config change only. `validateParserChainConfig` is the guard
 * that keeps the config honest against whatever parsers are actually
 * registered.
 */
import type { ParseInputType } from "./types.ts";

export interface ParserChainConfig {
  text: string[];
  image: string[];
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

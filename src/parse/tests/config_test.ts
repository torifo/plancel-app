import { assertThrows } from "jsr:@std/assert@^1.0.19";
import { UnknownParserError, validateParserChainConfig } from "../config.ts";

Deno.test("validateParserChainConfig accepts a config whose names are all registered", () => {
  validateParserChainConfig(
    { text: ["mock-primary", "mock-secondary"], image: ["mock-vision"] },
    ["mock-primary", "mock-secondary", "mock-vision"],
  );
});

Deno.test("validateParserChainConfig rejects an unknown parser name", () => {
  assertThrows(
    () =>
      validateParserChainConfig(
        { text: ["mock-primary", "nonexistent-parser"], image: [] },
        ["mock-primary"],
      ),
    UnknownParserError,
    'unknown parser "nonexistent-parser"',
  );
});

Deno.test("validateParserChainConfig rejects an unknown parser in the image chain", () => {
  assertThrows(
    () => validateParserChainConfig({ text: [], image: ["missing-vision"] }, ["mock-primary"]),
    UnknownParserError,
  );
});

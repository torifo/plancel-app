import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.19";
import { chainForInput, UnknownParserError, validateParserChainConfig } from "../config.ts";
import type { ParseInput } from "../types.ts";

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

const CHAIN = { text: ["groq-llama", "gemini-flash"], image: ["gemini-flash"] };
const textInput = (content: string): ParseInput => ({
  type: "text",
  content,
  correlation_id: "test",
});

Deno.test("chainForInput: a fee-from-boundary text puts the accurate parser first", () => {
  assertEquals(
    chainForInput(textInput("キャンセル: 3日前から20%、前日50%、当日80%"), CHAIN),
    ["gemini-flash", "groq-llama"],
  );
});

Deno.test("chainForInput: every other input keeps the declared order", () => {
  assertEquals(chainForInput(textInput("8/1 19時 〇〇レストラン 2名"), CHAIN), CHAIN.text);
  assertEquals(
    chainForInput(textInput("キャンセル規定: 7日前まで無料、当日100%"), CHAIN),
    CHAIN.text,
  );
  // Images never reorder: the vision chain has one parser and no alternative.
  assertEquals(
    chainForInput(
      { type: "image", content: "キャンセルは3日前から20%", correlation_id: "t" },
      CHAIN,
    ),
    CHAIN.image,
  );
});

Deno.test("chainForInput: a chain without the accurate parser is left alone", () => {
  const groqOnly = { text: ["groq-llama"], image: [] };
  assertEquals(
    chainForInput(textInput("キャンセル: 3日前から20%"), groqOnly),
    ["groq-llama"],
  );
});

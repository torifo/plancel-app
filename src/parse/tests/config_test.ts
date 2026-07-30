import { assert, assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@^1.0.19";
import {
  chainForInput,
  statesFeeFromBoundary,
  UnknownParserError,
  validateParserChainConfig,
} from "../config.ts";
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

Deno.test("statesFeeFromBoundary: a fee that starts at a boundary is recognised", () => {
  // The phrasings that put the free window a day earlier than the number says.
  assert(statesFeeFromBoundary("キャンセル: 3日前から20%、前日50%、当日80%"));
  assert(statesFeeFromBoundary("キャンセル料は7日前より20%頂戴します"));
  assert(statesFeeFromBoundary("キャンセルは当日以降100%"));
  assert(statesFeeFromBoundary("取消料 30日前から10%"));
  assert(statesFeeFromBoundary("解約は36時間前から有料です"));
  assert(statesFeeFromBoundary("キャンセル規定: 前日から50%"));
});

Deno.test("statesFeeFromBoundary: a deadline to cancel BY is not a fee-from boundary", () => {
  // 「まで」 already names the last free moment, so nothing needs shifting.
  assertFalse(statesFeeFromBoundary("キャンセル規定: 7日前まで無料、3日前まで30%、当日100%"));
  assertFalse(statesFeeFromBoundary("前日18時までキャンセル無料、以降キャンセル料100%"));
});

Deno.test("statesFeeFromBoundary: ordinary prose containing から does not match", () => {
  // 「から」 is far too common a particle to key off on its own — a reservation
  // mail is full of it, and every false match spends one of Gemini's 20/day.
  assertFalse(statesFeeFromBoundary("東京駅から徒歩5分 / キャンセル規定は前日まで無料"));
  assertFalse(statesFeeFromBoundary("10:00からチェックイン可能。キャンセルは無料です"));
  assertFalse(statesFeeFromBoundary("8月1日から営業"));
  assertFalse(statesFeeFromBoundary("3日前から満席のためキャンセル待ちです"));
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

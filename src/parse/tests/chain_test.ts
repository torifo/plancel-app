import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import type { ParserChainConfig } from "../config.ts";
import {
  allParsersFailed,
  missingFieldQuestions,
  parserFailures,
  runParseChain,
} from "../chain.ts";
import { MockParser } from "../mock-parser.ts";
import type { ParseInput, Parser, ParseResult } from "../types.ts";

const CLOCK = new VirtualClock("2026-07-04T00:00:00Z");
const TEXT_CONFIG: ParserChainConfig = { text: ["primary", "secondary"], image: [] };

let counter = 0;
function ids() {
  return {
    ulid: () => `JAB${String(++counter).padStart(23, "0")}`,
    nowIso: () => "2026-07-04T00:00:00.000Z",
  };
}

Deno.test("runParseChain: fallback — primary invalid, secondary succeeds -> parsed, 2 attempts", async () => {
  const primary = MockParser(
    "primary",
    new Map([[
      "土曜19時に○○を仮予約",
      { raw_response: '{"service_name":"○○"}', output: { service_name: "○○" } }, // missing starts_at
    ]]),
  );
  const secondary = MockParser(
    "secondary",
    new Map([[
      "土曜19時に○○を仮予約",
      {
        raw_response: '{"service_name":"○○","starts_at":"2026-08-01T10:00:00Z"}',
        output: { service_name: "○○", starts_at: "2026-08-01T10:00:00Z" },
      },
    ]]),
  );

  const job = await runParseChain(
    { type: "text", content: "土曜19時に○○を仮予約", correlation_id: "corr-1" },
    TEXT_CONFIG,
    [primary, secondary],
    CLOCK,
    ids(),
  );

  assertEquals(job.status, "parsed");
  assertEquals(job.attempts.length, 2);
  assertEquals(job.attempts[0]?.parser, "primary");
  assertEquals(job.attempts[0]?.validation_errors, ["missing required field: starts_at"]);
  assertEquals(job.attempts[1]?.parser, "secondary");
  assertEquals(job.attempts[1]?.validation_errors, []);
  assertEquals(job.conflicts, []);
});

Deno.test("runParseChain: conflict — two parsers disagree on starts_at -> FieldConflict, needs_review", async () => {
  const primary = MockParser(
    "primary",
    new Map([[
      "予約したい",
      {
        raw_response: '{"service_name":"○○","starts_at":"2026-08-01T10:00:00Z","amount_jpy":-500}',
        output: { service_name: "○○", starts_at: "2026-08-01T10:00:00Z", amount_jpy: -500 },
      },
    ]]),
  );
  const secondary = MockParser(
    "secondary",
    new Map([[
      "予約したい",
      {
        raw_response: '{"service_name":"○○","starts_at":"2026-08-01T18:00:00Z"}',
        output: { service_name: "○○", starts_at: "2026-08-01T18:00:00Z" },
      },
    ]]),
  );

  const job = await runParseChain(
    { type: "text", content: "予約したい", correlation_id: "corr-2" },
    TEXT_CONFIG,
    [primary, secondary],
    CLOCK,
    ids(),
  );

  assertEquals(job.status, "needs_review");
  assertEquals(job.attempts.length, 2);
  assertEquals(job.conflicts.length, 1);
  assertEquals(job.conflicts[0]?.field, "starts_at");
  assertEquals(
    new Set(job.conflicts[0]?.options.map((o) => o.value)),
    new Set(["2026-08-01T10:00:00Z", "2026-08-01T18:00:00Z"]),
  );
});

Deno.test("runParseChain: all attempts produce unusable output -> needs_review with missing-field questions", async () => {
  const primary = MockParser(
    "primary",
    new Map([["謎の入力", { raw_response: "not json", output: { service_name: "?" } }]]),
  );
  const secondary = MockParser(
    "secondary",
    new Map([["謎の入力", { raw_response: "still not json", output: { service_name: "??" } }]]),
  );

  const job = await runParseChain(
    { type: "text", content: "謎の入力", correlation_id: "corr-3" },
    TEXT_CONFIG,
    [primary, secondary],
    CLOCK,
    ids(),
  );

  assertEquals(job.status, "needs_review");
  assertEquals(job.attempts.length, 2);
  assertEquals(missingFieldQuestions(job), ["starts_at"]);
});

Deno.test("runParseChain: nothing parseable at all -> failed", async () => {
  const primary = MockParser("primary", new Map());
  const secondary = MockParser("secondary", new Map());

  const job = await runParseChain(
    { type: "text", content: "完全に理解不能な文字列", correlation_id: "corr-4" },
    TEXT_CONFIG,
    [primary, secondary],
    CLOCK,
    ids(),
  );

  assertEquals(job.status, "failed");
  assertEquals(job.attempts.every((a) => a.output === null), true);
});

Deno.test("runParseChain: raw_response is preserved verbatim in attempts", async () => {
  const rawResponse = '{"service_name":"○○","starts_at":"2026-08-01T10:00:00Z","extra":"junk"}';
  const primary = MockParser(
    "primary",
    new Map([[
      "予約",
      {
        raw_response: rawResponse,
        output: { service_name: "○○", starts_at: "2026-08-01T10:00:00Z" },
      },
    ]]),
  );

  const job = await runParseChain(
    { type: "text", content: "予約", correlation_id: "corr-5" },
    { text: ["primary"], image: [] },
    [primary],
    CLOCK,
    ids(),
  );

  assertEquals(job.attempts[0]?.raw_response, rawResponse);
});

Deno.test("runParseChain: ordinary valid Groq output does not spend Gemini quota", async () => {
  const content = "8/20 18:30 銀座レストラン 4名";
  const groq = MockParser(
    "groq-llama",
    new Map([[
      content,
      {
        raw_response: "groq",
        output: { service_name: "銀座レストラン", starts_at: "2026-08-20T09:30:00Z" },
      },
    ]]),
  );
  const gemini = MockParser(
    "gemini-flash",
    new Map([[
      content,
      {
        raw_response: "gemini",
        output: { service_name: "誤って呼ばれた", starts_at: "2026-08-21T09:30:00Z" },
      },
    ]]),
  );

  const job = await runParseChain(
    { type: "text", content, correlation_id: "corr-groq-only" },
    { text: ["groq-llama", "gemini-flash"], image: ["gemini-flash"] },
    [groq, gemini],
    CLOCK,
    ids(),
  );

  assertEquals(job.status, "parsed");
  assertEquals(job.attempts.map((attempt) => attempt.parser), ["groq-llama"]);
  assertEquals(job.review_reasons, undefined);
});

Deno.test("runParseChain: suspicious Groq output gets a Gemini review without prose conflicts", async () => {
  const content = "予約日 7/1、利用日 8/20 19:00 銀座レストラン";
  const groqOutput = {
    service_name: "銀座レストラン",
    starts_at: "2026-08-20T10:00:00Z",
    notes: "4名",
  };
  const geminiOutput = {
    service_name: "銀座レストラン",
    starts_at: "2026-08-20T10:00:00Z",
    notes: "人数: 4名、予約日: 7月1日",
  };
  const groq = MockParser(
    "groq-llama",
    new Map([[content, { raw_response: "groq", output: groqOutput }]]),
  );
  const gemini = MockParser(
    "gemini-flash",
    new Map([[content, { raw_response: "gemini", output: geminiOutput }]]),
  );

  const job = await runParseChain(
    { type: "text", content, correlation_id: "corr-reviewed" },
    { text: ["groq-llama", "gemini-flash"], image: ["gemini-flash"] },
    [groq, gemini],
    CLOCK,
    ids(),
  );

  assertEquals(job.status, "parsed");
  assertEquals(job.attempts.map((attempt) => attempt.parser), ["groq-llama", "gemini-flash"]);
  assertEquals(job.review_reasons, ["multiple_calendar_dates"]);
  assertEquals(job.conflicts, []);
});

Deno.test("runParseChain: equivalent timezone serializations do not create a false conflict", async () => {
  const content = "予約日 7/1、利用日 8/20 19:00 銀座レストラン";
  const groq = MockParser(
    "groq-llama",
    new Map([[
      content,
      {
        raw_response: "groq",
        output: {
          service_name: "銀座レストラン",
          starts_at: "2026-08-20T19:00:00+09:00",
        },
      },
    ]]),
  );
  const gemini = MockParser(
    "gemini-flash",
    new Map([[
      content,
      {
        raw_response: "gemini",
        output: { service_name: "銀座レストラン", starts_at: "2026-08-20T10:00:00Z" },
      },
    ]]),
  );

  const job = await runParseChain(
    { type: "text", content, correlation_id: "corr-timezone" },
    { text: ["groq-llama", "gemini-flash"], image: ["gemini-flash"] },
    [groq, gemini],
    CLOCK,
    ids(),
  );

  assertEquals(job.status, "parsed");
  assertEquals(job.conflicts, []);
});

Deno.test("runParseChain: unavailable Gemini review preserves a valid Groq result", async () => {
  const content = "予約日 7/1、利用日 8/20 19:00 銀座レストラン";
  const groq = MockParser(
    "groq-llama",
    new Map([[
      content,
      {
        raw_response: "groq",
        output: { service_name: "銀座レストラン", starts_at: "2026-08-20T10:00:00Z" },
      },
    ]]),
  );
  const gemini = MockParser("gemini-flash", new Map());

  const job = await runParseChain(
    { type: "text", content, correlation_id: "corr-review-unavailable" },
    { text: ["groq-llama", "gemini-flash"], image: ["gemini-flash"] },
    [groq, gemini],
    CLOCK,
    ids(),
  );

  assertEquals(job.status, "parsed");
  assertEquals(job.attempts.length, 2);
  assertEquals(job.attempts[1]?.output, null);
  assertEquals(job.review_reasons, ["multiple_calendar_dates"]);
  assertEquals(job.conflicts, []);
});

Deno.test("runParseChain: parsers receive the PII-masked text, not the raw input", async () => {
  let received: ParseInput | null = null;
  const spy: Parser = {
    name: "spy",
    supports: () => true,
    parse: (input): Promise<ParseResult> => {
      received = input;
      return Promise.resolve({
        raw_response: "{}",
        output: { service_name: "○○", starts_at: "2026-08-01T10:00:00Z" },
      });
    },
  };

  const rawInput = "090-1234-5678 に電話して○○を予約";
  const job = await runParseChain(
    { type: "text", content: rawInput, correlation_id: "corr-6" },
    { text: ["spy"], image: [] },
    [spy],
    CLOCK,
    ids(),
  );

  assertEquals(
    (received as unknown as ParseInput | null)?.content,
    "[MASKED_PHONE_1] に電話して○○を予約",
  );
  // raw_input on the ParseJob keeps the original, unmasked text for records.
  assertEquals(job.raw_input, rawInput);
});

// Task 8.3 / ADR-13: "no model answered" and "no model could read this" both
// end as status "failed", but they need opposite answers from every surface,
// so the difference has to survive out of the chain.
const PROVIDER_DOWN = {
  raw_response: "error: groq http 404: model_not_found",
  output: null,
};

Deno.test("parserFailures: names the providers that never answered", async () => {
  const text = "8/1 19時 〇〇";
  const job = await runParseChain(
    { type: "text", content: text, correlation_id: "c" },
    { text: ["p1", "p2"], image: [] } as ParserChainConfig,
    [
      MockParser("p1", new Map([[text, PROVIDER_DOWN]])),
      MockParser("p2", new Map([[text, { raw_response: "{}", output: {} }]])),
    ],
    new VirtualClock("2026-07-16T00:00:00Z"),
    { ulid: () => "J1", nowIso: () => "2026-07-16T00:00:00.000Z" },
  );

  assertEquals(parserFailures(job), [{
    parser: "p1",
    error: "groq http 404: model_not_found",
  }]);
  // p2 did answer, so something IS known about the text itself.
  assertEquals(allParsersFailed(job), false);
});

Deno.test("allParsersFailed: true only when nothing read the input at all", async () => {
  const text = "8/1 19時 〇〇";
  const job = await runParseChain(
    { type: "text", content: text, correlation_id: "c" },
    { text: ["p1", "p2"], image: [] } as ParserChainConfig,
    [
      MockParser("p1", new Map([[text, PROVIDER_DOWN]])),
      MockParser("p2", new Map([[text, { raw_response: "error: gemini http 503", output: null }]])),
    ],
    new VirtualClock("2026-07-16T00:00:00Z"),
    { ulid: () => "J2", nowIso: () => "2026-07-16T00:00:00.000Z" },
  );

  assertEquals(job.status, "failed");
  assertEquals(allParsersFailed(job), true);
});

Deno.test("allParsersFailed: a model that answered nothing useful is not a failure", async () => {
  const text = "？？？";
  const job = await runParseChain(
    { type: "text", content: text, correlation_id: "c" },
    { text: ["p1"], image: [] } as ParserChainConfig,
    [MockParser("p1", new Map())], // answers, but has nothing to say
    new VirtualClock("2026-07-16T00:00:00Z"),
    { ulid: () => "J3", nowIso: () => "2026-07-16T00:00:00.000Z" },
  );

  assertEquals(job.status, "failed");
  assertEquals(parserFailures(job), []);
  assertEquals(allParsersFailed(job), false);
});

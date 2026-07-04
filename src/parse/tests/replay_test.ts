import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import type { ParserChainConfig } from "../config.ts";
import { runParseChain } from "../chain.ts";
import { MockParser } from "../mock-parser.ts";
import { FixtureParser, recordFixture, replayAll, replayJob } from "../replay.ts";
import type { ReplayFixture } from "../replay.ts";

const CLOCK = new VirtualClock("2026-07-04T00:00:00Z");
const TEXT_CONFIG: ParserChainConfig = { text: ["primary", "secondary"], image: [] };

let counter = 0;
function ids() {
  return {
    ulid: () => `JAB${String(++counter).padStart(23, "0")}`,
    nowIso: () => "2026-07-04T00:00:00.000Z",
  };
}

Deno.test("recordFixture -> replayJob round-trip is identical", async () => {
  const primary = MockParser(
    "primary",
    new Map([[
      "土曜19時に○○を仮予約",
      { raw_response: '{"service_name":"○○"}', output: { service_name: "○○" } },
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

  const recordedJob = await runParseChain(
    { type: "text", content: "土曜19時に○○を仮予約", correlation_id: "corr-1" },
    TEXT_CONFIG,
    [primary, secondary],
    CLOCK,
    ids(),
  );

  const fixture = recordFixture(recordedJob);
  assertEquals(fixture.raw_input, "土曜19時に○○を仮予約");
  assertEquals(fixture.input_type, "text");
  assertEquals(fixture.attempts.length, 2);
  assertEquals(fixture.expected.status, "parsed");

  const { diff } = await replayJob(fixture, TEXT_CONFIG, CLOCK, ids());
  assertEquals(diff, { identical: true, changes: [] });
});

Deno.test("FixtureParser replays raw_response verbatim regardless of input content", async () => {
  const parser = FixtureParser({ parser: "primary", raw_response: '{"service_name":"foo"}' });
  const result = await parser.parse({
    type: "text",
    content: "anything at all",
    correlation_id: "c",
  });
  assertEquals(result.raw_response, '{"service_name":"foo"}');
  assertEquals(result.output, { service_name: "foo" });
  assertEquals(parser.name, "primary");
  assertEquals(parser.supports({ type: "text", content: "x", correlation_id: "c" }), true);
});

Deno.test("FixtureParser: unparseable raw_response yields null output", async () => {
  const parser = FixtureParser({ parser: "primary", raw_response: "not json at all" });
  const result = await parser.parse({ type: "text", content: "x", correlation_id: "c" });
  assertEquals(result.output, null);
});

Deno.test("replayJob: reports changed when expected outcome no longer matches (simulated logic change)", async () => {
  // Constructed directly (not via recordFixture) to simulate "this fixture's
  // expected outcome was produced under different validation/chain logic":
  // expected says a clean "parsed" with no conflicts, but the recorded
  // attempts (as JSON-parsed today) actually disagree on starts_at, so the
  // CURRENT chain reports needs_review + a conflict — a real regression.
  const fixture: ReplayFixture = {
    name: "stale-expectation",
    raw_input: "予約したい",
    input_type: "text",
    attempts: [
      {
        parser: "primary",
        raw_response: '{"service_name":"○○","starts_at":"2026-08-01T10:00:00Z","amount_jpy":-1}',
      },
      {
        parser: "secondary",
        raw_response: '{"service_name":"○○","starts_at":"2026-08-01T18:00:00Z"}',
      },
    ],
    expected: {
      status: "parsed",
      output: { service_name: "○○", starts_at: "2026-08-01T10:00:00Z" },
      conflicts: [],
    },
  };

  const { job, diff } = await replayJob(fixture, TEXT_CONFIG, CLOCK, ids());
  assertEquals(job.status, "needs_review");
  assertEquals(diff.identical, false);
  const fields = diff.changes.map((c) => c.field).sort();
  assertEquals(fields, ["conflicts", "output", "status"]);
});

Deno.test("replayAll: aggregates identical/changed counts and a report string", async () => {
  const identicalFixture: ReplayFixture = {
    name: "ok",
    raw_input: "text",
    input_type: "text",
    attempts: [{
      parser: "primary",
      raw_response: '{"service_name":"a","starts_at":"2026-08-01T10:00:00Z"}',
    }],
    expected: {
      status: "parsed",
      output: { service_name: "a", starts_at: "2026-08-01T10:00:00Z" },
      conflicts: [],
    },
  };
  const changedFixture: ReplayFixture = {
    name: "drifted",
    raw_input: "text2",
    input_type: "text",
    attempts: [{ parser: "primary", raw_response: '{"service_name":"a"}' }],
    expected: { status: "parsed" },
  };

  const result = await replayAll([identicalFixture, changedFixture], TEXT_CONFIG, CLOCK, ids());
  assertEquals(result.total, 2);
  assertEquals(result.identical, 1);
  assertEquals(result.changed, 1);
  assertEquals(result.report.includes("[identical] ok"), true);
  assertEquals(result.report.includes("[changed]   drifted"), true);
  assertEquals(result.report.includes("1/2 identical, 1/2 changed"), true);
});

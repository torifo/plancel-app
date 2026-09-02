import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import { CANARY_TEXT, classifyFault, runCanary } from "../canary.ts";
import { MockParser } from "../mock-parser.ts";
import type { Parser } from "../types.ts";

const clock = new VirtualClock("2026-08-20T00:00:00Z");
const answers = (name: string) =>
  MockParser(
    name,
    new Map([[CANARY_TEXT, { raw_response: "{}", output: { service_name: "テスト食堂" } }]]),
  );
const dead = (name: string, error: string) =>
  MockParser(name, new Map([[CANARY_TEXT, { raw_response: `error: ${error}`, output: null }]]));

Deno.test("canary: every parser answering is no fault", async () => {
  const r = await runCanary([answers("p1"), answers("p2")], clock);
  assertEquals(r.checked, ["p1", "p2"]);
  assertEquals(r.faults, []);
});

Deno.test("canary: a retired model is reported by name, and the others still run", async () => {
  const r = await runCanary(
    [dead("groq-llama", "groq http 404: model_not_found"), answers("gemini-flash")],
    clock,
  );
  assertEquals(r.checked, ["groq-llama", "gemini-flash"]);
  assertEquals(r.faults, [{
    parser: "groq-llama",
    kind: "structural",
    error: "groq http 404: model_not_found",
  }]);
});

Deno.test("canary: answering with nothing extractable is a fault too", async () => {
  // No provider error, but a sentence this plain must produce fields.
  const r = await runCanary([MockParser("p1", new Map())], clock);
  assertEquals(r.faults.length, 1);
  assertEquals(r.faults[0]?.parser, "p1");
  assertStringIncludes(r.faults[0]?.error ?? "", "answered but nothing was extractable");
});

Deno.test("canary: a parser that throws is as broken as one that fails", async () => {
  const boom: Parser = {
    name: "boom",
    supports: () => true,
    parse: () => Promise.reject(new Error("connection refused")),
  };
  const r = await runCanary([boom, answers("p2")], clock);
  assertEquals(r.checked, ["boom", "p2"]);
  assertEquals(r.faults, [{
    parser: "boom",
    kind: "structural",
    error: "threw: connection refused",
  }]);
});

Deno.test("canary: an image-only parser is not asked a text question", async () => {
  const vision = MockParser("v1", new Map(), { supports: (i) => i.type === "image" });
  const r = await runCanary([vision, answers("p1")], clock);
  assertEquals(r.checked, ["p1"]);
  assertEquals(r.faults, []);
});

Deno.test("classifyFault: a 4xx needs a person, a 5xx or a wire problem does not", () => {
  // These do not fix themselves.
  assertEquals(classifyFault("groq http 404: model_not_found"), "structural");
  assertEquals(classifyFault("gemini http 401: API key not valid"), "structural");
  assertEquals(classifyFault("GROQ_API_KEY is not set"), "structural");
  assertEquals(classifyFault("gemini response had no text parts: {}"), "structural");
  assertEquals(classifyFault("answered but nothing was extractable: hello"), "structural");
  // These are a bad minute, and filing them daily would drown the real ones.
  assertEquals(classifyFault("gemini http 503: experiencing high demand"), "transient");
  assertEquals(classifyFault("groq http 500: internal"), "transient");
  assertEquals(
    classifyFault("gemini request failed: The operation was aborted due to timeout"),
    "transient",
  );
});

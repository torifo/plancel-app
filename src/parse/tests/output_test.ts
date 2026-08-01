import { assertEquals } from "jsr:@std/assert@^1.0.19";
import type { ParseAttempt } from "../../core/schema/mod.ts";
import { isUsableParseAttempt, lastUsableParseOutput, mergedParsedOutput } from "../output.ts";

const attempt = (
  parser: string,
  output: ParseAttempt["output"],
  validation_errors: string[] = [],
): ParseAttempt => ({
  parser,
  raw_response: parser,
  output,
  validation_errors,
  correlation_id: "output-test",
});

Deno.test("mergedParsedOutput: an invalid reviewer cannot overwrite a valid primary", () => {
  const primary = attempt("groq-llama", {
    service_name: "正しい宿",
    starts_at: "2026-08-20T06:00:00Z",
    amount_jpy: 20_000,
  });
  const reviewer = attempt(
    "gemini-flash",
    {
      service_name: "正しい宿",
      starts_at: "2026-08-20T06:00:00Z",
      amount_jpy: -500,
    },
    ["amount_jpy must be >= 0"],
  );

  assertEquals(mergedParsedOutput({ attempts: [primary, reviewer] }), primary.output);
  assertEquals(lastUsableParseOutput({ attempts: [primary, reviewer] }), primary.output);
});

Deno.test("mergedParsedOutput: warnings remain usable and a valid reviewer may add fields", () => {
  const primary = attempt(
    "groq-llama",
    { service_name: "宿", starts_at: "2025-08-20T06:00:00Z" },
    ["warning: starts_at is in the past; requires confirmation"],
  );
  const reviewer = attempt("gemini-flash", {
    service_name: "宿",
    starts_at: "2025-08-20T06:00:00Z",
    location: "東京都新宿区",
  });

  assertEquals(isUsableParseAttempt(primary), true);
  assertEquals(mergedParsedOutput({ attempts: [primary, reviewer] }), {
    service_name: "宿",
    starts_at: "2025-08-20T06:00:00Z",
    location: "東京都新宿区",
  });
  assertEquals(lastUsableParseOutput({ attempts: [primary, reviewer] }), reviewer.output);
});

Deno.test("mergedParsedOutput: partial fields survive when every attempt is invalid", () => {
  const partial = attempt(
    "groq-llama",
    { service_name: "どこか" },
    ["missing required field: starts_at"],
  );

  assertEquals(mergedParsedOutput({ attempts: [partial] }), { service_name: "どこか" });
  assertEquals(lastUsableParseOutput({ attempts: [partial] }), partial.output);
});

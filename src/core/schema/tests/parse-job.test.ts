import { assertEquals } from "jsr:@std/assert@1";
import { parseJobSchema } from "../parse-job.ts";
import { validParseJob } from "./fixtures.ts";

Deno.test("parseJobSchema accepts a valid ParseJob", () => {
  const result = parseJobSchema.safeParse(validParseJob);
  assertEquals(result.success, true);
});

Deno.test("parseJobSchema accepts null attempt output and non-empty conflicts", () => {
  const result = parseJobSchema.safeParse({
    ...validParseJob,
    status: "needs_review",
    attempts: [
      { ...validParseJob.attempts[0], output: null, validation_errors: ["missing starts_at"] },
    ],
    conflicts: [
      {
        field: "service_name",
        options: [{ parser: "groq-llama", value: "A" }, {
          parser: "gemini-flash",
          value: "B",
        }],
      },
    ],
  });
  assertEquals(result.success, true);
});

Deno.test("parseJobSchema rejects bad status", () => {
  const result = parseJobSchema.safeParse({ ...validParseJob, status: "pending" });
  assertEquals(result.success, false);
});

Deno.test("parseJobSchema rejects bad input_type", () => {
  const result = parseJobSchema.safeParse({ ...validParseJob, input_type: "audio" });
  assertEquals(result.success, false);
});

Deno.test("parseJobSchema rejects missing required field (raw_input)", () => {
  const { raw_input: _r, ...rest } = validParseJob;
  const result = parseJobSchema.safeParse(rest);
  assertEquals(result.success, false);
});

Deno.test("parseJobSchema rejects missing correlation_id on an attempt", () => {
  const { correlation_id: _c, ...attemptRest } = validParseJob.attempts[0]!;
  const result = parseJobSchema.safeParse({
    ...validParseJob,
    attempts: [attemptRest],
  });
  assertEquals(result.success, false);
});

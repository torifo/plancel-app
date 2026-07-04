import { assertEquals } from "jsr:@std/assert@1";
import { isoDateSchema, isoDateTimeSchema } from "../common.ts";

Deno.test("isoDateTimeSchema normalizes a +09:00 offset to UTC 'Z' form", () => {
  const result = isoDateTimeSchema.safeParse("2026-08-02T09:00:00+09:00");
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data, "2026-08-02T00:00:00.000Z");
  }
});

Deno.test("isoDateTimeSchema passes through an already-UTC 'Z' datetime unchanged", () => {
  const result = isoDateTimeSchema.safeParse("2026-08-02T00:00:00.000Z");
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data, "2026-08-02T00:00:00.000Z");
  }
});

Deno.test("isoDateTimeSchema rejects a non-datetime string", () => {
  const result = isoDateTimeSchema.safeParse("not-a-datetime");
  assertEquals(result.success, false);
});

Deno.test("isoDateSchema accepts strict YYYY-MM-DD", () => {
  const result = isoDateSchema.safeParse("2026-07-04");
  assertEquals(result.success, true);
});

Deno.test("isoDateSchema rejects slash-separated dates", () => {
  const result = isoDateSchema.safeParse("2026/07/04");
  assertEquals(result.success, false);
});

Deno.test("isoDateSchema rejects a datetime string (time component not allowed)", () => {
  const result = isoDateSchema.safeParse("2026-07-04T00:00:00Z");
  assertEquals(result.success, false);
});

Deno.test("isoDateSchema rejects an invalid calendar date", () => {
  const result = isoDateSchema.safeParse("2026-02-30");
  assertEquals(result.success, false);
});

import { assertEquals } from "jsr:@std/assert@1";
import { eventSchema } from "../event.ts";
import { validEvent } from "./fixtures.ts";

Deno.test("eventSchema accepts a valid Event", () => {
  const result = eventSchema.safeParse(validEvent);
  assertEquals(result.success, true);
});

Deno.test("eventSchema accepts null date_range and notes", () => {
  const result = eventSchema.safeParse({ ...validEvent, date_range: null, notes: null });
  assertEquals(result.success, true);
});

Deno.test("eventSchema rejects missing required field (title)", () => {
  const { title: _title, ...rest } = validEvent;
  const result = eventSchema.safeParse(rest);
  assertEquals(result.success, false);
});

Deno.test("eventSchema rejects a non-ULID id", () => {
  const result = eventSchema.safeParse({ ...validEvent, id: "not-a-ulid" });
  assertEquals(result.success, false);
});

import { assertEquals, assertExists } from "jsr:@std/assert@^1.0.19";
import { logger, newCorrelationId } from "../log.ts";

Deno.test("logger emits one JSON line per call with expected shape", () => {
  const lines: string[] = [];
  const log = logger("test-component", {
    now: () => "2026-07-04T00:00:00.000Z",
    write: (line) => lines.push(line),
  });

  log.info("hello", { correlation_id: "01ABC", foo: "bar" });

  assertEquals(lines.length, 1);
  const record = JSON.parse(lines[0] ?? "");
  assertEquals(record, {
    ts: "2026-07-04T00:00:00.000Z",
    level: "info",
    component: "test-component",
    msg: "hello",
    correlation_id: "01ABC",
    foo: "bar",
  });
});

Deno.test("logger omits correlation_id when not provided", () => {
  const lines: string[] = [];
  const log = logger("test-component", {
    now: () => "2026-07-04T00:00:00.000Z",
    write: (line) => lines.push(line),
  });

  log.error("boom");

  const record = JSON.parse(lines[0] ?? "");
  assertEquals(record.level, "error");
  assertEquals(record.msg, "boom");
  assertEquals("correlation_id" in record, false);
});

Deno.test("logger supports all levels", () => {
  const lines: string[] = [];
  const log = logger("c", { write: (line) => lines.push(line) });
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  assertEquals(lines.length, 4);
  const levels = lines.map((l) => JSON.parse(l).level);
  assertEquals(levels, ["debug", "info", "warn", "error"]);
});

Deno.test("newCorrelationId returns a 26-char ULID-shaped string", () => {
  const id = newCorrelationId();
  assertExists(id);
  assertEquals(id.length, 26);
});

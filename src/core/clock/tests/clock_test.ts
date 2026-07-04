import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { SystemClock } from "../system.ts";
import { VirtualClock } from "../virtual.ts";

Deno.test("SystemClock.now() returns a plausible instant", () => {
  const clock = new SystemClock();
  const before = Temporal.Now.instant();
  const instant = clock.now();
  const after = Temporal.Now.instant();

  assert(Temporal.Instant.compare(instant, before) >= 0);
  assert(Temporal.Instant.compare(instant, after) <= 0);

  const year = instant.toZonedDateTimeISO("UTC").year;
  assert(year >= 2024 && year <= 2100, `unexpected year: ${year}`);
});

Deno.test("VirtualClock is constructed from an ISO instant string", () => {
  const clock = new VirtualClock("2026-01-01T00:00:00Z");
  assertEquals(clock.now().toString(), "2026-01-01T00:00:00Z");
});

Deno.test("VirtualClock is constructed from a Temporal.Instant", () => {
  const instant = Temporal.Instant.from("2026-01-01T00:00:00Z");
  const clock = new VirtualClock(instant);
  assertEquals(clock.now(), instant);
});

Deno.test("VirtualClock.set() updates the current instant", () => {
  const clock = new VirtualClock("2026-01-01T00:00:00Z");
  clock.set("2026-06-15T12:00:00Z");
  assertEquals(clock.now().toString(), "2026-06-15T12:00:00Z");
});

Deno.test("VirtualClock.advance() with an ISO duration string: advance 3 days", () => {
  const clock = new VirtualClock("2026-01-01T00:00:00Z");
  clock.advance("P3D");
  assertEquals(clock.now().toString(), "2026-01-04T00:00:00Z");
});

Deno.test("VirtualClock.advance() with a Temporal.Duration: advance 15 minutes", () => {
  const clock = new VirtualClock("2026-01-01T00:00:00Z");
  clock.advance(Temporal.Duration.from("PT15M"));
  assertEquals(clock.now().toString(), "2026-01-01T00:15:00Z");
});

Deno.test("VirtualClock.advance() accumulates across multiple calls", () => {
  const clock = new VirtualClock("2026-01-01T00:00:00Z");
  clock.advance("P1D");
  clock.advance("PT12H");
  assertEquals(clock.now().toString(), "2026-01-02T12:00:00Z");
});

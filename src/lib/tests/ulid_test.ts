import { assert, assertEquals, assertMatch } from "jsr:@std/assert@^1.0.19";
import { ulid } from "../ulid.ts";

Deno.test("ulid is 26 characters, Crockford Base32", () => {
  const id = ulid();
  assertEquals(id.length, 26);
  assertMatch(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

Deno.test("ulid is injectable and deterministic given fixed time/random", () => {
  const id1 = ulid({ now: () => 1_700_000_000_000, random: () => 0 });
  const id2 = ulid({ now: () => 1_700_000_000_000, random: () => 0 });
  assertEquals(id1, id2);
});

Deno.test("ulid is lexicographically sortable by increasing injected time", () => {
  const ids = [1_000, 2_000, 3_000, 1_700_000_000_000].map((t) =>
    ulid({ now: () => t, random: () => Math.random() })
  );
  const sorted = [...ids].sort();
  assertEquals(ids, sorted);
});

Deno.test("ulid varies with injected random when time is fixed", () => {
  const id1 = ulid({ now: () => 42, random: () => 0 });
  const id2 = ulid({ now: () => 42, random: () => 0.99 });
  assert(id1 !== id2);
});

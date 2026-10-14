import type { Clock } from "../../core/clock/mod.ts";
import type { AuthIds } from "../../web/users.ts";

/** Ids that read the injected clock, so a test controls "now" in one place. */
export function makeIds(clock: Clock): AuthIds {
  let n = 0;
  let t = 0;
  return {
    newId: () => `ID${String(++n).padStart(4, "0")}`,
    nowIso: () => clock.now().toString({ smallestUnit: "millisecond" }),
    nowMs: () => clock.now().epochMilliseconds,
    randomToken: () => `tok${++t}`,
  };
}

export async function withKv(fn: (kv: Deno.Kv) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

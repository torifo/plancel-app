import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.19";
import { copyIntoCanary, RELEASE_CANARY_KEY, releaseCanaryGate } from "../release-canary.ts";
import { smokeCanary } from "../release-canary-smoke.ts";
import { handleWebApi } from "../api.ts";
import { getOrCreateUserByEmail } from "../users.ts";
import { makeAuthIds } from "./users_test.ts";

const MARK = { copiedAt: "2026-11-13T00:00:00Z", source: "production" };

async function dump(kv: Deno.Kv) {
  const out: [string, unknown][] = [];
  for await (const e of kv.list({ prefix: [] })) out.push([JSON.stringify(e.key), e.value]);
  return out;
}

Deno.test("release canary: the copy marks first, replaces the canary's data, and never writes the source", async () => {
  const prod = await Deno.openKv(":memory:");
  const canary = await Deno.openKv(":memory:");
  try {
    for (let i = 0; i < 250; i++) await prod.set(["web", "L1", "resv", `R${i}`], { n: i });
    await prod.set(["webuser", "U1"], { email: "a@x.jp" });
    await canary.set(["web", "OLD", "resv", "STALE"], { stale: true });
    const before = await dump(prod);

    assertEquals(await copyIntoCanary(prod, canary, MARK, 40), 251);
    assertEquals(await dump(prod), before);
    assertEquals((await canary.get(RELEASE_CANARY_KEY)).value, MARK);
    assertEquals((await canary.get(["web", "OLD", "resv", "STALE"])).value, null);
    assertEquals((await canary.get(["web", "L1", "resv", "R249"])).value, { n: 249 });
    // Everything but the marker matches production.
    assertEquals(
      (await dump(canary)).filter(([k]) => k !== JSON.stringify(RELEASE_CANARY_KEY)),
      before,
    );

    // Run the other way round (ids swapped), it refuses before writing anything.
    const prodAgain = await dump(prod);
    await assertRejects(() => copyIntoCanary(canary, prod, MARK), Error, "canary copy");
    assertEquals(await dump(prod), prodAgain);
  } finally {
    prod.close();
    canary.close();
  }
});

Deno.test("release canary: the gate reads the marker and remembers it briefly", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    let now = 0;
    const isCanary = releaseCanaryGate(kv, () => now, 1000);
    assertEquals(await isCanary(), false);
    await kv.set(RELEASE_CANARY_KEY, MARK);
    assertEquals(await isCanary(), false); // still the cached answer
    now = 1000;
    assertEquals(await isCanary(), true);
  } finally {
    kv.close();
  }
});

Deno.test("release canary: the smoke test runs every ledger, and only on a canary", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const ids = makeAuthIds();
    const mom = await getOrCreateUserByEmail(kv, "mom@x.jp", ids);
    const me = await getOrCreateUserByEmail(kv, "me@x.jp", ids);
    const call = (user: typeof mom, method: string, path: string, body?: unknown) =>
      handleWebApi(
        kv,
        new Request(`http://localhost${path}`, {
          method,
          ...(body !== undefined
            ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
            : {}),
        }),
        ids,
        { user, ledger: user.ledgerId },
      );
    const hers = (await (await call(mom, "POST", "/api/reservations", {
      service: "ホテル白菊",
      startsAt: "2026-12-19T15:00:00+09:00",
      endsAt: "2026-12-20",
    })).json()).reservation;
    await call(mom, "POST", `/api/reservations/${hers.id}/members`, { q: "me@x.jp" });
    await call(me, "POST", "/api/reservations", {
      service: "おにやま",
      startsAt: "2026-12-19T15:30:00+09:00",
    });
    // An old-shape row, the kind that broke production on 2026-11-13.
    const key = ["web", mom.ledgerId, "resv", hers.id];
    const raw = { ...(await kv.get<Record<string, unknown>>(key)).value! };
    delete raw.suggestion;
    await kv.set(key, raw);

    await assertRejects(() => smokeCanary(kv, Date.parse("2026-11-13T00:00:00Z")), Error, "marker");
    await kv.set(RELEASE_CANARY_KEY, MARK);
    const r = await smokeCanary(kv, Date.parse("2026-11-13T00:00:00Z"));
    assertEquals([r.users, r.rows, r.failures], [2, 3, []]);
  } finally {
    kv.close();
  }
});

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { handleWebApi } from "../api.ts";
import { FARE_PRESETS, findFare } from "../fares.ts";
import { describePolicy } from "../policy.ts";
import { getOrCreateUserByEmail, type WebUser } from "../users.ts";
import { makeAuthIds } from "./users_test.ts";

const BASE = "/api/reservations";
type Ids = ReturnType<typeof makeAuthIds>;
const call = (kv: Deno.Kv, ids: Ids, user: WebUser, method: string, path: string, body?: unknown) =>
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

Deno.test("fares: a JAL fare is found by its name with or without the carrier, and reads as JAL states it", () => {
  assertEquals(findFare("JAL スペシャルセイバー")?.label, "JAL スペシャルセイバー");
  assertEquals(findFare("JALスペシャルセイバー")?.label, "JAL スペシャルセイバー");
  assertEquals(findFare("スペシャルセイバー")?.label, "JAL スペシャルセイバー");
  assertEquals(findFare("夕朝食付きプラン"), null);
  assertEquals(findFare(""), null);
  const read = Object.fromEntries(FARE_PRESETS.map((p) => [p.label, describePolicy(p.policy)]));
  assertEquals(read["JAL フレックス"], "いつでも無料");
  assertEquals(read["JAL セイバー"], "いつでも5%");
  assertEquals(read["JAL スペシャルセイバー"], "55日前まで5% → 以降50%");
  assertEquals(read["JAL スカイメイト"], "いつでも50%");
  for (const p of FARE_PRESETS) assertStringIncludes(p.source, "https://www.jal.co.jp/");
});

Deno.test("fares: naming a fare fills the policy, a saved default overrides the table, and an explicit policy wins", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const ids = makeAuthIds();
    const me = await getOrCreateUserByEmail(kv, "me@x.jp", ids);
    const mk = async (body: Record<string, unknown>) =>
      await (await call(kv, ids, me, "POST", BASE, {
        service: "JAL665",
        kind: "flight",
        startsAt: "2026-12-19T12:05:00+09:00",
        ...body,
      })).json();

    const a = await mk({ fare: "スペシャルセイバー" });
    assertEquals([a.policySource, a.reservation.fare], ["fare", "JAL スペシャルセイバー"]);
    assertEquals(a.reservation.policy, { stages: [{ h: 1320, pct: 5 }, { h: 0, pct: 50 }] });
    assertStringIncludes(a.hint, "変わることがある");

    // An explicit policy is never overwritten by the fare.
    const b = await mk({ fare: "JAL スペシャルセイバー", policy: "free24" });
    assertEquals([b.policySource, b.reservation.policy], ["explicit", "free24"]);

    // JAL changed the rule: the family saves the corrected one under the fare's name.
    const corrected = { stages: [{ h: 720, pct: 10 }, { h: 0, pct: 60 }] };
    await call(
      kv,
      ids,
      me,
      "PUT",
      "/api/policy-templates/" + encodeURIComponent("JAL スペシャルセイバー"),
      {
        policy: corrected,
      },
    );
    const c = await mk({ fare: "JALスペシャルセイバー" });
    assertEquals(c.reservation.policy, corrected);
    const list = (await (await call(kv, ids, me, "GET", "/api/fare-presets")).json()).fares;
    const ss = list.find((f: { label: string }) => f.label === "JAL スペシャルセイバー");
    assertEquals([ss.saved, ss.policy], [true, corrected]);
    assertEquals(list.find((f: { label: string }) => f.label === "JAL フレックス").saved, false);

    // Naming the fare later fills a policy that is still unknown; a known one stays.
    const d = await mk({});
    assertEquals(d.reservation.policy, "unknown");
    await call(kv, ids, me, "PATCH", `${BASE}/${d.reservation.id}`, { fare: "JAL フレックス" });
    const after = (await (await call(kv, ids, me, "GET", BASE)).json()).reservations
      .find((r: { id: string }) => r.id === d.reservation.id);
    assertEquals([after.fare, after.policy], ["JAL フレックス", "none"]);
    await call(kv, ids, me, "PATCH", `${BASE}/${d.reservation.id}`, { fare: "JAL セイバー" });
    const kept = (await (await call(kv, ids, me, "GET", BASE)).json()).reservations
      .find((r: { id: string }) => r.id === d.reservation.id);
    assertEquals([kept.fare, kept.policy], ["JAL セイバー", "none"]);
  } finally {
    kv.close();
  }
});

/**
 * Records written before a field existed must keep working on every path
 * (2026-11-13: a shared row from before proposals had no `suggestion` key,
 * and the ledger list failed with a 500 in production for everyone holding
 * a shared reservation). New code is tested with new records by default, so
 * this file writes reservations in the OLDEST shape — only the keys the first
 * release had — and drives each read and write path over them: the owner's
 * and a member's list, the MCP view, edit, settle, propose, choose, merge,
 * and the notification sweeps. When a field is added to the record, it needs
 * no change here: the strip below removes everything the first release lacked.
 */
import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { handleWebApi } from "../api.ts";
import { getOrCreateUserByEmail, type WebUser } from "../users.ts";
import { listReservations } from "../store.ts";
import { sweepDeadlineNotifications, sweepSuggestionNotifications } from "../notify.ts";
import { listFilterSchema, presentList } from "../../mcp/web_api_view.ts";
import { makeAuthIds } from "./users_test.ts";

const BASE = "/api/reservations";
/** The keys of the first release's record; everything else was added later, with a default. */
const FIRST_KEYS = [
  "id",
  "plan",
  "service",
  "startsAt",
  "amount",
  "policy",
  "status",
  "created_at",
  "updated_at",
];

type Ids = ReturnType<typeof makeAuthIds>;

function call(kv: Deno.Kv, ids: Ids, user: WebUser, method: string, path: string, body?: unknown) {
  const req = new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return handleWebApi(kv, req, ids, { user, ledger: user.ledgerId });
}

async function create(kv: Deno.Kv, ids: Ids, user: WebUser, body: Record<string, unknown>) {
  const res = await call(kv, ids, user, "POST", BASE, {
    startsAt: "2026-12-19T15:00:00+09:00",
    endsAt: "2026-12-20",
    amount: 50000,
    policy: "free24",
    ...body,
  });
  assertEquals(res.status, 201, `create ${JSON.stringify(body)}`);
  return (await res.json()).reservation as { id: string };
}

/** Rewrites a stored record into the first release's shape. */
async function makeOld(kv: Deno.Kv, ledger: string, id: string) {
  const key = ["web", ledger, "resv", id];
  const cur = (await kv.get<Record<string, unknown>>(key)).value!;
  const old = Object.fromEntries(Object.entries(cur).filter(([k]) => FIRST_KEYS.includes(k)));
  await kv.set(key, old);
}

Deno.test("legacy records: every path still works on the oldest record shape", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const ids = makeAuthIds();
    const mom = await getOrCreateUserByEmail(kv, "mom@x.jp", ids);
    const me = await getOrCreateUserByEmail(kv, "me@x.jp", ids);
    const a = await create(kv, ids, mom, { service: "宿A" });
    const b = await create(kv, ids, mom, { service: "宿B" });
    const c1 = await create(kv, ids, mom, { service: "候補1", plan: "1月の宿" });
    const c2 = await create(kv, ids, mom, { service: "候補2", plan: "1月の宿" });
    const m = await create(kv, ids, me, {
      service: "おにやま",
      startsAt: "2026-12-19T15:30:00+09:00",
    });
    const dup = await create(kv, ids, me, { service: "宿A" });
    for (const r of [a, b]) {
      await call(kv, ids, mom, "POST", `${BASE}/${r.id}/members`, { q: "me@x.jp", role: "editor" });
    }
    for (const r of [a, b, c1, c2]) await makeOld(kv, mom.ledgerId, r.id);
    for (const r of [m, dup]) await makeOld(kv, me.ledgerId, r.id);

    // Reads: the owner's list, the member's list (shared rows are read from the
    // owner's ledger), and the MCP view over what the member sees.
    const momList = await call(kv, ids, mom, "GET", BASE);
    assertEquals(momList.status, 200);
    const meList = await call(kv, ids, me, "GET", BASE);
    assertEquals(meList.status, 200);
    const rows = (await meList.json()).reservations;
    const sharedA = rows.find((r: { id: string }) => r.id === a.id);
    assertEquals(
      [sharedA.suggestion, sharedA.rank, sharedA.booked, sharedA.kind],
      [null, null, true, null],
    );
    const view = presentList(rows, listFilterSchema.parse({}), Date.parse("2026-11-13T00:00:00Z"));
    assertEquals(view.count, rows.length);

    // Writes on old records: an editor's edit, the owner's edit, proposals.
    assertEquals((await call(kv, ids, me, "PATCH", `${BASE}/${a.id}`, { rank: 1 })).status, 200);
    assertEquals(
      (await call(kv, ids, mom, "PATCH", `${BASE}/${b.id}`, { notes: "メモ" })).status,
      200,
    );
    await makeOld(kv, mom.ledgerId, b.id);
    assertEquals(
      (await call(kv, ids, me, "POST", `${BASE}/${b.id}/suggest`, { action: "cancel" })).status,
      200,
    );
    assertEquals((await call(kv, ids, mom, "POST", `${BASE}/${b.id}/suggest/accept`)).status, 200);
    assertEquals((await call(kv, ids, mom, "DELETE", `${BASE}/${a.id}/suggest`)).status, 200);

    // Settling old records: confirm a plan (its old sibling steps down), cancel, restore.
    assertEquals((await call(kv, ids, mom, "POST", `${BASE}/${c1.id}/confirm`)).status, 200);
    assertEquals((await call(kv, ids, mom, "POST", `${BASE}/${c2.id}/restore`)).status, 200);
    await makeOld(kv, mom.ledgerId, c2.id);
    assertEquals((await call(kv, ids, mom, "POST", `${BASE}/${c2.id}/cancel`)).status, 200);

    // Choosing my old one over her old shared one leaves her a proposal.
    await makeOld(kv, mom.ledgerId, a.id);
    const chose = await call(kv, ids, me, "POST", `${BASE}/${m.id}/choose`, { over: [a.id] });
    assertEquals(chose.status, 200);
    assertEquals((await chose.json()).needsOwner[0]?.suggested, true);

    // Folding my old copy into her old shared one.
    await makeOld(kv, mom.ledgerId, a.id);
    assertEquals(
      (await call(kv, ids, me, "POST", `${BASE}/${a.id}/merge`, { from: dup.id })).status,
      200,
    );

    // The cron sweeps read every ledger.
    for (const r of await listReservations(kv, mom.ledgerId)) await makeOld(kv, mom.ledgerId, r.id);
    const deps = {
      kv,
      nowMs: Date.parse("2026-12-18T12:00:00Z"),
      baseUrl: "https://plancel.test",
      send: () => Promise.resolve(),
    };
    await sweepDeadlineNotifications(deps);
    await sweepSuggestionNotifications(deps);
    assertEquals((await call(kv, ids, mom, "GET", BASE)).status, 200);
    assertEquals((await call(kv, ids, me, "GET", BASE)).status, 200);
  } finally {
    kv.close();
  }
});

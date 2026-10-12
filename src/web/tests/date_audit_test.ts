import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { auditStoredDates, handleAdminDateAudit, isAdminDateAuditPath } from "../date-audit.ts";
import { type AuthIds, getOrCreateUserByEmail, type WebUser } from "../users.ts";

/** Local, so this file does not pull users_test.ts's own tests in with it. */
function makeAuthIds(): AuthIds {
  let n = 0;
  let t = 0;
  return {
    newId: () => `ID${++n}`,
    nowIso: () => "2026-07-21T00:00:00.000Z",
    nowMs: () => 1_000_000,
    randomToken: () => `tok${++t}`,
  };
}

const ADMINS: ReadonlySet<string> = new Set(["admin@b.jp"]);

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

/** A stored record as KV holds it — written raw, the way older rows already sit there. */
function putRaw(
  kv: Deno.Kv,
  user: WebUser,
  id: string,
  startsAt: string,
  endsAt: string | null = null,
  status = "candidate",
) {
  return kv.set(["web", user.ledgerId, "resv", id], {
    id,
    plan: null,
    service: `svc-${id}`,
    startsAt,
    endsAt,
    amount: null,
    location: null,
    policy: "free24",
    status,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    updated_by: null,
  });
}

const get = (path = "/api/admin/date-audit", method = "GET") =>
  new Request(`http://localhost${path}`, { method });

Deno.test("date audit: only GET /api/admin/date-audit, and only for an admin", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const admin = await getOrCreateUserByEmail(kv, "admin@b.jp", ids);
    const someone = await getOrCreateUserByEmail(kv, "someone@b.jp", ids);
    const deps = { kv, adminEmails: ADMINS };

    assertEquals(isAdminDateAuditPath("/api/admin/date-audit"), true);
    assertEquals(isAdminDateAuditPath("/api/admin/reports"), false);
    assertEquals((await handleAdminDateAudit(get(), deps, { user: null })).status, 403);
    assertEquals((await handleAdminDateAudit(get(), deps, { user: someone })).status, 403);
    const post = get("/api/admin/date-audit", "POST");
    assertEquals((await handleAdminDateAudit(post, deps, { user: admin })).status, 405);
    assertEquals((await handleAdminDateAudit(get(), deps, { user: admin })).status, 200);
  });
});

Deno.test("date audit: names every stored date the ledger cannot read, by id only", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const admin = await getOrCreateUserByEmail(kv, "admin@b.jp", ids);
    const a = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    const b = await getOrCreateUserByEmail(kv, "c@d.jp", ids);
    await putRaw(kv, a, "OK", "2026-10-27T10:00:00.000Z");
    await putRaw(kv, a, "OFFSETLESS", "2026-10-27T19:00"); // readable: JST
    await putRaw(kv, a, "SLASH", "2026/10/27 19:00");
    await putRaw(kv, b, "JA", "10月27日 19時", null, "cancelled"); // every status counts
    await putRaw(kv, b, "BAD-END", "2026-10-27T10:00:00.000Z", "来週の金曜");

    const res = await handleAdminDateAudit(get(), { kv, adminEmails: ADMINS }, { user: admin });
    const text = await res.text();
    const body = JSON.parse(text);
    assertEquals(body.users, 3);
    assertEquals(body.reservations, 5);
    const byId = (x: { resvId: string }, y: { resvId: string }) => x.resvId.localeCompare(y.resvId);
    assertEquals(body.unreadable.sort(byId), [
      { userId: b.id, resvId: "BAD-END", field: "endsAt", status: "candidate" },
      { userId: b.id, resvId: "JA", field: "startsAt", status: "cancelled" },
      { userId: a.id, resvId: "SLASH", field: "startsAt", status: "candidate" },
    ]);
    // The stored text is the user's own words; the audit never repeats it.
    for (const raw of ["2026/10/27 19:00", "10月27日", "来週の金曜"]) {
      assertEquals(text.includes(raw), false, raw);
    }
  });
});

Deno.test("date audit: a clean ledger reports nothing", async () => {
  await withKv(async (kv) => {
    const a = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    await putRaw(kv, a, "OK", "2026-10-27T10:00:00.000Z", "2026-10-28T01:00:00.000Z");
    assertEquals(await auditStoredDates(kv), { users: 1, reservations: 1, unreadable: [] });
  });
});

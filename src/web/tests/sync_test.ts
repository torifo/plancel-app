import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { requestSync, sweepDirtySync, type SyncDeps } from "../calendar/sync.ts";
import { cancelReservation, createReservation } from "../store.ts";
import { getGcalEvent, getOrCreateUserByEmail, getUser, linkGoogle } from "../users.ts";
import { seal } from "../../lib/seal.ts";
import { makeAuthIds } from "./users_test.ts";

interface FakeGoogle {
  calls: string[];
  refreshStatus: number;
  deps(kv: Deno.Kv): SyncDeps;
}

function fakeGoogle(): FakeGoogle {
  const g: FakeGoogle = {
    calls: [],
    refreshStatus: 200,
    deps(kv) {
      const fetchFn = ((input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        const method = init?.method ?? "GET";
        g.calls.push(`${method} ${url}`);
        if (url.startsWith("https://oauth2.googleapis.com/token")) {
          return Promise.resolve(
            g.refreshStatus === 200
              ? new Response(JSON.stringify({ access_token: "at" }))
              : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
          );
        }
        if (method === "GET" && url.includes("/calendars/")) {
          return Promise.resolve(
            url.includes("calX") ? new Response("{}") : new Response("{}", { status: 404 }),
          );
        }
        if (method === "POST" && url.endsWith("/calendars")) {
          return Promise.resolve(new Response(JSON.stringify({ id: "calX" })));
        }
        if (method === "POST" && url.includes("/events")) {
          return Promise.resolve(new Response(JSON.stringify({ id: "evX" })));
        }
        if (method === "PATCH" || method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(new Response("{}", { status: 500 }));
      }) as typeof fetch;
      return {
        kv,
        ids: makeAuthIds(),
        fetchFn,
        google: { clientId: "cid", clientSecret: "sec" },
        kek: undefined,
      };
    },
  };
  return g;
}

/** Deps whose calendar API always 500s (token refresh still works). */
function brokenDeps(base: SyncDeps): SyncDeps {
  return {
    ...base,
    fetchFn: ((input: URL | RequestInfo) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "at" })));
      }
      return Promise.resolve(new Response("{}", { status: 500 }));
    }) as typeof fetch,
  };
}

async function isDirty(kv: Deno.Kv, userId: string, resvId: string): Promise<boolean> {
  return (await kv.get(["gcal_dirty", userId, resvId])).value !== null;
}

async function withUser(
  fn: (
    kv: Deno.Kv,
    userId: string,
    ledger: string,
    ids: ReturnType<typeof makeAuthIds>,
  ) => Promise<void>,
) {
  const kv = await Deno.openKv(":memory:");
  try {
    const ids = makeAuthIds();
    const user = await getOrCreateUserByEmail(kv, "s@example.com", ids);
    await linkGoogle(kv, user.id, {
      sub: "sub-1",
      refreshTokenSealed: await seal("rt", undefined),
      calendarId: null,
      error: null,
    }, ids);
    await fn(kv, user.id, user.ledgerId, ids);
  } finally {
    kv.close();
  }
}

const RESV = {
  plan: null,
  service: "宿",
  startsAt: "2026-08-01T15:00:00+09:00",
  amount: null,
  location: null,
  policy: "unknown" as const,
  confirmed: true,
};

Deno.test("requestSync (inline): calendar created, event inserted, dirty cleared", async () => {
  await withUser(async (kv, userId, ledger, ids) => {
    const r = await createReservation(kv, ledger, RESV, ids);
    const g = fakeGoogle();
    await requestSync(g.deps(kv), userId, r.id);
    assertEquals((await getGcalEvent(kv, userId, r.id))?.eventId, "evX");
    assertEquals((await getUser(kv, userId))?.google?.calendarId, "calX");
    assertEquals(await isDirty(kv, userId, r.id), false);
  });
});

Deno.test("cancelled reservation deletes the event and the mapping", async () => {
  await withUser(async (kv, userId, ledger, ids) => {
    const r = await createReservation(kv, ledger, RESV, ids);
    const g = fakeGoogle();
    await requestSync(g.deps(kv), userId, r.id); // sync up
    await cancelReservation(kv, ledger, r.id, ids);
    await requestSync(g.deps(kv), userId, r.id); // reconcile down
    assertEquals(await getGcalEvent(kv, userId, r.id), null);
    assertEquals(g.calls.some((c) => c.startsWith("DELETE ")), true);
    assertEquals(await isDirty(kv, userId, r.id), false);
  });
});

Deno.test("invalid_grant marks the user reauth and clears the dirty flag", async () => {
  await withUser(async (kv, userId, ledger, ids) => {
    const r = await createReservation(kv, ledger, RESV, ids);
    const g = fakeGoogle();
    g.refreshStatus = 400;
    await requestSync(g.deps(kv), userId, r.id);
    assertEquals((await getUser(kv, userId))?.google?.error, "reauth");
    assertEquals(await isDirty(kv, userId, r.id), false); // permanent, no retry
  });
});

Deno.test("transient failure stays dirty; the cron sweep repairs it later", async () => {
  await withUser(async (kv, userId, ledger, ids) => {
    const r = await createReservation(kv, ledger, RESV, ids);
    const g = fakeGoogle();
    await requestSync(brokenDeps(g.deps(kv)), userId, r.id);
    assertEquals(await isDirty(kv, userId, r.id), true);
    assertEquals(await getGcalEvent(kv, userId, r.id), null);

    // Google recovers -> the 15-minute sweep repairs the entry
    const repaired = await sweepDirtySync(g.deps(kv));
    assertEquals(repaired, 1);
    assertEquals((await getGcalEvent(kv, userId, r.id))?.eventId, "evX");
    assertEquals(await isDirty(kv, userId, r.id), false);
  });
});

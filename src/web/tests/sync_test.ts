import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { handleSyncMessage, requestSync, type SyncDeps, type SyncMsg } from "../calendar/sync.ts";
import { cancelReservation, createReservation } from "../store.ts";
import { getGcalEvent, getOrCreateUserByEmail, getUser, linkGoogle } from "../users.ts";
import { seal } from "../../lib/seal.ts";
import { makeAuthIds } from "./users_test.ts";

interface FakeGoogle {
  calls: string[];
  refreshStatus: number;
  deps(kv: Deno.Kv, enqueued: Array<{ msg: SyncMsg; delayMs: number }>): SyncDeps;
}

function fakeGoogle(): FakeGoogle {
  const g: FakeGoogle = {
    calls: [],
    refreshStatus: 200,
    deps(kv, enqueued) {
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
          // stored calendar id "calX" exists; anything else is gone
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
        enqueue: (msg, delayMs) => {
          enqueued.push({ msg, delayMs });
          return Promise.resolve();
        },
      };
    },
  };
  return g;
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

const msg = (userId: string, resvId: string, attempt = 0): SyncMsg => ({
  type: "gcal-sync",
  userId,
  resvId,
  attempt,
});

Deno.test("confirmed reservation syncs: calendar created, event inserted, mapping saved", async () => {
  await withUser(async (kv, userId, ledger, ids) => {
    const r = await createReservation(kv, ledger, {
      plan: null,
      service: "宿",
      startsAt: "2026-08-01T15:00:00+09:00",
      amount: null,
      location: null,
      policy: "unknown",
      confirmed: true,
    }, ids);
    const g = fakeGoogle();
    const enq: Array<{ msg: SyncMsg; delayMs: number }> = [];
    await handleSyncMessage(g.deps(kv, enq), msg(userId, r.id));
    assertEquals((await getGcalEvent(kv, userId, r.id))?.eventId, "evX");
    assertEquals((await getUser(kv, userId))?.google?.calendarId, "calX");
    assertEquals(enq.length, 0); // success -> no retry
  });
});

Deno.test("cancelled reservation deletes the event and the mapping", async () => {
  await withUser(async (kv, userId, ledger, ids) => {
    const r = await createReservation(kv, ledger, {
      plan: null,
      service: "宿",
      startsAt: "2026-08-01T15:00:00+09:00",
      amount: null,
      location: null,
      policy: "unknown",
      confirmed: true,
    }, ids);
    const g = fakeGoogle();
    const enq: Array<{ msg: SyncMsg; delayMs: number }> = [];
    await handleSyncMessage(g.deps(kv, enq), msg(userId, r.id)); // sync up
    await cancelReservation(kv, ledger, r.id, ids);
    await handleSyncMessage(g.deps(kv, enq), msg(userId, r.id)); // reconcile down
    assertEquals(await getGcalEvent(kv, userId, r.id), null);
    assertEquals(g.calls.some((c) => c.startsWith("DELETE ")), true);
    assertEquals(enq.length, 0);
  });
});

Deno.test("invalid_grant marks the user reauth and does NOT retry", async () => {
  await withUser(async (kv, userId, ledger, ids) => {
    const r = await createReservation(kv, ledger, {
      plan: null,
      service: "宿",
      startsAt: "2026-08-01T15:00:00+09:00",
      amount: null,
      location: null,
      policy: "unknown",
      confirmed: true,
    }, ids);
    const g = fakeGoogle();
    g.refreshStatus = 400;
    const enq: Array<{ msg: SyncMsg; delayMs: number }> = [];
    await handleSyncMessage(g.deps(kv, enq), msg(userId, r.id));
    assertEquals((await getUser(kv, userId))?.google?.error, "reauth");
    assertEquals(enq.length, 0);
  });
});

Deno.test("transient failure re-enqueues with backoff, then gives up at max", async () => {
  await withUser(async (kv, userId, ledger, ids) => {
    const r = await createReservation(kv, ledger, {
      plan: null,
      service: "宿",
      startsAt: "2026-08-01T15:00:00+09:00",
      amount: null,
      location: null,
      policy: "unknown",
      confirmed: true,
    }, ids);
    const g = fakeGoogle();
    const enq: Array<{ msg: SyncMsg; delayMs: number }> = [];
    const deps = g.deps(kv, enq);
    // break the calendar API (events insert 500s) by pointing fetch at junk:
    const broken: SyncDeps = {
      ...deps,
      fetchFn: ((input: URL | RequestInfo) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("https://oauth2.googleapis.com/token")) {
          return Promise.resolve(new Response(JSON.stringify({ access_token: "at" })));
        }
        return Promise.resolve(new Response("{}", { status: 500 }));
      }) as typeof fetch,
    };
    await handleSyncMessage(broken, msg(userId, r.id, 0));
    assertEquals(enq.length, 1);
    assertEquals(enq[0]?.msg.attempt, 1);
    assertEquals(enq[0]?.delayMs, 30_000);
    await handleSyncMessage(broken, msg(userId, r.id, 4)); // last attempt
    assertEquals(enq.length, 1); // gave up, nothing new enqueued
  });
});

Deno.test("requestSync enqueues an attempt-0 reconcile", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const g = fakeGoogle();
    const enq: Array<{ msg: SyncMsg; delayMs: number }> = [];
    await requestSync(g.deps(kv, enq), "U1", "R1");
    assertEquals(enq[0]?.msg, { type: "gcal-sync", userId: "U1", resvId: "R1", attempt: 0 });
    assertEquals(enq[0]?.delayMs, 0);
  } finally {
    kv.close();
  }
});

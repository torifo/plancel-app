import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import { makeIds, withKv } from "../../agent/tests/helpers.ts";
import { sensibleModel } from "../../agent/tests/fixtures.ts";
import { type AgentRouteDeps, handleAgentRoute } from "../../agent/routes.ts";
import { listProposals, listRuns, putProposal } from "../../agent/store.ts";
import { type AuthDeps, handleAuthApi } from "../../web/auth/routes.ts";
import { cancelReservation, listReservations } from "../../web/store.ts";
import {
  countUsers,
  getOrCreateUserByEmail,
  getSessionUser,
  getUser,
  type WebUser,
} from "../../web/users.ts";
import { seedDemoIfEmpty, seedDemoLedger } from "../demo.ts";
import {
  clientIp,
  demoSweepUsers,
  handleDemoStart,
  isSandbox,
  listSandboxes,
  markDemoHtml,
  SANDBOX_TTL_MS,
  type SandboxDeps,
  StartRateLimiter,
  touchSandbox,
} from "../sandbox.ts";

const NOW = "2026-10-15T11:00:00Z";
const HOUR = 3_600_000;

interface Rig {
  kv: Deno.Kv;
  clock: VirtualClock;
  ids: ReturnType<typeof makeIds>;
  deps: SandboxDeps;
}

async function withRig(fn: (r: Rig, over?: Partial<SandboxDeps>) => Promise<void>) {
  await withKv(async (kv) => {
    const clock = new VirtualClock(NOW);
    const ids = makeIds(clock);
    await fn({
      kv,
      clock,
      ids,
      deps: { kv, clock, ids, max: 100, limiter: new StartRateLimiter(10) },
    });
  });
}

const startReq = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/demo/start", { method: "POST", headers });

const sidOf = (res: Response): string =>
  /plancel_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;

/** Starts a sandbox and returns the user the browser would be logged in as. */
async function start(r: Rig, ip = "203.0.113.1"): Promise<WebUser> {
  const res = await handleDemoStart(startReq(), r.deps, ip);
  assertEquals(res.status, 200);
  const user = await getSessionUser(r.kv, sidOf(res), r.clock.now().epochMilliseconds);
  assert(user !== null, "the cookie must be a live session");
  return user;
}

const fakeProposal = (id: string, reservationId: string) => ({
  id,
  runId: "R",
  reservationId,
  service: "x",
  startsAt: "x",
  reason: "x",
  draftMessage: "x",
  urgency: "normal" as const,
  estimate: {
    pctNow: null,
    lossNowYen: null,
    lossAfterNextBoundaryYen: null,
    nextBoundaryAt: null,
    freeUntil: null,
  },
  status: "pending" as const,
  createdAt: NOW,
  decidedAt: null,
  outcome: null,
});

Deno.test("start: a private, seeded sandbox with no usable password, and the browser is logged in", async () => {
  await withRig(async (r) => {
    const res = await handleDemoStart(startReq(), r.deps, "203.0.113.1");
    assertEquals(res.status, 200);
    const cookie = res.headers.get("set-cookie")!;
    assertStringIncludes(cookie, "HttpOnly");
    assertStringIncludes(cookie, "SameSite=Lax");
    assertStringIncludes(cookie, `Max-Age=${SANDBOX_TTL_MS / 1000}`);

    const user = (await getSessionUser(r.kv, sidOf(res), r.clock.now().epochMilliseconds))!;
    assert(/^sandbox-[a-z0-9]+@plancel\.example$/.test(user.email), user.email);
    assertEquals(user.passwordHash, null); // nobody can log in to it with a password
    assertEquals(user.emailVerified, true);
    assertEquals(await isSandbox(r.kv, user.id), true);

    const rows = await listReservations(r.kv, user.ledgerId);
    assertEquals(rows.length, 6);
    assertEquals(rows.find((x) => x.service === "鮨 さいとう")?.status, "confirmed");
    assertEquals(rows.find((x) => x.service === "トラットリア アルバ")?.status, "to_cancel");
  });
});

Deno.test("start: each visitor gets an isolated ledger, session and sandbox record", async () => {
  await withRig(async (r) => {
    const a = await start(r, "198.51.100.1");
    const b = await start(r, "198.51.100.2");
    assert(a.id !== b.id && a.ledgerId !== b.ledgerId && a.email !== b.email);

    // Cancelling in one sandbox does not touch the other.
    const rowsA = await listReservations(r.kv, a.ledgerId);
    await cancelReservation(r.kv, a.ledgerId, rowsA[0]!.id, r.ids);
    assertEquals(
      (await listReservations(r.kv, a.ledgerId)).filter((x) => x.status === "cancelled").length,
      1,
    );
    assertEquals(
      (await listReservations(r.kv, b.ledgerId)).filter((x) => x.status === "cancelled").length,
      0,
    );
    assertEquals((await listSandboxes(r.kv)).length, 2);
  });
});

Deno.test("start: the agent API tells the UI it is a sandbox (and the fixed demo account it is not)", async () => {
  await withRig(async (r) => {
    const demo = await seedDemoIfEmpty({ ...r, password: "demo-pass-1234" });
    if (demo.status !== "seeded") throw new Error("seed failed");
    const sandbox = await start(r);
    const agent: AgentRouteDeps = {
      kv: r.kv,
      clock: r.clock,
      ids: r.ids,
      transport: null,
      agentToken: undefined,
      resolveUser: (req) => getUser(r.kv, req.headers.get("x-test-user")!),
      isSandbox: (u) => isSandbox(r.kv, u.id),
    };
    const get = async (u: WebUser) =>
      await (await handleAgentRoute(
        new Request("http://localhost/api/agent/runs", { headers: { "x-test-user": u.id } }),
        agent,
      )).json();
    assertEquals((await get(sandbox)).sandbox, true);
    assertEquals((await get(demo.user)).sandbox, false);
  });
});

Deno.test("cap: the oldest sandbox is evicted with everything it owns", async () => {
  await withRig(async (r) => {
    r.deps.max = 3;
    const made: WebUser[] = [];
    for (let i = 0; i < 5; i++) {
      made.push(await start(r, `192.0.2.${i}`));
      r.clock.advance("PT1M");
    }
    const left = await listSandboxes(r.kv);
    assertEquals(left.length, 3);
    assertEquals(left.map((s) => s.userId), made.slice(2).map((u) => u.id));

    // The two evicted are gone entirely: user, ledger, plan guards, agent records, sandbox record.
    const [first, second] = made as [WebUser, WebUser];
    for (const gone of [first, second]) {
      assertEquals(await getUser(r.kv, gone.id), null);
      assertEquals(await isSandbox(r.kv, gone.id), false);
      assertEquals((await listReservations(r.kv, gone.ledgerId)).length, 0);
      const leftover: Deno.KvKey[] = [];
      for await (const e of r.kv.list({ prefix: ["web", gone.ledgerId] })) leftover.push(e.key);
      assertEquals(leftover, []);
    }
    // The survivors are untouched.
    assertEquals((await listReservations(r.kv, made[4]!.ledgerId)).length, 6);
  });
});

Deno.test("cap: an evicted sandbox's agent history and proposals go with it", async () => {
  await withRig(async (r) => {
    r.deps.max = 1;
    const first = await start(r, "192.0.2.1");
    const row = (await listReservations(r.kv, first.ledgerId))[0]!;
    await putProposal(r.kv, first.id, fakeProposal("P1", row.id));
    assertEquals((await listProposals(r.kv, first.id)).length, 1);
    r.clock.advance("PT1M");
    await start(r, "192.0.2.2");
    assertEquals((await listProposals(r.kv, first.id)).length, 0);
    assertEquals((await listRuns(r.kv, first.id, 5)).length, 0);
    assertEquals((await listSandboxes(r.kv)).length, 1);
  });
});

Deno.test("start: sandboxes older than 48h are pruned when the next one starts", async () => {
  await withRig(async (r) => {
    const old = await start(r, "192.0.2.1");
    r.clock.advance(`PT${SANDBOX_TTL_MS / HOUR - 1}H`);
    assertEquals((await listSandboxes(r.kv)).length, 1);
    await start(r, "192.0.2.2"); // 47h on: still within its life
    assertEquals((await listSandboxes(r.kv)).length, 2);
    r.clock.advance("PT2H");
    const fresh = await start(r, "192.0.2.3");
    const alive = (await listSandboxes(r.kv)).map((s) => s.userId);
    assertEquals(alive.includes(old.id), false);
    assert(alive.includes(fresh.id));
    assertEquals(await getUser(r.kv, old.id), null);
  });
});

Deno.test("rate limit: 10 starts an hour per address, the 11th is refused and makes nothing", async () => {
  await withRig(async (r) => {
    for (let i = 0; i < 10; i++) {
      assertEquals((await handleDemoStart(startReq(), r.deps, "198.51.100.7")).status, 200);
    }
    const refused = await handleDemoStart(startReq(), r.deps, "198.51.100.7");
    assertEquals(refused.status, 429);
    assertEquals(refused.headers.get("set-cookie"), null);
    assertEquals((await listSandboxes(r.kv)).length, 10);

    // Another address is unaffected; the first is allowed again an hour later.
    assertEquals((await handleDemoStart(startReq(), r.deps, "198.51.100.8")).status, 200);
    r.clock.advance("PT1H1S");
    assertEquals((await handleDemoStart(startReq(), r.deps, "198.51.100.7")).status, 200);
  });
});

Deno.test("rate limit: keyed by the address the proxy saw, not by what the client claims", async () => {
  assertEquals(
    clientIp(startReq({ "x-forwarded-for": "6.6.6.6, 5.5.5.5" }), "10.0.0.1"),
    "5.5.5.5",
  );
  assertEquals(clientIp(startReq({ "x-forwarded-for": "5.5.5.5" }), "10.0.0.1"), "5.5.5.5");
  assertEquals(clientIp(startReq(), "10.0.0.1"), "10.0.0.1");
  assertEquals(clientIp(startReq(), undefined), "unknown");

  await withRig(async (r) => {
    const limiter = new StartRateLimiter(2);
    r.deps.limiter = limiter;
    for (const spoof of ["1.1.1.1", "2.2.2.2"]) {
      const res = await handleDemoStart(
        startReq({ "x-forwarded-for": `${spoof}, 5.5.5.5` }),
        r.deps,
      );
      assertEquals(res.status, 200);
    }
    const third = await handleDemoStart(
      startReq({ "x-forwarded-for": "3.3.3.3, 5.5.5.5" }),
      r.deps,
    );
    assertEquals(third.status, 429);
  });
});

Deno.test("rate limiter forgets old addresses instead of growing without bound", () => {
  const limiter = new StartRateLimiter(1, HOUR, 3);
  for (let i = 0; i < 10; i++) assertEquals(limiter.allow(`ip${i}`, 0), true);
  // ip0 was evicted to bound memory, so it is allowed again; the newest is still limited.
  assertEquals(limiter.allow("ip0", 1), true);
  assertEquals(limiter.allow("ip9", 1), false);
});

Deno.test("outside demo mode the route does not exist", async () => {
  await withRig(async (r) => {
    const res = await handleDemoStart(startReq(), null, "203.0.113.1");
    assertEquals(res.status, 404);
    assertEquals(res.headers.get("set-cookie"), null);
    assertEquals(await countUsers(r.kv), 0);
    assertEquals((await listSandboxes(r.kv)).length, 0);
    // In demo mode only POST starts one.
    const get = await handleDemoStart(
      new Request("http://localhost/api/demo/start"),
      r.deps,
      "203.0.113.1",
    );
    assertEquals(get.status, 405);
  });
});

Deno.test("the scheduler runs for the demo account and recent sandboxes only", async () => {
  await withRig(async (r) => {
    const demo = await seedDemoIfEmpty({ ...r, password: "demo-pass-1234" });
    if (demo.status !== "seeded") throw new Error("seed failed");
    // An open-signup user with the same kind of ledger: in demo mode the agent leaves it alone.
    const signup = await getOrCreateUserByEmail(r.kv, "signup@example.com", r.ids);
    await seedDemoLedger(r.kv, signup.ledgerId, r.clock, r.ids);

    const stale = await start(r, "192.0.2.1");
    const used = await start(r, "192.0.2.2");
    r.clock.advance("PT20H");
    await touchSandbox(r.kv, used.id, r.clock.now().epochMilliseconds);
    r.clock.advance("PT6H"); // `stale` was last seen 26h ago, `used` 6h ago
    const fresh = await start(r, "192.0.2.3");

    const model = sensibleModel();
    const deps: AgentRouteDeps = {
      kv: r.kv,
      clock: r.clock,
      ids: r.ids,
      transport: model,
      agentToken: "tok",
      resolveUser: () => Promise.resolve(null),
      sweepUsers: () => demoSweepUsers(r.kv, r.clock.now().epochMilliseconds),
    };
    const sweep = async () =>
      await (await handleAgentRoute(
        new Request("http://localhost/agent/run", {
          method: "POST",
          headers: { "x-plancel-agent-token": "tok" },
        }),
        deps,
      )).json();

    const first = await sweep();
    assertEquals(first.ran, 3);
    const touched = first.results.map((x: { userId: string }) => x.userId).sort();
    assertEquals(touched, [demo.user.id, used.id, fresh.id].sort());
    for (const left of [stale, signup]) {
      assertEquals((await listRuns(r.kv, left.id, 5)).length, 0);
    }
    assertEquals(await getUser(r.kv, stale.id) !== null, true); // stale is idle, not deleted

    // The unchanged-ledger skip still holds, so a second pass costs no model calls.
    const calls = model.requests.length;
    const second = await sweep();
    assertEquals(second.skipped, 3);
    assertEquals(model.requests.length, calls);
  });
});

Deno.test("touching a sandbox is throttled and ignores everyone else", async () => {
  await withRig(async (r) => {
    const sandbox = await start(r);
    const lastActive = async () => (await listSandboxes(r.kv))[0]!.lastActiveAt;
    const created = await lastActive();

    r.clock.advance("PT1M");
    await touchSandbox(r.kv, sandbox.id, r.clock.now().epochMilliseconds);
    assertEquals(await lastActive(), created); // too soon to bother writing

    r.clock.advance("PT10M");
    await touchSandbox(r.kv, sandbox.id, r.clock.now().epochMilliseconds);
    assertEquals(await lastActive(), r.clock.now().epochMilliseconds);

    const regular = await getOrCreateUserByEmail(r.kv, "reg@example.com", r.ids);
    await touchSandbox(r.kv, regular.id, r.clock.now().epochMilliseconds);
    assertEquals(await isSandbox(r.kv, regular.id), false);
  });
});

Deno.test("sandboxes do not use up the open-signup cap; normal signup still stops at it", async () => {
  await withRig(async (r) => {
    for (let i = 0; i < 5; i++) await start(r, `192.0.2.${i}`);
    assertEquals(await countUsers(r.kv), 0);

    const auth: AuthDeps = {
      kv: r.kv,
      ids: r.ids,
      fetchFn: fetch,
      google: null,
      sendMagicLink: null,
      kek: undefined,
      maxUsers: 2,
    };
    const register = async (email: string) =>
      (await handleAuthApi(
        new Request("https://app.test/auth/register", {
          method: "POST",
          body: JSON.stringify({ email, password: "password-1234" }),
        }),
        auth,
      )).status;
    assertEquals(await register("one@example.com"), 302);
    assertEquals(await register("two@example.com"), 302);
    assertEquals(await register("three@example.com"), 403); // the cap is unchanged
    assertEquals(await countUsers(r.kv), 2);
  });
});

Deno.test("the page is marked as a demo only when asked", async () => {
  const page = await Deno.readTextFile(new URL("../../../web/index.html", import.meta.url));
  assertStringIncludes(page, '<html lang="ja">'); // the marker this relies on
  const marked = markDemoHtml(page);
  assertStringIncludes(marked, '<html lang="ja" data-demo="1">');
  assertEquals(marked.split('data-demo="1"').length - 1 >= 1, true);
  // The login view has the button, and the banner's reset control exists.
  for (const id of ["demoStartBtn", "sandboxBar", "sandboxResetBtn"]) {
    assertStringIncludes(page, `id="${id}"`);
  }
  assertStringIncludes(page, "デモを始める（ログイン不要）");
  assertStringIncludes(page, "これはデモ用の環境です。データは一定時間で消えます。");
});

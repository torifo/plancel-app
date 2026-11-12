/**
 * The view-only browser session (owner 2026-11-12): a device token can ask for
 * a one-use link; opening it signs a browser in to LOOK at the ledger for 15
 * minutes. It must never be able to do more than the token it came from —
 * and here it can do less: it cannot write at all.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { type AuthDeps, handleAuthApi, viewOnlyGate } from "../auth/routes.ts";
import {
  type AuthIds,
  getOrCreateUserByEmail,
  issueApiToken,
  revokeApiTokenById,
  VIEW_SESSION_TTL_MS,
} from "../users.ts";

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

function clockIds(startMs = 1_700_000_000_000): AuthIds & { tick(ms: number): void } {
  let n = 0;
  let t = 0;
  let now = startMs;
  return {
    newId: () => `ID${++n}`,
    nowIso: () => new Date(now).toISOString(),
    nowMs: () => now,
    randomToken: () => `tok${++t}-${"x".repeat(40)}`,
    tick: (ms) => {
      now += ms;
    },
  };
}

const depsOf = (kv: Deno.Kv, ids: AuthIds): AuthDeps => ({
  kv,
  ids,
  fetchFn: fetch,
  google: null,
  sendMagicLink: null,
  kek: undefined,
});

const req = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Request(`https://app.test${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function paired(kv: Deno.Kv, ids: AuthIds) {
  const user = await getOrCreateUserByEmail(kv, "mom@example.com", ids);
  const issued = await issueApiToken(kv, user.id, ids, { name: "PC", kind: "device" });
  return { user, token: issued!.token, tokenId: issued!.record.id };
}

/** Asks for a link with the token and opens it; returns the browser's cookie. */
async function openView(deps: AuthDeps, token: string) {
  const link = await handleAuthApi(
    req("POST", "/auth/device/view-link", { "x-plancel-token": token }),
    deps,
  );
  const body = await link.json();
  const opened = await handleAuthApi(
    req("GET", new URL(body.url).pathname + new URL(body.url).search),
    deps,
  );
  return { link, body, opened, cookie: cookieOf(opened) };
}

Deno.test("view link: a token gets a one-use link; opening it signs the browser in to look", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const deps = depsOf(kv, ids);
    const { token } = await paired(kv, ids);

    const { link, body, opened, cookie } = await openView(deps, token);
    assertEquals(link.status, 200);
    assertEquals(body.expiresInSec, 60);
    assertEquals(body.sessionMinutes, 15);
    // The token itself is never in the link.
    assertEquals(String(body.url).includes(token), false);
    assertEquals(opened.status, 302);
    assertEquals(opened.headers.get("location"), "/");
    assertStringIncludes(opened.headers.get("set-cookie") ?? "", "Max-Age=900");

    // /auth/me says who, says it is view-only, and gives away no secret.
    const me = await (await handleAuthApi(req("GET", "/auth/me", { cookie }), deps)).json();
    assertEquals(me.email, "mom@example.com");
    assertEquals(me.viewOnly, true);
    assertEquals([me.icsPath, me.mailAddress, me.apiTokens], [null, null, []]);

    // One use: the same link a second time signs nobody in.
    const again = await handleAuthApi(
      req("GET", new URL(body.url).pathname + new URL(body.url).search),
      deps,
    );
    assertEquals(again.headers.get("set-cookie"), null);
    assertStringIncludes(again.headers.get("location") ?? "", "auth_error=view_link");
  });
});

Deno.test("view link: needs a real device token, and expires in a minute", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const deps = depsOf(kv, ids);
    const { token } = await paired(kv, ids);
    const none = await handleAuthApi(req("POST", "/auth/device/view-link"), deps);
    assertEquals(none.status, 401);
    const bad = await handleAuthApi(
      req("POST", "/auth/device/view-link", { "x-plancel-token": "nope" }),
      deps,
    );
    assertEquals(bad.status, 401);

    const link = await (await handleAuthApi(
      req("POST", "/auth/device/view-link", { "x-plancel-token": token }),
      deps,
    )).json();
    ids.tick(61_000);
    const late = await handleAuthApi(
      req("GET", new URL(link.url).pathname + new URL(link.url).search),
      deps,
    );
    assertEquals(late.headers.get("set-cookie"), null);
  });
});

Deno.test("view session: reads pass, every write and every identity route is refused", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const deps = depsOf(kv, ids);
    const { token } = await paired(kv, ids);
    const { cookie } = await openView(deps, token);
    const gate = (method: string, path: string) =>
      viewOnlyGate(req(method, path, { cookie }), deps);

    for (
      const path of [
        "/",
        "/icons/icon-192.png",
        "/auth/me",
        "/api/reservations",
        "/api/reservations/R1/members",
        "/api/policy-templates",
        "/api/policy-templates/lookup?service=x",
      ]
    ) {
      assertEquals(await gate("GET", path), null, `GET ${path} は通る`);
    }
    // Leaving, and the page's own boot beacon.
    assertEquals(await gate("POST", "/auth/logout"), null);
    assertEquals(await gate("POST", "/api/beacon"), null);

    const refused: [string, string][] = [
      ["POST", "/api/reservations"],
      ["PATCH", "/api/reservations/R1"],
      ["DELETE", "/api/reservations/R1"],
      ["POST", "/api/reservations/R1/confirm"],
      ["PUT", "/api/policy-templates/x"],
      ["POST", "/api/parse"],
      ["POST", "/api/reports"],
      ["GET", "/auth/tokens"],
      ["POST", "/auth/tokens"],
      ["POST", "/auth/device/approve"],
      ["GET", "/auth/google"],
      ["POST", "/auth/line/code"],
      ["DELETE", "/auth/account"],
      ["GET", "/api/users/lookup?q=a@b.c"],
      ["GET", "/api/admin/reports"],
    ];
    for (const [method, path] of refused) {
      const res = await gate(method, path);
      assertEquals(res?.status, 403, `${method} ${path} は 403`);
      assertEquals((await res!.json()).error, "view_only");
    }

    // A normal session and a request with no session are not this gate's business.
    assertEquals(await viewOnlyGate(req("POST", "/api/reservations"), deps), null);
  });
});

Deno.test("view session: ends after 15 minutes, on logout, and when its token is revoked", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const deps = depsOf(kv, ids);
    const { user, token, tokenId } = await paired(kv, ids);
    const me = (cookie: string) => handleAuthApi(req("GET", "/auth/me", { cookie }), deps);

    const a = await openView(deps, token);
    assertEquals((await me(a.cookie)).status, 200);
    ids.tick(VIEW_SESSION_TTL_MS + 1);
    assertEquals((await me(a.cookie)).status, 401);

    const b = await openView(deps, token);
    await handleAuthApi(req("POST", "/auth/logout", { cookie: b.cookie }), deps);
    assertEquals((await me(b.cookie)).status, 401);

    // 失効: the device is revoked on マイページ → the browser it opened is out too.
    const c = await openView(deps, token);
    assertEquals((await me(c.cookie)).status, 200);
    await revokeApiTokenById(kv, user.id, tokenId);
    assertEquals((await me(c.cookie)).status, 401);
    assertEquals(
      await viewOnlyGate(req("POST", "/api/reservations", { cookie: c.cookie }), deps),
      null,
    );
  });
});

Deno.test("view link: a browser that is already signed in keeps its own session", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const deps = depsOf(kv, ids);
    const { token } = await paired(kv, ids);
    const reg = await handleAuthApi(
      req("POST", "/auth/register", {}, { email: "dad@example.com", password: "hunter2secret" }),
      deps,
    );
    const full = cookieOf(reg);
    const link = await (await handleAuthApi(
      req("POST", "/auth/device/view-link", { "x-plancel-token": token }),
      deps,
    )).json();
    const opened = await handleAuthApi(
      req("GET", new URL(link.url).pathname + new URL(link.url).search, { cookie: full }),
      deps,
    );
    // Not downgraded, not switched to someone else's ledger.
    assertEquals(opened.headers.get("set-cookie"), null);
    const me = await (await handleAuthApi(req("GET", "/auth/me", { cookie: full }), deps)).json();
    assertEquals([me.email, me.viewOnly], ["dad@example.com", undefined]);
  });
});

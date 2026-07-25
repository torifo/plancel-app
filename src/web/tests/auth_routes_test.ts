import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { type AuthDeps, handleAuthApi, isAuthPath, resolveIdentity } from "../auth/routes.ts";
import { findUserByEmail } from "../users.ts";
import { createReservation } from "../store.ts";
import { makeAuthIds } from "./users_test.ts";

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Fake Google token endpoint issuing a fixed sub/email id_token. */
function fakeGoogleFetch(opts: { refreshToken?: string | null } = {}): typeof fetch {
  return ((input: URL | RequestInfo) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const idToken = `h.${b64url(JSON.stringify({ sub: "g-sub-1", email: "g@example.com" }))}.s`;
      return Promise.resolve(
        new Response(JSON.stringify({
          access_token: "at-1",
          id_token: idToken,
          ...(opts.refreshToken === null ? {} : { refresh_token: opts.refreshToken ?? "rt-1" }),
        })),
      );
    }
    return Promise.resolve(new Response("{}", { status: 500 }));
  }) as typeof fetch;
}

function makeDeps(kv: Deno.Kv, over: Partial<AuthDeps> = {}): AuthDeps {
  return {
    kv,
    ids: makeAuthIds(),
    fetchFn: fakeGoogleFetch(),
    google: { clientId: "cid", clientSecret: "sec" },
    sendMagicLink: null,
    kek: undefined,
    ...over,
  };
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://app.test${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

function cookieOf(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
}

Deno.test("isAuthPath", () => {
  assertEquals(isAuthPath("/auth/google"), true);
  assertEquals(isAuthPath("/api/reservations"), false);
});

Deno.test("google login: start redirects with PKCE, callback creates user + session", async () => {
  await withKv(async (kv) => {
    const deps = makeDeps(kv);
    const start = await handleAuthApi(req("GET", "/auth/google"), deps);
    assertEquals(start.status, 302);
    const loc = new URL(start.headers.get("location") ?? "");
    assertEquals(loc.searchParams.get("client_id"), "cid");
    assertEquals(loc.searchParams.get("code_challenge_method"), "S256");
    assertStringIncludes(loc.searchParams.get("scope") ?? "", "calendar.app.created");
    const state = loc.searchParams.get("state") ?? "";

    const cb = await handleAuthApi(
      req("GET", `/auth/callback?code=abc&state=${state}`),
      deps,
    );
    assertEquals(cb.status, 302);
    assertEquals(cb.headers.get("location"), "/");
    const cookie = cookieOf(cb);
    assertStringIncludes(cookie, "plancel_session=");

    const me = await handleAuthApi(req("GET", "/auth/me", undefined, { cookie }), deps);
    assertEquals(me.status, 200);
    const body = await me.json();
    assertEquals(body.email, "g@example.com");
    assertEquals(body.google, true);
    assertStringIncludes(body.icsPath, "/calendar/");
  });
});

Deno.test("google callback without a refresh token marks the link reauth", async () => {
  await withKv(async (kv) => {
    const deps = makeDeps(kv, { fetchFn: fakeGoogleFetch({ refreshToken: null }) });
    const start = await handleAuthApi(req("GET", "/auth/google"), deps);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const cb = await handleAuthApi(req("GET", `/auth/callback?code=c&state=${state}`), deps);
    const me = await handleAuthApi(
      req("GET", "/auth/me", undefined, { cookie: cookieOf(cb) }),
      deps,
    );
    const body = await me.json();
    assertEquals(body.google, false);
    assertEquals(body.googleError, "reauth");
  });
});

Deno.test("callback with a stale state redirects to an auth_error", async () => {
  await withKv(async (kv) => {
    const deps = makeDeps(kv);
    const cb = await handleAuthApi(req("GET", "/auth/callback?code=c&state=unknown"), deps);
    assertEquals(cb.status, 302);
    assertStringIncludes(cb.headers.get("location") ?? "", "auth_error=state_expired");
  });
});

Deno.test("magic link: send -> verify -> me -> logout", async () => {
  await withKv(async (kv) => {
    const sent: string[] = [];
    const deps = makeDeps(kv, {
      sendMagicLink: (_email, url) => {
        sent.push(url);
        return Promise.resolve();
      },
    });
    const send = await handleAuthApi(req("POST", "/auth/email", { email: "fam@example.com" }), deps);
    assertEquals(send.status, 200);
    const token = new URL(sent[0] ?? "").searchParams.get("token") ?? "";
    assertEquals(token.length > 0, true);

    const verify = await handleAuthApi(req("GET", `/auth/verify?token=${token}`), deps);
    assertEquals(verify.status, 302);
    const cookie = cookieOf(verify);

    const me = await handleAuthApi(req("GET", "/auth/me", undefined, { cookie }), deps);
    assertEquals((await me.json()).email, "fam@example.com");

    const out = await handleAuthApi(req("POST", "/auth/logout", undefined, { cookie }), deps);
    assertEquals(out.status, 200);
    const me2 = await handleAuthApi(req("GET", "/auth/me", undefined, { cookie }), deps);
    assertEquals(me2.status, 401);
  });
});

Deno.test("magic link send is 503 when email login is not configured", async () => {
  await withKv(async (kv) => {
    const res = await handleAuthApi(
      req("POST", "/auth/email", { email: "a@b.jp" }),
      makeDeps(kv),
    );
    assertEquals(res.status, 503);
  });
});

Deno.test("adopt takes over a pre-login token ledger once, while empty", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const deps = makeDeps(kv, {
      ids,
      sendMagicLink: () => Promise.resolve(),
      devUserEmail: "me@example.com",
    });
    // old browser-token ledger with one reservation
    await createReservation(kv, "old-token", {
      plan: null,
      service: "宿",
      startsAt: "2026-08-01T15:00:00+09:00",
      amount: null,
      location: null,
      policy: "unknown",
      confirmed: false,
    }, ids);

    const ok = await handleAuthApi(req("POST", "/auth/adopt", { token: "old-token" }), deps);
    assertEquals((await ok.json()).adopted, true);
    const user = await findUserByEmail(kv, "me@example.com");
    assertEquals(user?.ledgerId, "old-token");

    // second adopt attempt: ledger no longer empty -> refused
    const again = await handleAuthApi(req("POST", "/auth/adopt", { token: "other" }), deps);
    assertEquals((await again.json()).adopted, false);
  });
});

Deno.test("resolveIdentity: session ledger, demo suffix, admin header, anonymous", async () => {
  await withKv(async (kv) => {
    const deps = makeDeps(kv, { devUserEmail: "dev@local", adminToken: "adm1n" });
    const who = await resolveIdentity(req("GET", "/api/reservations"), deps);
    assertEquals(who.user?.email, "dev@local");
    assertEquals(who.ledger, who.user?.ledgerId);

    const demo = await resolveIdentity(
      req("GET", "/api/reservations", undefined, { "x-plancel-token": "whatever::demo" }),
      deps,
    );
    assertEquals(demo.ledger, `${who.user?.ledgerId}::demo`);

    const noDev = makeDeps(kv, { adminToken: "adm1n" });
    const admin = await resolveIdentity(
      req("GET", "/api/reservations", undefined, {
        "x-plancel-admin": "adm1n",
        "x-plancel-token": "raw-ledger",
      }),
      noDev,
    );
    assertEquals(admin.user, null);
    assertEquals(admin.ledger, "raw-ledger");

    const anon = await resolveIdentity(
      req("GET", "/api/reservations", undefined, { "x-plancel-token": "raw-ledger" }),
      noDev,
    );
    assertEquals(anon.ledger, null);
  });
});

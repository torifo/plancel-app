import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { type AuthDeps, handleAuthApi, isAuthPath, resolveIdentity } from "../auth/routes.ts";
import { findUserByEmail, getOrCreateUserByEmail } from "../users.ts";
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

Deno.test("signup cap: new accounts refused at maxUsers, existing users still log in", async () => {
  await withKv(async (kv) => {
    const sent: string[] = [];
    const deps = makeDeps(kv, {
      maxUsers: 1,
      sendMagicLink: (_email, url) => {
        sent.push(url);
        return Promise.resolve();
      },
    });
    // first user fills the cap
    await handleAuthApi(req("POST", "/auth/email", { email: "first@example.com" }), deps);
    const t1 = new URL(sent[0] ?? "").searchParams.get("token") ?? "";
    assertEquals((await handleAuthApi(req("GET", `/auth/verify?token=${t1}`), deps)).status, 302);

    // second address: refused at send time
    const second = await handleAuthApi(
      req("POST", "/auth/email", { email: "second@example.com" }),
      deps,
    );
    assertEquals(second.status, 403);
    assertEquals((await second.json()).error, "capacity");

    // Google login for a NEW identity: redirected to the capacity error
    const start = await handleAuthApi(req("GET", "/auth/google"), deps);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const cb = await handleAuthApi(req("GET", `/auth/callback?code=c&state=${state}`), deps);
    assertStringIncludes(cb.headers.get("location") ?? "", "auth_error=capacity");

    // the EXISTING user still gets a fresh magic link + login
    const again = await handleAuthApi(
      req("POST", "/auth/email", { email: "first@example.com" }),
      deps,
    );
    assertEquals(again.status, 200);

    // guaranteed member: allowed past a FULL cap (家族の保険)
    const withAllow = makeDeps(kv, {
      maxUsers: 1,
      allowedEmails: new Set(["family@example.com"]),
      sendMagicLink: (_email, url) => {
        sent.push(url);
        return Promise.resolve();
      },
    });
    assertEquals(
      (await handleAuthApi(req("POST", "/auth/email", { email: "Family@Example.com" }), withAllow))
        .status,
      200,
    );

    // cap disabled (0) lets new users in again
    const open = makeDeps(kv, {
      maxUsers: 0,
      sendMagicLink: (_email, url) => {
        sent.push(url);
        return Promise.resolve();
      },
    });
    assertEquals(
      (await handleAuthApi(req("POST", "/auth/email", { email: "second@example.com" }), open))
        .status,
      200,
    );
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

Deno.test("password auth: register -> login (wrong pw rejected) -> me", async () => {
  await withKv(async (kv) => {
    const deps = makeDeps(kv);
    const reg = await handleAuthApi(
      req("POST", "/auth/register", { email: "IC@icloud.com", password: "hunter2secret" }),
      deps,
    );
    assertEquals(reg.status, 302);
    const cookie = cookieOf(reg);

    const me = await (await handleAuthApi(req("GET", "/auth/me", undefined, { cookie }), deps))
      .json();
    assertEquals(me.email, "ic@icloud.com");
    assertEquals(me.hasPassword, true);
    assertEquals(me.emailVerified, false); // password signup = unverified

    // duplicate register refused
    const dup = await handleAuthApi(
      req("POST", "/auth/register", { email: "ic@icloud.com", password: "hunter2secret" }),
      deps,
    );
    assertEquals(dup.status, 409);

    const bad = await handleAuthApi(
      req("POST", "/auth/login", { email: "ic@icloud.com", password: "wrongwrong1" }),
      deps,
    );
    assertEquals(bad.status, 401);
    const good = await handleAuthApi(
      req("POST", "/auth/login", { email: "ic@icloud.com", password: "hunter2secret" }),
      deps,
    );
    assertEquals(good.status, 302);
  });
});

Deno.test("google login with an UNVERIFIED same-address account is refused (no auto-merge)", async () => {
  await withKv(async (kv) => {
    const deps = makeDeps(kv, {
      fetchFn: fakeGoogleFetch(), // claims g@example.com
    });
    await handleAuthApi(
      req("POST", "/auth/register", { email: "g@example.com", password: "hunter2secret" }),
      deps,
    );
    const start = await handleAuthApi(req("GET", "/auth/google"), deps);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const cb = await handleAuthApi(req("GET", `/auth/callback?code=c&state=${state}`), deps);
    assertStringIncludes(cb.headers.get("location") ?? "", "auth_error=email_taken");
  });
});

Deno.test("link mode attaches Google to the logged-in account and verifies it", async () => {
  await withKv(async (kv) => {
    const deps = makeDeps(kv);
    const reg = await handleAuthApi(
      req("POST", "/auth/register", { email: "g@example.com", password: "hunter2secret" }),
      deps,
    );
    const cookie = cookieOf(reg);
    const start = await handleAuthApi(
      req("GET", "/auth/google?link=1", undefined, { cookie }),
      deps,
    );
    assertEquals(start.status, 302);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const cb = await handleAuthApi(req("GET", `/auth/callback?code=c&state=${state}`), deps);
    assertEquals(cb.headers.get("location"), "/");
    const me = await (await handleAuthApi(
      req("GET", "/auth/me", undefined, { cookie: cookieOf(cb) }),
      deps,
    )).json();
    assertEquals(me.google, true);
    assertEquals(me.emailVerified, true); // link verified the account
  });
});

Deno.test("profile: display name free-form, uid unique, alt email becomes a login id", async () => {
  await withKv(async (kv) => {
    const deps = makeDeps(kv, { devUserEmail: "me@example.com" });
    const ok = await handleAuthApi(
      req("POST", "/auth/profile", { displayName: "あきと", uid: "akitosan" }),
      deps,
    );
    assertEquals(ok.status, 200);

    // lowercase letters only, 6+ for ordinary users
    const badFormat = await handleAuthApi(req("POST", "/auth/profile", { uid: "akito_1" }), deps);
    assertEquals(badFormat.status, 400);
    const tooShort = await handleAuthApi(req("POST", "/auth/profile", { uid: "akito" }), deps);
    assertEquals((await tooShort.json()).error, "uid_too_short");

    // another user cannot take the same uid, but may share the display name
    const other = makeDeps(kv, { devUserEmail: "other@example.com" });
    const clash = await handleAuthApi(req("POST", "/auth/profile", { uid: "akitosan" }), other);
    assertEquals(clash.status, 409);

    // reserved uids: refused for ordinary users, claimable by admin accounts
    const reserved = await handleAuthApi(req("POST", "/auth/profile", { uid: "torifo" }), other);
    assertEquals(reserved.status, 403);
    assertEquals((await reserved.json()).error, "uid_reserved");
    const adminDeps = makeDeps(kv, {
      devUserEmail: "boss@example.com",
      adminEmails: new Set(["boss@example.com"]),
    });
    // reserved AND shorter than 6 — allowed only because the claimer is admin
    const claimed = await handleAuthApi(req("POST", "/auth/profile", { uid: "admin" }), adminDeps);
    assertEquals(claimed.status, 200);
    const sameName = await handleAuthApi(
      req("POST", "/auth/profile", { displayName: "あきと" }),
      other,
    );
    assertEquals(sameName.status, 200);

    // uid + password also logs in (owner 2026-07-23: uid OR email)
    await handleAuthApi(req("POST", "/auth/password", { password: "hunter2secret" }), deps);
    const uidLogin = await handleAuthApi(
      req("POST", "/auth/login", { email: "akitosan", password: "hunter2secret" }),
      makeDeps(kv),
    );
    assertEquals(uidLogin.status, 302);
    const unknownUid = await handleAuthApi(
      req("POST", "/auth/login", { email: "nobodyx", password: "hunter2secret" }),
      makeDeps(kv),
    );
    assertEquals(unknownUid.status, 401);

    // alt email + password -> can log in with the icloud address
    await handleAuthApi(req("POST", "/auth/profile", { altEmail: "Me@icloud.com" }), deps);
    await handleAuthApi(req("POST", "/auth/password", { password: "hunter2secret" }), deps);
    const login = await handleAuthApi(
      req("POST", "/auth/login", { email: "me@icloud.com", password: "hunter2secret" }),
      makeDeps(kv),
    );
    assertEquals(login.status, 302);
  });
});

Deno.test("personal API token: issue -> act as user -> rotate invalidates -> revoke", async () => {
  await withKv(async (kv) => {
    const deps = makeDeps(kv, { devUserEmail: "me@example.com" });
    const t1 = (await (await handleAuthApi(req("POST", "/auth/token"), deps)).json()).token;

    // the token resolves to the user's ledger WITHOUT any session/dev context
    const plain = makeDeps(kv); // no devUserEmail
    const who = await resolveIdentity(
      req("GET", "/api/reservations", undefined, { "x-plancel-token": t1 }),
      plain,
    );
    assertEquals(who.user?.email, "me@example.com");
    assertEquals(who.ledger, who.user?.ledgerId);

    // rotation invalidates the old token
    const t2 = (await (await handleAuthApi(req("POST", "/auth/token"), deps)).json()).token;
    const stale = await resolveIdentity(
      req("GET", "/api/reservations", undefined, { "x-plancel-token": t1 }),
      plain,
    );
    assertEquals(stale.ledger, null);
    const fresh = await resolveIdentity(
      req("GET", "/api/reservations", undefined, { "x-plancel-token": t2 }),
      plain,
    );
    assertEquals(fresh.user?.email, "me@example.com");

    // revoke kills it and /auth/me reflects the state
    await handleAuthApi(req("DELETE", "/auth/token"), deps);
    const gone = await resolveIdentity(
      req("GET", "/api/reservations", undefined, { "x-plancel-token": t2 }),
      plain,
    );
    assertEquals(gone.ledger, null);
    const me = await (await handleAuthApi(req("GET", "/auth/me"), deps)).json();
    assertEquals(me.hasApiToken, false);
  });
});

Deno.test("admin /auth/me carries userCount and warns at 100 users", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    for (let i = 0; i < 99; i++) {
      await getOrCreateUserByEmail(kv, `u${i}@example.com`, ids);
    }
    const deps = makeDeps(kv, {
      ids,
      maxUsers: 0,
      devUserEmail: "admin@example.com", // becomes the 100th user
      adminEmails: new Set(["admin@example.com"]),
    });
    const body = await (await handleAuthApi(req("GET", "/auth/me"), deps)).json();
    assertEquals(body.admin, true);
    assertEquals(body.userCount, 100);
    assertEquals(body.capacityWarning, true);

    // non-admin users never see the counters
    const plain = makeDeps(kv, { ids, maxUsers: 0, devUserEmail: "u1@example.com" });
    const p = await (await handleAuthApi(req("GET", "/auth/me"), plain)).json();
    assertEquals("userCount" in p, false);
    assertEquals("capacityWarning" in p, false);
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

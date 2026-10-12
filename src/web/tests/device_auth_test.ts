import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { type AuthDeps, handleAuthApi } from "../auth/routes.ts";
import {
  DEVICE_CODE_TTL_MS,
  DEVICE_MAX_POLLS,
  DEVICE_POLL_INTERVAL_SEC,
  formatUserCode,
} from "../auth/device.ts";
import { type AuthIds, findUserByApiToken, findUserByEmail } from "../users.ts";

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

/** Ids with a clock the test can move. */
function clockIds(startMs = 1_700_000_000_000): AuthIds & { tick(ms: number): void } {
  let n = 0;
  let t = 0;
  let now = startMs;
  return {
    newId: () => `ID${++n}`,
    nowIso: () => new Date(now).toISOString(),
    nowMs: () => now,
    randomToken: () => `tok${++t}-${"x".repeat(60)}`,
    tick: (ms) => {
      now += ms;
    },
  };
}

function makeDeps(kv: Deno.Kv, ids: AuthIds, over: Partial<AuthDeps> = {}): AuthDeps {
  return {
    kv,
    ids,
    fetchFn: fetch,
    google: null,
    sendMagicLink: null,
    kek: undefined,
    ...over,
  };
}

const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://app.test${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function phone(kv: Deno.Kv, ids: AuthIds, email = "mom@example.com") {
  const deps = makeDeps(kv, ids);
  const reg = await handleAuthApi(
    req("POST", "/auth/register", { email, password: "hunter2secret" }),
    deps,
  );
  return { deps, cookie: cookieOf(reg) };
}

async function pcAsks(deps: AuthDeps, client_name = "MacBook/akito (Claude)") {
  const res = await handleAuthApi(req("POST", "/auth/device/code", { client_name }), deps);
  assertEquals(res.status, 200);
  return await res.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };
}

const poll = async (deps: AuthDeps, device_code: string) => {
  const res = await handleAuthApi(req("POST", "/auth/device/token", { device_code }), deps);
  return { status: res.status, body: await res.json() };
};

Deno.test("device pairing: pending → approve on the phone → the PC's next poll gets a token", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const { deps, cookie } = await phone(kv, ids);
    const code = await pcAsks(deps);
    assertEquals(code.user_code.length, 9); // XXXX-XXXX
    assertEquals(code.verification_uri, "https://app.test/#pair");
    assertEquals(code.expires_in, DEVICE_CODE_TTL_MS / 1000);
    assertEquals(code.interval, DEVICE_POLL_INTERVAL_SEC);

    // Nothing yet.
    const first = await poll(deps, code.device_code);
    assertEquals(first.status, 400);
    assertEquals(first.body.error, "authorization_pending");

    // The phone looks the code up (spaces, case and dashes forgiven) and sees who is asking.
    const typed = ` ${code.user_code.toLowerCase().replace("-", " ")} `;
    const pending = await handleAuthApi(
      req("GET", `/auth/device/pending?code=${encodeURIComponent(typed)}`, undefined, { cookie }),
      deps,
    );
    assertEquals(pending.status, 200);
    const view = await pending.json();
    assertEquals(view.client_name, "MacBook/akito (Claude)");
    assertEquals(view.account.label, "mom@example.com");
    assertEquals(view.expiresInSec, DEVICE_CODE_TTL_MS / 1000);

    const ok = await handleAuthApi(
      req("POST", "/auth/device/approve", { code: typed, name: "自宅の MacBook" }, { cookie }),
      deps,
    );
    assertEquals(ok.status, 200);

    ids.tick(DEVICE_POLL_INTERVAL_SEC * 1000);
    const got = await poll(deps, code.device_code);
    assertEquals(got.status, 200);
    assertEquals(typeof got.body.access_token, "string");
    assertEquals(got.body.account.label, "mom@example.com");
    // The token really is this user's, and it is named as the phone named it.
    assertEquals((await findUserByApiToken(kv, got.body.access_token))?.email, "mom@example.com");
    const list =
      await (await handleAuthApi(req("GET", "/auth/tokens", undefined, { cookie }), deps))
        .json();
    assertEquals(list.tokens.map((t: { name: string; kind: string }) => [t.name, t.kind]), [[
      "自宅の MacBook",
      "device",
    ]]);

    // Exactly once: the next poll finds nothing.
    ids.tick(DEVICE_POLL_INTERVAL_SEC * 1000);
    const again = await poll(deps, code.device_code);
    assertEquals(again.body.error, "invalid_grant");
    // and the user_code is gone too
    const stale = await handleAuthApi(
      req("GET", `/auth/device/pending?code=${code.user_code}`, undefined, { cookie }),
      deps,
    );
    assertEquals(stale.status, 404);
  });
});

Deno.test("device pairing: polling faster than interval answers slow_down and widens the interval", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const { deps } = await phone(kv, ids);
    const code = await pcAsks(deps);
    assertEquals((await poll(deps, code.device_code)).body.error, "authorization_pending");
    ids.tick(1000);
    assertEquals((await poll(deps, code.device_code)).body.error, "slow_down");
    // The old interval (5 s) is no longer enough; 10 s is.
    ids.tick(5000);
    assertEquals((await poll(deps, code.device_code)).body.error, "slow_down");
    ids.tick(15000);
    assertEquals((await poll(deps, code.device_code)).body.error, "authorization_pending");
  });
});

Deno.test("device pairing: a code expires after ten minutes, and the phone can no longer approve it", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const { deps, cookie } = await phone(kv, ids);
    const code = await pcAsks(deps);
    ids.tick(DEVICE_CODE_TTL_MS);
    const approve = await handleAuthApi(
      req("POST", "/auth/device/approve", { code: code.user_code }, { cookie }),
      deps,
    );
    assertEquals(approve.status, 404);
    assertEquals((await poll(deps, code.device_code)).body.error, "expired_token");
  });
});

Deno.test("device pairing: denied is reported once and the code dies", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const { deps, cookie } = await phone(kv, ids);
    const code = await pcAsks(deps);
    const deny = await handleAuthApi(
      req("POST", "/auth/device/deny", { code: code.user_code }, { cookie }),
      deps,
    );
    assertEquals(deny.status, 200);
    // deciding twice
    const again = await handleAuthApi(
      req("POST", "/auth/device/approve", { code: code.user_code }, { cookie }),
      deps,
    );
    assertEquals(again.status, 409);
    assertEquals((await poll(deps, code.device_code)).body.error, "access_denied");
    assertEquals((await poll(deps, code.device_code)).body.error, "invalid_grant");
    // nothing was issued
    const list =
      await (await handleAuthApi(req("GET", "/auth/tokens", undefined, { cookie }), deps))
        .json();
    assertEquals(list.tokens, []);
  });
});

Deno.test("device pairing: unknown codes write nothing; a client that will not slow down is cut off", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const { deps } = await phone(kv, ids);
    assertEquals((await poll(deps, "nope")).body.error, "invalid_grant");
    let n = 0;
    for await (const _ of kv.list({ prefix: ["device_code"] })) n += 1;
    assertEquals(n, 0);

    // Hammering without waiting never reaches the TTL, so the poll cap is
    // what ends it: slow_down up to the cap, then the record is gone.
    const code = await pcAsks(deps);
    assertEquals((await poll(deps, code.device_code)).body.error, "authorization_pending");
    for (let i = 1; i < DEVICE_MAX_POLLS; i += 1) {
      assertEquals((await poll(deps, code.device_code)).body.error, "slow_down");
    }
    assertEquals((await poll(deps, code.device_code)).body.error, "expired_token");
    assertEquals((await poll(deps, code.device_code)).body.error, "invalid_grant");
  });
});

Deno.test("device pairing: a header token cannot approve, look up or deny", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const { deps, cookie } = await phone(kv, ids);
    const manual =
      await (await handleAuthApi(req("POST", "/auth/token", { name: "x" }, { cookie }), deps))
        .json();
    const code = await pcAsks(deps);
    const headers = { "x-plancel-token": manual.token };
    for (
      const r of [
        req("GET", `/auth/device/pending?code=${code.user_code}`, undefined, headers),
        req("POST", "/auth/device/approve", { code: code.user_code }, headers),
        req("POST", "/auth/device/deny", { code: code.user_code }, headers),
      ]
    ) {
      assertEquals((await handleAuthApi(r, deps)).status, 401);
    }
    assertEquals((await poll(deps, code.device_code)).body.error, "authorization_pending");
  });
});

Deno.test("device pairing: the phone side is rate limited (10 / 15 min per account)", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const { deps, cookie } = await phone(kv, ids);
    for (let i = 0; i < 10; i += 1) {
      const r = await handleAuthApi(
        req("GET", "/auth/device/pending?code=AAAA-AAAA", undefined, { cookie }),
        deps,
      );
      assertEquals(r.status, 404);
    }
    const blocked = await handleAuthApi(
      req("POST", "/auth/device/approve", { code: "AAAA-AAAA" }, { cookie }),
      deps,
    );
    assertEquals(blocked.status, 429);
  });
});

Deno.test("device pairing: client_name is bounded and cleaned; the token cap answers 403", async () => {
  await withKv(async (kv) => {
    const ids = clockIds();
    const { deps, cookie } = await phone(kv, ids);
    const tooLong = await handleAuthApi(
      req("POST", "/auth/device/code", { client_name: "x".repeat(61) }),
      deps,
    );
    assertEquals(tooLong.status, 400);
    const empty = await handleAuthApi(
      req("POST", "/auth/device/code", { client_name: "  " }),
      deps,
    );
    assertEquals(empty.status, 400);
    const ctl = await pcAsks(deps, "Mac\u0007Book\n (Claude)");
    const seen = await (await handleAuthApi(
      req("GET", `/auth/device/pending?code=${ctl.user_code}`, undefined, { cookie }),
      deps,
    )).json();
    assertEquals(seen.client_name, "MacBook (Claude)");

    // fill the cap with manual tokens, then approving a device is refused
    for (let i = 0; i < 5; i += 1) {
      await handleAuthApi(req("POST", "/auth/token", { name: `m${i}` }, { cookie }), deps);
    }
    const full = await handleAuthApi(
      req("POST", "/auth/device/approve", { code: ctl.user_code }, { cookie }),
      deps,
    );
    assertEquals(full.status, 403);
    assertEquals((await full.json()).error, "token_limit");
    // the PC keeps waiting rather than failing — the person can free a slot and approve
    assertEquals((await poll(deps, ctl.device_code)).body.error, "authorization_pending");
  });
});

Deno.test("device pairing: formatUserCode and the user's label", async () => {
  assertEquals(formatUserCode("WXYZ2345"), "WXYZ-2345");
  await withKv(async (kv) => {
    const ids = clockIds();
    const { deps, cookie } = await phone(kv, ids);
    await handleAuthApi(req("POST", "/auth/profile", { uid: "momuid" }, { cookie }), deps);
    const code = await pcAsks(deps);
    const seen = await (await handleAuthApi(
      req("GET", `/auth/device/pending?code=${code.user_code}`, undefined, { cookie }),
      deps,
    )).json();
    assertEquals(seen.account.label, "@momuid");
    const u = await findUserByEmail(kv, "mom@example.com");
    assertStringIncludes(u?.uid ?? "", "momuid");
  });
});

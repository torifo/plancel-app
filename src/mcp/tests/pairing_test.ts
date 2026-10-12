import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import { type CredentialFs, credentialsPath, CredentialStore } from "../credentials.ts";
import { PairingClient } from "../pairing.ts";

/** An in-memory filesystem that records modes. */
function memFs(): CredentialFs & { files: Map<string, string>; modes: Map<string, number> } {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  return {
    files,
    modes,
    readText: (p) => Promise.resolve(files.get(p) ?? null),
    writeText: (p, t) => {
      files.set(p, t);
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    chmod: (p, m) => {
      modes.set(p, m);
      return Promise.resolve();
    },
  };
}

/** A scripted /auth/device/* server. */
function fakeAuth(script: string[]) {
  const posts: { path: string; body: unknown }[] = [];
  const fetchFn = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    posts.push({ path, body });
    if (path === "/auth/device/code") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            device_code: "dev-1",
            user_code: "WXYZ-2345",
            verification_uri: "https://plancel.test/#pair",
            expires_in: 600,
            interval: 5,
          }),
          { status: 200 },
        ),
      );
    }
    // An exhausted script ends the loop: a restart after the script ran out
    // would otherwise poll forever against instant virtual sleeps.
    const next = script.shift() ?? "expired_token";
    if (next === "ok") {
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "secret-1", token_id: "T1", account: { label: "@mom" } }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ error: next }), { status: 400 }));
  }) as typeof fetch;
  return { fetchFn, posts };
}

function harness(script: string[], envToken?: string) {
  const fs = memFs();
  const store = new CredentialStore("/cfg/plancel/credentials.json", fs);
  const clock = new VirtualClock("2026-10-13T00:00:00Z");
  const sleeps: number[] = [];
  const { fetchFn, posts } = fakeAuth(script);
  const client = new PairingClient({
    baseUrl: "https://plancel.test",
    clientName: "mac/akito (Claude)",
    store,
    clock,
    fetchFn,
    sleep: (ms) => {
      sleeps.push(ms);
      clock.set(clock.now().add({ milliseconds: ms }));
      return Promise.resolve();
    },
    ...(envToken !== undefined ? { envToken } : {}),
  });
  return { client, store, fs, clock, sleeps, posts };
}

Deno.test("credentials: path resolution honours PLANCEL_CREDENTIALS, then XDG, then HOME", () => {
  const env = (vars: Record<string, string>) => (n: string) => vars[n];
  assertEquals(credentialsPath(env({ PLANCEL_CREDENTIALS: "/x/c.json" })), "/x/c.json");
  assertEquals(
    credentialsPath(env({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/a" })),
    "/xdg/plancel/credentials.json",
  );
  assertEquals(
    credentialsPath(env({ HOME: "/home/a" })),
    "/home/a/.config/plancel/credentials.json",
  );
});

Deno.test("credentials: keyed by base URL, written 0600 under a 0700 dir, removable", async () => {
  const fs = memFs();
  const store = new CredentialStore("/cfg/plancel/credentials.json", fs);
  const entry = {
    token: "t",
    tokenId: "T1",
    account: { label: "@mom" },
    pairedAt: "2026-10-13T00:00:00Z",
  };
  await store.set("https://prod", entry);
  await store.set("http://localhost:18097", { ...entry, token: "dev" });
  assertEquals((await store.get("https://prod"))?.token, "t");
  assertEquals((await store.get("http://localhost:18097"))?.token, "dev");
  assertEquals(fs.modes.get("/cfg/plancel/credentials.json"), 0o600);
  assertEquals(fs.modes.get("/cfg/plancel"), 0o700);
  assertEquals(await store.remove("https://prod"), true);
  assertEquals(await store.get("https://prod"), null);
  assertEquals((await store.get("http://localhost:18097"))?.token, "dev");
  assertEquals(await store.remove("https://prod"), false);
  // A corrupt file reads as empty rather than throwing.
  fs.files.set("/cfg/plancel/credentials.json", "{not json");
  assertEquals(await store.get("http://localhost:18097"), null);
});

Deno.test("pairing client: start → pending (same code while pending) → polls → paired and saved", async () => {
  const { client, store, sleeps, posts } = harness(["authorization_pending", "ok"]);
  assertEquals(await client.token(), null);
  const s1 = await client.start();
  assertEquals(s1.kind, "pending");
  if (s1.kind !== "pending") throw new Error();
  assertEquals(s1.userCode, "WXYZ-2345");
  // Asking again while pending does not create a second request.
  const s2 = await client.start();
  assertEquals(s2, s1);
  assertEquals(posts.filter((p) => p.path === "/auth/device/code").length, 1);

  await client.background;
  assertEquals(client.current.kind, "paired");
  assertEquals(await client.token(), "secret-1");
  assertEquals((await store.get("https://plancel.test"))?.account.label, "@mom");
  assertEquals(sleeps, [5000, 5000]);
});

Deno.test("pairing client: slow_down widens the wait; denied stops; force restarts", async () => {
  const { client, sleeps } = harness(["slow_down", "authorization_pending", "access_denied"]);
  await client.start();
  await client.background;
  assertEquals(client.current.kind, "denied");
  assertEquals(sleeps, [5000, 10000, 10000]);
  // Not retried on its own…
  assertEquals((await client.start()).kind, "denied");
  // …but an explicit force asks again.
  assertEquals((await client.start(true)).kind, "pending");
});

Deno.test("pairing client: expiry ends the loop; the next start asks for a fresh code", async () => {
  const { client, posts } = harness(["expired_token"]);
  await client.start();
  await client.background;
  assertEquals(client.current.kind, "expired");
  assertEquals((await client.start()).kind, "pending");
  assertEquals(posts.filter((p) => p.path === "/auth/device/code").length, 2);
});

Deno.test("pairing client: a saved file is used without pairing; forget() drops it", async () => {
  const { client, store } = harness([]);
  await store.set("https://plancel.test", {
    token: "from-file",
    tokenId: "T9",
    account: { label: "@mom" },
    pairedAt: "2026-10-01T00:00:00Z",
  });
  assertEquals(await client.token(), "from-file");
  assertEquals(client.current.kind, "paired");
  await client.forget();
  assertEquals(client.current.kind, "idle");
  assertEquals(await client.token(), null);
  assertEquals(await store.get("https://plancel.test"), null);
});

Deno.test("pairing client: an env token wins over the file", async () => {
  const { client, store } = harness([], "env-secret");
  await store.set("https://plancel.test", {
    token: "from-file",
    tokenId: "T9",
    account: { label: "@mom" },
    pairedAt: "2026-10-01T00:00:00Z",
  });
  assertEquals(await client.token(), "env-secret");
});

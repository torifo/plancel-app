import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { buildWebApiServer } from "../web_api_tools.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

interface Captured {
  method: string;
  url: string;
  body: unknown;
}

function fakeApi(): { calls: Captured[]; fetchFn: typeof fetch } {
  const calls: Captured[] = [];
  const fetchFn = ((input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input instanceof Request ? input.url : input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }) as typeof fetch;
  return { calls, fetchFn };
}

async function withClient(
  fetchFn: typeof fetch,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = buildWebApiServer({
    baseUrl: "https://plancel.test",
    token: "tok-1",
    fetchFn,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

Deno.test("web-api MCP tools call the reservation API with the personal token", async () => {
  const { calls, fetchFn } = fakeApi();
  await withClient(fetchFn, async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((t: { name: string }) => t.name).sort();
    assertEquals(names, [
      "cancel_reservation",
      "choose_reservation",
      "confirm_reservation",
      "create_reservation",
      "delete_policy_template",
      "delete_reservation",
      "drop_reservation",
      "list_policy_templates",
      "list_reservation_members",
      "list_reservations",
      "lookup_policy_template",
      "merge_reservations",
      "open_in_browser",
      "pair_with_plancel",
      "pairing_status",
      "restore_reservation",
      "save_policy_template",
      "set_member_role",
      "set_trip_people",
      "share_reservation",
      "suggest_to_owner",
      "unpair_plancel",
      "unshare_reservation",
      "update_reservation",
    ]);

    await client.callTool({ name: "list_reservations", arguments: {} });
    await client.callTool({
      name: "create_reservation",
      arguments: { service: "鮨", startsAt: "2026-08-01T19:00:00+09:00", confirmed: true },
    });
    await client.callTool({ name: "confirm_reservation", arguments: { id: "R1" } });
    await client.callTool({
      name: "update_reservation",
      arguments: { id: "R1", location: "六本木" },
    });

    assertEquals(calls[0]?.url, "https://plancel.test/api/reservations");
    // create reads the list first (duplicate check, issue #5), then posts.
    assertEquals(calls[1]?.method, "GET");
    assertEquals(calls[2]?.method, "POST");
    assertEquals(
      (calls[2]?.body as { service: string; confirmed: boolean }).confirmed,
      true,
    );
    assertEquals(calls[3]?.url, "https://plancel.test/api/reservations/R1/confirm");
    assertEquals(calls[4]?.method, "PATCH");
    assertEquals((calls[4]?.body as { location: string }).location, "六本木");
  });
});

Deno.test("web-api MCP tools drive the sharing API, including the role grant", async () => {
  const { calls, fetchFn } = fakeApi();
  await withClient(fetchFn, async (client) => {
    // Role omitted -> the API's read-only default travels explicitly.
    await client.callTool({
      name: "share_reservation",
      arguments: { id: "R1", q: "m@x.jp" },
    });
    await client.callTool({
      name: "share_reservation",
      arguments: { id: "R1", q: "e@x.jp", role: "editor" },
    });
    await client.callTool({
      name: "set_member_role",
      arguments: { id: "R1", userId: "U9", role: "editor" },
    });
    await client.callTool({ name: "list_reservation_members", arguments: { id: "R1" } });
    await client.callTool({
      name: "unshare_reservation",
      arguments: { id: "R1", userId: "U9" },
    });

    assertEquals(calls[0]?.method, "POST");
    assertEquals(calls[0]?.url, "https://plancel.test/api/reservations/R1/members");
    assertEquals(calls[0]?.body, { q: "m@x.jp", role: "viewer" });
    assertEquals(calls[1]?.body, { q: "e@x.jp", role: "editor" });
    assertEquals(calls[2]?.method, "PATCH");
    assertEquals(calls[2]?.url, "https://plancel.test/api/reservations/R1/members/U9");
    assertEquals(calls[2]?.body, { role: "editor" });
    assertEquals(calls[3]?.url, "https://plancel.test/api/reservations/R1/members");
    assertEquals(calls[4]?.method, "DELETE");

    // An unknown role is rejected locally, without touching the API.
    const bad = await client.callTool({
      name: "set_member_role",
      arguments: { id: "R1", userId: "U9", role: "admin" },
    });
    assertEquals(bad.isError, true);
    assertEquals(calls.length, 5);
  });
});

Deno.test("web-api MCP tools drive the policy-template API with encoded facility names", async () => {
  const { calls, fetchFn } = fakeApi();
  await withClient(fetchFn, async (client) => {
    await client.callTool({
      name: "save_policy_template",
      arguments: { facility: "湖畔の湯宿 蛍", policy: { stages: [{ h: 120, pct: 0 }] } },
    });
    // The h=0 stage is missing, so the tool rejects locally (no API call).
    assertEquals(calls.length, 0);

    await client.callTool({
      name: "save_policy_template",
      arguments: { facility: "湖畔の湯宿 蛍", policy: "free24" },
    });
    await client.callTool({ name: "lookup_policy_template", arguments: { facility: "翠嶺館" } });
    await client.callTool({ name: "list_policy_templates", arguments: {} });
    await client.callTool({ name: "delete_policy_template", arguments: { facility: "翠嶺館" } });

    const enc = encodeURIComponent("湖畔の湯宿 蛍");
    assertEquals(calls[0]?.method, "PUT");
    assertEquals(calls[0]?.url, `https://plancel.test/api/policy-templates/${enc}`);
    assertEquals(calls[0]?.body, { policy: "free24" }); // facility travels in the path only
    assertEquals(
      calls[1]?.url,
      `https://plancel.test/api/policy-templates/lookup?service=${encodeURIComponent("翠嶺館")}`,
    );
    assertEquals(calls[2]?.url, "https://plancel.test/api/policy-templates");
    assertEquals(calls[3]?.method, "DELETE");

    // "unknown" is not part of the template tool's schema at all.
    const unknown = await client.callTool({
      name: "save_policy_template",
      arguments: { facility: "宿", policy: "unknown" },
    });
    assertEquals(unknown.isError, true);
    assertEquals(calls.length, 4);
  });
});

Deno.test("web-api MCP tools surface validation errors without calling the API", async () => {
  const { calls, fetchFn } = fakeApi();
  await withClient(fetchFn, async (client) => {
    const res = await client.callTool({ name: "create_reservation", arguments: {} });
    assertEquals(res.isError, true);
    assertStringIncludes(JSON.stringify(res.content), "service");
    assertEquals(calls.length, 0);
  });
});

// ---- device pairing from the tool side (issue #1) ----

function pairingHarness(opts: { token: string | null; state: "idle" | "pending" | "denied" }) {
  const events: string[] = [];
  let current = opts.state === "pending"
    ? {
      kind: "pending" as const,
      userCode: "WXYZ-2345",
      verificationUri: "https://plancel.test/#pair",
      expiresAtMs: 0,
    }
    : { kind: opts.state } as { kind: "idle" | "denied" };
  let token = opts.token;
  const cfg = {
    baseUrl: "https://plancel.test",
    token: () => Promise.resolve(token),
    pairing: {
      start: (force?: boolean) => {
        events.push(`start${force ? ":force" : ""}`);
        if (current.kind !== "denied" || force) {
          current = {
            kind: "pending",
            userCode: "WXYZ-2345",
            verificationUri: "https://plancel.test/#pair",
            expiresAtMs: 0,
          };
        }
        return Promise.resolve(current);
      },
      forget: () => {
        events.push("forget");
        token = null;
        current = { kind: "idle" };
        return Promise.resolve();
      },
      current: () => current,
    },
  };
  return { cfg, events, setToken: (t: string | null) => (token = t) };
}

async function withPairedClient(
  cfg: Parameters<typeof buildWebApiServer>[0],
  fn: (client: Client) => Promise<void>,
) {
  const server = buildWebApiServer(cfg);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

Deno.test("pairing: an unpaired tool call returns the code and instructions at once, no API call", async () => {
  const { calls, fetchFn } = fakeApi();
  const { cfg, events } = pairingHarness({ token: null, state: "idle" });
  await withPairedClient({ ...cfg, fetchFn }, async (client) => {
    const r = await client.callTool({ name: "list_reservations", arguments: {} });
    assertEquals((r as { isError?: boolean }).isError, true);
    assertStringIncludes(textOf(r), "WXYZ-2345");
    assertStringIncludes(textOf(r), "④ Claude（PC）を承認する");
    // The token never appears, and the ledger API was never hit.
    assertEquals(calls.length, 0);
    assertEquals(events, ["start"]);
  });
});

Deno.test("pairing: once paired, tools call the API with the paired token", async () => {
  const { calls, fetchFn } = fakeApi();
  const { cfg } = pairingHarness({ token: "paired-secret", state: "idle" });
  const seen: string[] = [];
  const spy = ((input: URL | RequestInfo, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>)["x-plancel-token"]));
    return fetchFn(input, init);
  }) as typeof fetch;
  await withPairedClient({ ...cfg, fetchFn: spy }, async (client) => {
    const r = await client.callTool({ name: "list_reservations", arguments: {} });
    assertEquals((r as { isError?: boolean }).isError, undefined);
    assertEquals(calls.length, 1);
    assertEquals(seen, ["paired-secret"]);
  });
});

Deno.test("pairing: a 401 drops the credentials and says to re-pair; the next call starts over", async () => {
  const { cfg, events } = pairingHarness({ token: "stale", state: "idle" });
  const fetchFn =
    (() =>
      Promise.resolve(new Response('{"error":"login required"}', { status: 401 }))) as typeof fetch;
  await withPairedClient({ ...cfg, fetchFn }, async (client) => {
    const r = await client.callTool({ name: "list_reservations", arguments: {} });
    assertStringIncludes(textOf(r), "連携が解除されています");
    assertEquals(events, ["forget"]);
    const again = await client.callTool({ name: "list_reservations", arguments: {} });
    assertStringIncludes(textOf(again), "WXYZ-2345");
    assertEquals(events, ["forget", "start"]);
  });
});

Deno.test("pairing: denied is not retried on its own; force starts over; status and unpair", async () => {
  const { fetchFn } = fakeApi();
  const { cfg, events } = pairingHarness({ token: null, state: "denied" });
  await withPairedClient({ ...cfg, fetchFn }, async (client) => {
    const r = await client.callTool({ name: "list_reservations", arguments: {} });
    assertStringIncludes(textOf(r), "拒否されました");
    const forced = await client.callTool({ name: "pair_with_plancel", arguments: { force: true } });
    assertStringIncludes(textOf(forced), "WXYZ-2345");
    assertEquals(events, ["start", "start:force"]);
    const status = await client.callTool({ name: "pairing_status", arguments: {} });
    assertStringIncludes(textOf(status), "WXYZ-2345");
    const un = await client.callTool({ name: "unpair_plancel", arguments: {} });
    assertStringIncludes(textOf(un), "連携を消しました");
    assertEquals(events.at(-1), "forget");
  });
});

Deno.test("pairing: a fixed env token never enters the pairing flow", async () => {
  const { calls, fetchFn } = fakeApi();
  await withPairedClient(
    { baseUrl: "https://plancel.test", token: "env-secret", fetchFn },
    async (client) => {
      const r = await client.callTool({ name: "pair_with_plancel", arguments: {} });
      assertStringIncludes(textOf(r), "固定接続");
      await client.callTool({ name: "list_reservations", arguments: {} });
      assertEquals(calls.length, 1);
    },
  );
});

Deno.test("web-api MCP: a natural-language startsAt is refused before any API call (issue #2)", async () => {
  const { calls, fetchFn } = fakeApi();
  await withClient(fetchFn, async (client) => {
    const created = await client.callTool({
      name: "create_reservation",
      arguments: { service: "鮨", startsAt: "10月27日 19時" },
    });
    assertEquals(created.isError, true);
    const text = (created.content as { text: string }[])[0]!.text;
    assertStringIncludes(text, "2026-10-27T19:00:00+09:00");

    const edited = await client.callTool({
      name: "update_reservation",
      arguments: { id: "R1", startsAt: "来週の金曜" },
    });
    assertEquals(edited.isError, true);
    assertEquals(calls.length, 0, "the API never sees an unreadable date");

    // The tool description tells the model how to hand over a date.
    const tools = await client.listTools();
    const create = tools.tools.find((t: { name: string }) => t.name === "create_reservation")!;
    const schema = JSON.stringify(create.inputSchema);
    assertStringIncludes(schema, "ISO 8601");
    assertStringIncludes(schema, "JST");
  });
});

Deno.test("web-api MCP: create_reservation tells the model how a policy is decided (issue #4)", async () => {
  const { fetchFn } = fakeApi();
  await withClient(fetchFn, async (client) => {
    const tools = await client.listTools();
    const create = tools.tools.find((t: { name: string }) => t.name === "create_reservation")!;
    // Known → pass it; unknown → omit and the facility's saved template applies;
    // still unknown → ask the user and fill it in with update_reservation.
    assertStringIncludes(create.description!, "施設の既定規定");
    assertStringIncludes(create.description!, "update_reservation");
  });
});

Deno.test("pairing_status names the ledger it talks to: the production one the phone shows (issue #3)", async () => {
  const { fetchFn } = fakeApi();
  // Paired through the phone.
  const { cfg } = pairingHarness({ token: "paired-secret", state: "idle" });
  const paired = {
    ...cfg,
    pairing: {
      ...cfg.pairing,
      current: () => ({ kind: "paired" as const, account: { label: "@torifo" } }),
    },
  };
  await withPairedClient({ ...paired, fetchFn }, async (client) => {
    const r = await client.callTool({ name: "pairing_status", arguments: {} });
    assertStringIncludes(textOf(r), "本番の台帳");
    assertStringIncludes(textOf(r), "@torifo");
    assertStringIncludes(textOf(r), "スマホ");
  });
  // Fixed token from env: still the production ledger.
  await withClient(fetchFn, async (client) => {
    const r = await client.callTool({ name: "pairing_status", arguments: {} });
    assertStringIncludes(textOf(r), "本番の台帳");
  });
});

Deno.test("web-api MCP: a negative or fractional amount is refused before any API call (issue #5)", async () => {
  const { calls, fetchFn } = fakeApi();
  await withClient(fetchFn, async (client) => {
    for (const amount of [-500, 1.5]) {
      const r = await client.callTool({
        name: "create_reservation",
        arguments: { service: "鮨", startsAt: "2026-10-27T19:00:00+09:00", amount },
      });
      assertEquals(r.isError, true, `${amount}`);
    }
    assertEquals(calls.length, 0);
  });
});

// ---- what the model sees (issues #5, #6) ----

const ROW = {
  id: "R1",
  plan: null,
  service: "鮨 さいとう",
  startsAt: "2026-12-20T10:00:00.000Z",
  endsAt: null,
  amount: 30000,
  location: null,
  policy: "staged",
  status: "candidate",
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
  updated_by: "01USER",
};

/** A fake API whose answers the test chooses per request. */
function scriptedApi(
  answer: (method: string, url: string, body: unknown) => { status: number; json: unknown },
) {
  const calls: Captured[] = [];
  const fetchFn = ((input: URL | RequestInfo, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(input instanceof Request ? input.url : input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const a = answer(call.method, call.url, call.body);
    return Promise.resolve(new Response(JSON.stringify(a.json), { status: a.status }));
  }) as typeof fetch;
  return { calls, fetchFn };
}

const parsed = (r: unknown) => JSON.parse(textOf(r));

Deno.test("web-api MCP: list_reservations answers in JST with deadlines, filtered and trimmed", async () => {
  const { fetchFn } = scriptedApi(() => ({ status: 200, json: { reservations: [ROW] } }));
  await withClient(fetchFn, async (client) => {
    const out = parsed(await client.callTool({ name: "list_reservations", arguments: {} }));
    assertEquals(out.count, 1);
    assertEquals(out.reservations[0].startsAt, "2026-12-20T19:00:00+09:00");
    assertEquals(out.reservations[0].freeUntil, "2026-12-13T23:59:59+09:00");
    assertEquals(out.reservations[0].updated_by, undefined);
    const none = parsed(
      await client.callTool({ name: "list_reservations", arguments: { status: ["cancelled"] } }),
    );
    assertEquals(none.count, 0);
  });
});

Deno.test("web-api MCP: an API error code comes with a Japanese next step (issue #5)", async () => {
  const { fetchFn } = scriptedApi(() => ({ status: 404, json: { error: "user_not_found" } }));
  await withClient(fetchFn, async (client) => {
    const r = await client.callTool({
      name: "share_reservation",
      arguments: { id: "R1", q: "x@example.com" },
    });
    assertEquals(r.isError, true);
    assertStringIncludes(parsed(r).hint, "未登録");
  });
});

Deno.test("pairing_status with a token from env names the ledger instead of saying 'not paired'", async () => {
  // main.ts always passes `pairing`; with PLANCEL_API_TOKEN the pairing state
  // stays idle while the token works. The answer used to be 「連携していません」.
  const { fetchFn } = fakeApi();
  const { cfg } = pairingHarness({ token: "env-token", state: "idle" });
  await withPairedClient({ ...cfg, fetchFn }, async (client) => {
    const r = await client.callTool({ name: "pairing_status", arguments: {} });
    assertStringIncludes(textOf(r), "接続先");
    assertStringIncludes(textOf(r), "plancel.test");
    assertEquals(textOf(r).includes("連携していません"), false);
  });
  // A local server is not 「本番」.
  await withPairedClient(
    { ...cfg, baseUrl: "http://localhost:18097", fetchFn },
    async (client) => {
      const r = await client.callTool({ name: "pairing_status", arguments: {} });
      assertStringIncludes(textOf(r), "開発用");
      assertEquals(textOf(r).includes("本番"), false);
    },
  );
});

Deno.test("web-api MCP: descriptions say how stages, plans and 要キャンセル work", async () => {
  const { fetchFn } = fakeApi();
  await withClient(fetchFn, async (client) => {
    const { tools } = await client.listTools();
    const tool = (name: string) => tools.find((t: { name: string }) => t.name === name)!;
    const props = tool("create_reservation").inputSchema.properties as Record<
      string,
      { description: string }
    >;
    // 「3日前まで無料、そのあと50%、当日100%」 written out, so `h` is not guessed.
    assertStringIncludes(
      props.policy!.description,
      '{"h":72,"pct":0},{"h":24,"pct":50},{"h":0,"pct":100}',
    );
    assertStringIncludes(props.plan!.description, "同じプラン名の中で確定できるのは1件");
    const confirm = tool("confirm_reservation").description!;
    assertStringIncludes(confirm, "お店に取り消しの連絡");
    assertStringIncludes(confirm, "cancel_reservation");
  });
});

Deno.test("web-api MCP: endsAt says a date alone is enough", async () => {
  const { fetchFn } = fakeApi();
  await withClient(fetchFn, async (client) => {
    const { tools } = await client.listTools();
    for (const name of ["create_reservation", "update_reservation"]) {
      const props = tools.find((t: { name: string }) => t.name === name)!.inputSchema
        .properties as Record<string, { description: string }>;
      assertStringIncludes(props.endsAt!.description, "日付だけ");
      assertStringIncludes(props.endsAt!.description, "2026-12-20");
    }
  });
});

Deno.test("web-api MCP: notes, trip and timeTentative travel to the API on create and update", async () => {
  const { calls, fetchFn } = scriptedApi((method) =>
    method === "GET"
      ? { status: 200, json: { reservations: [] } }
      : { status: 201, json: { reservation: ROW, policySource: "explicit" } }
  );
  await withClient(fetchFn, async (client) => {
    await client.callTool({
      name: "create_reservation",
      arguments: {
        service: "別府の宿",
        startsAt: "2026-12-19T15:30:00+09:00",
        endsAt: "2026-12-20",
        notes: "夕朝食付き",
        trip: "別府旅行",
        timeTentative: true,
      },
    });
    await client.callTool({
      name: "update_reservation",
      arguments: { id: "R1", timeTentative: false, notes: null },
    });
    const post = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    assertEquals([post.notes, post.trip, post.timeTentative], ["夕朝食付き", "別府旅行", true]);
    const patch = calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    assertEquals(patch, { timeTentative: false, notes: null });

    const { tools } = await client.listTools();
    const props = tools.find((t: { name: string }) => t.name === "create_reservation")!
      .inputSchema.properties as Record<string, { description: string }>;
    // The two groupings are told apart where the model chooses between them.
    assertStringIncludes(props.trip!.description, "全部使う");
    assertStringIncludes(props.plan!.description, "trip");
    assertStringIncludes(props.timeTentative!.description, "仮");
  });
});

Deno.test("web-api MCP: a look-alike is reported, never blocked (owner 2026-11-12)", async () => {
  const { calls, fetchFn } = scriptedApi((method) =>
    method === "GET"
      ? { status: 200, json: { reservations: [ROW] } }
      : { status: 201, json: { reservation: { ...ROW, id: "R2" }, policySource: "explicit" } }
  );
  await withClient(fetchFn, async (client) => {
    // The same place at the same instant: a family may book it twice on purpose.
    const same = parsed(
      await client.callTool({
        name: "create_reservation",
        arguments: { service: "鮨さいとう", startsAt: "2026-12-20T19:00:00+09:00" },
      }),
    );
    assertEquals(same.reservation.id, "R2");
    assertEquals(same.warning, "duplicate");
    assertEquals(same.similar.id, "R1");
    assertStringIncludes(same.hint, "登録しました");

    // The same place that day at another hour.
    const sameDay = parsed(
      await client.callTool({
        name: "create_reservation",
        arguments: { service: "鮨さいとう", startsAt: "2026-12-20T18:00:00+09:00" },
      }),
    );
    assertEquals(sameDay.reservation.id, "R2");
    assertEquals(sameDay.warning, "possible_duplicate");

    // Nothing alike: no warning, no `similar`.
    const other = parsed(
      await client.callTool({
        name: "create_reservation",
        arguments: { service: "別の店", startsAt: "2026-12-20T19:00:00+09:00" },
      }),
    );
    assertEquals([other.warning, other.similar], [undefined, undefined]);
    assertEquals(calls.filter((c) => c.method === "POST").length, 3);
  });
});

Deno.test("web-api MCP: open_in_browser asks the API for a one-use view link", async () => {
  const { calls, fetchFn } = scriptedApi(() => ({
    status: 200,
    json: { url: "https://plancel.test/auth/view?c=abc", expiresInSec: 60, viewOnly: true },
  }));
  await withClient(fetchFn, async (client) => {
    const out = parsed(await client.callTool({ name: "open_in_browser", arguments: {} }));
    assertEquals(out.url, "https://plancel.test/auth/view?c=abc");
    assertEquals(calls[0]?.method, "POST");
    assertEquals(calls[0]?.url, "https://plancel.test/auth/device/view-link");
    const { tools } = await client.listTools();
    const d = tools.find((t: { name: string }) => t.name === "open_in_browser")!.description!;
    assertStringIncludes(d, "閲覧専用");
  });
});

Deno.test("web-api MCP: merge_reservations folds one entry into another through the API", async () => {
  const { calls, fetchFn } = scriptedApi(() => ({
    status: 200,
    json: { reservation: ROW, filled: ["amount"], removedId: "R9" },
  }));
  await withClient(fetchFn, async (client) => {
    const out = parsed(
      await client.callTool({
        name: "merge_reservations",
        arguments: { keepId: "R1", removeId: "R9" },
      }),
    );
    assertEquals(out.removedId, "R9");
    assertEquals(calls[0]?.method, "POST");
    assertEquals(calls[0]?.url, "https://plancel.test/api/reservations/R1/merge");
    assertEquals(calls[0]?.body, { from: "R9" });
    const { tools } = await client.listTools();
    const d = tools.find((t: { name: string }) => t.name === "merge_reservations")!.description!;
    assertStringIncludes(d, "ユーザーに確かめて");
  });
});

Deno.test("web-api MCP: choose_reservation takes one stay over the others through the API", async () => {
  const { calls, fetchFn } = scriptedApi(() => ({
    status: 200,
    json: {
      reservation: ROW,
      affected: [{ id: "R9", service: "別の宿", status: "to_cancel" }],
      needsOwner: [{ id: "R7", service: "母の宿", ownerDisplayName: "母", need: "cancel" }],
    },
  }));
  await withClient(fetchFn, async (client) => {
    const out = parsed(
      await client.callTool({
        name: "choose_reservation",
        arguments: { id: "R1", overIds: ["R9", "R7"] },
      }),
    );
    assertEquals(out.needsOwner[0].need, "cancel");
    assertEquals(calls[0]?.method, "POST");
    assertEquals(calls[0]?.url, "https://plancel.test/api/reservations/R1/choose");
    assertEquals(calls[0]?.body, { over: ["R9", "R7"] });
    // No ids to drop → refused before the API is called.
    const bad = await client.callTool({ name: "choose_reservation", arguments: { id: "R1" } });
    assertEquals(bad.isError, true);
    assertEquals(calls.length, 1);
    const { tools } = await client.listTools();
    const d = tools.find((t: { name: string }) => t.name === "choose_reservation")!.description!;
    assertStringIncludes(d, "needsOwner");
    const list = tools.find((t: { name: string }) => t.name === "list_reservations")!.description!;
    assertStringIncludes(list, "overlaps");
  });
});

Deno.test("web-api MCP: suggest_to_owner proposes to the owner, or withdraws", async () => {
  const { calls, fetchFn } = scriptedApi(() => ({ status: 200, json: { ok: true } }));
  await withClient(fetchFn, async (client) => {
    await client.callTool({ name: "suggest_to_owner", arguments: { id: "R7", action: "cancel" } });
    await client.callTool({
      name: "suggest_to_owner",
      arguments: { id: "R7", action: "withdraw" },
    });
    assertEquals(calls.map((c) => [c.method, c.url, c.body]), [
      ["POST", "https://plancel.test/api/reservations/R7/suggest", { action: "cancel" }],
      ["DELETE", "https://plancel.test/api/reservations/R7/suggest", undefined],
    ]);
    const bad = await client.callTool({
      name: "suggest_to_owner",
      arguments: { id: "R7", action: "maybe" },
    });
    assertEquals(bad.isError, true);
    const { tools } = await client.listTools();
    const d = tools.find((t: { name: string }) => t.name === "suggest_to_owner")!.description!;
    assertStringIncludes(d, "持ち主");
    const u = tools.find((t: { name: string }) => t.name === "update_reservation")!;
    assertStringIncludes(JSON.stringify(u.inputSchema), "希望順");
  });
});

Deno.test("web-api MCP: set_trip_people and drop_reservation reach the API", async () => {
  const { calls, fetchFn } = scriptedApi(() => ({ status: 200, json: { ok: true } }));
  await withClient(fetchFn, async (client) => {
    await client.callTool({ name: "set_trip_people", arguments: { trip: "別府 旅行", people: 4 } });
    await client.callTool({
      name: "set_trip_people",
      arguments: { trip: "別府 旅行", people: null },
    });
    await client.callTool({ name: "drop_reservation", arguments: { id: "R1" } });
    assertEquals(calls.map((c) => [c.method, c.url, c.body]), [
      ["PUT", "https://plancel.test/api/trips/%E5%88%A5%E5%BA%9C%20%E6%97%85%E8%A1%8C", {
        people: 4,
      }],
      ["PUT", "https://plancel.test/api/trips/%E5%88%A5%E5%BA%9C%20%E6%97%85%E8%A1%8C", {
        people: null,
      }],
      ["POST", "https://plancel.test/api/reservations/R1/drop", undefined],
    ]);
    const { tools } = await client.listTools();
    const create = tools.find((t: { name: string }) => t.name === "create_reservation")!;
    assertStringIncludes(JSON.stringify(create.inputSchema), "何人分");
    const list = tools.find((t: { name: string }) => t.name === "list_reservations")!.description!;
    assertStringIncludes(list, "split");
  });
});

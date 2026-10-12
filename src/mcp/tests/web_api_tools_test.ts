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
      "confirm_reservation",
      "create_reservation",
      "delete_policy_template",
      "delete_reservation",
      "list_policy_templates",
      "list_reservation_members",
      "list_reservations",
      "lookup_policy_template",
      "pair_with_plancel",
      "pairing_status",
      "restore_reservation",
      "save_policy_template",
      "set_member_role",
      "share_reservation",
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
    assertEquals(calls[1]?.method, "POST");
    assertEquals(
      (calls[1]?.body as { service: string; confirmed: boolean }).confirmed,
      true,
    );
    assertEquals(calls[2]?.url, "https://plancel.test/api/reservations/R1/confirm");
    assertEquals(calls[3]?.method, "PATCH");
    assertEquals((calls[3]?.body as { location: string }).location, "六本木");
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

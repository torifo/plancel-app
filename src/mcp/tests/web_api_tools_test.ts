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
      "restore_reservation",
      "save_policy_template",
      "set_member_role",
      "share_reservation",
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

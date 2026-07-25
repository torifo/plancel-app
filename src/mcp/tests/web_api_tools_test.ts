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
      "delete_reservation",
      "list_reservations",
      "restore_reservation",
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

Deno.test("web-api MCP tools surface validation errors without calling the API", async () => {
  const { calls, fetchFn } = fakeApi();
  await withClient(fetchFn, async (client) => {
    const res = await client.callTool({ name: "create_reservation", arguments: {} });
    assertEquals(res.isError, true);
    assertStringIncludes(JSON.stringify(res.content), "service");
    assertEquals(calls.length, 0);
  });
});

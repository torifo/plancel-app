/**
 * The local-core server says which ledger it is (issue #3): a PC registered
 * with the env-less command talks to a local KV that the phone never shows,
 * and the tool names overlap with the remote server's, so the model needs a
 * way to tell — and every tool must say so in its description.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryStore } from "../../core/store/mod.ts";
import { VirtualClock } from "../../core/clock/mod.ts";
import { ulid } from "../../lib/ulid.ts";
import { buildServer } from "../server.ts";

Deno.test("local-core MCP: pairing_status says this is the local ledger, every tool says so too", async () => {
  const server = buildServer({
    store: new InMemoryStore(),
    clock: new VirtualClock("2026-10-13T00:00:00.000Z"),
    ids: { newUlid: () => ulid() },
  }, { debug: false });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    const { tools } = await client.listTools();
    const status = tools.find((t: { name: string }) => t.name === "pairing_status");
    assert(status !== undefined, "pairing_status exists in local-core mode too");
    const r = await client.callTool({ name: "pairing_status", arguments: {} });
    const text = (r as { content: { text: string }[] }).content[0]!.text;
    assertStringIncludes(text, "ローカル");
    assertStringIncludes(text, "スマホ");
    assertStringIncludes(text, "PLANCEL_API_URL");
    for (const t of tools) {
      if (t.name === "pairing_status") continue;
      assertEquals(t.description?.startsWith("[ローカル台帳]"), true, t.name);
    }
  } finally {
    await client.close();
  }
});

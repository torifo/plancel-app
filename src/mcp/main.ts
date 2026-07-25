/**
 * plancel MCP server entrypoint (`deno run`). Wires the default production
 * context (KvStore + SystemClock) into the server and serves over stdio.
 *
 * Not imported by tests — tests build the server/tools with an injected
 * InMemoryStore + VirtualClock instead.
 *
 *   deno run --unstable-kv --unstable-temporal \
 *     --allow-env --allow-read --allow-write src/mcp/main.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDefaultContext } from "./context.ts";
import { buildServer } from "./server.ts";
import { buildWebApiServer } from "./web_api_tools.ts";
import { logger } from "../lib/log.ts";

if (import.meta.main) {
  const log = logger("mcp/main");
  // Remote mode (owner 2026-07-23): with PLANCEL_API_URL + PLANCEL_API_TOKEN
  // the server talks to the production web ledger over HTTP instead of the
  // local core store — Claude's edits land where the family looks.
  const apiUrl = Deno.env.get("PLANCEL_API_URL");
  const apiToken = Deno.env.get("PLANCEL_API_TOKEN");
  const server = apiUrl !== undefined && apiToken !== undefined
    ? buildWebApiServer({ baseUrl: apiUrl.replace(/\/$/, ""), token: apiToken })
    : buildServer(await createDefaultContext());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("plancel MCP server connected over stdio", {
    mode: apiUrl !== undefined && apiToken !== undefined ? "web-api" : "local-core",
  });
}

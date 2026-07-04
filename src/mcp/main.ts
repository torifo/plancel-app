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
import { logger } from "../lib/log.ts";

if (import.meta.main) {
  const log = logger("mcp/main");
  const ctx = await createDefaultContext();
  const server = buildServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("plancel MCP server connected over stdio");
}

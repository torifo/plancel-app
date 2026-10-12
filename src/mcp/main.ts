/**
 * plancel MCP server entrypoint (`deno run`). Serves over stdio.
 *
 * Modes (owner 2026-10-13, issue #1):
 *   - no PLANCEL_API_URL            → local core store (unchanged default)
 *   - PLANCEL_API_URL + _API_TOKEN   → remote, fixed token (back-compat)
 *   - PLANCEL_API_URL only           → remote, device pairing: the first tool
 *     call hands back a code to approve on the phone; the token lands in
 *     $XDG_CONFIG_HOME/plancel/credentials.json and never in this config.
 *
 * stdout is the JSON-RPC channel, so every log line goes to stderr.
 *
 *   deno run --unstable-kv --unstable-temporal \
 *     --allow-env --allow-read --allow-write --allow-net src/mcp/main.ts
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDefaultContext } from "./context.ts";
import { buildServer } from "./server.ts";
import { buildWebApiServer, type PairingStateView } from "./web_api_tools.ts";
import { credentialsPath, CredentialStore } from "./credentials.ts";
import { PairingClient } from "./pairing.ts";
import { SystemClock } from "../core/clock/mod.ts";
import { logger } from "../lib/log.ts";

/**
 * The machine's name for the approval screen. `Deno.hostname()` needs
 * --allow-sys, which the documented command deliberately does not grant;
 * without it the name degrades to "pc" rather than the server dying at boot
 * (found by the first real run, 2026-10-13).
 */
function hostName(): string {
  try {
    return Deno.hostname();
  } catch {
    return "pc";
  }
}

/** The view a tool reply may see — never the token. */
function viewOf(client: PairingClient): PairingStateView {
  const s = client.current;
  switch (s.kind) {
    case "pending":
      return {
        kind: "pending",
        userCode: s.userCode,
        verificationUri: s.verificationUri,
        expiresAtMs: s.expiresAtMs,
      };
    case "paired":
      return { kind: "paired", account: s.entry.account };
    default:
      return { kind: s.kind };
  }
}

if (import.meta.main) {
  // MCP stdio: stdout carries JSON-RPC only; a stray log line there corrupts it.
  const log = logger("mcp/main", { write: (line) => console.error(line) });
  const env = (name: string) => Deno.env.get(name);
  const apiUrl = env("PLANCEL_API_URL");
  let mode: string;
  let server;
  if (apiUrl === undefined || apiUrl === "") {
    mode = "local-core";
    server = buildServer(await createDefaultContext());
  } else {
    const baseUrl = apiUrl.replace(/\/$/, "");
    const envToken = env("PLANCEL_API_TOKEN");
    const clock = new SystemClock();
    const client = new PairingClient({
      baseUrl,
      clientName: `${hostName()}/${env("USER") ?? env("USERNAME") ?? "user"} (Claude)`,
      store: new CredentialStore(credentialsPath(env)),
      clock,
      fetchFn: fetch,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...(envToken !== undefined && envToken !== "" ? { envToken } : {}),
    });
    mode = envToken !== undefined && envToken !== "" ? "web-api" : "web-api (pairing)";
    server = buildWebApiServer({
      baseUrl,
      clock,
      token: () => client.token(),
      pairing: {
        start: async (force) => {
          await client.start(force);
          return viewOf(client);
        },
        forget: () => client.forget(),
        current: () => viewOf(client),
      },
    });
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("plancel MCP server connected over stdio", { mode });
}

/**
 * LINE Bot entrypoint (Task 6.2) — `deno task line`.
 *
 * Deno.serve exposing POST /webhook for the LINE platform. All wiring is
 * env-driven:
 *   LINE_CHANNEL_SECRET       — webhook signature verification (required)
 *   LINE_CHANNEL_ACCESS_TOKEN — Messaging API calls (required)
 *   LINE_ALLOWED_USER_IDS     — comma-separated userId allowlist (required)
 *   PLANCEL_KV_PATH           — optional KV path (createDefaultContext)
 *
 * Real-device verification happens after deploy (Task 6.2 done-when);
 * the handler logic itself is covered by src/line/tests/.
 */
import { createDefaultContext } from "../mcp/context.ts";
import { loadParserChainConfig, realParsers } from "../parse/mod.ts";
import { logger } from "../lib/log.ts";
import { createLineClient } from "./client.ts";
import { handleLineWebhook, type LineWebhookDeps } from "./webhook.ts";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function buildDeps(): Promise<LineWebhookDeps> {
  const ctx = await createDefaultContext(Deno.env.get("PLANCEL_KV_PATH"));
  return {
    channelSecret: requiredEnv("LINE_CHANNEL_SECRET"),
    allowedUserIds: new Set(
      requiredEnv("LINE_ALLOWED_USER_IDS").split(",").map((s) => s.trim()).filter(Boolean),
    ),
    ctx,
    parsers: realParsers(),
    chainConfig: await loadParserChainConfig(),
    client: createLineClient({ channelAccessToken: requiredEnv("LINE_CHANNEL_ACCESS_TOKEN") }),
  };
}

if (import.meta.main) {
  const deps = await buildDeps();
  const log = logger("line.main");
  Deno.serve({ port: Number(Deno.env.get("PORT") ?? "8000") }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/webhook") {
      const rawBody = await req.text();
      const result = await handleLineWebhook(rawBody, req.headers.get("x-line-signature"), deps);
      log.info("webhook handled", { status: result.status, handled: result.handled });
      return new Response(null, { status: result.status });
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  });
}

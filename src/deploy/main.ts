/**
 * Unified Deno Deploy entrypoint (deploy wiring — separate org per ADR-2).
 *
 * One deployment serves ALL surfaces off a single managed-KV Store:
 *   - `Deno.serve` — the web UI (GET /), LINE webhook (POST /webhook), GET /healthz
 *   - `Deno.cron`  — the 15-minute boundary check (SDD §6 スケジューラ)
 *
 * The web UI (web/index.html, MVP per owner 2026-07-16) is the primary
 * surface; it is a self-contained client-side app (localStorage) served at
 * `/`. Wiring it to the core KV over an HTTP API is the next step.
 *
 * Deno Deploy runs `Deno.cron` and `Deno.serve` from the same entrypoint, so
 * plancel needs no second deployment. The cron and the webhook share one
 * `KvStore` opened once at startup (the cron handler must NOT close it — it
 * lives for the isolate's lifetime). The notifier is chosen from env
 * (selectNotifier): LINE push > Email > Console.
 *
 * All logic lives in tested modules (webhook.ts, tick.ts, notifier.ts); this
 * file is only the thin `import.meta.main` wiring, like cron/main.ts and
 * line/main.ts. Env:
 *   LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / LINE_ALLOWED_USER_IDS
 *   PLANCEL_OWNER_USER_ID (push target; defaults to first allowed id)
 *   RESEND_API_KEY / PLANCEL_EMAIL_FROM / PLANCEL_EMAIL_TO (email fallback)
 *   GROQ_API_KEY / GEMINI_API_KEY (parsers) · PORT (default 8000)
 */
import { SystemClock } from "../core/clock/mod.ts";
import { KvStore } from "../core/store/mod.ts";
import { ulid } from "../lib/ulid.ts";
import { logger } from "../lib/log.ts";
import { loadParserChainConfig, realParsers } from "../parse/mod.ts";
import { runTick } from "../cron/tick.ts";
import { createLineClient } from "../line/client.ts";
import { handleLineWebhook, type LineWebhookDeps } from "../line/webhook.ts";
import { handleWebApi, isApiPath } from "../web/api.ts";
import { denoEnvReader, selectNotifier } from "./notifier.ts";

const CRON_NAME = "plancel-boundary-check";
const CRON_SCHEDULE = "*/15 * * * *";

if (import.meta.main) {
  const log = logger("deploy.main");
  const env = denoEnvReader();

  const store = await KvStore.open();
  const clock = new SystemClock();
  const ctx = { store, clock, ids: { newUlid: () => ulid() } };

  // Cron: shares the startup Store; never closes it (isolate-lived).
  const { notifier, kind } = selectNotifier(env);
  Deno.cron(CRON_NAME, CRON_SCHEDULE, async () => {
    await runTick({ store, clock, notifier });
  });
  log.info("cron registered", { schedule: CRON_SCHEDULE, notifier: kind });

  // Webhook deps only when LINE is configured; healthz always serves.
  const channelSecret = env.get("LINE_CHANNEL_SECRET");
  const lineToken = env.get("LINE_CHANNEL_ACCESS_TOKEN");
  const allowedUserIds = new Set(
    (env.get("LINE_ALLOWED_USER_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  const webhookDeps: LineWebhookDeps | null = channelSecret !== undefined && lineToken !== undefined
    ? {
      channelSecret,
      allowedUserIds,
      ctx,
      parsers: realParsers({ clock }),
      chainConfig: await loadParserChainConfig(),
      client: createLineClient({ channelAccessToken: lineToken }),
    }
    : null;
  log.info("webhook configured", { enabled: webhookDeps !== null });

  // Web UI served at `/` (read once at startup; the repo file ships with the deploy).
  const INDEX_HTML = await Deno.readTextFile(new URL("../../web/index.html", import.meta.url));
  const htmlHeaders = { "content-type": "text/html; charset=utf-8" };

  // Web API (per-user reservation CRUD in the shared KV, keyed by browser token).
  const webIds = {
    newId: () => ulid(),
    nowIso: () => clock.now().toString({ smallestUnit: "millisecond" }),
  };

  Deno.serve({ port: Number(env.get("PORT") ?? "8000") }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(INDEX_HTML, { headers: htmlHeaders });
    }
    if (isApiPath(url.pathname)) {
      return await handleWebApi(store.kv, req, webIds);
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok");
    }
    if (req.method === "POST" && url.pathname === "/webhook") {
      if (webhookDeps === null) return new Response("line not configured", { status: 503 });
      const rawBody = await req.text();
      const result = await handleLineWebhook(
        rawBody,
        req.headers.get("x-line-signature"),
        webhookDeps,
      );
      log.info("webhook handled", { status: result.status, handled: result.handled });
      return new Response(null, { status: result.status });
    }
    return new Response("not found", { status: 404 });
  });
}

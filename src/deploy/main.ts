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
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (Google login + calendar push)
 *   PLANCEL_KEK (base64 32B, seals refresh tokens) · PLANCEL_BASE_URL
 *   PLANCEL_DEV_USER (local auto-login) · PLANCEL_ADMIN_TOKEN (smoke tests)
 *   PLANCEL_MAX_USERS (open-signup cap, default 50; 0 = unlimited)
 *   PLANCEL_ALLOWED_EMAILS (comma-separated; always allowed past the cap)
 *   PLANCEL_ADMIN_EMAILS (comma-separated; /auth/me carries the 100-user warning)
 *   (RESEND_API_KEY + PLANCEL_EMAIL_FROM also power magic-link login)
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
import { handleParseApi, type ParseApiDeps } from "../web/parse-api.ts";
import { type AuthDeps, handleAuthApi, isAuthPath, resolveIdentity } from "../web/auth/routes.ts";
import type { AuthIds } from "../web/users.ts";
import { handleCalendarFeed, isCalendarFeedPath } from "../web/calendar/ics.ts";
import { handleSyncMessage, requestSync, type SyncDeps, syncMsgSchema } from "../web/calendar/sync.ts";
import { hexEncode } from "../lib/encoding.ts";
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

  // One parser chain shared by every intake surface (web /api/parse, LINE).
  const parsers = realParsers({ clock });
  const chainConfig = await loadParserChainConfig();

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
      parsers,
      chainConfig,
      client: createLineClient({ channelAccessToken: lineToken }),
    }
    : null;
  log.info("webhook configured", { enabled: webhookDeps !== null });

  // Web UI served at `/` (read once at startup; the repo file ships with the deploy).
  const INDEX_HTML = await Deno.readTextFile(new URL("../../web/index.html", import.meta.url));
  const htmlHeaders = { "content-type": "text/html; charset=utf-8" };

  // Web API (per-user reservation CRUD in the shared KV, keyed by ledger id).
  const webIds = {
    newId: () => ulid(),
    nowIso: () => clock.now().toString({ smallestUnit: "millisecond" }),
  };

  // ---- Login + calendar integration (spec 2026-07-21) ----
  const authIds: AuthIds = {
    ...webIds,
    nowMs: () => clock.now().epochMilliseconds,
    randomToken: () => {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      return hexEncode(b);
    },
  };
  const googleClientId = env.get("GOOGLE_CLIENT_ID");
  const googleClientSecret = env.get("GOOGLE_CLIENT_SECRET");
  const googleApp = googleClientId !== undefined && googleClientSecret !== undefined
    ? { clientId: googleClientId, clientSecret: googleClientSecret }
    : null;
  const kek = env.get("PLANCEL_KEK");
  if (kek === undefined) {
    log.warn("PLANCEL_KEK unset — Google refresh tokens will be stored unencrypted");
  }
  const resendKey = env.get("RESEND_API_KEY");
  const emailFrom = env.get("PLANCEL_EMAIL_FROM");
  const sendMagicLink = resendKey !== undefined && emailFrom !== undefined
    ? async (email: string, url: string) => {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: emailFrom,
          to: [email],
          subject: "[plancel] ログインリンク",
          text: `plancel へのログインリンクです（15分間有効・1回のみ）:\n\n${url}\n\n` +
            "心当たりがない場合はこのメールを無視してください。",
        }),
      });
      if (!res.ok) throw new Error(`magic link send failed: http ${res.status}`);
      await res.body?.cancel();
    }
    : null;
  const authDeps: AuthDeps = {
    kv: store.kv,
    ids: authIds,
    fetchFn: fetch,
    google: googleApp,
    sendMagicLink,
    kek,
    ...(env.get("PLANCEL_BASE_URL") !== undefined
      ? { baseUrl: env.get("PLANCEL_BASE_URL") as string }
      : {}),
    ...(env.get("PLANCEL_DEV_USER") !== undefined
      ? { devUserEmail: env.get("PLANCEL_DEV_USER") as string }
      : {}),
    ...(env.get("PLANCEL_ADMIN_TOKEN") !== undefined
      ? { adminToken: env.get("PLANCEL_ADMIN_TOKEN") as string }
      : {}),
    // Signup policy (owner 2026-07-23): the Google side stays fully open and
    // the app enforces capacity — an open-signup pool of 50 (this default),
    // plus 身近な知り合い (~20 expected) guaranteed past the cap via
    // PLANCEL_ALLOWED_EMAILS. The free-tier math supports ~100 users; 50
    // deliberately leaves half the request quota as headroom (opulse shares
    // the org quota, and overage pauses BOTH apps). PLANCEL_MAX_USERS=0
    // disables the cap.
    maxUsers: Number(env.get("PLANCEL_MAX_USERS") ?? "50"),
    allowedEmails: new Set(
      (env.get("PLANCEL_ALLOWED_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    adminEmails: new Set(
      (env.get("PLANCEL_ADMIN_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
  const syncDeps: SyncDeps = {
    kv: store.kv,
    ids: authIds,
    fetchFn: fetch,
    google: googleApp,
    kek,
    enqueue: async (msg, delayMs) => {
      await store.kv.enqueue(msg, { delay: delayMs });
    },
  };
  store.kv.listenQueue(async (raw) => {
    if (syncMsgSchema.safeParse(raw).success) await handleSyncMessage(syncDeps, raw);
  });
  log.info("auth configured", {
    google: googleApp !== null,
    emailLogin: sendMagicLink !== null,
    kek: kek !== undefined,
  });
  // Web intake: pasted mail text / screenshot images through the parse chain.
  const parseDeps: ParseApiDeps = {
    parsers,
    chainConfig,
    clock,
    ids: { ulid: () => ulid(), nowIso: webIds.nowIso },
    saveJob: (job) => store.putParseJob(job),
  };

  Deno.serve({ port: Number(env.get("PORT") ?? "8000") }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(INDEX_HTML, { headers: htmlHeaders });
    }
    if (isAuthPath(url.pathname)) {
      return await handleAuthApi(req, authDeps);
    }
    if (isCalendarFeedPath(url.pathname)) {
      return await handleCalendarFeed(store.kv, req);
    }
    if (url.pathname === "/api/parse") {
      // Login-gated: parsing burns LLM quota, so anonymous callers get 401.
      const who = await resolveIdentity(req, authDeps);
      if (who.ledger === null) return new Response(`{"error":"login required"}`, { status: 401 });
      return await handleParseApi(req, parseDeps);
    }
    if (isApiPath(url.pathname)) {
      const who = await resolveIdentity(req, authDeps);
      if (who.ledger === null) return new Response(`{"error":"login required"}`, { status: 401 });
      const user = who.user;
      return await handleWebApi(store.kv, req, webIds, {
        ledger: who.ledger,
        onMutate: (resvId) => {
          // Only real (non-demo) ledgers of Google-linked users sync.
          if (user === null || user.google === null || who.ledger !== user.ledgerId) return;
          requestSync(syncDeps, user.id, resvId).catch((err) =>
            log.error("requestSync failed", { err: String(err) })
          );
        },
      });
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

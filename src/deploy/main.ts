/**
 * Unified Deno Deploy entrypoint.
 *
 * One deployment serves ALL surfaces off a single managed-KV Store:
 *   - `Deno.serve` — the web UI (GET /), LINE webhook (POST /webhook), the
 *     inbound-mail webhook (POST /webhook/email), GET /healthz
 *   - `Deno.cron`  — the 15-minute boundary check (SDD §6 スケジューラ)
 *
 * The web UI (web/index.html) is the primary surface. Authentication, the
 * per-user web ledger, sharing, parsing, calendar feeds/sync, and remote MCP
 * all use the HTTP APIs backed by the managed KV.
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
 *   LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN
 *   LINE_ALLOWED_USER_IDS (a private-beta gate over UNLINKED senders only, still
 *     read here and enforced in line/webhook.ts. EMPTY is the correct state for
 *     a public account: a non-empty set would stop anyone new from linking. It
 *     can never block a sender who is already linked)
 *   PLANCEL_OWNER_USER_ID (core-ledger cron push target, see notifier.ts;
 *     web-ledger reminders go to each user's OWN linked LINE account)
 *   RESEND_API_KEY / PLANCEL_EMAIL_FROM / PLANCEL_EMAIL_TO (email fallback)
 *   GROQ_API_KEY / GEMINI_API_KEY (parsers) · PORT (default 8000)
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (Google login + calendar push)
 *   PLANCEL_KEK (base64 32B, seals refresh tokens) · PLANCEL_BASE_URL
 *   PLANCEL_DEV_USER (local auto-login) · PLANCEL_ADMIN_TOKEN (smoke tests)
 *   PLANCEL_MAX_USERS (open-signup cap, default 50; 0 = unlimited)
 *   PLANCEL_ALLOWED_EMAILS (comma-separated; always allowed past the cap, and
 *     served first by the deadline-reminder sweep)
 *   PLANCEL_EMAIL_DAILY_CAP (reminder e-mails per JST day, default 90)
 *   PLANCEL_ADMIN_EMAILS (comma-separated; /auth/me carries the 100-user warning)
 *   (RESEND_API_KEY + PLANCEL_EMAIL_FROM also power magic-link login)
 *   PLANCEL_INBOUND_DOMAIN / RESEND_WEBHOOK_SECRET (メール転送インテーク; the
 *     Received-Emails read also needs RESEND_API_KEY)
 *   PLANCEL_MAIL_DAILY_CAP (accepted forwards per user per day, default 50)
 */
import { SystemClock } from "../core/clock/mod.ts";
import { KvStore } from "../core/store/mod.ts";
import { ulid } from "../lib/ulid.ts";
import { logger } from "../lib/log.ts";
import { healthzBody } from "../lib/build.ts";
import {
  GEMINI_DEFAULT_MODEL,
  GROQ_DEFAULT_MODEL,
  loadParserChainConfig,
  realParsers,
} from "../parse/mod.ts";
import { runTick } from "../cron/tick.ts";
import { createLineClient } from "../line/client.ts";
import { handleLineWebhook, type LineWebhookDeps } from "../line/webhook.ts";
import { handleUserLookup, handleWebApi, isApiPath, isUsersLookupPath } from "../web/api.ts";
import { handleParseApi, type ParseApiDeps } from "../web/parse-api.ts";
import { type AuthDeps, handleAuthApi, isAuthPath, resolveIdentity } from "../web/auth/routes.ts";
import type { AuthIds } from "../web/users.ts";
import { handleCalendarFeed, isCalendarFeedPath } from "../web/calendar/ics.ts";
import { requestSync, sweepDirtySync, type SyncDeps } from "../web/calendar/sync.ts";
import { EMAIL_DAILY_CAP_DEFAULT, sweepDeadlineNotifications } from "../web/notify.ts";
import {
  type EmailIntakeDeps,
  handleEmailWebhook,
  isEmailWebhookPath,
  MAIL_DAILY_CAP_DEFAULT,
} from "../web/email-intake.ts";
import { loadPwaAssets, servePwaAsset } from "../web/pwa.ts";
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

  // Notifier for the cron (registered below, after syncDeps exists).
  const { notifier, kind } = selectNotifier(env);

  // One parser chain shared by every intake surface (web /api/parse, LINE).
  const parsers = realParsers({ clock });
  const chainConfig = await loadParserChainConfig();
  // Which model this build actually asks for, said out loud at boot. Providers
  // retire models without notice (ADR-13) and the chain swallows that as a
  // fall-through, so the running model has to be readable from outside
  // without a deploy.
  log.info("parsers configured", {
    text: chainConfig.text,
    image: chainConfig.image,
    groqModel: GROQ_DEFAULT_MODEL,
    geminiModel: GEMINI_DEFAULT_MODEL,
    groqKey: env.get("GROQ_API_KEY") !== undefined,
    geminiKey: env.get("GEMINI_API_KEY") !== undefined,
  });

  // Webhook deps only when LINE is configured; healthz always serves.
  const channelSecret = env.get("LINE_CHANNEL_SECRET");
  const lineToken = env.get("LINE_CHANNEL_ACCESS_TOKEN");
  // One client for both the webhook replies and the owner's deadline pushes.
  const lineClient = lineToken !== undefined
    ? createLineClient({ channelAccessToken: lineToken })
    : null;
  // Linking a LINE account to a web account is the authorization now (owner
  // 2026-07-27), so this set can only restrict senders that are NOT linked yet
  // — but it IS still read and still enforced for them (line/webhook.ts).
  // Production leaves it unset on purpose: the account is public, and a
  // non-empty set would reject every newcomer before they could send a link
  // code. Set it only to run a closed beta.
  const allowedUserIds = new Set(
    (env.get("LINE_ALLOWED_USER_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  const webhookDeps: LineWebhookDeps | null = channelSecret !== undefined && lineClient !== null
    ? { channelSecret, allowedUserIds, ctx, parsers, chainConfig, client: lineClient }
    : null;
  // `web` (the per-user WEB ledger surface) is attached further down, once the
  // ledger/sync wiring below exists.
  log.info("webhook configured", { enabled: webhookDeps !== null });

  // Web UI served at `/` (read once at startup; the repo file ships with the deploy).
  const INDEX_HTML = await Deno.readTextFile(new URL("../../web/index.html", import.meta.url));
  const pwaAssets = await loadPwaAssets();
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
  // 保証リスト (身近な知り合い). Read once: it is both the signup-capacity
  // bypass and the priority order of the deadline-reminder sweep.
  const allowedEmails = new Set(
    (env.get("PLANCEL_ALLOWED_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
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
    allowedEmails,
    adminEmails: new Set(
      (env.get("PLANCEL_ADMIN_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    // メール転送インテーク: /auth/me shows the address only once a receiving
    // domain exists (production: the auto-issued *.resend.app domain).
    ...(env.get("PLANCEL_INBOUND_DOMAIN") !== undefined
      ? { inboundDomain: env.get("PLANCEL_INBOUND_DOMAIN") as string }
      : {}),
  };
  // Queue-free sync (KV Connect has no queues in production): inline
  // reconcile on write + dirty-flag sweep from the cron below.
  const syncDeps: SyncDeps = {
    kv: store.kv,
    ids: authIds,
    fetchFn: fetch,
    google: googleApp,
    kek,
  };

  // Web-ledger deadline notifications (owner 2026-07-25). Delivery: Resend
  // when configured (same shape as sendMagicLink), else a console log line.
  const notifyLog = logger("web.notify");
  const webNotifySend = resendKey !== undefined && emailFrom !== undefined
    ? async (email: string, subject: string, text: string) => {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: emailFrom, to: [email], subject, text }),
      });
      if (!res.ok) throw new Error(`web notify send failed: http ${res.status}`);
      await res.body?.cancel();
    }
    : (email: string, subject: string, text: string) => {
      notifyLog.info("deadline notification (console fallback)", { email, subject, text });
      return Promise.resolve();
    };
  const webNotifyBaseUrl = env.get("PLANCEL_BASE_URL") ?? "https://plancel-app.torifo.deno.net";
  // LINE v2 #1: each user reads their own deadline reminders in LINE, not mail.
  // Needs only the channel token — the push target is the ledger owner's own
  // linked LINE account; users without a link keep the email/console route.
  const webNotifyLine = lineClient !== null
    ? {
      push: (lineUserId: string, text: string) =>
        lineClient.push(lineUserId, [{ type: "text" as const, text }]),
    }
    : null;
  // Daily EMAIL ceiling (owner 2026-07-27, 「知人優先で枠を使いたい」): reminders
  // are the only bulk consumer of Resend's free 100/day, so the sweep serves
  // PLANCEL_ALLOWED_EMAILS first and stops mailing once the cap is reached.
  // An unset / non-positive / unparsable value keeps the default — a mistyped
  // env must not silence reminders.
  const capEnv = Number(env.get("PLANCEL_EMAIL_DAILY_CAP") ?? "");
  const emailDailyCap = Number.isFinite(capEnv) && capEnv > 0 ? capEnv : EMAIL_DAILY_CAP_DEFAULT;
  log.info("web deadline notify channel", {
    line: webNotifyLine !== null,
    emailDailyCap,
    guaranteed: allowedEmails.size,
  });
  // LINE v2 #2/#3: 「確認」and the confirm / cancelled-it Quick Replies operate
  // on the SENDER'S OWN WEB ledger (resolved from their LINE link), through the
  // same store functions + calendar-sync hook the HTTP API uses.
  if (webhookDeps !== null) {
    webhookDeps.web = {
      kv: store.kv,
      ids: authIds,
      nowMs: () => clock.now().epochMilliseconds,
      onMutate: (user, resvId) => {
        if (user.google === null) return;
        requestSync(syncDeps, user.id, resvId).catch((err) =>
          log.error("requestSync failed", { err: String(err) })
        );
      },
    };
  }
  log.info("line web-ledger commands", { enabled: webhookDeps?.web !== undefined });
  log.info("auth configured", {
    google: googleApp !== null,
    emailLogin: sendMagicLink !== null,
    kek: kek !== undefined,
  });

  // Cron: shares the startup Store; never closes it (isolate-lived). Also
  // retries any calendar syncs the inline pass left dirty.
  Deno.cron(CRON_NAME, CRON_SCHEDULE, async () => {
    await runTick({ store, clock, notifier });
    const repaired = await sweepDirtySync(syncDeps);
    if (repaired > 0) log.info("gcal sweep repaired", { repaired });
    const notified = await sweepDeadlineNotifications({
      kv: store.kv,
      nowMs: clock.now().epochMilliseconds,
      baseUrl: webNotifyBaseUrl,
      send: webNotifySend,
      emailDailyCap,
      allowedEmails,
      ...(webNotifyLine !== null ? { line: webNotifyLine } : {}),
    });
    if (notified > 0) log.info("web deadline notifications sent", { notified });
  });
  log.info("cron registered", { schedule: CRON_SCHEDULE, notifier: kind });
  // Web intake: pasted mail text / screenshot images through the parse chain.
  const parseDeps: ParseApiDeps = {
    parsers,
    chainConfig,
    clock,
    ids: { ulid: () => ulid(), nowIso: webIds.nowIso },
    saveJob: (job) => store.putParseJob(job),
  };

  // メール転送インテーク (owner 2026-07-27): a forwarded confirmation mail lands
  // in the FORWARDER'S OWN ledger as a candidate, through the same parser chain
  // and the same createReservation + sync hook as every other intake surface.
  // The recipient's secret is the identity — `from` is never trusted.
  const mailCapEnv = Number(env.get("PLANCEL_MAIL_DAILY_CAP") ?? "");
  const emailIntakeDeps: EmailIntakeDeps = {
    kv: store.kv,
    ids: webIds,
    clock,
    parsers,
    chainConfig,
    ...(env.get("RESEND_WEBHOOK_SECRET") !== undefined
      ? { webhookSecret: env.get("RESEND_WEBHOOK_SECRET") as string }
      : {}),
    ...(resendKey !== undefined ? { apiKey: resendKey } : {}),
    fetchFn: fetch,
    saveJob: (job) => store.putParseJob(job),
    ...(webNotifyLine !== null ? { line: webNotifyLine } : {}),
    baseUrl: webNotifyBaseUrl,
    dailyCap: Number.isFinite(mailCapEnv) && mailCapEnv > 0 ? mailCapEnv : MAIL_DAILY_CAP_DEFAULT,
    onMutate: (user, resvId) => {
      if (user.google === null) return;
      requestSync(syncDeps, user.id, resvId).catch((err) =>
        log.error("requestSync failed", { err: String(err) })
      );
    },
  };
  log.info("email intake configured", {
    enabled: emailIntakeDeps.webhookSecret !== undefined && emailIntakeDeps.apiKey !== undefined,
    domain: env.get("PLANCEL_INBOUND_DOMAIN") ?? null,
  });

  Deno.serve({ port: Number(env.get("PORT") ?? "8000") }, async (req) => {
    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(INDEX_HTML, { headers: htmlHeaders });
    }
    if (req.method === "GET") {
      const asset = servePwaAsset(url.pathname, pwaAssets);
      if (asset !== null) return asset;
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
    if (isUsersLookupPath(url.pathname)) {
      // Exact-match lookup for the invite box — login required (never leaks email).
      const who = await resolveIdentity(req, authDeps);
      return await handleUserLookup(store.kv, req, who.user);
    }
    if (isApiPath(url.pathname)) {
      const who = await resolveIdentity(req, authDeps);
      if (who.ledger === null) return new Response(`{"error":"login required"}`, { status: 401 });
      const user = who.user;
      return await handleWebApi(store.kv, req, webIds, {
        ledger: who.ledger,
        user,
        onMutate: (resvId, ledgerOwner) => {
          // Only real (non-demo) ledgers of Google-linked users sync. An
          // editor member's edit landed in `ledgerOwner`'s ledger, so it is
          // THEIR calendar that has to follow — not the caller's.
          const target = ledgerOwner ??
            (user !== null && who.ledger === user.ledgerId ? user : null);
          if (target === null || target.google === null) return;
          requestSync(syncDeps, target.id, resvId).catch((err) =>
            log.error("requestSync failed", { err: String(err) })
          );
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      // 本番に何が入っているかを外から言える唯一の場所（src/lib/build.ts）。
      return new Response(healthzBody(env));
    }
    if (isEmailWebhookPath(url.pathname)) {
      return await handleEmailWebhook(req, emailIntakeDeps);
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

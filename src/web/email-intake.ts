/**
 * `POST /webhook/email` — メール転送インテーク (owner 2026-07-27:
 * 「メールの内容をコピーするのではなく転送してもらうとかがいいな」).
 *
 * Design: local/reports/2026-07-27-email-forward-intake.md. Deno Deploy cannot
 * receive SMTP, so inbound mail arrives as a Resend webhook. Each user has a
 * unique receive address `p-<mailSecret>@<PLANCEL_INBOUND_DOMAIN>` (users.ts):
 * they save it once as a contact and afterwards only ever press 転送.
 *
 * Two independent security layers, mirroring the LINE webhook:
 *   1. THE RECIPIENT IS THE IDENTITY. The secret in the local part resolves the
 *      ledger via `findUserByMailSecret`. `from` is never read for identity —
 *      a forged sender resolves to nothing, and forging the recipient means
 *      guessing a 32-byte token.
 *   2. Svix signature over the raw body (./email-signature.ts) proves the POST
 *      came from Resend and not from someone hitting the endpoint directly.
 *
 * STATUS CODES ARE A RETRY CONTRACT. Resend retries non-2xx, so everything the
 * app decides — unknown recipient, duplicate delivery, over the daily cap, a
 * parse the LLMs could not do — answers 200 and writes a log line instead.
 * Only a genuinely retryable upstream failure (the Received-Emails read) and a
 * malformed/unauthenticated request are non-2xx. The response body never says
 * whether a secret matched.
 *
 * The webhook payload is metadata only; the body is a second call to Resend's
 * Received-Emails API (`GET /emails/receiving/{id}`), capped before it reaches
 * the parser. Attachments are out of scope for v1 (the `/api/parse` image path
 * wants a prepared data URL) and only logged.
 *
 * Idempotency: `["mail_seen", <email_id>]` is CLAIMED atomically before any
 * parsing, so a redelivery can neither create a second reservation nor burn LLM
 * quota twice. An unexpected exception releases the claim so a retry still
 * works; a decided outcome (created / unparseable) keeps it.
 *
 * No direct clock reads (FR-008): time comes from the injected `Clock`.
 */
import { z } from "zod";
import type { Clock } from "../core/clock/mod.ts";
import type { ParseJob } from "../core/schema/mod.ts";
import { logger } from "../lib/log.ts";
import {
  allParsersFailed,
  impliedFreeBoundaryHours,
  mergedParsedOutput,
  parserFailures,
  runParseChain,
} from "../parse/mod.ts";
import type { ParseInput, Parser, ParserChainConfig } from "../parse/mod.ts";
import { fromCoreStages } from "./policy.ts";
import { createReservation, webCreateSchema, type WebIds } from "./store.ts";
import { findUserByMailSecret, mailSecretFromAddress, type WebUser } from "./users.ts";
import { readSvixHeaders, verifySvixSignature } from "./email-signature.ts";

const SEEN = "mail_seen";
const RATE = "mail_rate";

/** One forward is one reservation candidate; 60 days outlives any redelivery. */
const SEEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;
/** Rolling window of the per-user cap (fixed window, like `magic_rate`). */
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Accepted forwards per user per window. A personal ledger sees a handful of
 * confirmation mails a day, so this only ever stops a loop (a mail rule
 * forwarding plancel's own mail back to itself) or a leaked address.
 * Env-overridable via PLANCEL_MAIL_DAILY_CAP (read in src/deploy/main.ts).
 */
export const MAIL_DAILY_CAP_DEFAULT = 50;

/**
 * Ceiling on the raw webhook body. The real payload is a few hundred bytes of
 * metadata; anything past this is not Resend and is refused before JSON.parse.
 */
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/** Ceiling on the mail text handed to the parsers (LLM cost, not correctness). */
const MAX_BODY_CHARS = 100 * 1024;

export interface EmailIntakeDeps {
  kv: Deno.Kv;
  ids: WebIds;
  clock: Clock;
  /** The same parser instances `/api/parse` and the LINE webhook share. */
  parsers: Parser[];
  chainConfig: ParserChainConfig;
  /** Svix signing secret. undefined → the route answers 503 (not configured). */
  webhookSecret?: string;
  /** Resend API key for the body read. undefined → 503, same as above. */
  apiKey?: string;
  fetchFn: typeof fetch;
  /** Persists the ParseJob for the replay corpus (best-effort, like /api/parse). */
  saveJob?: (job: ParseJob) => Promise<void>;
  /**
   * LINE push route, injected exactly as in ./notify.ts: present whenever a
   * channel token is configured. Used ONLY to tell the forwarder that a mail
   * could not be read — a mail reply would need a verified sending domain and
   * would spend the same free-tier quota the reminders need.
   */
  line?: { push(lineUserId: string, text: string): Promise<void> };
  /** Link put in that notification. */
  baseUrl: string;
  dailyCap?: number;
  /** Calendar-sync hook — the same one the HTTP API and LINE fire on create. */
  onMutate?: (user: WebUser, resvId: string) => void;
  logWrite?: (line: string) => void;
}

export function isEmailWebhookPath(pathname: string): boolean {
  return pathname === "/webhook/email";
}

// ---------- webhook payload (metadata only — Resend sends no body) ----------

const RECEIVED_TYPE = "email.received";

const attachmentSchema = z.object({
  filename: z.string().nullable().default(null),
}).passthrough();

const eventSchema = z.object({
  type: z.string(),
  data: z.object({
    email_id: z.string().min(1),
    to: z.array(z.string()).default([]),
    received_for: z.array(z.string()).default([]),
    from: z.string().nullable().default(null),
    subject: z.string().nullable().default(null),
    attachments: z.array(attachmentSchema).default([]),
  }),
});

/** `GET /emails/receiving/{id}` — only the fields v1 reads. */
const receivedEmailSchema = z.object({
  text: z.string().nullable().default(null),
  html: z.string().nullable().default(null),
  subject: z.string().nullable().default(null),
  attachments: z.array(attachmentSchema).default([]),
});

// ---------- helpers ----------

/**
 * Reads at most `max` bytes of the request body. A larger body is reported
 * rather than buffered — `req.text()` would materialize whatever was sent.
 */
async function readCappedBody(
  req: Request,
  max: number,
): Promise<{ body: string; tooLarge: boolean }> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await req.body?.cancel();
    return { body: "", tooLarge: true };
  }
  const reader = req.body?.getReader();
  if (reader === undefined) return { body: "", tooLarge: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return { body: "", tooLarge: true };
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return { body: new TextDecoder().decode(joined), tooLarge: false };
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Plain text out of an HTML-only mail. Not a MIME/HTML library (the repo has no
 * such dependency): block boundaries become newlines, tags go, a handful of
 * entities are decoded. The parsers only need the human-readable lines.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? " ")
    .split("\n")
    .map((line) => line.replace(/[ \t 　]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The first intake secret among the recipients, or null. */
function secretFromRecipients(
  to: readonly string[],
  receivedFor: readonly string[],
): string | null {
  for (const address of [...to, ...receivedFor]) {
    const secret = mailSecretFromAddress(address);
    if (secret !== null) return secret;
  }
  return null;
}

const rateSchema = z.object({ count: z.number() });

/** True when this user may take another forward (counts the attempt). */
async function allowForward(kv: Deno.Kv, userId: string, cap: number): Promise<boolean> {
  const key = [RATE, userId];
  const cur = rateSchema.safeParse((await kv.get(key)).value);
  const count = cur.success ? cur.data.count : 0;
  if (count >= cap) return false;
  await kv.set(key, { count: count + 1 }, { expireIn: RATE_WINDOW_MS });
  return true;
}

const NOTE_UNREADABLE = "転送メールから予約情報を読み取れませんでした。";

function unreadableText(subject: string | null, baseUrl: string): string {
  const which = subject === null || subject.trim() === "" ? "" : `\n件名: ${subject.trim()}`;
  // `/#import` opens the 取り込み modal directly (web/index.html routeHash), so the
  // reply names a screen the reader can actually land on.
  return `${NOTE_UNREADABLE}${which}\nplancel の「取り込む」で本文を貼り付けてください: ${baseUrl}/#import`;
}

// ---------- handler ----------

const empty = (status: number) => new Response(null, { status });

export async function handleEmailWebhook(
  req: Request,
  deps: EmailIntakeDeps,
): Promise<Response> {
  const log = logger("web.email", deps.logWrite !== undefined ? { write: deps.logWrite } : {});

  if (req.method !== "POST") return empty(405);
  const secret = deps.webhookSecret;
  const apiKey = deps.apiKey;
  // Unconfigured behaves like the LINE webhook: 503, never a silent accept.
  if (secret === undefined || apiKey === undefined) {
    log.warn("email intake not configured", {
      webhookSecret: secret !== undefined,
      apiKey: apiKey !== undefined,
    });
    return empty(503);
  }

  const { body: rawBody, tooLarge } = await readCappedBody(req, MAX_WEBHOOK_BODY_BYTES);
  if (tooLarge) {
    log.warn("webhook body over the size ceiling", { max: MAX_WEBHOOK_BODY_BYTES });
    return empty(413);
  }

  const verdict = await verifySvixSignature(
    secret,
    rawBody,
    readSvixHeaders(req.headers),
    deps.clock.now().epochMilliseconds,
  );
  if (verdict !== "ok") {
    log.warn("signature verification failed", { verdict });
    return empty(401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return empty(400);
  }
  // Anything that is not a received mail (delivered/bounced/complained…) is
  // acknowledged so Resend stops, before the shape is scrutinized at all.
  const type = (payload as { type?: unknown } | null)?.type;
  if (type !== RECEIVED_TYPE) {
    log.info("event ignored", { type: typeof type === "string" ? type : null });
    return empty(200);
  }
  const parsedEvent = eventSchema.safeParse(payload);
  if (!parsedEvent.success) {
    log.warn("received event has an unexpected shape", {
      issues: parsedEvent.error.issues.map((i) => i.path.join(".")),
    });
    return empty(400);
  }
  const event = parsedEvent.data.data;

  const mailSecret = secretFromRecipients(event.to, event.received_for);
  const user = mailSecret === null ? null : await findUserByMailSecret(deps.kv, mailSecret);
  if (user === null) {
    // `from` is logged for forensics only — it never resolved anything.
    log.warn("no ledger for this recipient; dropped", {
      email_id: event.email_id,
      matchedPrefix: mailSecret !== null,
      from: event.from,
    });
    return empty(200);
  }

  if (!await allowForward(deps.kv, user.id, deps.dailyCap ?? MAIL_DAILY_CAP_DEFAULT)) {
    log.warn("daily forward cap reached; dropped", {
      userId: user.id,
      email_id: event.email_id,
      cap: deps.dailyCap ?? MAIL_DAILY_CAP_DEFAULT,
    });
    return empty(200);
  }

  // Claim before any work: a redelivery (or a concurrent duplicate) loses the
  // atomic check and becomes a no-op instead of a second reservation.
  const seenKey = [SEEN, event.email_id];
  const claimed = await deps.kv.atomic()
    .check({ key: seenKey, versionstamp: null })
    .set(seenKey, { at: deps.clock.now().toString() }, { expireIn: SEEN_TTL_MS })
    .commit();
  if (!claimed.ok) {
    log.info("duplicate delivery; already handled", {
      userId: user.id,
      email_id: event.email_id,
    });
    return empty(200);
  }

  try {
    return await intake(event, user, deps, log, apiKey);
  } catch (err) {
    // Release the claim so Resend's retry (this answers 5xx) can try again.
    await deps.kv.delete(seenKey);
    log.error("intake failed", { userId: user.id, email_id: event.email_id, err: String(err) });
    return empty(500);
  }
}

type Log = ReturnType<typeof logger>;
type ReceivedEvent = z.infer<typeof eventSchema>["data"];

async function intake(
  event: ReceivedEvent,
  user: WebUser,
  deps: EmailIntakeDeps,
  log: Log,
  apiKey: string,
): Promise<Response> {
  const mail = await fetchReceivedEmail(event.email_id, apiKey, deps);
  if (mail === null) {
    // Transient upstream failure — the ONE case worth a Resend retry.
    await deps.kv.delete([SEEN, event.email_id]);
    log.warn("could not read the received mail; asking for a retry", {
      userId: user.id,
      email_id: event.email_id,
    });
    return empty(502);
  }

  const attachments = [...event.attachments, ...mail.attachments];
  if (attachments.length > 0) {
    // v1 reads text only (see the module docstring).
    log.info("attachments ignored", {
      userId: user.id,
      email_id: event.email_id,
      count: attachments.length,
    });
  }

  const text = bodyText(mail);
  const subject = mail.subject ?? event.subject;
  if (text === "") {
    await notifyUnreadable(user, subject, deps, log);
    log.warn("mail had no readable text", { userId: user.id, email_id: event.email_id });
    return empty(200);
  }

  const input: ParseInput = {
    type: "text",
    content: text,
    correlation_id: `mail-${deps.ids.newId()}`,
  };
  const job = await runParseChain(input, deps.chainConfig, deps.parsers, deps.clock, {
    ulid: deps.ids.newId,
    nowIso: deps.ids.nowIso,
  });
  if (deps.saveJob !== undefined) {
    try {
      await deps.saveJob(job);
    } catch (err) {
      log.warn("saveJob failed (ignored)", { job_id: job.id, err: String(err) });
    }
  }

  const merged = mergedParsedOutput(job);
  const create = job.status === "parsed"
    ? webCreateSchema.safeParse({
      service: merged.service_name,
      startsAt: merged.starts_at,
      // 型を確かめてから渡す: 変な値をそのまま渡すと safeParse が転けて、
      // 読めていた予約ごと「読み取れませんでした」になる。
      endsAt: typeof merged.ends_at === "string" ? merged.ends_at : null,
      amount: typeof merged.amount_jpy === "number" ? merged.amount_jpy : null,
      location: typeof merged.location === "string" ? merged.location : null,
      policy: fromCoreStages(merged.cancellation_policy, impliedFreeBoundaryHours(text)),
      // Forwarded mail lands as a CANDIDATE: the ledger owner confirms in the UI,
      // exactly like a LINE-registered reservation.
      confirmed: false,
    })
    : null;
  if (create === null || !create.success) {
    await notifyUnreadable(user, subject, deps, log);
    // Name the providers that never answered: without them "could not be
    // parsed" reads as a mail problem even when no model was reachable at
    // all (ADR-13).
    const failures = parserFailures(job);
    const fields = {
      userId: user.id,
      email_id: event.email_id,
      job_id: job.id,
      status: job.status,
      ...(failures.length > 0 ? { failures } : {}),
    };
    if (allParsersFailed(job)) log.error("no parser could answer a forwarded mail", fields);
    else log.warn("forwarded mail could not be parsed; nothing written", fields);
    return empty(200);
  }

  // A policy the mail never stated falls back to the facility's saved template.
  // That rescue lives in createReservation (src/web/store.ts) so every intake
  // route gets it — this one used to carry its own copy, and the copy LINE never
  // had is what made the same hotel behave differently there (2026-07-28).
  const fields = create.data;
  const r = await createReservation(deps.kv, user.ledgerId, fields, deps.ids, user.id);
  deps.onMutate?.(user, r.id);
  log.info("forwarded mail registered as a candidate", {
    userId: user.id,
    email_id: event.email_id,
    job_id: job.id,
    resvId: r.id,
    policyFromTemplate: fields.policy === "unknown" && r.policy !== "unknown",
  });
  return empty(200);
}

/** Plain text preferred; an HTML-only mail is stripped. Capped either way. */
function bodyText(mail: z.infer<typeof receivedEmailSchema>): string {
  const plain = (mail.text ?? "").trim();
  const text = plain !== "" ? plain : htmlToText(mail.html ?? "");
  return text.slice(0, MAX_BODY_CHARS);
}

/** Resend's Received-Emails read. null = the body could not be obtained. */
async function fetchReceivedEmail(
  emailId: string,
  apiKey: string,
  deps: EmailIntakeDeps,
): Promise<z.infer<typeof receivedEmailSchema> | null> {
  let res: Response;
  try {
    res = await deps.fetchFn(
      `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
      { headers: { "Authorization": `Bearer ${apiKey}` } },
    );
  } catch {
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return null;
  }
  const parsed = receivedEmailSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Tells the forwarder the mail was a dead end — LINE only, and only when they
 * linked an account. Delivery failure is logged, never propagated: the mail is
 * already accounted for and Resend must not retry it.
 */
async function notifyUnreadable(
  user: WebUser,
  subject: string | null,
  deps: EmailIntakeDeps,
  log: Log,
): Promise<void> {
  const line = deps.line;
  const lineUserId = user.lineUserId;
  if (line === undefined || lineUserId === null) {
    log.info("no LINE link; unreadable forward not notified", { userId: user.id });
    return;
  }
  try {
    await line.push(lineUserId, unreadableText(subject, deps.baseUrl));
  } catch (err) {
    log.warn("unreadable-forward push failed", { userId: user.id, err: String(err) });
  }
}

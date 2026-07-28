/**
 * LINE Bot webhook — text/image intake + Quick Reply one-tap resolution
 * (Task 6.2, SDD §5 / §7, ADR-9).
 *
 * Flow per event:
 *   - signature invalid            -> 401, nothing processed
 *   - sender resolution            -> the sender's LINE userId is looked up in
 *                        the per-user link index (`findUserByLineUserId`); the
 *                        resolved user's ledger is the ONLY one this event can
 *                        read or write. An unlinked sender can only complete a
 *                        link (by sending a code issued from the web app) —
 *                        nothing else is processed for them.
 *   - text matching a COMMAND      -> that command's WEB-ledger reply + the
 *                        command Quick Reply (only when `deps.web` is wired —
 *                        the table lives in web-commands.ts and is what the
 *                        LINE rich menu's buttons send)
 *   - short text matching none     -> the command list, NOT the parse pipeline
 *   - text/image message           -> common parse pipeline (runParseChain)
 *       parsed        -> reservation registered (WEB ledger when `deps.web` is
 *                        wired — LINE v2 #4 — else the core domain layer),
 *                        reply summary
 *       needs_review  -> FieldConflict: Quick Reply buttons (one tap, never retype —
 *                        SDD §5); missing fields: reply listing ONLY what is missing
 *       failed        -> reply "読み取れませんでした"
 *   - postback (conflict choice)   -> narrow that conflict to the chosen option;
 *                        when no conflict remains and validation passes, register
 *                        the reservation and mark the ParseJob resolved
 *
 * Resolution state lives in ParseJob.conflicts (a resolved conflict keeps only
 * its chosen option); attempts[] stays a frozen record (SDD §10.4 replay corpus).
 * Missing-field answers are NOT a stateful chat flow in this version: the user
 * re-sends the message including the missing info (new ParseJob).
 */
import type { ToolContext } from "../mcp/context.ts";
import {
  buildReservation,
  persistNewReservation,
  reservationInputSchema,
} from "../mcp/tools/shared.ts";
import type { ParseJob, Reservation } from "../core/schema/mod.ts";
import { missingFieldQuestions, runParseChain, validateParsedOutput } from "../parse/mod.ts";
import type { ParseInput, Parser, ParserChainConfig } from "../parse/mod.ts";
import { logger, newCorrelationId } from "../lib/log.ts";
import { verifyLineSignature } from "./signature.ts";
import { findUserByLineUserId, type WebUser } from "../web/users.ts";
import {
  applyWebPostback,
  buildCommandReply,
  buildUnknownCommandReply,
  type LineWebDeps,
  LINK_GUIDE_TEXT,
  looksLikeMistypedCommand,
  matchCommand,
  parseWebPostback,
  registerWebReservation,
  tryLinkFromMessage,
} from "./web-commands.ts";
import type {
  LineMessagingClient,
  LineQuickReplyItem,
  LineTextMessage,
  LineWebhookBody,
  LineWebhookEvent,
} from "./types.ts";

export interface LineWebhookDeps {
  channelSecret: string;
  /**
   * Private-beta gate (`LINE_ALLOWED_USER_IDS`). Per-user linking is the
   * authorization now, so this set can NEVER block a linked sender; a non-empty
   * set only restricts senders that are not linked YET — which is why the
   * public account keeps it empty (owner 2026-07-27): a non-empty set would
   * turn away every new person before they could send their link code.
   * Standalone mode (no `web`) has no link index, so there it still gates
   * everything, including its fail-closed empty case.
   */
  allowedUserIds: ReadonlySet<string>;
  ctx: ToolContext;
  parsers: Parser[];
  chainConfig: ParserChainConfig;
  client: LineMessagingClient;
  /**
   * Access to the WEB ledgers + the LINE link index (LINE v2 #2/#3). Optional:
   * without it 「確認」falls through to the parse pipeline exactly as before,
   * `webact|` postbacks are ignored, and the core ledger is the sink
   * (src/line/main.ts standalone).
   */
  web?: LineWebDeps;
  /** Sink for structured logs; defaults to console.log via logger(). */
  logWrite?: (line: string) => void;
}

/** The one ledger an event may touch: the sender's own (null = core sink). */
interface WebCtx {
  deps: LineWebDeps;
  user: WebUser;
}

export interface LineWebhookResult {
  status: number;
  /** One entry per processed event, for tests/observability. */
  handled: string[];
}

const POSTBACK_PREFIX = "resolve";

function chainIds(ctx: ToolContext) {
  return {
    ulid: () => ctx.ids.newUlid(),
    nowIso: () => ctx.clock.now().toString({ smallestUnit: "millisecond" }),
  };
}

/** Merges all non-null attempt outputs in chain order (later overrides earlier). */
function mergedOutput(job: ParseJob): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const attempt of job.attempts) {
    if (!attempt.output) continue;
    for (const [k, v] of Object.entries(attempt.output)) {
      if (v !== undefined && v !== null) merged[k] = v;
    }
  }
  return merged;
}

/** Applies every single-option (= resolved) conflict onto the merged output. */
function resolvedOutput(job: ParseJob): Record<string, unknown> {
  const output = mergedOutput(job);
  for (const conflict of job.conflicts) {
    const only = conflict.options.length === 1 ? conflict.options[0] : undefined;
    if (only !== undefined) output[conflict.field] = only.value;
  }
  return output;
}

function unresolvedConflicts(job: ParseJob) {
  return job.conflicts.filter((c) => c.options.length > 1);
}

/** Quick Reply message for the FIRST unresolved conflict (one tap per field). */
function conflictMessage(job: ParseJob): LineTextMessage | null {
  const conflict = unresolvedConflicts(job)[0];
  if (conflict === undefined) return null;
  const items: LineQuickReplyItem[] = conflict.options.map((option, idx) => {
    const label = String(option.value).slice(0, 20);
    return {
      type: "action",
      action: {
        type: "postback",
        label,
        data: `${POSTBACK_PREFIX}|${job.id}|${conflict.field}|${idx}`,
        displayText: label,
      },
    };
  });
  return {
    type: "text",
    text: `「${conflict.field}」の読み取りが食い違いました。正しい方を選んでください。`,
    quickReply: { items },
  };
}

function missingMessage(job: ParseJob): LineTextMessage {
  const questions = missingFieldQuestions(job);
  const list = questions.length > 0 ? questions.join(" / ") : "必須項目";
  return {
    type: "text",
    text: `次の項目が読み取れませんでした: ${list}。その情報を含めてもう一度送ってください。`,
  };
}

function summaryText(reservation: Reservation): string {
  const policyNote = reservation.cancellation_policy === "unknown"
    ? "（キャンセル規定は不明 — あとで set_policy で補完できます）"
    : "";
  return `登録しました: ${reservation.service_name} / ${reservation.starts_at}${policyNote}`;
}

/**
 * Outcome of registering a parse output: the reply message on success, or
 * `ok: false` when the output does not satisfy `reservationInputSchema`
 * (missing/invalid fields). A whole message rather than a string because the
 * web-ledger path may attach Quick Reply items to it (キャンセル規定の選択).
 */
type Registration = { ok: true; message: LineTextMessage } | { ok: false };

/**
 * Registers a validated parse output as a reservation (source: line).
 *
 * Sink selection (LINE v2 #4): with a resolved `web` context the reservation
 * lands in THAT SENDER'S WEB LEDGER as a candidate, so it shows up in the web
 * UI they actually use. Without it (standalone src/line/main.ts, MCP-local
 * mode) the core event-sourced ledger stays the sink, unchanged. Validation is
 * the same `reservationInputSchema` in both cases, so a parse output that is
 * too thin is rejected identically either way.
 */
async function registerOutput(
  deps: LineWebhookDeps,
  web: WebCtx | null,
  output: Record<string, unknown>,
  jobId: string,
): Promise<Registration> {
  const parsed = reservationInputSchema.safeParse({
    ...output,
    source: "line",
    raw_input_ref: jobId,
  });
  if (!parsed.success) return { ok: false };

  if (web !== null) {
    const registered = await registerWebReservation(web.deps, web.user, parsed.data);
    return { ok: true, message: registered.message };
  }

  const reservation = buildReservation(deps.ctx, parsed.data);
  const created = await persistNewReservation(deps.ctx, reservation);
  return { ok: true, message: { type: "text", text: summaryText(created) } };
}

export async function handleLineWebhook(
  rawBody: string,
  signature: string | null,
  deps: LineWebhookDeps,
): Promise<LineWebhookResult> {
  const log = logger("line.webhook", deps.logWrite !== undefined ? { write: deps.logWrite } : {});

  if (!(await verifyLineSignature(deps.channelSecret, rawBody, signature))) {
    log.warn("signature verification failed", {});
    return { status: 401, handled: [] };
  }

  let body: LineWebhookBody;
  try {
    body = JSON.parse(rawBody) as LineWebhookBody;
  } catch {
    return { status: 400, handled: [] };
  }

  const handled: string[] = [];
  for (const event of body.events ?? []) {
    const userId = event.source?.userId;
    if (userId === undefined) {
      handled.push("ignored:no-sender");
      continue;
    }
    // Per-user link = the authorization. In standalone mode (no `web`) there is
    // no link index, so the legacy allowlist stays the ONLY gate, including its
    // fail-closed empty case. With `web` wired it can only narrow who may
    // ATTEMPT a link — it never blocks a sender who is already linked.
    const sender = deps.web !== undefined ? await findUserByLineUserId(deps.web.kv, userId) : null;
    const gated = deps.web === undefined || deps.allowedUserIds.size > 0;
    if (sender === null && gated && !deps.allowedUserIds.has(userId)) {
      handled.push("ignored:not-allowed");
      continue;
    }
    const web: WebCtx | null = deps.web !== undefined && sender !== null
      ? { deps: deps.web, user: sender }
      : null;
    if (event.replyToken === undefined) {
      handled.push(`ignored:${event.type}`);
      continue;
    }
    // A wired web surface with an unresolved sender means "not linked yet":
    // the only thing such an event can do is complete the link.
    if (deps.web !== undefined && web === null) {
      handled.push(await handleUnlinked(event, deps, deps.web, userId, log));
    } else if (event.type === "message") {
      handled.push(await handleMessage(event, deps, web, log));
    } else if (event.type === "postback") {
      handled.push(await handlePostback(event, deps, web));
    } else {
      handled.push(`ignored:${event.type}`);
    }
  }
  return { status: 200, handled };
}

/**
 * Everything an unlinked LINE sender gets: a link when they send an
 * outstanding code, guidance otherwise. No ParseJob, no reservation, no
 * ledger read — an unknown sender must not be able to make the app do work.
 */
async function handleUnlinked(
  event: LineWebhookEvent,
  deps: LineWebhookDeps,
  web: LineWebDeps,
  lineUserId: string,
  log: ReturnType<typeof logger>,
): Promise<string> {
  const replyToken = event.replyToken as string;
  if (event.type !== "message" || event.message?.type !== "text") {
    await deps.client.reply(replyToken, [{ type: "text", text: LINK_GUIDE_TEXT }]);
    return "line:guide";
  }
  const attempt = await tryLinkFromMessage(web, lineUserId, event.message.text);
  // The web userId only: the LINE id is the messaging platform's identifier.
  if (attempt.kind === "linked") log.info("line link completed", { userId: attempt.user.id });
  await deps.client.reply(replyToken, [attempt.reply]);
  return `line:${attempt.kind}`;
}

async function handleMessage(
  event: LineWebhookEvent,
  deps: LineWebhookDeps,
  web: WebCtx | null,
  log: ReturnType<typeof logger>,
): Promise<string> {
  const replyToken = event.replyToken as string;
  const message = event.message;
  const correlation_id = newCorrelationId();

  // Commands take precedence over the parse pipeline, and short text that
  // matches none is answered with the command list rather than sent to the
  // parsers — a mistyped menu word must not dead-end in 「読み取れませんでした」.
  // Images and longer text keep going to the parse pipeline untouched.
  if (web !== null && message?.type === "text" && message.text !== undefined) {
    const command = matchCommand(message.text);
    if (command !== null) {
      await deps.client.reply(replyToken, [await buildCommandReply(web.deps, web.user, command)]);
      return `web:${command}`;
    }
    if (looksLikeMistypedCommand(message.text)) {
      await deps.client.reply(replyToken, [buildUnknownCommandReply()]);
      return "web:unknown-command";
    }
  }

  let input: ParseInput;
  if (message?.type === "text" && message.text !== undefined) {
    input = { type: "text", content: message.text, correlation_id };
  } else if (message?.type === "image" && message.id !== undefined) {
    const content = await deps.client.getMessageContent(message.id);
    input = {
      type: "image",
      content: `data:${content.mimeType};base64,${content.base64}`,
      correlation_id,
    };
  } else {
    return `ignored:message-${message?.type ?? "unknown"}`;
  }

  const job = await runParseChain(
    input,
    deps.chainConfig,
    deps.parsers,
    deps.ctx.clock,
    chainIds(deps.ctx),
  );
  await deps.ctx.store.putParseJob(job);
  log.info("parse job created", { job_id: job.id, status: job.status, correlation_id });

  if (job.status === "parsed") {
    const registered = await registerOutput(deps, web, resolvedOutput(job), job.id);
    if (registered.ok) {
      await deps.client.reply(replyToken, [registered.message]);
      return "registered";
    }
    await deps.client.reply(replyToken, [missingMessage(job)]);
    return "needs_review";
  }

  if (job.status === "needs_review") {
    const conflict = conflictMessage(job);
    await deps.client.reply(replyToken, [conflict ?? missingMessage(job)]);
    return "needs_review";
  }

  await deps.client.reply(replyToken, [{
    type: "text",
    text: "予約情報を読み取れませんでした。店名と日時がわかる形でもう一度送ってください。",
  }]);
  return "failed";
}

async function handlePostback(
  event: LineWebhookEvent,
  deps: LineWebhookDeps,
  web: WebCtx | null,
): Promise<string> {
  const replyToken = event.replyToken as string;
  const data = event.postback?.data ?? "";

  // Web-ledger action (LINE v2 #3) — a separate namespace from `resolve|`.
  const webAct = parseWebPostback(data);
  if (webAct !== null) {
    if (web === null) return "ignored:postback";
    // `web` はこのイベントの送信者本人の台帳。よその予約IDを載せた postback は
    // この台帳に無いIDとして落ちる（web-commands.ts の applyWebPostback）。
    const reply = await applyWebPostback(web.deps, web.user, webAct);
    await deps.client.reply(replyToken, [reply]);
    return `web:${webAct.action}`;
  }

  const parts = data.split("|");
  const [prefix, jobId, field, idxStr] = parts;
  if (prefix !== POSTBACK_PREFIX || jobId === undefined || field === undefined) {
    return "ignored:postback";
  }

  const job = await deps.ctx.store.getParseJob(jobId);
  if (job === null || job.status !== "needs_review") {
    await deps.client.reply(replyToken, [{
      type: "text",
      text: "この差し戻しは既に処理済みか、見つかりませんでした。",
    }]);
    return "postback:stale";
  }

  const idx = Number(idxStr);
  const conflicts = job.conflicts.map((c) => {
    if (c.field !== field) return c;
    const chosen = c.options[idx];
    return chosen === undefined ? c : { ...c, options: [chosen] };
  });
  let updated: ParseJob = { ...job, conflicts };

  if (unresolvedConflicts(updated).length > 0) {
    await deps.ctx.store.putParseJob(updated);
    const next = conflictMessage(updated) as LineTextMessage;
    await deps.client.reply(replyToken, [next]);
    return "postback:next-conflict";
  }

  const output = resolvedOutput(updated);
  const validation = validateParsedOutput(output, deps.ctx.clock);
  if (!validation.ok) {
    await deps.ctx.store.putParseJob(updated);
    await deps.client.reply(replyToken, [missingMessage(updated)]);
    return "postback:still-missing";
  }

  const registered = await registerOutput(deps, web, output, updated.id);
  if (!registered.ok) {
    await deps.ctx.store.putParseJob(updated);
    await deps.client.reply(replyToken, [missingMessage(updated)]);
    return "postback:invalid-output";
  }
  updated = { ...updated, status: "resolved" };
  await deps.ctx.store.putParseJob(updated);
  await deps.client.reply(replyToken, [registered.message]);
  return "postback:registered";
}

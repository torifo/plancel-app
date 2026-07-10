/**
 * LINE Bot webhook — text/image intake + Quick Reply one-tap resolution
 * (Task 6.2, SDD §5 / §7, ADR-9).
 *
 * Flow per event:
 *   - signature invalid            -> 401, nothing processed
 *   - sender not in allowlist      -> ignored (200; personal service, SDD §7)
 *   - text/image message           -> common parse pipeline (runParseChain)
 *       parsed        -> reservation registered via the domain layer, reply summary
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
import type {
  LineMessagingClient,
  LineQuickReplyItem,
  LineTextMessage,
  LineWebhookBody,
  LineWebhookEvent,
} from "./types.ts";

export interface LineWebhookDeps {
  channelSecret: string;
  /** LINE userIds allowed to use the bot (personal service — usually one). */
  allowedUserIds: ReadonlySet<string>;
  ctx: ToolContext;
  parsers: Parser[];
  chainConfig: ParserChainConfig;
  client: LineMessagingClient;
  /** Sink for structured logs; defaults to console.log via logger(). */
  logWrite?: (line: string) => void;
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

/** Registers a validated parse output as a reservation (source: line). */
async function registerOutput(
  ctx: ToolContext,
  output: Record<string, unknown>,
  jobId: string,
): Promise<Reservation | null> {
  const parsed = reservationInputSchema.safeParse({
    ...output,
    source: "line",
    raw_input_ref: jobId,
  });
  if (!parsed.success) return null;
  const reservation = buildReservation(ctx, parsed.data);
  return await persistNewReservation(ctx, reservation);
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
    if (userId === undefined || !deps.allowedUserIds.has(userId)) {
      handled.push("ignored:not-allowed");
      continue;
    }
    if (event.type === "message" && event.replyToken !== undefined) {
      handled.push(await handleMessage(event, deps, log));
    } else if (event.type === "postback" && event.replyToken !== undefined) {
      handled.push(await handlePostback(event, deps));
    } else {
      handled.push(`ignored:${event.type}`);
    }
  }
  return { status: 200, handled };
}

async function handleMessage(
  event: LineWebhookEvent,
  deps: LineWebhookDeps,
  log: ReturnType<typeof logger>,
): Promise<string> {
  const replyToken = event.replyToken as string;
  const message = event.message;
  const correlation_id = newCorrelationId();

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
    const reservation = await registerOutput(deps.ctx, resolvedOutput(job), job.id);
    if (reservation !== null) {
      await deps.client.reply(replyToken, [{ type: "text", text: summaryText(reservation) }]);
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
): Promise<string> {
  const replyToken = event.replyToken as string;
  const parts = (event.postback?.data ?? "").split("|");
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

  const reservation = await registerOutput(deps.ctx, output, updated.id);
  if (reservation === null) {
    await deps.ctx.store.putParseJob(updated);
    await deps.client.reply(replyToken, [missingMessage(updated)]);
    return "postback:invalid-output";
  }
  updated = { ...updated, status: "resolved" };
  await deps.ctx.store.putParseJob(updated);
  await deps.client.reply(replyToken, [{ type: "text", text: summaryText(reservation) }]);
  return "postback:registered";
}

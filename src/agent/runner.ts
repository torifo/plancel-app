/**
 * The cancellation concierge: observe the ledger, decide, act, with Gemini function calling.
 *
 * The model can read and it can propose; it cannot cancel. Every step it takes
 * (what it looked at, what it decided and why, what it recorded) is kept in the run,
 * which is what the UI shows as the decision log.
 */
import type { Clock } from "../core/clock/mod.ts";
import { hexEncode } from "../lib/encoding.ts";
import { logger } from "../lib/log.ts";
import { isFinished } from "../web/lifecycle.ts";
import { listReservations, type WebIds, type WebReservation } from "../web/store.ts";
import { listUsers, type WebUser } from "../web/users.ts";
import { jstOfEpoch } from "./loss.ts";
import {
  type GeminiContent,
  type GeminiPart,
  type GeminiTransport,
  GeminiTransportError,
} from "./gemini.ts";
import { acquireRunLock, listProposals, listRuns, putRun, releaseRunLock } from "./store.ts";
import { AGENT_TOOLS, type RunState, sanitizeArgs, toolByName, type ToolCtx } from "./tools.ts";
import type { Run, RunTrigger, Step } from "./types.ts";

const log = logger("agent.runner");

export const MAX_TOOL_CALLS = 8;
/** A scheduled run is skipped while the ledger is unchanged and the last run is newer than this. */
export const UNCHANGED_RECHECK_MS = 6 * 3_600_000;
export const SWEEP_MAX_USERS = 25;
const NOTIFICATION_MEMORY_MS = 24 * 3_600_000;

export const AGENT_SYSTEM_PROMPT =
  `あなたは予約台帳アプリ plancel の「キャンセル・コンシェルジュ」です。
ユーザーは外食・宿などを複数の候補で仮押さえし、1つに決めたら残りをキャンセルします。キャンセル料は期限を過ぎると段階的に上がるため、キャンセル忘れは実際の損失になります。あなたの仕事は、台帳を見張り、放置すると損をする予約を先回りして見つけ、ユーザーが判断するための材料を渡すことです。

進め方:
1. 観測: list_reservations で台帳を読む。必要なら get_reservation / estimate_loss で詳しく見る。
2. 判断: 次の2つを探す。
   a. 確定済み（confirmed）の予約と同じプラン、または同じ日の近い時間帯（conflictsWith）で重なっている、未確定の候補（candidate / to_cancel）。これはキャンセルすべき候補。
   b. 無料キャンセル期限（freeUntil）が48時間以内に迫っている予約（hoursToFreeUntil が 48 以下）。
3. 実行:
   - キャンセルすべき候補 → estimate_loss で損失を確認してから propose_cancellation。reason に根拠（どの確定済み予約と重なるか、いつまで無料か）を書き、draft_message に施設宛の丁寧なキャンセル連絡文を書く。
   - まだユーザーが選ぶ段階（確定済みが無く、候補が複数あって期限が迫る）→ notify_user で判断を促す。この場合はキャンセルを提案しない（どれを残すかはユーザーが決める）。

守ること:
- あなたはキャンセルを実行できない。propose_cancellation は提案を作るだけで、承認はユーザーが行う。
- 確定済み（confirmed）の予約をキャンセル提案しない。終わった予約・キャンセル済みの予約には何もしない。
- 日時・期限・金額は、ツールが返した値だけを使う。自分で計算し直さない。時刻は日本時間。
- すでに提案済み（pending）の予約を提案し直さない。同じ内容の通知を繰り返さない。
- ツール呼び出しは合計${MAX_TOOL_CALLS}回まで。互いに依存しない呼び出し（複数の estimate_loss など）は、1回の応答にまとめて出す。
- 最後に、何を見て、何を提案・通知したかを日本語3〜5文で報告する。対応が要らなければ「対応が必要な予約はありません」と書く。`;

export interface AgentDeps {
  kv: Deno.Kv;
  clock: Clock;
  ids: WebIds;
  transport: GeminiTransport;
}

export type RunOutcome =
  | { status: "ran"; run: Run }
  | { status: "skipped"; reason: "unchanged" | "nothing_to_watch" }
  | { status: "busy" };

const isLive = (r: WebReservation, nowMs: number) =>
  r.status !== "cancelled" && !isFinished(r, nowMs);

/** Identifies the ledger's content (not the time), so an unchanged ledger can be recognised. */
async function fingerprintOf(rows: WebReservation[]): Promise<string> {
  const text = rows.map((r) => `${r.id}:${r.status}:${r.updated_at}`).sort().join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hexEncode(new Uint8Array(digest)).slice(0, 16);
}

const clip = (s: string, n: number) => s.length > n ? s.slice(0, n) + "…" : s;

/** What a failed run says on screen: a reason a person can act on, not the provider's JSON. */
export function describeFailure(err: unknown): string {
  if (err instanceof GeminiTransportError) {
    if (err.status === 429) {
      return "Gemini の利用上限（429）に達しました。少し待ってから、もう一度実行してください。";
    }
    if (err.status >= 500) {
      return `Gemini が混み合っています（${err.status}）。少し待ってから、もう一度実行してください。`;
    }
    return `Gemini に受け付けられませんでした（${err.status}）。`;
  }
  return clip(String(err instanceof Error ? err.message : err).replace(/\s+/g, " "), 200);
}

function kickoff(
  nowMs: number,
  trigger: RunTrigger,
  state: RunState,
): string {
  const lines = [
    `現在: ${jstOfEpoch(nowMs)}（日本時間）`,
    trigger === "scheduler"
      ? "起動: 定期実行（ユーザーは見ていません）"
      : "起動: ユーザーが「今すぐ実行」を押しました",
  ];
  if (state.priorPending.length > 0) {
    lines.push(
      "承認待ちの提案（再提案しないこと）:",
      ...state.priorPending.map((p) => `- ${p.service}（${p.reservationId}）`),
    );
  }
  if (state.recentNotifications.length > 0) {
    lines.push(
      "24時間以内に通知済み（繰り返さないこと）:",
      ...state.recentNotifications.map((n) => `- ${n.title}`),
    );
  }
  lines.push("台帳を確認して、必要な対応を進めてください。");
  return lines.join("\n");
}

function emptyRun(
  deps: AgentDeps,
  user: WebUser,
  trigger: RunTrigger,
  fingerprint: string,
): Run {
  return {
    id: deps.ids.newId(),
    userId: user.id,
    trigger,
    startedAt: deps.ids.nowIso(),
    finishedAt: null,
    status: "ok",
    model: deps.transport.model,
    transport: deps.transport.name,
    steps: [],
    summary: null,
    error: null,
    toolCalls: 0,
    proposalIds: [],
    notifications: [],
    fingerprint,
    usage: null,
  };
}

/** Runs the agent once for one user. Never throws: a failure becomes a run with status "error". */
export async function runAgentForUser(
  deps: AgentDeps,
  user: WebUser,
  trigger: RunTrigger,
): Promise<RunOutcome> {
  const nowMs = deps.clock.now().epochMilliseconds;
  // One model for the whole conversation (see GeminiTransport.forRun).
  deps = { ...deps, transport: deps.transport.forRun?.() ?? deps.transport };
  const rows = await listReservations(deps.kv, user.ledgerId);
  const live = rows.filter((r) => isLive(r, nowMs));
  const fingerprint = await fingerprintOf(rows);

  if (trigger === "scheduler") {
    if (live.length === 0) return { status: "skipped", reason: "nothing_to_watch" };
    const [last] = await listRuns(deps.kv, user.id, 1);
    if (
      last !== undefined && last.status === "ok" && last.fingerprint === fingerprint &&
      nowMs - Temporal.Instant.from(last.startedAt).epochMilliseconds < UNCHANGED_RECHECK_MS
    ) return { status: "skipped", reason: "unchanged" };
  }

  const run = emptyRun(deps, user, trigger, fingerprint);
  if (!await acquireRunLock(deps.kv, user.id, run.id)) return { status: "busy" };
  try {
    if (live.length === 0) {
      // Nothing to watch: a manual run answers without spending a model call.
      run.steps.push({
        seq: 1,
        phase: "observe",
        at: deps.ids.nowIso(),
        tool: "list_reservations",
        args: null,
        result: "見張る予約がありません（候補・確定の予約が 0 件）",
      });
      run.summary = "見張る予約がありません。予約を登録すると、キャンセル期限の見守りを始めます。";
    } else {
      await converse(deps, user, run, trigger);
    }
  } catch (err) {
    run.status = "error";
    run.error = describeFailure(err);
    log.error("agent run failed", { userId: user.id, err: clip(String(err), 300) });
  } finally {
    run.finishedAt = deps.ids.nowIso();
    run.transport = deps.transport.name;
    run.model = deps.transport.model;
    await putRun(deps.kv, run);
    await releaseRunLock(deps.kv, user.id);
  }
  log.info("agent run", {
    userId: user.id,
    trigger,
    status: run.status,
    toolCalls: run.toolCalls,
    proposals: run.proposalIds.length,
    notifications: run.notifications.length,
  });
  return { status: "ran", run };
}

async function converse(
  deps: AgentDeps,
  user: WebUser,
  run: Run,
  trigger: RunTrigger,
): Promise<void> {
  const nowMs = deps.clock.now().epochMilliseconds;
  const priorPending = (await listProposals(deps.kv, user.id)).filter((p) =>
    p.status === "pending"
  );
  const recentNotifications = (await listRuns(deps.kv, user.id, 10))
    .flatMap((r) => r.notifications)
    .filter((n) => nowMs - Temporal.Instant.from(n.at).epochMilliseconds < NOTIFICATION_MEMORY_MS);
  const state: RunState = { proposals: [], notifications: [], priorPending, recentNotifications };
  const ctx: ToolCtx = {
    kv: deps.kv,
    user,
    ledger: user.ledgerId,
    clock: deps.clock,
    ids: deps.ids,
    runId: run.id,
    state,
  };
  const step = (s: Omit<Step, "seq" | "at">) =>
    run.steps.push({ seq: run.steps.length + 1, at: deps.ids.nowIso(), ...s });

  const contents: GeminiContent[] = [
    { role: "user", parts: [{ text: kickoff(nowMs, trigger, state) }] },
  ];
  const usage = { promptTokens: 0, outputTokens: 0 };
  let malformedRetried = false;

  try {
    for (let turn = 0; turn < MAX_TOOL_CALLS + 3; turn++) {
      const exhausted = run.toolCalls >= MAX_TOOL_CALLS;
      const res = await deps.transport.generate({
        systemInstruction: { parts: [{ text: AGENT_SYSTEM_PROMPT }] },
        contents,
        tools: [{ functionDeclarations: AGENT_TOOLS.map((t) => t.declaration) }],
        toolConfig: { functionCallingConfig: { mode: exhausted ? "NONE" : "AUTO" } },
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
      });
      usage.promptTokens += res.usageMetadata?.promptTokenCount ?? 0;
      usage.outputTokens += res.usageMetadata?.candidatesTokenCount ?? 0;

      const candidate = res.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      if (parts.length === 0) {
        const why = res.promptFeedback?.blockReason ?? candidate?.finishReason ?? "no content";
        // Gemini occasionally emits a function call it cannot serialise; one more ask is enough.
        if (why === "MALFORMED_FUNCTION_CALL" && !malformedRetried) {
          malformedRetried = true;
          continue;
        }
        throw new Error(`model returned no content (${why})`);
      }
      contents.push({ role: "model", parts });

      const text = parts.filter((p) => typeof p.text === "string" && p.thought !== true)
        .map((p) => p.text).join("").trim();
      const calls = parts.filter((p) => p.functionCall !== undefined);
      if (calls.length === 0) {
        run.summary = text === "" ? null : text;
        return;
      }
      if (text !== "") step({ phase: "decide", tool: null, args: null, result: clip(text, 500) });

      const answers: GeminiPart[] = [];
      for (const part of calls) {
        const call = part.functionCall!;
        const answer = (response: Record<string, unknown>): GeminiPart => ({
          functionResponse: {
            name: call.name,
            response,
            ...(call.id !== undefined ? { id: call.id } : {}),
          },
        });
        const tool = toolByName(call.name);
        if (tool === undefined) {
          answers.push(answer({ error: "unknown_tool" }));
          continue;
        }
        if (run.toolCalls >= MAX_TOOL_CALLS) {
          answers.push(
            answer({
              error: "tool_call_limit",
              hint: "もうツールは使えません。報告を書いてください。",
            }),
          );
          continue;
        }
        run.toolCalls += 1;
        if (tool.phase === "act") {
          const why = call.args?.reason ?? call.args?.body ?? call.args?.title;
          if (typeof why === "string") {
            step({ phase: "decide", tool: null, args: null, result: clip(why, 300) });
          }
        }
        const outcome = await tool.run(call.args ?? {}, ctx);
        step({
          phase: tool.phase,
          tool: call.name,
          args: sanitizeArgs(call.args),
          result: outcome.summary,
        });
        answers.push(answer(outcome.response));
      }
      contents.push({ role: "user", parts: answers });
    }
    run.summary = run.summary ?? "（報告が得られないまま、やり取りの上限に達しました）";
  } finally {
    run.proposalIds = state.proposals.map((p) => p.id);
    run.notifications = state.notifications;
    run.usage = usage;
  }
}

export interface SweepResult {
  userId: string;
  status: "ran" | "skipped" | "busy";
  runId?: string;
  runStatus?: Run["status"];
  proposals?: number;
  notifications?: number;
  reason?: string;
}

/** Cloud Scheduler's entry: every user in turn (sequentially, to stay inside the model quota). */
export async function runAgentSweep(
  deps: AgentDeps,
  opts: { maxUsers?: number } = {},
): Promise<SweepResult[]> {
  const users = (await listUsers(deps.kv)).slice(0, opts.maxUsers ?? SWEEP_MAX_USERS);
  const results: SweepResult[] = [];
  for (const user of users) {
    const o = await runAgentForUser(deps, user, "scheduler");
    results.push(
      o.status === "ran"
        ? {
          userId: user.id,
          status: "ran",
          runId: o.run.id,
          runStatus: o.run.status,
          proposals: o.run.proposalIds.length,
          notifications: o.run.notifications.length,
        }
        : {
          userId: user.id,
          status: o.status,
          ...(o.status === "skipped" ? { reason: o.reason } : {}),
        },
    );
  }
  return results;
}

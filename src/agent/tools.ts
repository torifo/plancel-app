/**
 * The agent's tools. Reads go through the remote MCP's presenter (JST, freeUntil); actions only
 * record a proposal or a notification. Nothing here cancels, confirms or deletes: that is the
 * person's (see approveProposal in routes.ts). Bad arguments answer {error}, never throw.
 */
import { z } from "zod";
import type { Clock } from "../core/clock/mod.ts";
import {
  type ApiReservation,
  listFilterSchema,
  presentList,
  presentReservation,
} from "../mcp/web_api_view.ts";
import { toInstantOrNull } from "../web/instant.ts";
import { isFinished } from "../web/lifecycle.ts";
import { getReservation, listReservations, type WebIds, webStatusSchema } from "../web/store.ts";
import type { WebReservation } from "../web/store.ts";
import type { WebUser } from "../web/users.ts";
import type { FunctionDeclaration } from "./gemini.ts";
import { estimateLoss, jstOfEpoch } from "./loss.ts";
import { putProposal } from "./store.ts";
import {
  type Notification,
  notificationLevelSchema,
  type Proposal,
  urgencySchema,
} from "./types.ts";

const HOUR_MS = 3_600_000;
/** Bookings this close in time are treated as competing for the same slot. */
const SAME_SLOT_MS = 3 * HOUR_MS;
/** The same notification (same reservations, same level) is not repeated inside this window. */
export const NOTIFY_DEDUPE_MS = 12 * HOUR_MS;
const MAX_PROPOSALS_PER_RUN = 5;
const MAX_NOTIFICATIONS_PER_RUN = 5;

export interface RunState {
  /** Created by this run. */
  proposals: Proposal[];
  notifications: Notification[];
  /** Carried in from earlier runs, for de-duplication. */
  priorPending: Proposal[];
  recentNotifications: Notification[];
}

export interface ToolCtx {
  kv: Deno.Kv;
  user: WebUser;
  ledger: string;
  clock: Clock;
  ids: WebIds;
  runId: string;
  state: RunState;
}

export interface ToolOutcome {
  /** What the model reads. */
  response: Record<string, unknown>;
  /** One short line for the decision log. */
  summary: string;
}

export interface AgentTool {
  phase: "observe" | "act";
  declaration: FunctionDeclaration;
  run(args: unknown, ctx: ToolCtx): Promise<ToolOutcome>;
}

const nowMsOf = (ctx: ToolCtx) => ctx.clock.now().epochMilliseconds;

const invalid = (issues: z.ZodIssue[]): ToolOutcome => ({
  response: {
    error: "invalid_args",
    issues: issues.map((i) => `${i.path.join(".")}: ${i.message}`),
  },
  summary: "引数が不正",
});

const isLive = (r: WebReservation, nowMs: number) =>
  r.status !== "cancelled" && !isFinished(r, nowMs);

/** Other live bookings the model should weigh against this one. */
function conflictsFor(r: WebReservation, rows: WebReservation[], nowMs: number) {
  const start = toInstantOrNull(r.startsAt)?.epochMilliseconds ?? null;
  const out: { id: string; service: string; status: string; why: "same_plan" | "same_slot" }[] = [];
  for (const o of rows) {
    if (o.id === r.id || !isLive(o, nowMs)) continue;
    const oStart = toInstantOrNull(o.startsAt)?.epochMilliseconds ?? null;
    const samePlan = r.plan !== null && o.plan === r.plan;
    const sameSlot = start !== null && oStart !== null && Math.abs(oStart - start) <= SAME_SLOT_MS;
    if (samePlan || sameSlot) {
      out.push({
        id: o.id,
        service: o.service,
        status: o.status,
        why: samePlan ? "same_plan" : "same_slot",
      });
    }
  }
  return out.slice(0, 6);
}

/** The MCP's model view of a reservation, plus what the agent decides on. */
function viewOf(r: WebReservation, rows: WebReservation[], nowMs: number) {
  const v = presentReservation(r as ApiReservation, nowMs);
  const freeAt = v.freeUntil === null ? null : toInstantOrNull(v.freeUntil)?.epochMilliseconds;
  return {
    ...v,
    hoursToFreeUntil: freeAt === null || freeAt === undefined
      ? null
      : Math.round(((freeAt - nowMs) / HOUR_MS) * 10) / 10,
    conflictsWith: conflictsFor(r, rows, nowMs),
  };
}

const listArgs = z.object({
  status: z.array(webStatusSchema).optional(),
  free_deadline_within_hours: z.number().min(0).max(24 * 60).optional(),
  limit: z.number().int().min(1).max(50).default(30),
});

const listReservationsTool: AgentTool = {
  phase: "observe",
  declaration: {
    name: "list_reservations",
    description:
      "ユーザーの予約台帳を読む。無料キャンセル期限が近い順。各予約に freeUntil（無料期限）、hoursToFreeUntil（期限までの時間。負なら期限切れ）、" +
      "nextCharge、conflictsWith（同じプラン・同じ時間帯の他の予約）が付く。終わった予約・キャンセル済みは既定で含まれない。",
    parameters: {
      type: "OBJECT",
      properties: {
        status: {
          type: "ARRAY",
          items: { type: "STRING", enum: ["candidate", "confirmed", "to_cancel", "cancelled"] },
          description: "この状態だけ。省略時は cancelled 以外",
        },
        free_deadline_within_hours: {
          type: "NUMBER",
          description: "無料期限が今からこの時間以内（期限切れを含む）の予約だけ",
        },
        limit: { type: "INTEGER", description: "最大件数（既定30）" },
      },
    },
  },
  async run(args, ctx) {
    const parsed = listArgs.safeParse(args ?? {});
    if (!parsed.success) return invalid(parsed.error.issues);
    const a = parsed.data;
    const nowMs = nowMsOf(ctx);
    const rows = await listReservations(ctx.kv, ctx.ledger);
    const filter = listFilterSchema.parse({
      ...(a.status !== undefined ? { status: a.status } : {}),
      sort: "deadline",
      limit: a.limit,
    });
    const list = presentList(rows as ApiReservation[], filter, nowMs);
    const byId = new Map(rows.map((r) => [r.id, r]));
    let reservations = list.reservations.map((v) => viewOf(byId.get(v.id)!, rows, nowMs));
    if (a.free_deadline_within_hours !== undefined) {
      const within = a.free_deadline_within_hours;
      reservations = reservations.filter((v) =>
        v.hoursToFreeUntil !== null && v.hoursToFreeUntil <= within
      );
    }
    return {
      response: {
        now: jstOfEpoch(nowMs),
        total: list.total,
        count: reservations.length,
        reservations,
      },
      summary: `${reservations.length}件を取得`,
    };
  },
};

const idArgs = z.object({ id: z.string().min(1) });

const getReservationTool: AgentTool = {
  phase: "observe",
  declaration: {
    name: "get_reservation",
    description: "1件の予約の詳細（規定の全文、同じプラン・同じ時間帯の他の予約）を読む。",
    parameters: {
      type: "OBJECT",
      properties: { id: { type: "STRING", description: "予約ID" } },
      required: ["id"],
    },
  },
  async run(args, ctx) {
    const parsed = idArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    const r = await getReservation(ctx.kv, ctx.ledger, parsed.data.id);
    if (r === null) return { response: { error: "not_found" }, summary: "見つからない" };
    const nowMs = nowMsOf(ctx);
    const rows = await listReservations(ctx.kv, ctx.ledger);
    return {
      response: { reservation: viewOf(r, rows, nowMs) },
      summary: `${r.service}（${r.status}）`,
    };
  },
};

const estimateLossTool: AgentTool = {
  phase: "observe",
  declaration: {
    name: "estimate_loss",
    description:
      "今キャンセルした場合のキャンセル料と、次に料率が上がる境界を過ぎた後の料率・金額・増える額を、台帳の規定から計算して返す。" +
      "金額は自分で計算せず、必ずこの値を使うこと。",
    parameters: {
      type: "OBJECT",
      properties: { id: { type: "STRING", description: "予約ID" } },
      required: ["id"],
    },
  },
  async run(args, ctx) {
    const parsed = idArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    const r = await getReservation(ctx.kv, ctx.ledger, parsed.data.id);
    if (r === null) return { response: { error: "not_found" }, summary: "見つからない" };
    const loss = estimateLoss(r, nowMsOf(ctx));
    const yen = (n: number | null) => n === null ? "不明" : `¥${n.toLocaleString("ja-JP")}`;
    return {
      response: { loss },
      summary: loss.policyKnown
        ? `今 ${yen(loss.now.yen)}${
          loss.next
            ? ` → ${loss.next.at.slice(5, 16).replace("T", " ")} 以降 ${yen(loss.next.yen)}`
            : ""
        }`
        : "規定不明",
    };
  },
};

const proposeArgs = z.object({
  reservation_id: z.string().min(1),
  reason: z.string().trim().min(1).max(400),
  draft_message: z.string().trim().min(1).max(1000),
  urgency: urgencySchema.default("normal"),
});

const proposeTool: AgentTool = {
  phase: "act",
  declaration: {
    name: "propose_cancellation",
    description:
      "未確定の予約（candidate か to_cancel）のキャンセルを「提案」する。これはキャンセルの実行ではない。ユーザーが承認するまで台帳は変わらない。" +
      "確定済み（confirmed）の予約には使えない。reason は判断の根拠（なぜこの予約をキャンセルすべきか。他の予約との関係と期限を含める）、" +
      "draft_message は施設に送る丁寧なキャンセル連絡文（日本語。ユーザーが自分で送る下書き）。",
    parameters: {
      type: "OBJECT",
      properties: {
        reservation_id: { type: "STRING", description: "キャンセルを提案する予約ID" },
        reason: { type: "STRING", description: "提案の根拠（日本語、1〜3文）" },
        draft_message: {
          type: "STRING",
          description: "施設宛てキャンセル連絡文の下書き（日本語）",
        },
        urgency: {
          type: "STRING",
          enum: ["low", "normal", "high"],
          description: "高=無料期限が24時間以内",
        },
      },
      required: ["reservation_id", "reason", "draft_message"],
    },
  },
  async run(args, ctx) {
    const parsed = proposeArgs.safeParse(args);
    if (!parsed.success) return invalid(parsed.error.issues);
    const a = parsed.data;
    const nowMs = nowMsOf(ctx);

    const r = await getReservation(ctx.kv, ctx.ledger, a.reservation_id);
    if (r === null) {
      return { response: { ok: false, error: "not_found" }, summary: "見つからない" };
    }
    if (r.status === "confirmed" || r.status === "cancelled" || isFinished(r, nowMs)) {
      const why = r.status === "confirmed"
        ? "confirmed_reservation_cannot_be_proposed"
        : r.status === "cancelled"
        ? "already_cancelled"
        : "already_finished";
      return {
        response: {
          ok: false,
          error: why,
          hint: "確定済み・キャンセル済み・終了済みの予約は提案できません。",
        },
        summary: `提案不可（${why}）`,
      };
    }
    const existing = [...ctx.state.priorPending, ...ctx.state.proposals].find((p) =>
      p.reservationId === r.id && p.status === "pending"
    );
    if (existing !== undefined) {
      return {
        response: { ok: true, duplicate: true, proposal_id: existing.id, status: "pending" },
        summary: `${r.service}: 提案済み（重複）`,
      };
    }
    if (ctx.state.proposals.length >= MAX_PROPOSALS_PER_RUN) {
      return { response: { ok: false, error: "limit_per_run" }, summary: "1回の上限" };
    }

    const loss = estimateLoss(r, nowMs);
    const proposal: Proposal = {
      id: ctx.ids.newId(),
      runId: ctx.runId,
      reservationId: r.id,
      service: r.service,
      startsAt: presentReservation(r as ApiReservation, nowMs).startsAt,
      reason: a.reason,
      draftMessage: a.draft_message,
      urgency: a.urgency,
      estimate: {
        pctNow: loss.now.pct,
        lossNowYen: loss.now.yen,
        lossAfterNextBoundaryYen: loss.next?.yen ?? null,
        nextBoundaryAt: loss.next?.at ?? null,
        freeUntil: loss.freeUntil,
      },
      status: "pending",
      createdAt: ctx.ids.nowIso(),
      decidedAt: null,
      outcome: null,
    };
    await putProposal(ctx.kv, ctx.user.id, proposal);
    ctx.state.proposals.push(proposal);
    return {
      response: {
        ok: true,
        proposal_id: proposal.id,
        status: "pending",
        note: "承認待ちです。キャンセルはまだ実行されていません。",
      },
      summary: `${r.service}のキャンセルを提案（承認待ち）`,
    };
  },
};

const notifyArgs = z.object({
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(600),
  level: notificationLevelSchema.default("info"),
  reservation_ids: z.array(z.string()).max(10).default([]),
});

const notifyKey = (n: { level: string; reservationIds: string[]; title: string }) =>
  n.reservationIds.length > 0
    ? `${n.level}|${[...n.reservationIds].sort().join(",")}`
    : `${n.level}|${n.title}`;

const notifyTool: AgentTool = {
  phase: "act",
  declaration: {
    name: "notify_user",
    description:
      "ユーザーに知らせる（判断を促す）。キャンセル提案ではなく、ユーザーが自分で決める段階（候補が複数で確定済みが無い等）で期限が迫っているときに使う。" +
      "この版では通知は台帳の記録に残るだけで、LINE やメールには送られない。",
    parameters: {
      type: "OBJECT",
      properties: {
        title: { type: "STRING", description: "見出し（日本語、短く）" },
        body: { type: "STRING", description: "本文（日本語。期限と、期限後の金額を含める）" },
        level: {
          type: "STRING",
          enum: ["info", "warning", "urgent"],
          description: "urgent=24時間以内",
        },
        reservation_ids: {
          type: "ARRAY",
          items: { type: "STRING" },
          description: "関係する予約ID",
        },
      },
      required: ["title", "body"],
    },
  },
  run(args, ctx) {
    const parsed = notifyArgs.safeParse(args);
    if (!parsed.success) return Promise.resolve(invalid(parsed.error.issues));
    const a = parsed.data;
    const nowMs = nowMsOf(ctx);
    const candidate = { level: a.level, reservationIds: a.reservation_ids, title: a.title };
    const key = notifyKey(candidate);
    const recent = [...ctx.state.recentNotifications, ...ctx.state.notifications].some((n) =>
      notifyKey(n) === key &&
      nowMs - Temporal.Instant.from(n.at).epochMilliseconds < NOTIFY_DEDUPE_MS
    );
    if (recent) {
      return Promise.resolve({
        response: { ok: true, duplicate: true },
        summary: "通知済み（重複）",
      });
    }
    if (ctx.state.notifications.length >= MAX_NOTIFICATIONS_PER_RUN) {
      return Promise.resolve({
        response: { ok: false, error: "limit_per_run" },
        summary: "1回の上限",
      });
    }
    const n: Notification = {
      id: ctx.ids.newId(),
      at: ctx.ids.nowIso(),
      level: a.level,
      title: a.title,
      body: a.body,
      reservationIds: a.reservation_ids,
    };
    ctx.state.notifications.push(n);
    return Promise.resolve({
      response: { ok: true, notification_id: n.id },
      summary: `通知: ${a.title}`,
    });
  },
};

export const AGENT_TOOLS: readonly AgentTool[] = [
  listReservationsTool,
  getReservationTool,
  estimateLossTool,
  proposeTool,
  notifyTool,
];

export const toolByName = (name: string): AgentTool | undefined =>
  AGENT_TOOLS.find((t) => t.declaration.name === name);

/** Arguments as they go in the decision log: strings clipped, structures flattened. */
export function sanitizeArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {}).slice(0, 12)) {
    if (typeof v === "string") out[k] = v.length > 240 ? v.slice(0, 240) + "…" : v;
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else out[k] = JSON.stringify(v).slice(0, 240);
  }
  return out;
}

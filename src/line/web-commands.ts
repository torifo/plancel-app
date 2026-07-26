/**
 * LINE ⇄ WEB ledger check / narrow update (LINE v2 #2 + #3).
 *
 * The owner reads and narrowly updates the WEB ledger (src/web/store.ts) from
 * LINE chat — NOT the core event-sourced ledger the parse pipeline writes to
 * (that split is LINE v2 #4, still open):
 *   - 「確認」/「予定」/「一覧」  → summary of upcoming reservations + Quick Reply
 *   - Quick Reply postback       → confirm / report-cancelled on the web ledger
 *
 * Business rules are NOT re-implemented here: `confirmReservation` /
 * `cancelReservation` from src/web/store.ts are the same functions the HTTP
 * API calls (so plan-sibling auto to_cancel stays in one place), and
 * `onMutate` is the same post-write hook that kicks the Google Calendar sync.
 * Display math reuses `freeDeadlineMs` / `maxLossYen` from src/web/notify.ts,
 * which mirror web/index.html.
 *
 * The owner's ledger is resolved by email (PLANCEL_LINE_OWNER_EMAIL, default =
 * first PLANCEL_ADMIN_EMAILS) exactly like the deadline reminders. No direct
 * system-clock reads — "now" is injected via `nowMs` (FR-008).
 */
import {
  cancelReservation,
  confirmReservation,
  getReservation,
  listReservations,
  type WebIds,
  type WebReservation,
} from "../web/store.ts";
import { findUserByEmail, type WebUser } from "../web/users.ts";
import { freeDeadlineMs, maxLossYen } from "../web/notify.ts";
import type { LineQuickReplyItem, LineTextMessage } from "./types.ts";

/** Access to the owner's WEB ledger, injected into the webhook (optional). */
export interface LineWebDeps {
  kv: Deno.Kv;
  /** The web account whose ledger LINE speaks for (matched case-insensitively). */
  ownerEmail: string;
  ids: WebIds;
  /** Snapshot source for "now" (epoch ms) — injected via the Clock (FR-008). */
  nowMs(): number;
  /** Same post-mutation hook the web API passes (Google Calendar sync). */
  onMutate?: (user: WebUser, resvId: string) => void;
}

/** Postback namespace for web-ledger actions (`resolve|` stays parse-only). */
export const WEB_POSTBACK_PREFIX = "webact";

const CHECK_COMMANDS: ReadonlySet<string> = new Set(["確認", "予定", "一覧"]);

/** True when the text is exactly one of the check commands (trimmed). */
export function isCheckCommand(text: string): boolean {
  return CHECK_COMMANDS.has(text.trim());
}

export type WebAction = "confirm" | "cancel";

/** Parses `webact|<action>|<id>`; null when this is not a web-ledger postback. */
export function parseWebPostback(data: string): { action: WebAction; id: string } | null {
  const [prefix, action, id] = data.split("|");
  if (prefix !== WEB_POSTBACK_PREFIX || id === undefined || id === "") return null;
  if (action !== "confirm" && action !== "cancel") return null;
  return { action, id };
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TOKYO_OFFSET = "+09:00";
const MAX_LINES = 10;
/** LINE allows at most 13 Quick Reply items per message. */
const MAX_QUICK_REPLY = 13;
/** LINE truncates Quick Reply labels past 20 chars. */
const MAX_LABEL = 20;
const MAX_NAME = 14;

const STATUS_LABEL: Record<string, string> = {
  candidate: "候補",
  confirmed: "確定",
  to_cancel: "要キャンセル",
  cancelled: "キャンセル済み",
};

/** `8/22(土)` in JST. */
function fmtMd(ms: number): string {
  const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(TOKYO_OFFSET);
  const dow = "日月火水木金土"[z.dayOfWeek % 7];
  return `${z.month}/${z.day}(${dow})`;
}

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

function startMs(r: WebReservation): number {
  return Temporal.Instant.from(r.startsAt).epochMilliseconds;
}

/** `◆8/15まで¥0` / `規定不明` / `いつでも無料` — the per-line deadline hint. */
function deadlineNote(r: WebReservation): string {
  if (r.policy === "unknown") return "規定不明";
  const deadlineMs = freeDeadlineMs(r.policy, r.startsAt);
  if (deadlineMs === null) return "いつでも無料";
  return `◆${fmtMd(deadlineMs)}まで¥0`;
}

function line(r: WebReservation): string {
  const status = STATUS_LABEL[r.status] ?? r.status;
  return `${fmtMd(startMs(r))} ${r.service} [${status}] ${deadlineNote(r)}`;
}

function quickReplyItems(active: WebReservation[]): LineQuickReplyItem[] {
  const items: LineQuickReplyItem[] = [];
  for (const r of active) {
    if (items.length >= MAX_QUICK_REPLY) break;
    const action: WebAction | null = r.status === "candidate"
      ? "confirm"
      : (r.status === "to_cancel" || r.status === "confirmed" ? "cancel" : null);
    if (action === null) continue;
    const prefix = action === "confirm" ? "確定:" : "済:";
    const label = `${prefix}${r.service.slice(0, MAX_NAME)}`.slice(0, MAX_LABEL);
    items.push({
      type: "action",
      action: {
        type: "postback",
        label,
        data: `${WEB_POSTBACK_PREFIX}|${action}|${r.id}`,
        displayText: label,
      },
    });
  }
  return items;
}

function footer(active: WebReservation[], nowMs: number): string {
  const deadlines = active
    .map((r) => freeDeadlineMs(r.policy, r.startsAt))
    .filter((d): d is number => d !== null && d > nowMs)
    .sort((a, b) => a - b);
  const next = deadlines[0];
  const nextPart = next === undefined
    ? "◆差し迫った締切なし"
    : `◆次の締切 ${fmtMd(next)}（あと${Math.max(1, Math.ceil((next - nowMs) / DAY_MS))}日）`;
  const loss = active.reduce((sum, r) => sum + maxLossYen(r.policy, r.amount), 0);
  return `${nextPart} / 放置損失 ${yen(loss)}`;
}

const text = (t: string): LineTextMessage => ({ type: "text", text: t });

/** Summary of the owner's active web-ledger reservations + action Quick Reply. */
export async function buildCheckReply(deps: LineWebDeps): Promise<LineTextMessage> {
  const owner = await findUserByEmail(deps.kv, deps.ownerEmail);
  if (owner === null) {
    return text("LINEに紐づくWeb台帳のアカウントが見つかりませんでした。先にWebでログインしてください。");
  }
  const all = await listReservations(deps.kv, owner.ledgerId);
  const active = all.filter((r) => r.status !== "cancelled");
  if (active.length === 0) {
    return text("Web台帳に予約はまだありません。予約メールやスクショを送れば登録できます。");
  }

  const shown = active.slice(0, MAX_LINES);
  const body = shown.map(line);
  if (active.length > shown.length) body.push(`…ほか${active.length - shown.length}件`);
  const message = text(
    [`Web台帳の予約 ${active.length}件`, ...body, "", footer(active, deps.nowMs())].join("\n"),
  );
  const items = quickReplyItems(active);
  return items.length > 0 ? { ...message, quickReply: { items } } : message;
}

const STALE = "この予約は見つかりませんでした。すでに処理済みかもしれません。「確認」で最新の一覧を出せます。";

/**
 * Applies a Quick Reply action to the owner's web ledger through the SAME
 * store functions the HTTP API uses, then fires `onMutate` for the acted
 * reservation only (mirroring the API, which syncs the acted id).
 */
export async function applyWebAction(
  deps: LineWebDeps,
  action: WebAction,
  id: string,
): Promise<LineTextMessage> {
  const owner = await findUserByEmail(deps.kv, deps.ownerEmail);
  if (owner === null) return text(STALE);
  const ledger = owner.ledgerId;
  const before = await getReservation(deps.kv, ledger, id);
  if (before === null) return text(STALE);

  if (action === "cancel") {
    const r = await cancelReservation(deps.kv, ledger, id, deps.ids);
    if (r === null) return text(STALE);
    deps.onMutate?.(owner, id);
    return text(`キャンセル済みにしました: ${r.service}。「確認」で一覧`);
  }

  // Count the plan siblings settleSiblings() is about to flip, before the write.
  const siblings = before.plan === null ? 0 : (await listReservations(deps.kv, ledger)).filter(
    (r) => r.id !== id && r.plan === before.plan && r.status === "candidate",
  ).length;
  const r = await confirmReservation(deps.kv, ledger, id, deps.ids);
  if (r === null) return text(STALE);
  deps.onMutate?.(owner, id);
  const note = siblings > 0 ? ` — 同プランの残り${siblings}件を要キャンセルにしました。` : "";
  return text(`確定しました: ${r.service}${note}「確認」で一覧`);
}

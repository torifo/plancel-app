/**
 * LINE ⇄ WEB ledger check / narrow update / add (LINE v2 #2 + #3 + #4).
 *
 * Each user reads, adds to, and narrowly updates their OWN WEB ledger
 * (src/web/store.ts) from LINE chat — the core event-sourced ledger is only the
 * standalone/MCP-local sink now (LINE v2 #4, closed):
 *   - a COMMAND word (`COMMANDS` below) → its own reply + the command Quick Reply
 *   - Quick Reply postback              → confirm / report-cancelled on the web ledger
 *   - parsed reservation                → created as a web-ledger candidate
 *
 * The command table is the rich menu's contract (owner 2026-07-28): a rich-menu
 * button can only send a fixed text or open a URL, so every word the menu sends
 * must resolve to a row here — anything that falls through to the AI parse
 * pipeline comes back as 「読み取れませんでした」, which is a dead end for a button.
 *
 * Business rules are NOT re-implemented here: `confirmReservation` /
 * `cancelReservation` from src/web/store.ts are the same functions the HTTP
 * API calls (so plan-sibling auto to_cancel stays in one place), and
 * `onMutate` is the same post-write hook that kicks the Google Calendar sync.
 * Display math and the parsed-policy conversion reuse src/web/policy.ts — the
 * single source the web UI mirrors.
 *
 * WHOSE ledger (owner 2026-07-27): every function here takes the ledger owner
 * as an argument — the webhook resolves it from the SENDER'S LINE link
 * (`findUserByLineUserId`), so nothing here can reach another user's ledger.
 * One person may own several accounts, so every reply names the account it
 * acted on. No direct system-clock reads — "now" is injected via `nowMs`
 * (FR-008).
 */
import {
  cancelReservation,
  confirmReservation,
  createReservation,
  getReservation,
  listReservations,
  type WebReservation,
  WebTransitionError,
} from "../web/store.ts";
import type { CancellationPolicyOrUnknown } from "../core/schema/mod.ts";
import {
  type AuthIds,
  consumeLineLinkCode,
  getUser,
  LINE_CODE_TTL_MS,
  linkLineUser,
  looksLikeLineLinkCode,
  type WebUser,
} from "../web/users.ts";
import { freeDeadlineMs, fromCoreStages, isAlwaysFree, maxLossYen } from "../web/policy.ts";
import type { LineQuickReplyItem, LineTextMessage } from "./types.ts";

/** Access to the WEB ledgers, injected into the webhook (optional). */
export interface LineWebDeps {
  kv: Deno.Kv;
  /** AuthIds (not just WebIds): linking writes user records, like /auth/* does. */
  ids: AuthIds;
  /** Snapshot source for "now" (epoch ms) — injected via the Clock (FR-008). */
  nowMs(): number;
  /** Same post-mutation hook the web API passes (Google Calendar sync). */
  onMutate?: (user: WebUser, resvId: string) => void;
}

/**
 * How a reply names the ledger it acted on. One person may own several
 * accounts, so a bare 「登録しました」 would be ambiguous.
 */
export function accountLabel(user: WebUser): string {
  if (user.uid !== null) return `@${user.uid}`;
  return user.displayName ?? user.email;
}

/** Postback namespace for web-ledger actions (`resolve|` stays parse-only). */
export const WEB_POSTBACK_PREFIX = "webact";

/**
 * Production URL, hard-coded on purpose: a LINE reply has to be actionable on
 * its own, and the webhook has no request origin to derive it from. The `#…`
 * fragment names the screen that answers the reply, so a link never points at
 * the bare origin (web/index.html has yet to route them — see ROADMAP).
 */
const APP_URL = "https://plancel-app.torifo.deno.net";
const APP_IMPORT_URL = `${APP_URL}/#import`;
const APP_LINK_URL = `${APP_URL}/#link`;
const APP_HELP_URL = `${APP_URL}/#help`;
const CODE_MINUTES = LINE_CODE_TTL_MS / 60_000;

// ---- Command table (rich menu, owner 2026-07-28) ----
//
// A rich-menu button can only send a fixed text or open a URL, so every menu
// word has to resolve here — a menu button that falls through to the parse
// pipeline is a dead end. One row per trigger; adding a command is one line.

export type LineCommand = "check" | "help" | "link" | "deadline" | "today" | "week";

/** Keys are pre-normalized (`normalizeCommand`): NFKC, trimmed, lower-cased. */
const COMMANDS: ReadonlyMap<string, LineCommand> = new Map<string, LineCommand>([
  ["確認", "check"],
  ["予定", "check"],
  ["一覧", "check"],
  ["使い方", "help"],
  ["ヘルプ", "help"],
  ["help", "help"],
  ["連携", "link"],
  ["設定", "link"],
  ["締切", "deadline"],
  ["期限", "deadline"],
  ["今日", "today"],
  ["今週", "week"],
]);

/**
 * NFKC folds the full-width forms a phone keyboard produces (ＨＥＬＰ, ﾍﾙﾌﾟ,
 * U+3000) onto the table's keys; lower-casing only affects ASCII triggers.
 */
export function normalizeCommand(text: string): string {
  return text.normalize("NFKC").trim().toLowerCase();
}

/** The command this text names, or null when it names none. */
export function matchCommand(text: string): LineCommand | null {
  return COMMANDS.get(normalizeCommand(text)) ?? null;
}

/**
 * Longest text still read as a mistyped/unknown COMMAND rather than as parse
 * input. Real intake is a mail body or a screenshot caption and runs far
 * longer, so text this short that matches no command is almost always a menu
 * word — answering it with the command list beats a dead-end
 * 「読み取れませんでした」. The cost of the cut-off is that a genuinely terse
 * one-liner (「8/1 19時 宿A」= 11字) never reaches the parsers, which is why
 * the bar sits well below a realistic 予約メール line.
 */
export const MAX_COMMAND_GUESS_CHARS = 12;

/** True when an unmatched text is short enough to answer with the command list. */
export function looksLikeMistypedCommand(text: string): boolean {
  const normalized = normalizeCommand(text);
  return normalized.length > 0 && normalized.length <= MAX_COMMAND_GUESS_CHARS;
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

/** `8/22(土) 15:00` in JST. */
function fmtMdHm(ms: number): string {
  const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(TOKYO_OFFSET);
  const hh = String(z.hour).padStart(2, "0");
  const mm = String(z.minute).padStart(2, "0");
  return `${fmtMd(ms)} ${hh}:${mm}`;
}

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

function startMs(r: WebReservation): number {
  return Temporal.Instant.from(r.startsAt).epochMilliseconds;
}

/** `◆8/15まで¥0` / `規定不明` / `いつでも無料` — the per-line deadline hint. */
function deadlineNote(r: WebReservation): string {
  if (r.policy === "unknown") return "規定不明";
  if (isAlwaysFree(r.policy)) return "いつでも無料";
  const deadlineMs = freeDeadlineMs(r.policy, r.startsAt);
  // A custom policy can be paid from the outset — there is no free window to
  // count down to, which is NOT the same as always-free.
  if (deadlineMs === null) return "無料期間なし";
  return `◆${fmtMd(deadlineMs)}まで¥0`;
}

function line(r: WebReservation): string {
  const status = STATUS_LABEL[r.status] ?? r.status;
  return `${fmtMd(startMs(r))} ${r.service} [${status}] ${deadlineNote(r)}`;
}

/**
 * The commands worth one tap. Every entry's label IS its trigger, so a tap
 * sends the same text a rich-menu button sends and takes the same path.
 */
const COMMAND_MENU: readonly { command: LineCommand; label: string }[] = [
  { command: "check", label: "確認" },
  { command: "deadline", label: "締切" },
  { command: "today", label: "今日" },
  { command: "week", label: "今週" },
  { command: "help", label: "使い方" },
];

/** The menu minus the command that produced this reply. */
function commandQuickReplies(self: LineCommand | null): LineQuickReplyItem[] {
  return COMMAND_MENU.filter((e) => e.command !== self).map((e) => ({
    type: "action",
    action: { type: "message", label: e.label.slice(0, MAX_LABEL), text: e.label },
  }));
}

/**
 * Every command reply carries the menu, so the chat stays navigable even
 * without the rich menu. `lead` (per-reservation actions) comes first and the
 * whole strip is capped at what LINE accepts.
 */
function withMenu(
  message: LineTextMessage,
  self: LineCommand | null,
  lead: LineQuickReplyItem[] = [],
): LineTextMessage {
  const items = [...lead, ...commandQuickReplies(self)].slice(0, MAX_QUICK_REPLY);
  return { ...message, quickReply: { items } };
}

function quickReplyItems(active: WebReservation[], limit: number): LineQuickReplyItem[] {
  const items: LineQuickReplyItem[] = [];
  for (const r of active) {
    if (items.length >= limit) break;
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

/** THIS user's active reservations, cancelled ones dropped. */
async function activeOf(deps: LineWebDeps, owner: WebUser): Promise<WebReservation[]> {
  const all = await listReservations(deps.kv, owner.ledgerId);
  return all.filter((r) => r.status !== "cancelled");
}

/** Summary of THIS user's active web-ledger reservations + action Quick Reply. */
export async function buildCheckReply(
  deps: LineWebDeps,
  owner: WebUser,
): Promise<LineTextMessage> {
  const label = accountLabel(owner);
  const active = await activeOf(deps, owner);
  if (active.length === 0) {
    return withMenu(
      text(
        `${label} のWeb台帳に予約はまだありません。予約メールやスクショを送れば登録できます。`,
      ),
      "check",
    );
  }

  const shown = active.slice(0, MAX_LINES);
  const body = shown.map(line);
  if (active.length > shown.length) body.push(`…ほか${active.length - shown.length}件`);
  const message = text(
    [`${label} のWeb台帳の予約 ${active.length}件`, ...body, "", footer(active, deps.nowMs())]
      .join("\n"),
  );
  // Per-reservation actions never crowd the command menu out of the strip.
  const items = quickReplyItems(active, MAX_QUICK_REPLY - COMMAND_MENU.length);
  return withMenu(message, "check", items);
}

// ---- The other menu commands (owner 2026-07-28) ----

/** Free-cancel deadlines are only news while they are still ahead of us. */
const DEADLINE_WINDOW_DAYS = 7;

/** What is on the table once the free window closes. */
function stakeNote(r: WebReservation): string {
  if (r.amount === null) return "金額未登録";
  return `過ぎると最大${yen(maxLossYen(r.policy, r.amount))}`;
}

/** Upcoming free-cancel deadlines, soonest first (already past ones dropped). */
function upcomingDeadlines(
  active: WebReservation[],
  nowMs: number,
): { r: WebReservation; at: number }[] {
  return active
    .map((r) => ({ r, at: freeDeadlineMs(r.policy, r.startsAt) }))
    .filter((d): d is { r: WebReservation; at: number } => d.at !== null && d.at > nowMs)
    .sort((a, b) => a.at - b.at);
}

/** 「締切」/「期限」 — what stops being free within a week. */
export async function buildDeadlineReply(
  deps: LineWebDeps,
  owner: WebUser,
): Promise<LineTextMessage> {
  const label = accountLabel(owner);
  const now = deps.nowMs();
  const all = upcomingDeadlines(await activeOf(deps, owner), now);
  const soon = all.filter((d) => d.at <= now + DEADLINE_WINDOW_DAYS * DAY_MS);

  if (soon.length === 0) {
    const next = all[0];
    const tail = next === undefined
      ? "この先に期限が決まっている予約もありません。"
      : `次の期限は ${fmtMd(next.at)}「${next.r.service}」です。`;
    return withMenu(
      text(`${label} に${DEADLINE_WINDOW_DAYS}日以内の無料キャンセル期限はありません。\n${tail}`),
      "deadline",
    );
  }

  const shown = soon.slice(0, MAX_LINES);
  const body = shown.map((d) => `${fmtMd(d.at)} ${d.r.service} — ${stakeNote(d.r)}`);
  if (soon.length > shown.length) body.push(`…ほか${soon.length - shown.length}件`);
  return withMenu(
    text([
      `${label} の無料キャンセル期限（${DEADLINE_WINDOW_DAYS}日以内）${soon.length}件`,
      ...body,
      "無料のうちに、確定かキャンセルを決めてください。",
    ].join("\n")),
    "deadline",
  );
}

/** JST calendar-day start of the day containing `ms` — 「今日」 is a JST day. */
function jstDayStartMs(ms: number): number {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(TOKYO_OFFSET)
    .startOfDay()
    .epochMilliseconds;
}

/** 「今日」/「今週」 — what is starting, as opposed to the full 「確認」 list. */
export async function buildUpcomingReply(
  deps: LineWebDeps,
  owner: WebUser,
  span: "today" | "week",
): Promise<LineTextMessage> {
  const label = accountLabel(owner);
  const days = span === "today" ? 1 : DEADLINE_WINDOW_DAYS;
  const from = jstDayStartMs(deps.nowMs());
  const until = from + days * DAY_MS;
  const window = span === "today" ? "今日" : "これから7日間";

  const inWindow = (await activeOf(deps, owner))
    .filter((r) => startMs(r) >= from && startMs(r) < until)
    .sort((a, b) => startMs(a) - startMs(b));
  if (inWindow.length === 0) {
    return withMenu(text(`${label} に${window}の予定はありません。`), span);
  }

  const shown = inWindow.slice(0, MAX_LINES);
  const body = shown.map((r) =>
    `${fmtMdHm(startMs(r))} ${r.service} [${STATUS_LABEL[r.status] ?? r.status}]`
  );
  if (inWindow.length > shown.length) body.push(`…ほか${inWindow.length - shown.length}件`);
  return withMenu(
    text([`${label} の${window}の予定 ${inWindow.length}件`, ...body].join("\n")),
    span,
  );
}

/** 「使い方」/「ヘルプ」 — short enough to read in a chat bubble. */
export function buildHelpReply(): LineTextMessage {
  return withMenu(
    text([
      "plancel は予約のキャンセル期限を見張って、無料のうちに知らせるサービスです。",
      "使えるコマンド",
      "・確認：予約の一覧と次の締切",
      "・締切：7日以内に無料キャンセル期限が切れる予約",
      "・今日／今週：これから始まる予定",
      "・連携：このトークがつながっているアカウント",
      "予約の追加は、予約確認メールの本文かスクショをこのトークにそのまま送ってください。",
      `サイト: ${APP_HELP_URL}`,
    ].join("\n")),
    "help",
  );
}

/** 「連携」/「設定」 — which account this chat is bound to, and how to undo it. */
export function buildLinkReply(owner: WebUser): LineTextMessage {
  return withMenu(
    text([
      `このトークは ${accountLabel(owner)} のWeb台帳につながっています。`,
      `解除するときは ${APP_LINK_URL} の「LINE連携」から行えます。`,
    ].join("\n")),
    "link",
  );
}

/** The dead-end replacement: short text that matched no command. */
export function buildUnknownCommandReply(): LineTextMessage {
  return withMenu(
    text([
      "コマンドとして読み取れませんでした。使えるのは次のとおりです。",
      "確認／締切／今日／今週／連携／使い方",
      `予約の追加は、予約確認メールの本文かスクショをそのまま送ってください（Webからは ${APP_IMPORT_URL}）。`,
    ].join("\n")),
    null,
  );
}

/** The one dispatcher — the webhook never branches on a command itself. */
export function buildCommandReply(
  deps: LineWebDeps,
  owner: WebUser,
  command: LineCommand,
): Promise<LineTextMessage> {
  switch (command) {
    case "check":
      return buildCheckReply(deps, owner);
    case "deadline":
      return buildDeadlineReply(deps, owner);
    case "today":
    case "week":
      return buildUpcomingReply(deps, owner, command);
    case "help":
      return Promise.resolve(buildHelpReply());
    case "link":
      return Promise.resolve(buildLinkReply(owner));
  }
}

const STALE =
  "この予約は見つかりませんでした。すでに処理済みかもしれません。「確認」で最新の一覧を出せます。";

/**
 * Applies a Quick Reply action to THIS user's web ledger through the SAME
 * store functions the HTTP API uses, then fires `onMutate` for the acted
 * reservation only (mirroring the API, which syncs the acted id).
 *
 * The id is read from postback data, i.e. from the client — it is only ever
 * looked up inside `owner`'s ledger, so a stale or foreign id resolves to
 * nothing instead of mutating someone else's reservation.
 */
export async function applyWebAction(
  deps: LineWebDeps,
  owner: WebUser,
  action: WebAction,
  id: string,
): Promise<LineTextMessage> {
  const ledger = owner.ledgerId;
  const label = accountLabel(owner);
  const before = await getReservation(deps.kv, ledger, id);
  if (before === null) return text(STALE);

  if (action === "cancel") {
    const r = await cancelReservation(deps.kv, ledger, id, deps.ids);
    if (r === null) return text(STALE);
    deps.onMutate?.(owner, id);
    return text(`キャンセル済みにしました: ${r.service}（${label}）。「確認」で一覧`);
  }

  // Count the plan siblings settleSiblings() is about to flip, before the write.
  const siblings = before.plan === null ? 0 : (await listReservations(deps.kv, ledger)).filter(
    (r) => r.id !== id && r.plan === before.plan && r.status === "candidate",
  ).length;
  let r;
  try {
    r = await confirmReservation(deps.kv, ledger, id, deps.ids);
  } catch (error) {
    if (error instanceof WebTransitionError) {
      return text("この予約は現在の状態から確定できません。「確認」で最新の一覧を出せます。");
    }
    throw error;
  }
  if (r === null) return text(STALE);
  deps.onMutate?.(owner, id);
  const note = siblings > 0 ? ` — 同プランの残り${siblings}件を要キャンセルにしました。` : "";
  return text(`確定しました: ${r.service}（${label}）${note}「確認」で一覧`);
}

// ---- Registration into the web ledger (LINE v2 #4) ----

/**
 * The parse-chain output fields a web reservation needs. A subset of the core
 * `Reservation` shape (src/core/schema) so this module keeps depending on the
 * schema layer only — never on the MCP tool layer.
 */
export interface WebRegistrationInput {
  service_name: string;
  starts_at: string;
  amount_jpy?: number | null;
  location?: string | null;
  cancellation_policy?: CancellationPolicyOrUnknown;
}

/**
 * Registers a parsed reservation as a CANDIDATE in THIS user's web ledger,
 * through the same `createReservation` the HTTP API calls (and firing the same
 * `onMutate` hook it fires on create, unconditionally — the sync itself decides
 * what a candidate means).
 */
export async function registerWebReservation(
  deps: LineWebDeps,
  owner: WebUser,
  output: WebRegistrationInput,
): Promise<{ id: string; summaryText: string }> {
  // Arbitrary parsed stages are preserved as-is (src/web/policy.ts); only a
  // policy with no % expression at all stays "unknown" for the owner to fill in.
  const policy = fromCoreStages(output.cancellation_policy);
  const r = await createReservation(deps.kv, owner.ledgerId, {
    plan: null,
    service: output.service_name,
    startsAt: output.starts_at,
    amount: output.amount_jpy ?? null,
    location: output.location ?? null,
    policy,
    // LINE additions are candidates; the owner confirms from 「確認」or the web UI.
    confirmed: false,
  }, deps.ids);
  deps.onMutate?.(owner, r.id);

  const when = fmtMdHm(Temporal.Instant.from(r.startsAt).epochMilliseconds);
  const note = policy === "unknown" ? "（キャンセル規定は不明のためWebで補完してください）" : "";
  return {
    id: r.id,
    summaryText: `登録しました: ${r.service} / ${when} — ${
      accountLabel(owner)
    } のWeb台帳に候補として入りました${note}`,
  };
}

// ---- Per-user linking (owner 2026-07-27) ----

/** Reply for a LINE account with no plancel link yet. */
export const LINK_GUIDE_TEXT = [
  "このLINEアカウントはまだ plancel のアカウントと連携されていません。",
  `1. ${APP_LINK_URL} をブラウザで開いてログイン`,
  "2. マイページの「LINE連携」で連携コードを発行",
  "3. そのコードをこのトークに送る",
  `（コードは8文字・${CODE_MINUTES}分間有効。連携するまで予約は登録できません）`,
].join("\n");

/** Reply when the sent text looked like a code but no longer resolves. */
export const LINK_CODE_UNKNOWN_TEXT = [
  "連携コードが確認できませんでした。",
  `期限切れ（${CODE_MINUTES}分）か入力ミスの可能性があります。`,
  `${APP_LINK_URL} のマイページで新しいコードを発行して、もう一度送ってください。`,
].join("\n");

/** Reply when the code's account is already linked to a different LINE. */
export const LINK_TAKEN_TEXT =
  "このLINEアカウントは別の plancel アカウントに連携済みです。Webのマイページで連携を解除してから、もう一度お試しください。";

/** What a message from an unlinked LINE sender resulted in. */
export type LinkAttempt =
  | { kind: "linked"; user: WebUser; reply: LineTextMessage }
  | { kind: "bad-code" | "taken" | "guide"; reply: LineTextMessage };

/**
 * Resolves a message from an UNLINKED LINE sender. The only thing such a
 * message can do is complete a link, and only by carrying a code issued from a
 * logged-in session — the LINE userId itself proves nothing. Nothing is ever
 * written to a ledger from here.
 */
export async function tryLinkFromMessage(
  deps: LineWebDeps,
  lineUserId: string,
  messageText: string | undefined,
): Promise<LinkAttempt> {
  if (messageText === undefined || !looksLikeLineLinkCode(messageText)) {
    return { kind: "guide", reply: text(LINK_GUIDE_TEXT) };
  }
  const userId = await consumeLineLinkCode(deps.kv, messageText, deps.nowMs());
  if (userId === null) return { kind: "bad-code", reply: text(LINK_CODE_UNKNOWN_TEXT) };
  const outcome = await linkLineUser(deps.kv, userId, lineUserId, deps.ids);
  if (outcome === "taken") return { kind: "taken", reply: text(LINK_TAKEN_TEXT) };
  const user = await getUser(deps.kv, userId);
  if (user === null) return { kind: "bad-code", reply: text(LINK_CODE_UNKNOWN_TEXT) };
  return {
    kind: "linked",
    user,
    // The menu is offered right here: the first thing a new user needs is to
    // know that words like 「確認」 do anything at all.
    reply: withMenu(
      text(
        `LINE連携が完了しました: ${
          accountLabel(user)
        } のWeb台帳につながりました。「確認」で予約一覧、予約メールやスクショを送れば登録できます。`,
      ),
      null,
    ),
  };
}

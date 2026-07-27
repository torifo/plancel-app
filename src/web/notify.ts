/**
 * Web ledger cancellation-deadline notifications (owner 2026-07-25).
 *
 * When a reservation's FREE-cancellation deadline is within the next 24 hours
 * (and still in the future), the ledger owner gets one notification so they can
 * decide before free cancellation lapses. Delivery is a LINE push to the
 * ledger owner's OWN linked LINE account (`user.lineUserId`, owner 2026-07-27)
 * when they have one, and e-mail/console otherwise. This is the web-store
 * analogue of the core domain's `fee_boundary_24h` trigger, but it reads the plain
 * per-user reservation records (src/web/store.ts) directly — the core
 * notifier (src/notify/) is event-sourced and is NOT reused here.
 *
 * Deadline math is NOT re-implemented here: `freeDeadlineMs` from ./policy.ts
 * is the single source (mirrored by web/index.html `freeDeadline`). Policies
 * with no free window to lose — "unknown", always-free, paid from the outset —
 * yield a null deadline and never notify.
 *
 * ONE MESSAGE PER USER PER SWEEP (owner 2026-07-27, 「知人優先で枠を使いたい」):
 * every reservation that crossed the boundary in this sweep is bundled into a
 * single mail/push, and email delivery is additionally capped per JST day
 * (`deps.emailDailyCap`). Reminders are the only bulk consumer of Resend's free
 * tier (100/day), and that quota belongs to the 保証リスト, not to system noise.
 *
 * QUEUE-FREE (Deno Deploy KV Connect has no queues): this is swept from the
 * existing 15-minute cron, alongside sweepDirtySync. Idempotency is a KV
 * marker `["web_notified", userId, resvId, "boundary24"]` (expireIn 60d) — one
 * notification per reservation, and a deleted reservation never re-notifies
 * because the marker survives it. No direct system-clock reads — time is
 * injected via `deps.nowMs` (FR-008).
 */
import { logger } from "../lib/log.ts";
import { freeDeadlineMs, maxLossYen } from "./policy.ts";
import { listReservations, type WebReservation, type WebStatus } from "./store.ts";
import { type WebUser, webUserSchema } from "./users.ts";

const USER = "webuser";
const NOTIFIED = "web_notified";
const BOUNDARY = "boundary24";
const EMAIL_QUOTA = "email_quota";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NOTIFIED_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
/** The counter only has to outlive its own JST day; 3 days covers any skew. */
const EMAIL_QUOTA_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const TOKYO_OFFSET = "+09:00";

/**
 * Default daily EMAIL ceiling. Resend's free tier stops accepting past
 * 100/day, so the guard sits deliberately under it: a burst degrades into
 * "goes out tomorrow" instead of an HTTP failure. Env-overridable via
 * PLANCEL_EMAIL_DAILY_CAP (read in src/deploy/main.ts, never here).
 */
export const EMAIL_DAILY_CAP_DEFAULT = 90;

/** Nobody guaranteed — the 保証リスト defaults to empty, not to "everyone". */
const NO_ALLOWED_EMAILS: ReadonlySet<string> = new Set<string>();

/** Statuses that still warrant a deadline nudge (cancelled ones do not). */
const ACTIVE_STATUSES: ReadonlySet<WebStatus> = new Set<WebStatus>([
  "candidate",
  "confirmed",
  "to_cancel",
]);

export interface NotifyDeps {
  kv: Deno.Kv;
  /** Snapshot of "now" (epoch ms) for the whole sweep — injected (FR-008). */
  nowMs: number;
  /** Link the e-mail points at (PLANCEL_BASE_URL or the production URL). */
  baseUrl: string;
  /** Delivery sink (Resend or console) — injected so tests can capture. */
  send(email: string, subject: string, text: string): Promise<void>;
  /**
   * LINE push route (LINE v2 #1). Present whenever a channel token is
   * configured — the target is per user: a ledger owner with a linked LINE
   * account (`user.lineUserId`) is pushed to and bypasses `send`; everyone
   * else keeps the email/console route.
   */
  line?: { push: (lineUserId: string, text: string) => Promise<void> };
  /**
   * Ceiling on EMAIL deliveries per JST day. LINE pushes have their own quota
   * and never touch Resend, so they are not counted and not capped. Defaults
   * to EMAIL_DAILY_CAP_DEFAULT.
   */
  emailDailyCap?: number;
  /**
   * 保証リスト = PLANCEL_ALLOWED_EMAILS, normalized lowercase (the same set the
   * signup capacity check consults). These users are swept FIRST, so a sweep
   * that exhausts the daily cap has already served them.
   */
  allowedEmails?: ReadonlySet<string>;
  /** Log sink; defaults to console.log via logger(). */
  logWrite?: (line: string) => void;
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** Formats an epoch-ms instant as `YYYY/MM/DD(曜) HH:MM JST`. */
function fmtJst(ms: number): string {
  const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(TOKYO_OFFSET);
  const dow = "日月火水木金土"[z.dayOfWeek % 7];
  return `${z.year}/${p2(z.month)}/${p2(z.day)}(${dow}) ${p2(z.hour)}:${p2(z.minute)} JST`;
}

/**
 * `YYYY-MM-DD` in Asia/Tokyo — the bucket a send counts against. Derived from
 * the injected clock via TOKYO_OFFSET (never the host's zone), so a sweep just
 * after 00:00 JST starts a fresh day even though UTC is still on the previous.
 */
function tokyoDate(nowMs: number): string {
  const z = Temporal.Instant.fromEpochMilliseconds(nowMs).toZonedDateTimeISO(TOKYO_OFFSET);
  return `${z.year}-${p2(z.month)}-${p2(z.day)}`;
}

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;

/** A reservation that crossed the boundary in this sweep, with its deadline. */
interface Due {
  resv: WebReservation;
  deadlineMs: number;
}

function subjectFor(count: number): string {
  return count === 1
    ? "[plancel] キャンセル無料期限が近づいています"
    : `[plancel] 無料キャンセル期限が近い予約が${count}件あります`;
}

/** One line per reservation: サービス / 開始 / 無料期限 / 期限後の金額. */
function dueLine(d: Due): string {
  const startMs = Temporal.Instant.from(d.resv.startsAt).epochMilliseconds;
  // ¥0 would read as "free to drop"; an unpriced reservation says so instead.
  const loss = d.resv.amount === null
    ? "金額未登録"
    : `期限後 ${yen(maxLossYen(d.resv.policy, d.resv.amount))}`;
  return `・${d.resv.service} / 開始 ${fmtJst(startMs)} / ◆無料期限 ${
    fmtJst(d.deadlineMs)
  } / ${loss}`;
}

function buildBody(due: readonly Due[], baseUrl: string): string {
  // Singular gets a sentence, not 「1件あります」.
  const head = due.length === 1
    ? "無料キャンセル期限が近い予約があります。"
    : `無料キャンセル期限が近い予約が${due.length}件あります。`;
  return [head, "", ...due.map(dueLine), "", `plancel で確認: ${baseUrl}`].join("\n");
}

/** True when `deadlineMs` is in the future and within the next 24 hours. */
function withinBoundary(deadlineMs: number, nowMs: number): boolean {
  return deadlineMs > nowMs && deadlineMs <= nowMs + DAY_MS;
}

function markerKey(userId: string, resvId: string): Deno.KvKey {
  return [NOTIFIED, userId, resvId, BOUNDARY];
}

async function listUsers(kv: Deno.Kv): Promise<WebUser[]> {
  const out: WebUser[] = [];
  for await (const e of kv.list({ prefix: [USER] })) {
    const parsed = webUserSchema.safeParse(e.value);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

const byId = (a: WebUser, b: WebUser) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * 保証リスト first (owner: 「知人優先で枠を使いたい」). The daily email cap can
 * bind mid-sweep, and whoever is left unsent waits a day — so the guaranteed
 * addresses must already have been served when it does. Within each group the
 * order is by user id: deterministic rather than dependent on KV listing
 * order, which is what makes a capped sweep reproducible.
 */
function orderUsers(users: WebUser[], allowedEmails: ReadonlySet<string>): WebUser[] {
  const guaranteed = (u: WebUser) =>
    allowedEmails.has(u.email) || (u.altEmail !== null && allowedEmails.has(u.altEmail));
  return [...users].sort((a, b) => Number(guaranteed(b)) - Number(guaranteed(a)) || byId(a, b));
}

/** Every not-yet-notified reservation of this user crossing the boundary now. */
async function collectDue(deps: NotifyDeps, user: WebUser): Promise<Due[]> {
  const due: Due[] = [];
  for (const resv of await listReservations(deps.kv, user.ledgerId)) {
    if (!ACTIVE_STATUSES.has(resv.status)) continue;
    const deadlineMs = freeDeadlineMs(resv.policy, resv.startsAt);
    if (deadlineMs === null) continue;
    if (!withinBoundary(deadlineMs, deps.nowMs)) continue;
    if ((await deps.kv.get(markerKey(user.id, resv.id))).value !== null) continue; // notified
    due.push({ resv, deadlineMs });
  }
  // Soonest deadline first so the bundle reads as a to-do list; the id
  // tiebreak keeps identical deadlines in a fixed order.
  return due.sort((a, b) =>
    a.deadlineMs - b.deadlineMs ||
    (a.resv.id < b.resv.id ? -1 : a.resv.id > b.resv.id ? 1 : 0)
  );
}

async function readEmailCount(kv: Deno.Kv, date: string): Promise<number> {
  const v = (await kv.get([EMAIL_QUOTA, date])).value;
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Sweeps every web user's own ledger (never the `::demo` namespace — a distinct
 * KV token, so `listReservations(ledgerId)` excludes it) and sends ONE bundled
 * deadline notification per user, listing every reservation whose free-cancel
 * deadline crossed into the next 24 hours. Idempotent via the `web_notified`
 * marker, written for every bundled reservation only after that single delivery
 * succeeds: a failed send retries the whole bundle next sweep, and a partial
 * success cannot silently drop a member.
 *
 * Returns the number of MESSAGES delivered (one per user), not reservations.
 */
export async function sweepDeadlineNotifications(deps: NotifyDeps): Promise<number> {
  const log = logger(
    "web.notify",
    deps.logWrite !== undefined ? { write: deps.logWrite } : {},
  );
  const cap = deps.emailDailyCap ?? EMAIL_DAILY_CAP_DEFAULT;
  const date = tokyoDate(deps.nowMs);
  // Single-writer counter: the 15-minute cron never overlaps itself, so a
  // read-modify-write is enough for a best-effort ceiling (and the cap already
  // sits under Resend's real limit).
  let emailsToday = await readEmailCount(deps.kv, date);
  let sent = 0;
  const users = orderUsers(await listUsers(deps.kv), deps.allowedEmails ?? NO_ALLOWED_EMAILS);
  for (const user of users) {
    const due = await collectDue(deps, user);
    if (due.length === 0) continue;

    // Own LINE linked → push there; everyone else → email/console. Same
    // markers on both routes: the channel never changes idempotency.
    const line = deps.line;
    const lineUserId = user.lineUserId;
    const viaLine = line !== undefined && lineUserId !== null;
    if (!viaLine && emailsToday >= cap) {
      // No markers → these reservations are picked up again by the first sweep
      // of the next JST day, which starts a fresh counter bucket.
      log.warn("daily email cap reached; deferring to the next JST day", {
        userId: user.id,
        date,
        cap,
        deferred: due.length,
      });
      continue;
    }

    const body = buildBody(due, deps.baseUrl);
    try {
      if (line !== undefined && lineUserId !== null) await line.push(lineUserId, body);
      else await deps.send(user.email, subjectFor(due.length), body);
    } catch (err) {
      // Leave every marker unset so the next sweep retries the whole bundle.
      log.warn("deadline notification send failed; will retry", {
        userId: user.id,
        resvIds: due.map((d) => d.resv.id),
        channel: viaLine ? "line" : "email",
        err: String(err),
      });
      continue;
    }
    if (!viaLine) {
      emailsToday++;
      await deps.kv.set([EMAIL_QUOTA, date], emailsToday, { expireIn: EMAIL_QUOTA_TTL_MS });
    }
    for (const d of due) {
      await deps.kv.set(markerKey(user.id, d.resv.id), { at: deps.nowMs }, {
        expireIn: NOTIFIED_TTL_MS,
      });
    }
    sent++;
  }
  return sent;
}

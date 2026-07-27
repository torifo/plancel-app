/**
 * Web ledger cancellation-deadline notifications (owner 2026-07-25).
 *
 * When a reservation's FREE-cancellation deadline is within the next 24 hours
 * (and still in the future), the ledger owner gets one e-mail so they can
 * decide before free cancellation lapses. Delivery is LINE push when the
 * ledger's email is the configured owner email (`deps.line`, LINE v2 #1), and
 * e-mail/console for everyone else. This is the web-store analogue of
 * the core domain's `fee_boundary_24h` trigger, but it reads the plain
 * per-user reservation records (src/web/store.ts) directly — the core
 * notifier (src/notify/) is event-sourced and is NOT reused here.
 *
 * Deadline math is NOT re-implemented here: `freeDeadlineMs` from ./policy.ts
 * is the single source (mirrored by web/index.html `freeDeadline`). Policies
 * with no free window to lose — "unknown", always-free, paid from the outset —
 * yield a null deadline and never notify.
 *
 * QUEUE-FREE (Deno Deploy KV Connect has no queues): this is swept from the
 * existing 15-minute cron, alongside sweepDirtySync. Idempotency is a KV
 * marker `["web_notified", userId, resvId, "boundary24"]` (expireIn 60d) — one
 * notification per reservation, and a deleted reservation never re-notifies
 * because the marker survives it. No direct system-clock reads — time is
 * injected via `deps.nowMs` (FR-008).
 */
import { logger } from "../lib/log.ts";
import { freeDeadlineMs } from "./policy.ts";
import { listReservations, type WebReservation, type WebStatus } from "./store.ts";
import { type WebUser, webUserSchema } from "./users.ts";

const USER = "webuser";
const NOTIFIED = "web_notified";
const BOUNDARY = "boundary24";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NOTIFIED_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const TOKYO_OFFSET = "+09:00";

const log = logger("web.notify");

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
   * LINE push route for the single owner (LINE v2 #1). Present only when a
   * channel token AND an owner email are configured; the owner's ledger is
   * matched by email (case-insensitive, trimmed) and then bypasses `send`.
   * Everyone else keeps the email/console route.
   */
  line?: { ownerEmail: string; push: (text: string) => Promise<void> };
}

/** Formats an epoch-ms instant as `YYYY/MM/DD(曜) HH:MM JST`. */
function fmtJst(ms: number): string {
  const z = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(TOKYO_OFFSET);
  const dow = "日月火水木金土"[z.dayOfWeek % 7];
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${z.year}/${p2(z.month)}/${p2(z.day)}(${dow}) ${p2(z.hour)}:${p2(z.minute)} JST`;
}

const SUBJECT = "[plancel] キャンセル無料期限が近づいています";

function buildBody(r: WebReservation, deadlineMs: number, baseUrl: string): string {
  const startMs = Temporal.Instant.from(r.startsAt).epochMilliseconds;
  return [
    `予約「${r.service}」の無料キャンセル期限が近づいています。`,
    "",
    `サービス: ${r.service}`,
    `開始日時: ${fmtJst(startMs)}`,
    `無料キャンセル期限: ${fmtJst(deadlineMs)}`,
    "",
    `plancel で確認: ${baseUrl}`,
  ].join("\n");
}

const norm = (email: string) => email.trim().toLowerCase();

/** True when `deadlineMs` is in the future and within the next 24 hours. */
function withinBoundary(deadlineMs: number, nowMs: number): boolean {
  return deadlineMs > nowMs && deadlineMs <= nowMs + DAY_MS;
}

async function listUsers(kv: Deno.Kv): Promise<WebUser[]> {
  const out: WebUser[] = [];
  for await (const e of kv.list({ prefix: [USER] })) {
    const parsed = webUserSchema.safeParse(e.value);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Sweeps every web user's own ledger (never the `::demo` namespace — a distinct
 * KV token, so `listReservations(ledgerId)` excludes it) and sends one
 * deadline notification per qualifying reservation. Idempotent via the
 * `web_notified` marker. Returns the number of notifications sent.
 */
export async function sweepDeadlineNotifications(deps: NotifyDeps): Promise<number> {
  let sent = 0;
  const users = await listUsers(deps.kv);
  for (const user of users) {
    const reservations = await listReservations(deps.kv, user.ledgerId);
    for (const r of reservations) {
      if (!ACTIVE_STATUSES.has(r.status)) continue;
      const deadlineMs = freeDeadlineMs(r.policy, r.startsAt);
      if (deadlineMs === null) continue;
      if (!withinBoundary(deadlineMs, deps.nowMs)) continue;

      const marker = [NOTIFIED, user.id, r.id, BOUNDARY];
      if ((await deps.kv.get(marker)).value !== null) continue; // already notified

      const body = buildBody(r, deadlineMs, deps.baseUrl);
      // Owner ledger → LINE push; everyone else → email/console. Same marker on
      // both routes: the channel never changes idempotency.
      const line = deps.line;
      const viaLine = line !== undefined && norm(user.email) === norm(line.ownerEmail);
      try {
        if (line !== undefined && viaLine) await line.push(body);
        else await deps.send(user.email, SUBJECT, body);
      } catch (err) {
        // Leave the marker unset so the next sweep retries this reservation.
        log.warn("deadline notification send failed; will retry", {
          userId: user.id,
          resvId: r.id,
          channel: viaLine ? "line" : "email",
          err: String(err),
        });
        continue;
      }
      await deps.kv.set(marker, { at: deps.nowMs }, { expireIn: NOTIFIED_TTL_MS });
      sent++;
    }
  }
  return sent;
}

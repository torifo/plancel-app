/**
 * Notification fire-decision — pure functions (Task 3.1, SDD §6 / §10.3,
 * requirements US-003 / FR-005 / FR-010).
 *
 * This module NEVER sends anything and holds no state. It maps
 * `{reservations, plans}` + a `Clock` (or a list of domain events) onto the
 * `PendingNotification`s that should fire. Enqueueing / idempotency
 * consumption / retries / delivery are Task 3.2 (`outbox.ts`) — here we only
 * decide *what* and produce stable idempotency keys so the Outbox can dedupe.
 *
 * ## Timezone / day-boundary decisions (documented)
 *
 * Users are Japanese (SDD), so all *calendar-day* reasoning — the daily
 * `policy_unknown_digest` key, and the `day_of_reminder` "morning of" — is
 * done in **Asia/Tokyo**, expressed as the fixed offset `+09:00`. Japan has
 * no DST, so a fixed offset is exact and avoids depending on the host's IANA
 * tz database. All *instants* remain UTC-canonical (Temporal.Instant); only
 * the projection to a wall-clock day/morning uses the offset.
 *
 *   - Digest "day"  = the Asia/Tokyo calendar date (YYYY-MM-DD) of `now`.
 *   - Digest fire   = 08:00 Asia/Tokyo on that date (morning digest).
 *   - Reminder fire = 08:00 Asia/Tokyo on the reservation's start date, or
 *                     the start instant itself if the event is before 08:00.
 *
 * ## Idempotency key formats (per design.md `reservation_id + trigger + 境界時刻`)
 *
 *   - fee_boundary_24h:      `${reservation_id}:fee_boundary_24h:${boundaryInstant}`
 *   - plan_settled:          `${plan_id}:plan_settled:${settleEventId}`
 *   - policy_unknown_digest: `digest:policy_unknown_digest:${tokyoDate}`
 *   - day_of_reminder:       `${reservation_id}:day_of_reminder:${tokyoDate}`
 *
 * The boundary instant (or day) in the key is what makes repeated cron ticks
 * within the same window collapse to a single delivery.
 */

import type { Clock } from "../core/clock/mod.ts";
import type { Plan, Reservation } from "../core/schema/mod.ts";
import type { DomainEvent } from "../core/schema/mod.ts";
import { isPlanSettled } from "../core/eventlog/mod.ts";
import { estimateLoss, nextBoundary } from "../core/domain/mod.ts";
import type { PendingNotification } from "./types.ts";

/** Fixed Asia/Tokyo offset — Japan observes no DST (documented above). */
const TOKYO_OFFSET = "+09:00";
/** Morning hour (Asia/Tokyo) used for the daily digest and day-of reminder. */
const MORNING = Temporal.PlainTime.from("08:00");
/** Lead time before a fee boundary at which trigger (1) opens (SDD §6.1). */
const BOUNDARY_LEAD = Temporal.Duration.from({ hours: 24 });

/** Reservation statuses that are still "live" for time-driven triggers. */
const LIVE_STATUSES = new Set<Reservation["status"]>([
  "candidate",
  "confirmed",
  "to_cancel",
]);

export interface NotificationInput {
  reservations: Reservation[];
  plans: Plan[];
}

// ---------------------------------------------------------------------------
// Asia/Tokyo helpers
// ---------------------------------------------------------------------------

function startsAtInstant(reservation: Reservation): Temporal.Instant {
  return Temporal.Instant.from(reservation.starts_at);
}

/** The Asia/Tokyo calendar date (YYYY-MM-DD) of an instant. */
function tokyoDate(instant: Temporal.Instant): string {
  return instant.toZonedDateTimeISO(TOKYO_OFFSET).toPlainDate().toString();
}

/** 08:00 Asia/Tokyo on the given calendar date, as a UTC instant. */
function tokyoMorningInstant(date: Temporal.PlainDate): Temporal.Instant {
  return date.toZonedDateTime({ timeZone: TOKYO_OFFSET, plainTime: MORNING }).toInstant();
}

/**
 * The instant the day-of reminder becomes due for a reservation: 08:00
 * Asia/Tokyo on its start date, or the start instant itself if the event is
 * earlier than 08:00 (so an early-morning event still reminds before it,
 * never after).
 */
function reminderInstant(reservation: Reservation): Temporal.Instant {
  const startsAt = startsAtInstant(reservation);
  const morning = tokyoMorningInstant(startsAt.toZonedDateTimeISO(TOKYO_OFFSET).toPlainDate());
  return Temporal.Instant.compare(morning, startsAt) <= 0 ? morning : startsAt;
}

// ---------------------------------------------------------------------------
// Message builders (Japanese, SDD §6)
// ---------------------------------------------------------------------------

function yen(amount: number): string {
  return `¥${Math.round(amount).toLocaleString("ja-JP")}`;
}

function boundaryMessage(
  reservation: Reservation,
  nowJpy: number | null,
  afterJpy: number | null,
): string {
  const head = `「${reservation.service_name}」のキャンセル料が上がる境界が近づいています。`;
  if (nowJpy === null || afterJpy === null) {
    return `${head}今のうちにキャンセルを検討してください。`;
  }
  const nowPart = nowJpy === 0
    ? "今キャンセルすれば無料"
    : `今キャンセルすれば ${yen(nowJpy)} の損`;
  return `${head}${nowPart} / 明日から ${yen(afterJpy)} の損。`;
}

// ---------------------------------------------------------------------------
// Individual trigger evaluators (shared by "due now" and "preview")
// ---------------------------------------------------------------------------

interface BoundaryHit {
  reservation: Reservation;
  boundaryAt: Temporal.Instant;
  /** When the 24h window opens (boundary − 24h). */
  fireAt: Temporal.Instant;
  nowJpy: number | null;
  afterJpy: number | null;
}

/**
 * The single upcoming fee boundary (if any) strictly after `at`, with loss
 * amounts resolved as of `at`. Returns `null` for unknown policies, no
 * further boundary, or non-live status.
 */
function boundaryHitAt(reservation: Reservation, at: Temporal.Instant): BoundaryHit | null {
  if (!LIVE_STATUSES.has(reservation.status)) return null;
  const policy = reservation.cancellation_policy;
  const startsAt = startsAtInstant(reservation);
  const boundary = nextBoundary(policy, startsAt, at);
  if (boundary === null) return null;

  const loss = estimateLoss(policy, startsAt, reservation.amount_jpy, at);
  return {
    reservation,
    boundaryAt: boundary.at,
    fireAt: boundary.at.subtract(BOUNDARY_LEAD),
    nowJpy: loss.nowJpy,
    afterJpy: loss.afterNextBoundaryJpy,
  };
}

function boundaryNotification(hit: BoundaryHit): PendingNotification {
  return {
    idempotency_key: `${hit.reservation.id}:fee_boundary_24h:${hit.boundaryAt.toString()}`,
    trigger: "fee_boundary_24h",
    reservation_id: hit.reservation.id,
    fire_at: hit.fireAt.toString(),
    message: boundaryMessage(hit.reservation, hit.nowJpy, hit.afterJpy),
    boundary_at: hit.boundaryAt.toString(),
    now_loss_jpy: hit.nowJpy,
    after_loss_jpy: hit.afterJpy,
  };
}

function unknownDigestReservations(reservations: Reservation[]): Reservation[] {
  return reservations.filter(
    (r) => LIVE_STATUSES.has(r.status) && r.cancellation_policy === "unknown",
  );
}

function digestNotification(
  members: Reservation[],
  date: string,
  fireAt: Temporal.Instant,
): PendingNotification {
  const names = members.map((r) => `「${r.service_name}」`).join("、");
  return {
    idempotency_key: `digest:policy_unknown_digest:${date}`,
    trigger: "policy_unknown_digest",
    reservation_id: "digest",
    fire_at: fireAt.toString(),
    message:
      `期限不明のキャンセル候補が ${members.length} 件あります: ${names}。ポリシーの確認をおすすめします。`,
    reservation_ids: members.map((r) => r.id),
  };
}

function reminderNotification(
  reservation: Reservation,
  fireAt: Temporal.Instant,
): PendingNotification {
  const date = tokyoDate(startsAtInstant(reservation));
  return {
    idempotency_key: `${reservation.id}:day_of_reminder:${date}`,
    trigger: "day_of_reminder",
    reservation_id: reservation.id,
    fire_at: fireAt.toString(),
    message: `本日「${reservation.service_name}」の予約があります。お忘れなく。`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Notifications DUE at/before `clock.now()` (SDD §6 triggers 1, 3, 4 —
 * trigger 2 is event-driven, see `notificationsForEvents`).
 *
 * A cron tick calls this every 15 min; the Outbox dedupes repeat ticks via
 * the idempotency keys. Voided / cancelled / done reservations are skipped.
 */
export function computePendingNotifications(
  input: NotificationInput,
  clock: Clock,
): PendingNotification[] {
  const now = clock.now();
  const out: PendingNotification[] = [];

  // (1) fee-boundary 24h — due while now is within [boundary−24h, boundary).
  for (const reservation of input.reservations) {
    const hit = boundaryHitAt(reservation, now);
    if (hit === null) continue;
    const inWindow = Temporal.Instant.compare(now, hit.fireAt) >= 0 &&
      Temporal.Instant.compare(now, hit.boundaryAt) < 0;
    if (inWindow) out.push(boundaryNotification(hit));
  }

  // (3) policy-unknown daily digest — one aggregated notification per day,
  //     due once now has reached this Tokyo-day's morning digest time.
  const unknowns = unknownDigestReservations(input.reservations);
  if (unknowns.length > 0) {
    const date = now.toZonedDateTimeISO(TOKYO_OFFSET).toPlainDate();
    const digestFire = tokyoMorningInstant(date);
    if (Temporal.Instant.compare(now, digestFire) >= 0) {
      out.push(digestNotification(unknowns, date.toString(), digestFire));
    }
  }

  // (4) day-of reminder — confirmed reservations, morning of start (Tokyo),
  //     due from the reminder instant until the reservation starts.
  for (const reservation of input.reservations) {
    if (reservation.status !== "confirmed") continue;
    const startsAt = startsAtInstant(reservation);
    if (tokyoDate(now) !== tokyoDate(startsAt)) continue;
    const fireAt = reminderInstant(reservation);
    const due = Temporal.Instant.compare(now, fireAt) >= 0 &&
      Temporal.Instant.compare(now, startsAt) <= 0;
    if (due) out.push(reminderNotification(reservation, fireAt));
  }

  return out;
}

/**
 * Trigger (2) 確定即時 — EVENT-driven. For each `plan.settled` event, emit an
 * immediate "残りN件が要キャンセルです" notification where N is the count of
 * that plan's reservations currently in `to_cancel`. `reservation.auto_to_cancel`
 * events are the individual side-effects of the same settle; N is derived
 * from the post-settle reservation snapshot in `context` rather than by
 * counting those events, so the number is always the true current remainder.
 */
export function notificationsForEvents(
  events: DomainEvent[],
  context: { reservations: Reservation[] },
  _clock: Clock,
): PendingNotification[] {
  const out: PendingNotification[] = [];
  for (const event of events) {
    if (!isPlanSettled(event)) continue;
    const planId = event.payload.plan_id;
    const remaining = context.reservations.filter(
      (r) => r.plan_id === planId && r.status === "to_cancel",
    );
    out.push({
      idempotency_key: `${planId}:plan_settled:${event.id}`,
      trigger: "plan_settled",
      reservation_id: planId,
      fire_at: event.occurred_at,
      message: `プラン内で1件確定しました。残り ${remaining.length} 件が要キャンセルです。`,
      remaining_to_cancel: remaining.length,
    });
  }
  return out;
}

/**
 * Pure simulation (FR-010, SDD §10.3): everything that WOULD fire in
 * `[asOf, asOf + horizon]`, without sending. Each notification's `fire_at`
 * is the instant it first becomes due. Deterministic and side-effect-free —
 * combine with `VirtualClock` for the "今後7日間の通知シミュレーション".
 */
export function previewNotifications(
  input: NotificationInput,
  asOf: Temporal.Instant,
  horizon: Temporal.Duration = Temporal.Duration.from("P7D"),
): PendingNotification[] {
  const until = asOf.toZonedDateTimeISO("UTC").add(horizon).toInstant();
  const inWindow = (i: Temporal.Instant) =>
    Temporal.Instant.compare(i, asOf) >= 0 && Temporal.Instant.compare(i, until) <= 0;

  const out: PendingNotification[] = [];

  // (1) fee-boundary 24h — every boundary whose window opens within range.
  for (const reservation of input.reservations) {
    if (!LIVE_STATUSES.has(reservation.status)) continue;
    const policy = reservation.cancellation_policy;
    if (policy === "unknown") continue;
    const startsAt = startsAtInstant(reservation);
    // Walk boundaries forward: probe just after each found boundary.
    let probe = asOf;
    for (let guard = 0; guard < policy.stages.length + 1; guard++) {
      const boundary = nextBoundary(policy, startsAt, probe);
      if (boundary === null) break;
      const fireAt = boundary.at.subtract(BOUNDARY_LEAD);
      if (Temporal.Instant.compare(fireAt, until) > 0) break;
      if (inWindow(fireAt)) {
        const loss = estimateLoss(policy, startsAt, reservation.amount_jpy, fireAt);
        out.push(boundaryNotification({
          reservation,
          boundaryAt: boundary.at,
          fireAt,
          nowJpy: loss.nowJpy,
          afterJpy: loss.afterNextBoundaryJpy,
        }));
      }
      probe = boundary.at.add({ nanoseconds: 1 });
    }
  }

  // (3) policy-unknown daily digest — one per Tokyo day in range.
  const unknowns = unknownDigestReservations(input.reservations);
  if (unknowns.length > 0) {
    let day = asOf.toZonedDateTimeISO(TOKYO_OFFSET).toPlainDate();
    const untilDay = until.toZonedDateTimeISO(TOKYO_OFFSET).toPlainDate();
    while (Temporal.PlainDate.compare(day, untilDay) <= 0) {
      const fireAt = tokyoMorningInstant(day);
      if (inWindow(fireAt)) out.push(digestNotification(unknowns, day.toString(), fireAt));
      day = day.add({ days: 1 });
    }
  }

  // (4) day-of reminder — confirmed reservations whose reminder falls in range.
  for (const reservation of input.reservations) {
    if (reservation.status !== "confirmed") continue;
    const fireAt = reminderInstant(reservation);
    if (inWindow(fireAt)) out.push(reminderNotification(reservation, fireAt));
  }

  out.sort((a, b) => a.fire_at.localeCompare(b.fire_at));
  return out;
}

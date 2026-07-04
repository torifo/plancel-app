/**
 * Pure state-transition functions for Reservations (Task 2.1, FR-002, US-002).
 *
 * These functions are the heart of plancel's core behavior. They are PURE:
 * no I/O, no Store, no direct clock/ULID access. Every non-deterministic
 * input is injected —
 *   - the current instant via a {@link Clock},
 *   - new event/entity ids via {@link TransitionIds.newId},
 *   - the correlation id via {@link TransitionIds.correlationId}.
 * so identical inputs always produce identical output events (SDD §10.1).
 *
 * Each function takes a {@link TransitionContext} (the target reservation plus
 * — when it belongs to a Plan — the plan and its sibling reservations), and
 * returns a {@link TransitionOutcome}: either the appended {@link DomainEvent}s
 * and the updated entities, or a typed {@link TransitionError} for an illegal
 * transition (SDD §4 diagram). No entity is ever mutated in place and nothing
 * is deleted — `voided` is expressed purely as an appended event (§10.2).
 *
 * The legal transition table (SDD §4):
 *
 *   candidate  --confirm-->        confirmed
 *   candidate  --(sibling quota)--> to_cancel   (auto, caused_by = confirmed)
 *   confirmed  --markDone-->       done
 *   confirmed  --selfCancel-->     to_cancel    (自発キャンセル)
 *   to_cancel  --reportCancelled--> cancelled
 *   <any non-voided> --void-->     voided
 *
 * Anything else (e.g. cancelled --confirm--> confirmed) is rejected.
 */
import type { Clock } from "../clock/mod.ts";
import type { DomainEvent, DomainEventType, Plan, Reservation } from "../schema/mod.ts";

/**
 * Injected id/correlation source. `newId()` must return a fresh ULID-shaped
 * string on every call (order matters: the first id minted by `confirm` is the
 * `reservation.confirmed` event id that every `auto_to_cancel` event's
 * `caused_by` points back to). `correlationId` ties every event emitted by a
 * single command together and to the triggering request's logs (§10.5).
 */
export interface TransitionIds {
  newId(): string;
  correlationId: string;
}

/**
 * Everything a transition needs, already loaded by the caller (the domain
 * layer performs no I/O).
 *
 * - `reservation`: the transition target.
 * - `plan`: the plan the target belongs to, or `null` for a standalone
 *   reservation (`plan_id: null`).
 * - `planReservations`: every reservation in that plan **including** the
 *   target. Empty/ignored when `plan` is `null`. Used to evaluate the
 *   `confirm_quota` on confirm.
 */
export interface TransitionContext {
  plan: Plan | null;
  planReservations: Reservation[];
  reservation: Reservation;
}

/** What changed as a result of a transition. Callers persist these. */
export interface TransitionUpdate {
  /**
   * Reservations whose state changed, target first. On a quota-reaching
   * confirm this includes the confirmed reservation plus every sibling
   * candidate that was auto-moved to `to_cancel`.
   */
  reservations: Reservation[];
  /** Present only when the plan itself changed (e.g. → `settled`). */
  plan?: Plan;
}

/** A rejected transition (SDD §4 / Error Handling in design.md). */
export interface TransitionError {
  code:
    | "illegal_transition"
    | "plan_already_settled";
  message: string;
  /** The command that was attempted. */
  command: TransitionCommand;
  /** The reservation status the command was attempted from. */
  from: Reservation["status"];
}

export type TransitionCommand =
  | "confirm"
  | "reportCancelled"
  | "markDone"
  | "selfCancel"
  | "void";

/** Result of a transition: success with events + updates, or a typed error. */
export type TransitionOutcome =
  | { ok: true; events: DomainEvent[]; updated: TransitionUpdate }
  | { ok: false; error: TransitionError };

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

/** Canonical millisecond-precision UTC string, matching `isoDateTimeSchema`. */
function nowIso(clock: Clock): string {
  return clock.now().toString({ smallestUnit: "millisecond" });
}

function makeEvent(
  id: string,
  type: DomainEventType,
  entityId: string,
  payload: unknown,
  causedBy: string | null,
  correlationId: string,
  occurredAt: string,
): DomainEvent {
  return {
    id,
    type,
    entity_id: entityId,
    payload,
    caused_by: causedBy,
    correlation_id: correlationId,
    occurred_at: occurredAt,
  };
}

/** Returns a copy of `r` with a new status and refreshed `updated_at`. */
function withStatus(
  r: Reservation,
  status: Reservation["status"],
  updatedAt: string,
): Reservation {
  return { ...r, status, updated_at: updatedAt };
}

function illegal(
  command: TransitionCommand,
  from: Reservation["status"],
  allowed: string,
): TransitionOutcome {
  return {
    ok: false,
    error: {
      code: "illegal_transition",
      command,
      from,
      message:
        `illegal transition: cannot ${command} a reservation in "${from}" state (allowed from: ${allowed})`,
    },
  };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/**
 * Confirm a `candidate` reservation.
 *
 * When the plan's `confirmed` count reaches `confirm_quota` as a result, this
 * settles the plan: it emits `reservation.confirmed` + `plan.settled` and, for
 * **every other candidate** in the plan, a `reservation.auto_to_cancel` event
 * whose `caused_by` is the confirmed event's id (US-002, the core behavior).
 * A standalone reservation (`plan: null`) simply becomes `confirmed`.
 */
export function confirm(
  ctx: TransitionContext,
  clock: Clock,
  ids: TransitionIds,
): TransitionOutcome {
  const { reservation, plan, planReservations } = ctx;
  if (reservation.status !== "candidate") {
    return illegal("confirm", reservation.status, "candidate");
  }

  const at = nowIso(clock);
  const { correlationId } = ids;

  // Standalone reservation: no quota logic.
  if (plan === null) {
    const confirmedId = ids.newId();
    const updatedRes = withStatus(reservation, "confirmed", at);
    return {
      ok: true,
      events: [
        makeEvent(
          confirmedId,
          "reservation.confirmed",
          reservation.id,
          { reservation_id: reservation.id, plan_id: null },
          null,
          correlationId,
          at,
        ),
      ],
      updated: { reservations: [updatedRes] },
    };
  }

  const existingConfirmed = planReservations.filter(
    (r) => r.id !== reservation.id && r.status === "confirmed",
  ).length;

  // A plan already at/over quota must not accept more confirmations.
  if (plan.status === "settled" || existingConfirmed >= plan.confirm_quota) {
    return {
      ok: false,
      error: {
        code: "plan_already_settled",
        command: "confirm",
        from: reservation.status,
        message:
          `plan ${plan.id} is already settled (confirm_quota=${plan.confirm_quota} reached); cannot confirm more`,
      },
    };
  }

  const confirmedId = ids.newId();
  const events: DomainEvent[] = [
    makeEvent(
      confirmedId,
      "reservation.confirmed",
      reservation.id,
      { reservation_id: reservation.id, plan_id: plan.id },
      null,
      correlationId,
      at,
    ),
  ];
  const updatedReservations: Reservation[] = [withStatus(reservation, "confirmed", at)];

  const newConfirmedCount = existingConfirmed + 1;
  const quotaReached = newConfirmedCount >= plan.confirm_quota;

  let updatedPlan: Plan | undefined;
  if (quotaReached) {
    // Settle the plan and auto-cancel every remaining candidate.
    const otherCandidates = planReservations.filter(
      (r) => r.id !== reservation.id && r.status === "candidate",
    );

    events.push(
      makeEvent(
        ids.newId(),
        "plan.settled",
        plan.id,
        {
          plan_id: plan.id,
          confirm_quota: plan.confirm_quota,
          confirmed_reservation_id: reservation.id,
          auto_to_cancel_reservation_ids: otherCandidates.map((r) => r.id),
        },
        confirmedId,
        correlationId,
        at,
      ),
    );

    for (const cand of otherCandidates) {
      events.push(
        makeEvent(
          ids.newId(),
          "reservation.auto_to_cancel",
          cand.id,
          {
            reservation_id: cand.id,
            plan_id: plan.id,
            reason: "plan_settled",
            confirmed_reservation_id: reservation.id,
          },
          confirmedId, // causal chain: confirmed → auto_to_cancel
          correlationId,
          at,
        ),
      );
      updatedReservations.push(withStatus(cand, "to_cancel", at));
    }

    updatedPlan = { ...plan, status: "settled", updated_at: at };
  }

  return {
    ok: true,
    events,
    updated: updatedPlan === undefined
      ? { reservations: updatedReservations }
      : { reservations: updatedReservations, plan: updatedPlan },
  };
}

/**
 * Report that a `to_cancel` reservation has actually been cancelled.
 * to_cancel → cancelled.
 */
export function reportCancelled(
  ctx: TransitionContext,
  clock: Clock,
  ids: TransitionIds,
): TransitionOutcome {
  const { reservation } = ctx;
  if (reservation.status !== "to_cancel") {
    return illegal("reportCancelled", reservation.status, "to_cancel");
  }
  const at = nowIso(clock);
  return {
    ok: true,
    events: [
      makeEvent(
        ids.newId(),
        "reservation.cancelled",
        reservation.id,
        { reservation_id: reservation.id, plan_id: reservation.plan_id },
        null,
        ids.correlationId,
        at,
      ),
    ],
    updated: { reservations: [withStatus(reservation, "cancelled", at)] },
  };
}

/**
 * Mark a `confirmed` reservation as visited/completed. confirmed → done.
 */
export function markDone(
  ctx: TransitionContext,
  clock: Clock,
  ids: TransitionIds,
): TransitionOutcome {
  const { reservation } = ctx;
  if (reservation.status !== "confirmed") {
    return illegal("markDone", reservation.status, "confirmed");
  }
  const at = nowIso(clock);
  return {
    ok: true,
    events: [
      makeEvent(
        ids.newId(),
        "reservation.done",
        reservation.id,
        { reservation_id: reservation.id, plan_id: reservation.plan_id },
        null,
        ids.correlationId,
        at,
      ),
    ],
    updated: { reservations: [withStatus(reservation, "done", at)] },
  };
}

/**
 * Voluntarily cancel an already-confirmed reservation (SDD §4 自発キャンセル).
 * confirmed → to_cancel. Distinct from the automatic `auto_to_cancel` caused by
 * a sibling confirmation: this is a manual, uncaused transition.
 */
export function selfCancel(
  ctx: TransitionContext,
  clock: Clock,
  ids: TransitionIds,
): TransitionOutcome {
  const { reservation } = ctx;
  if (reservation.status !== "confirmed") {
    return illegal("selfCancel", reservation.status, "confirmed");
  }
  const at = nowIso(clock);
  return {
    ok: true,
    events: [
      makeEvent(
        ids.newId(),
        "reservation.self_cancel",
        reservation.id,
        { reservation_id: reservation.id, plan_id: reservation.plan_id, reason: "self_cancel" },
        null,
        ids.correlationId,
        at,
      ),
    ],
    updated: { reservations: [withStatus(reservation, "to_cancel", at)] },
  };
}

/**
 * Void (invalidate) a mis-registered reservation. Reachable from ALL states
 * except itself, and expressed purely as an appended `reservation.voided`
 * event — nothing is deleted (SDD §4, §10.2, US-005). Voiding an
 * already-voided reservation is rejected as a no-op illegal transition.
 */
export function voidReservation(
  ctx: TransitionContext,
  clock: Clock,
  ids: TransitionIds,
  reason?: string,
): TransitionOutcome {
  const { reservation } = ctx;
  if (reservation.status === "voided") {
    return illegal("void", reservation.status, "candidate|confirmed|to_cancel|cancelled|done");
  }
  const at = nowIso(clock);
  return {
    ok: true,
    events: [
      makeEvent(
        ids.newId(),
        "reservation.voided",
        reservation.id,
        {
          reservation_id: reservation.id,
          plan_id: reservation.plan_id,
          previous_status: reservation.status,
          reason: reason ?? null,
        },
        null,
        ids.correlationId,
        at,
      ),
    ],
    updated: { reservations: [withStatus(reservation, "voided", at)] },
  };
}

/**
 * Emit the `reservation.created` event for a freshly-built reservation.
 * The reservation object itself is constructed by the caller (validated
 * against the Zod schema); this only mints the append-only creation event so
 * the event log is the complete first-class history (§10.2). No state change.
 */
export function createReservation(
  reservation: Reservation,
  clock: Clock,
  ids: TransitionIds,
): TransitionOutcome {
  const at = nowIso(clock);
  return {
    ok: true,
    events: [
      makeEvent(
        ids.newId(),
        "reservation.created",
        reservation.id,
        { reservation },
        null,
        ids.correlationId,
        at,
      ),
    ],
    updated: { reservations: [reservation] },
  };
}

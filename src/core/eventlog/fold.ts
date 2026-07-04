/**
 * fold — rebuild current entity state from an ordered DomainEvent stream
 * (Task 2.3, SDD §10.2: "current state is reconstructible by folding events;
 * KV current values are a derived cache").
 */
import type { DomainEvent } from "../schema/domain-event.ts";
import type { Reservation } from "../schema/reservation.ts";
import type { PlanStatus } from "../schema/plan.ts";
import {
  isPlanSettled,
  isPolicyAppliedFromTemplate,
  isPolicyProvided,
  isReservationAutoToCancel,
  isReservationCancelled,
  isReservationConfirmed,
  isReservationCreated,
  isReservationVoided,
} from "./payloads.ts";

/**
 * Partial, derived Plan projection. The 8-type `DomainEventType` enum (Task
 * 1.1) has no `plan.created`/`plan.updated` event, only `plan.settled` — so a
 * pure event fold can only ever know a plan's id and whether it has been
 * settled, never its title/date_range/etc. Those fields live only in the
 * `Plan` entity written by Task 2.1's transition functions; this projection
 * is intentionally partial and exists to let `verifyProjection` cross-check
 * the one fact the event log commits to (settled-ness).
 */
export interface FoldedPlanView {
  id: string;
  status: PlanStatus;
}

/** Result of `foldAll`: current state of every entity touched by the stream. */
export interface FoldedState {
  reservations: Record<string, Reservation>;
  plans: Record<string, FoldedPlanView>;
}

function reservationIdOf(event: DomainEvent): string | undefined {
  if (isReservationCreated(event)) return event.payload.reservation.id;
  if (isReservationConfirmed(event)) return event.payload.reservation_id;
  if (isReservationAutoToCancel(event)) return event.payload.reservation_id;
  if (isReservationCancelled(event)) return event.payload.reservation_id;
  if (isReservationVoided(event)) return event.payload.reservation_id;
  if (isPolicyProvided(event)) return event.payload.reservation_id;
  if (isPolicyAppliedFromTemplate(event)) return event.payload.reservation_id;
  return undefined;
}

/**
 * Applies a single DomainEvent to a Reservation projection. `state` is
 * `null` until a `reservation.created` event is seen (which carries the full
 * entity per the payload contract in payloads.ts); events for an unseen
 * reservation, or events unrelated to reservations, are no-ops.
 */
export function applyReservationEvent(
  state: Reservation | null,
  event: DomainEvent,
): Reservation | null {
  if (isReservationCreated(event)) {
    return { ...event.payload.reservation };
  }
  if (!state) return null;

  if (isReservationConfirmed(event)) {
    if (state.id !== event.payload.reservation_id) return state;
    return {
      ...state,
      status: "confirmed",
      plan_id: event.payload.plan_id ?? state.plan_id,
      updated_at: event.occurred_at,
    };
  }
  if (isReservationAutoToCancel(event)) {
    if (state.id !== event.payload.reservation_id) return state;
    return {
      ...state,
      status: "to_cancel",
      plan_id: event.payload.plan_id,
      updated_at: event.occurred_at,
    };
  }
  if (isReservationCancelled(event)) {
    if (state.id !== event.payload.reservation_id) return state;
    return { ...state, status: "cancelled", updated_at: event.occurred_at };
  }
  if (isReservationVoided(event)) {
    if (state.id !== event.payload.reservation_id) return state;
    return { ...state, status: "voided", updated_at: event.occurred_at };
  }
  if (isPolicyProvided(event)) {
    if (state.id !== event.payload.reservation_id) return state;
    return { ...state, cancellation_policy: event.payload.policy, updated_at: event.occurred_at };
  }
  if (isPolicyAppliedFromTemplate(event)) {
    if (state.id !== event.payload.reservation_id) return state;
    return {
      ...state,
      cancellation_policy: event.payload.policy,
      policy_template_id: event.payload.template_id,
      updated_at: event.occurred_at,
    };
  }
  return state;
}

/**
 * Folds an ordered event stream for a single reservation into its current
 * state. `events` may contain events for other entities too (they are
 * ignored); events are expected in chronological (ULID) order.
 */
export function foldReservation(events: readonly DomainEvent[]): Reservation | null {
  let state: Reservation | null = null;
  for (const event of events) {
    const id = reservationIdOf(event);
    if (id !== undefined && state !== null && id !== state.id) continue;
    state = applyReservationEvent(state, event);
  }
  return state;
}

/**
 * Folds an ordered event stream into the current state of every entity it
 * touches. See `FoldedPlanView` for why plan projections are partial.
 */
export function foldAll(events: readonly DomainEvent[]): FoldedState {
  const reservations: Record<string, Reservation> = {};
  const plans: Record<string, FoldedPlanView> = {};

  const ensurePlan = (plan_id: string | undefined | null) => {
    if (!plan_id) return;
    if (!plans[plan_id]) {
      plans[plan_id] = { id: plan_id, status: "open" };
    }
  };

  for (const event of events) {
    const resId = reservationIdOf(event);
    if (resId !== undefined) {
      const prior = reservations[resId] ?? null;
      const next = applyReservationEvent(prior, event);
      if (next) reservations[resId] = next;
    }

    if (isReservationConfirmed(event)) ensurePlan(event.payload.plan_id);
    if (isReservationAutoToCancel(event)) ensurePlan(event.payload.plan_id);

    if (isPlanSettled(event)) {
      const plan_id = event.payload.plan_id;
      plans[plan_id] = { id: plan_id, status: "settled" };
    }
  }

  return { reservations, plans };
}

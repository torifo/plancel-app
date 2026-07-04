/**
 * Payload contract for each `DomainEventType` (Task 2.3).
 *
 * This is the shared contract Task 2.1's transition functions must write to
 * and this module's fold/projection functions read from. Convention:
 *   - Creation events carry the full entity so a fold can materialize it
 *     from nothing (`reservation.created` = `{ reservation }`).
 *   - Transition events carry only the identifiers + fields that changed,
 *     since the fold already has prior state to mutate.
 *
 * Field names are deliberately unabbreviated (`reservation_id`, not `id`)
 * because `entity_id` on the envelope is already the subject's id — the
 * payload's own id fields exist for readability/self-description and for
 * events where the "subject" of the envelope and a referenced entity differ
 * (e.g. `policy.applied_from_template` is about the reservation but also
 * names the template it came from).
 */
import type { Reservation } from "../schema/reservation.ts";
import type { CancellationPolicy } from "../schema/cancellation-policy.ts";
import type { DomainEvent } from "../schema/domain-event.ts";

/** `reservation.created` — full entity, so fold can materialize from nothing. */
export interface ReservationCreatedPayload {
  reservation: Reservation;
}

/** `reservation.confirmed` — plan_id present when confirmed as part of a Plan's quota. */
export interface ReservationConfirmedPayload {
  reservation_id: string;
  plan_id?: string;
}

/** `reservation.auto_to_cancel` — a sibling reservation's confirm pushed this one to to_cancel. */
export interface ReservationAutoToCancelPayload {
  reservation_id: string;
  plan_id: string;
}

/** `reservation.cancelled` — cancellation actually reported/executed. */
export interface ReservationCancelledPayload {
  reservation_id: string;
  reason?: string;
}

/** `reservation.voided` — mis-entry invalidated (not a physical delete). */
export interface ReservationVoidedPayload {
  reservation_id: string;
  reason?: string;
}

/** `policy.provided` — unknown policy filled in after the fact. */
export interface PolicyProvidedPayload {
  reservation_id: string;
  policy: CancellationPolicy;
}

/** `plan.settled` — a Plan's confirm_quota has been reached and it is closed out. */
export interface PlanSettledPayload {
  plan_id: string;
}

/** `policy.applied_from_template` — policy derived from a named PolicyTemplate. */
export interface PolicyAppliedFromTemplatePayload {
  reservation_id: string;
  template_id: string;
  policy: CancellationPolicy;
}

/** Maps each `DomainEventType` to its payload shape. */
export interface DomainEventPayloadMap {
  "reservation.created": ReservationCreatedPayload;
  "reservation.confirmed": ReservationConfirmedPayload;
  "reservation.auto_to_cancel": ReservationAutoToCancelPayload;
  "reservation.cancelled": ReservationCancelledPayload;
  "reservation.voided": ReservationVoidedPayload;
  "policy.provided": PolicyProvidedPayload;
  "plan.settled": PlanSettledPayload;
  "policy.applied_from_template": PolicyAppliedFromTemplatePayload;
}

/** A `DomainEvent` narrowed so `payload` has the type matching `type`. */
export type TypedDomainEvent<
  T extends keyof DomainEventPayloadMap = keyof DomainEventPayloadMap,
> =
  & Omit<DomainEvent, "type" | "payload">
  & { type: T; payload: DomainEventPayloadMap[T] };

function hasStringField(payload: unknown, field: string): boolean {
  return typeof payload === "object" && payload !== null &&
    typeof (payload as Record<string, unknown>)[field] === "string";
}

function hasObjectField(payload: unknown, field: string): boolean {
  return typeof payload === "object" && payload !== null &&
    typeof (payload as Record<string, unknown>)[field] === "object" &&
    (payload as Record<string, unknown>)[field] !== null;
}

/** Type guard: does `event.type === "reservation.created"` and payload match. */
export function isReservationCreated(
  event: DomainEvent,
): event is TypedDomainEvent<"reservation.created"> {
  return event.type === "reservation.created" && hasObjectField(event.payload, "reservation");
}

/** Type guard for `reservation.confirmed`. */
export function isReservationConfirmed(
  event: DomainEvent,
): event is TypedDomainEvent<"reservation.confirmed"> {
  return event.type === "reservation.confirmed" &&
    hasStringField(event.payload, "reservation_id");
}

/** Type guard for `reservation.auto_to_cancel`. */
export function isReservationAutoToCancel(
  event: DomainEvent,
): event is TypedDomainEvent<"reservation.auto_to_cancel"> {
  return event.type === "reservation.auto_to_cancel" &&
    hasStringField(event.payload, "reservation_id") &&
    hasStringField(event.payload, "plan_id");
}

/** Type guard for `reservation.cancelled`. */
export function isReservationCancelled(
  event: DomainEvent,
): event is TypedDomainEvent<"reservation.cancelled"> {
  return event.type === "reservation.cancelled" &&
    hasStringField(event.payload, "reservation_id");
}

/** Type guard for `reservation.voided`. */
export function isReservationVoided(
  event: DomainEvent,
): event is TypedDomainEvent<"reservation.voided"> {
  return event.type === "reservation.voided" && hasStringField(event.payload, "reservation_id");
}

/** Type guard for `policy.provided`. */
export function isPolicyProvided(
  event: DomainEvent,
): event is TypedDomainEvent<"policy.provided"> {
  return event.type === "policy.provided" &&
    hasStringField(event.payload, "reservation_id") &&
    hasObjectField(event.payload, "policy");
}

/** Type guard for `plan.settled`. */
export function isPlanSettled(event: DomainEvent): event is TypedDomainEvent<"plan.settled"> {
  return event.type === "plan.settled" && hasStringField(event.payload, "plan_id");
}

/** Type guard for `policy.applied_from_template`. */
export function isPolicyAppliedFromTemplate(
  event: DomainEvent,
): event is TypedDomainEvent<"policy.applied_from_template"> {
  return event.type === "policy.applied_from_template" &&
    hasStringField(event.payload, "reservation_id") &&
    hasStringField(event.payload, "template_id") &&
    hasObjectField(event.payload, "policy");
}

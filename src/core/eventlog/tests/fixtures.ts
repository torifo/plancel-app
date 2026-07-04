/**
 * Fixtures for eventlog tests: a create -> confirm -> auto_to_cancel ->
 * cancelled DomainEvent stream for two sibling reservations in a Plan with
 * confirm_quota 1 (SDD §3.1: confirming one candidate pushes the others to
 * to_cancel).
 */
import type { DomainEvent } from "../../schema/domain-event.ts";
import type { Reservation } from "../../schema/reservation.ts";
import { validPolicy, validReservation } from "../../schema/tests/fixtures.ts";

export const PLAN_ID = "PN200000000000000000000000".slice(0, 26);
export const RES_A_ID = "RSVA0000000000000000000000".slice(0, 26);
export const RES_B_ID = "RSVB0000000000000000000000".slice(0, 26);

// Prefixed EV0..EV4 so string order matches chronological order (tests rely
// on this for InMemoryStore's ULID-sort semantics).
export const EVT_CREATE_A = "EV0CRA00000000000000000000".slice(0, 26);
export const EVT_CREATE_B = "EV1CRB00000000000000000000".slice(0, 26);
export const EVT_CONFIRM_A = "EV2CNF00000000000000000000".slice(0, 26);
export const EVT_AUTO_CANCEL_B = "EV3ATC00000000000000000000".slice(0, 26);
export const EVT_CANCELLED_B = "EV4CNC00000000000000000000".slice(0, 26);

const t = (mins: number) => new Date(Date.UTC(2026, 6, 1, 0, mins)).toISOString();

export const reservationA: Reservation = {
  ...validReservation,
  id: RES_A_ID,
  plan_id: PLAN_ID,
  service_name: "宿A",
  status: "candidate",
  created_at: t(0),
  updated_at: t(0),
};

export const reservationB: Reservation = {
  ...validReservation,
  id: RES_B_ID,
  plan_id: PLAN_ID,
  service_name: "宿B",
  status: "candidate",
  created_at: t(1),
  updated_at: t(1),
};

/** create(A) -> create(B) -> confirm(A) -> auto_to_cancel(B) -> cancelled(B). */
export const reservationLifecycleEvents: DomainEvent[] = [
  {
    id: EVT_CREATE_A,
    type: "reservation.created",
    entity_id: RES_A_ID,
    payload: { reservation: reservationA },
    caused_by: null,
    correlation_id: "corr-fixture",
    occurred_at: t(0),
  },
  {
    id: EVT_CREATE_B,
    type: "reservation.created",
    entity_id: RES_B_ID,
    payload: { reservation: reservationB },
    caused_by: null,
    correlation_id: "corr-fixture",
    occurred_at: t(1),
  },
  {
    id: EVT_CONFIRM_A,
    type: "reservation.confirmed",
    entity_id: RES_A_ID,
    payload: { reservation_id: RES_A_ID, plan_id: PLAN_ID },
    caused_by: null,
    correlation_id: "corr-fixture",
    occurred_at: t(2),
  },
  {
    id: EVT_AUTO_CANCEL_B,
    type: "reservation.auto_to_cancel",
    entity_id: RES_B_ID,
    payload: { reservation_id: RES_B_ID, plan_id: PLAN_ID },
    caused_by: EVT_CONFIRM_A,
    correlation_id: "corr-fixture",
    occurred_at: t(2),
  },
  {
    id: EVT_CANCELLED_B,
    type: "reservation.cancelled",
    entity_id: RES_B_ID,
    payload: { reservation_id: RES_B_ID, reason: "manually reported" },
    caused_by: EVT_AUTO_CANCEL_B,
    correlation_id: "corr-fixture",
    occurred_at: t(3),
  },
];

export { validPolicy };

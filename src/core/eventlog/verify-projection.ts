/**
 * verifyProjection — cross-check the event-log fold against the Store's
 * stored current entities (Task 2.3, SDD §10.2: "KV current values are a
 * derived cache" — this is the consistency check that backs that claim).
 */
import type { Store } from "../store/store.ts";
import { foldAll } from "./fold.ts";

export type ProjectionMismatchKind =
  | "missing_in_store"
  | "missing_in_projection"
  | "state_mismatch";

export interface ProjectionMismatch {
  kind: "reservation" | "plan";
  id: string;
  issue: ProjectionMismatchKind;
  projected?: unknown;
  stored?: unknown;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec).sort();
  const bKeys = Object.keys(bRec).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((k, i) => k !== bKeys[i])) return false;
  return aKeys.every((k) => deepEqual(aRec[k], bRec[k]));
}

/**
 * Folds the store's entire event log and compares the result against the
 * store's stored reservations/plans, returning every mismatch found. An
 * empty array means the store's current-value cache is consistent with the
 * event log. Plan comparisons only check `status`, since the 8-type event
 * enum (Task 1.1) commits only to plan settled-ness, not full Plan fields
 * (see `FoldedPlanView` in fold.ts).
 */
export async function verifyProjection(store: Store): Promise<ProjectionMismatch[]> {
  const events = await store.listEvents();
  const folded = foldAll(events);
  const mismatches: ProjectionMismatch[] = [];

  const storedReservations = await store.listReservations();
  const storedReservationById = new Map(storedReservations.map((r) => [r.id, r] as const));
  const projectedReservationIds = new Set(Object.keys(folded.reservations));

  for (const [id, projected] of Object.entries(folded.reservations)) {
    const stored = storedReservationById.get(id);
    if (!stored) {
      mismatches.push({ kind: "reservation", id, issue: "missing_in_store", projected });
      continue;
    }
    if (!deepEqual(projected, stored)) {
      mismatches.push({ kind: "reservation", id, issue: "state_mismatch", projected, stored });
    }
  }
  for (const stored of storedReservations) {
    if (!projectedReservationIds.has(stored.id)) {
      mismatches.push({
        kind: "reservation",
        id: stored.id,
        issue: "missing_in_projection",
        stored,
      });
    }
  }

  const storedPlans = await store.listPlans();
  const storedPlanById = new Map(storedPlans.map((p) => [p.id, p] as const));
  const projectedPlanIds = new Set(Object.keys(folded.plans));

  for (const [id, projected] of Object.entries(folded.plans)) {
    const stored = storedPlanById.get(id);
    if (!stored) {
      mismatches.push({ kind: "plan", id, issue: "missing_in_store", projected });
      continue;
    }
    if (stored.status !== projected.status) {
      mismatches.push({
        kind: "plan",
        id,
        issue: "state_mismatch",
        projected: projected.status,
        stored: stored.status,
      });
    }
  }
  for (const stored of storedPlans) {
    if (!projectedPlanIds.has(stored.id)) {
      // A plan the log never mentions isn't a fold failure — the 8-type
      // enum has no plan.created event, so plans only enter the
      // projection when a reservation.confirmed/auto_to_cancel/plan.settled
      // event references them.
      continue;
    }
  }

  return mismatches;
}

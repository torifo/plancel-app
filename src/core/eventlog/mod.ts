/**
 * eventlog — DomainEvent append, fold/projection, causal chain, and
 * projection consistency check (Task 2.3).
 */
export { append } from "./append.ts";
export { applyReservationEvent, foldAll, foldReservation } from "./fold.ts";
export type { FoldedPlanView, FoldedState } from "./fold.ts";
export { causalChain } from "./causal-chain.ts";
export { verifyProjection } from "./verify-projection.ts";
export type { ProjectionMismatch, ProjectionMismatchKind } from "./verify-projection.ts";
export * from "./payloads.ts";

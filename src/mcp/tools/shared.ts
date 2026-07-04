/**
 * Shared plumbing for the MCP registration/read tools (Task 3.3).
 *
 * A `ToolDefinition` bundles a tool's name, description, its Zod input schema,
 * and a `run` handler that assumes already-validated input. `invokeTool` is the
 * single entry point that (1) validates raw input against the schema — turning a
 * ZodError into a structured `validation_error` listing every offending field
 * path + message (US-004 / design.md Error Handling) — and (2) delegates to
 * `run`. Tests call `invokeTool` (to exercise validation) or `run` directly.
 *
 * `starts_at` in the past is deliberately NOT a validation error (SDD §5,
 * design.md): tools succeed but surface a `warning` array on the result.
 */
import { z } from "zod";
import type { ToolContext } from "../context.ts";
import type { Reservation } from "../../core/schema/mod.ts";
import { reservationSchema } from "../../core/schema/mod.ts";
import type {
  TransitionContext,
  TransitionError,
  TransitionIds,
  TransitionOutcome,
} from "../../core/domain/mod.ts";
import { createReservation } from "../../core/domain/mod.ts";
import { append } from "../../core/eventlog/mod.ts";
import { onEventsAppended } from "../../notify/mod.ts";
import { newCorrelationId } from "../../lib/log.ts";

/** A single Zod issue flattened to `{ path, message }` for the client. */
export interface FieldIssue {
  path: string;
  message: string;
}

/** A structured, non-Zod error a handler can return (e.g. "plan not found"). */
export interface ToolError {
  code: string;
  message: string;
  issues?: FieldIssue[];
}

/** Result of running a tool handler: success (with optional warnings) or error. */
export type ToolRunResult =
  | { ok: true; data: Record<string, unknown>; warning?: string[] }
  | { ok: false; error: ToolError };

/** A registered tool: metadata + Zod input schema + validated-input handler. */
export interface ToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  run(ctx: ToolContext, input: z.infer<S>): Promise<ToolRunResult>;
}

/** Flattens a ZodError's issues into client-facing `{ path, message }` entries. */
export function zodIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/**
 * Validates `rawInput` against the tool's schema, then runs the handler.
 * On validation failure returns a `validation_error` result listing offending
 * field paths — the registration never proceeds (US-004).
 */
export async function invokeTool<S extends z.ZodTypeAny>(
  def: ToolDefinition<S>,
  ctx: ToolContext,
  rawInput: unknown,
): Promise<ToolRunResult> {
  const parsed = def.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation_error",
        message: "input failed schema validation",
        issues: zodIssues(parsed.error),
      },
    };
  }
  return await def.run(ctx, parsed.data);
}

/** Canonical millisecond-precision UTC timestamp from the injected clock. */
export function nowIso(ctx: ToolContext): string {
  return ctx.clock.now().toString({ smallestUnit: "millisecond" });
}

/** Builds `TransitionIds` for the domain layer from the tool context. */
export function transitionIds(ctx: ToolContext): TransitionIds {
  return { newId: () => ctx.ids.newUlid(), correlationId: newCorrelationId() };
}

/**
 * Returns a one-element warning array when `startsAt` is before the current
 * instant, else `undefined`. `starts_at` in the past is allowed (SDD §5) but
 * flagged so the caller can confirm.
 */
export function pastStartWarning(ctx: ToolContext, startsAt: string): string[] | undefined {
  const start = Temporal.Instant.from(startsAt);
  if (Temporal.Instant.compare(start, ctx.clock.now()) < 0) {
    return [`starts_at ${startsAt} is in the past`];
  }
  return undefined;
}

/** Builds a `not_found` error result pointing at the offending input field. */
export function notFound(path: string, message: string): ToolRunResult {
  return { ok: false, error: { code: "not_found", message, issues: [{ path, message }] } };
}

/** Maps a rejected domain transition to a tool error carrying its code. */
export function transitionErrorResult(error: TransitionError): ToolRunResult {
  return { ok: false, error: { code: error.code, message: error.message } };
}

/**
 * Loads everything a domain transition needs for a reservation: the target
 * reservation plus — when it belongs to a plan — the plan and every sibling
 * reservation in that plan. Returns `null` when the reservation is missing.
 */
export async function loadTransitionContext(
  ctx: ToolContext,
  reservationId: string,
): Promise<TransitionContext | null> {
  const reservation = await ctx.store.getReservation(reservationId);
  if (reservation === null) return null;
  if (reservation.plan_id === null) {
    return { plan: null, planReservations: [], reservation };
  }
  const plan = await ctx.store.getPlan(reservation.plan_id);
  const planReservations = plan === null
    ? []
    : await ctx.store.listReservationsByPlan(reservation.plan_id);
  return { plan, planReservations, reservation };
}

/**
 * Persists a successful transition outcome: appends its events to the log,
 * upserts every changed reservation (and the plan, if it changed), then calls
 * the notify subscription glue with the post-transition reservation snapshot
 * so event-driven notifications (e.g. plan_settled) land on the Outbox.
 */
export async function persistTransition(
  ctx: ToolContext,
  tctx: TransitionContext,
  outcome: Extract<TransitionOutcome, { ok: true }>,
): Promise<void> {
  await append(ctx.store, outcome.events);
  for (const r of outcome.updated.reservations) {
    await ctx.store.putReservation(r);
  }
  if (outcome.updated.plan !== undefined) {
    await ctx.store.putPlan(outcome.updated.plan);
  }
  // Post-transition snapshot: siblings with the updated versions substituted.
  const updatedById = new Map(outcome.updated.reservations.map((r) => [r.id, r] as const));
  const base = tctx.plan === null ? [tctx.reservation] : tctx.planReservations;
  const snapshot = base.map((r) => updatedById.get(r.id) ?? r);
  for (const r of outcome.updated.reservations) {
    if (!snapshot.some((s) => s.id === r.id)) snapshot.push(r);
  }
  await onEventsAppended(ctx.store, outcome.events, { reservations: snapshot }, ctx.clock);
}

/** Attaches an optional warning array to a success result. */
export function ok(data: Record<string, unknown>, warning?: string[]): ToolRunResult {
  return warning === undefined ? { ok: true, data } : { ok: true, data, warning };
}

/** Every Reservation status, so status rollups always report all keys (incl. 0). */
export const RESERVATION_STATUSES = [
  "candidate",
  "confirmed",
  "to_cancel",
  "cancelled",
  "done",
  "voided",
] as const;

export type ReservationStatusRollup = Record<
  (typeof RESERVATION_STATUSES)[number],
  number
>;

/** Aggregates reservations into per-status counts (all six keys present). */
export function statusRollup(reservations: Reservation[]): ReservationStatusRollup {
  const rollup = Object.fromEntries(
    RESERVATION_STATUSES.map((s) => [s, 0]),
  ) as ReservationStatusRollup;
  for (const r of reservations) rollup[r.status] += 1;
  return rollup;
}

/**
 * Zod input schema for a reservation as accepted by MCP tools: the §3.2
 * Reservation schema minus server-generated fields (id, status, created_at,
 * updated_at), with sensible defaults so only `service_name` + `starts_at` are
 * required. `cancellation_policy` defaults to "unknown" (§3.3 — must be
 * accepted, never rejected).
 */
export const reservationInputSchema = reservationSchema
  .omit({ id: true, status: true, created_at: true, updated_at: true })
  .extend({
    plan_id: reservationSchema.shape.plan_id.default(null),
    event_id: reservationSchema.shape.event_id.default(null),
    provider: reservationSchema.shape.provider.default(null),
    ends_at: reservationSchema.shape.ends_at.default(null),
    location: reservationSchema.shape.location.default(null),
    amount_jpy: reservationSchema.shape.amount_jpy.default(null),
    cancellation_policy: reservationSchema.shape.cancellation_policy.default("unknown"),
    policy_template_id: reservationSchema.shape.policy_template_id.default(null),
    source: reservationSchema.shape.source.default("mcp"),
    raw_input_ref: reservationSchema.shape.raw_input_ref.default(null),
    notes: reservationSchema.shape.notes.default(null),
  });

export type ReservationInput = z.infer<typeof reservationInputSchema>;

/**
 * Builds a full, validated `Reservation` from tool input: mints an id, stamps
 * created_at/updated_at from the clock, and starts in `candidate`. Optional
 * `overrides` (e.g. `plan_id` for `add_to_plan`) win over the input.
 */
export function buildReservation(
  ctx: ToolContext,
  input: ReservationInput,
  overrides: Partial<Reservation> = {},
): Reservation {
  const at = nowIso(ctx);
  return reservationSchema.parse({
    ...input,
    id: ctx.ids.newUlid(),
    status: "candidate",
    created_at: at,
    updated_at: at,
    ...overrides,
  });
}

/**
 * Persists a freshly-built reservation through the domain `createReservation`
 * transition: emits the `reservation.created` event, appends it to the event
 * log, then upserts the reservation. Reservation creation logic is never
 * hand-rolled here — it always goes through the domain layer (SDD §10.2).
 */
export async function persistNewReservation(
  ctx: ToolContext,
  reservation: Reservation,
): Promise<Reservation> {
  const outcome = createReservation(reservation, ctx.clock, transitionIds(ctx));
  if (!outcome.ok) {
    // createReservation never rejects, but the type is a union — be explicit.
    throw new Error(`createReservation rejected: ${outcome.error.message}`);
  }
  await append(ctx.store, outcome.events);
  const created = outcome.updated.reservations[0] ?? reservation;
  await ctx.store.putReservation(created);
  return created;
}

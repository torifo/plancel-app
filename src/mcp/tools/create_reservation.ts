/**
 * create_reservation — register a structured reservation (SDD §3.2, §7).
 *
 * Parsing is the Claude conversation's job; this tool only validates the
 * already-structured input and persists it through the domain
 * `createReservation` transition (emitting `reservation.created`). A
 * `cancellation_policy` of "unknown" is accepted (§3.3). A `starts_at` in the
 * past is NOT a validation error (§5): the tool succeeds with a `warning`.
 */
import type { ToolContext } from "../context.ts";
import {
  buildReservation,
  ok,
  pastStartWarning,
  persistNewReservation,
  reservationInputSchema,
  type ToolDefinition,
} from "./shared.ts";

export const createReservationTool: ToolDefinition<typeof reservationInputSchema> = {
  name: "create_reservation",
  description: "Register a structured reservation. Input must already be parsed into the " +
    "reservation schema (this tool has no parsing intelligence). Only " +
    "service_name and starts_at are required; cancellation_policy may be " +
    '"unknown". A past starts_at is accepted but returns a warning.',
  inputSchema: reservationInputSchema,
  async run(ctx: ToolContext, input) {
    const reservation = buildReservation(ctx, input);
    const created = await persistNewReservation(ctx, reservation);
    return ok({ reservation: created }, pastStartWarning(ctx, created.starts_at));
  },
};

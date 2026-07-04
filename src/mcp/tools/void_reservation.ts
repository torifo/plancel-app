/**
 * void_reservation — invalidate a mis-registered reservation (SDD §4/§7,
 * US-005, Task 3.4). Expressed purely as an appended `reservation.voided`
 * event via the domain `voidReservation` transition — nothing is deleted.
 * A voided reservation drops out of listings (its status is no longer
 * `to_cancel`, so `list_pending_cancellations` excludes it) and out of
 * notification targets. Voiding an already-voided reservation is rejected.
 */
import { z } from "zod";
import { ulidSchema } from "../../core/schema/mod.ts";
import { voidReservation } from "../../core/domain/mod.ts";
import type { ToolContext } from "../context.ts";
import {
  loadTransitionContext,
  notFound,
  ok,
  persistTransition,
  type ToolDefinition,
  transitionErrorResult,
  transitionIds,
} from "./shared.ts";

const inputSchema = z.object({
  reservation_id: ulidSchema,
  reason: z.string().min(1).optional(),
});

export const voidReservationTool: ToolDefinition<typeof inputSchema> = {
  name: "void_reservation",
  description: "Void (invalidate) a mis-registered reservation by appending a " +
    "reservation.voided event. Nothing is deleted; the reservation is excluded " +
    "from listings and notifications thereafter. To fix a mistake: void, then re-create.",
  inputSchema,
  async run(ctx: ToolContext, input) {
    const tctx = await loadTransitionContext(ctx, input.reservation_id);
    if (tctx === null) {
      return notFound("reservation_id", `reservation ${input.reservation_id} not found`);
    }

    const outcome = voidReservation(tctx, ctx.clock, transitionIds(ctx), input.reason);
    if (!outcome.ok) return transitionErrorResult(outcome.error);

    await persistTransition(ctx, tctx, outcome);
    return ok({ reservation: outcome.updated.reservations[0] ?? null });
  },
};

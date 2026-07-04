/**
 * confirm_reservation — confirm a candidate reservation (SDD §4/§7, US-002,
 * Task 3.4).
 *
 * Runs the domain `confirm` transition with the full plan context. When the
 * plan's `confirm_quota` is reached the plan settles and every sibling
 * candidate is auto-moved to `to_cancel`; those siblings are returned as
 * `side_effects` (design.md: 副作用一覧返却) alongside `plan_settled`.
 * Events are appended and the notify subscription glue fires (plan_settled
 * notification onto the Outbox). Illegal transitions surface the domain
 * error code (`illegal_transition` / `plan_already_settled`).
 */
import { z } from "zod";
import { ulidSchema } from "../../core/schema/mod.ts";
import { confirm } from "../../core/domain/mod.ts";
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

const inputSchema = z.object({ reservation_id: ulidSchema });

export const confirmReservationTool: ToolDefinition<typeof inputSchema> = {
  name: "confirm_reservation",
  description: "Confirm a candidate reservation. When the plan's confirm_quota is reached, " +
    "the plan settles and sibling candidates auto-move to to_cancel; those are " +
    "returned as side_effects, plus a plan_settled flag.",
  inputSchema,
  async run(ctx: ToolContext, input) {
    const tctx = await loadTransitionContext(ctx, input.reservation_id);
    if (tctx === null) {
      return notFound("reservation_id", `reservation ${input.reservation_id} not found`);
    }

    const outcome = confirm(tctx, ctx.clock, transitionIds(ctx));
    if (!outcome.ok) return transitionErrorResult(outcome.error);

    await persistTransition(ctx, tctx, outcome);

    const [reservation, ...sideEffects] = outcome.updated.reservations;
    return ok({
      reservation: reservation ?? null,
      side_effects: sideEffects,
      plan_settled: outcome.updated.plan?.status === "settled",
      ...(outcome.updated.plan !== undefined ? { plan: outcome.updated.plan } : {}),
    });
  },
};

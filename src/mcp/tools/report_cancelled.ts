/**
 * report_cancelled — report that a `to_cancel` reservation has actually been
 * cancelled (SDD §4/§7, Task 3.4). to_cancel → cancelled via the domain
 * `reportCancelled` transition; anything else is an `illegal_transition`.
 */
import { z } from "zod";
import { ulidSchema } from "../../core/schema/mod.ts";
import { reportCancelled } from "../../core/domain/mod.ts";
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

export const reportCancelledTool: ToolDefinition<typeof inputSchema> = {
  name: "report_cancelled",
  description: "Report that a to_cancel reservation has actually been cancelled " +
    "(to_cancel → cancelled). Returns the updated reservation.",
  inputSchema,
  async run(ctx: ToolContext, input) {
    const tctx = await loadTransitionContext(ctx, input.reservation_id);
    if (tctx === null) {
      return notFound("reservation_id", `reservation ${input.reservation_id} not found`);
    }

    const outcome = reportCancelled(tctx, ctx.clock, transitionIds(ctx));
    if (!outcome.ok) return transitionErrorResult(outcome.error);

    await persistTransition(ctx, tctx, outcome);
    return ok({ reservation: outcome.updated.reservations[0] ?? null });
  },
};

/**
 * get_plan — a Plan plus its reservations and a per-status rollup (SDD §7).
 */
import { z } from "zod";
import { ulidSchema } from "../../core/schema/mod.ts";
import type { ToolContext } from "../context.ts";
import { ok, statusRollup, type ToolDefinition, type ToolRunResult } from "./shared.ts";

const inputSchema = z.object({ plan_id: ulidSchema });

export const getPlanTool: ToolDefinition<typeof inputSchema> = {
  name: "get_plan",
  description: "Get a Plan with its associated reservations and a status rollup " +
    "(counts of reservations by status).",
  inputSchema,
  async run(ctx: ToolContext, input): Promise<ToolRunResult> {
    const plan = await ctx.store.getPlan(input.plan_id);
    if (plan === null) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `plan ${input.plan_id} not found`,
          issues: [{ path: "plan_id", message: `plan ${input.plan_id} not found` }],
        },
      };
    }
    const reservations = await ctx.store.listReservationsByPlan(plan.id);
    return ok({ plan, reservations, status_rollup: statusRollup(reservations) });
  },
};

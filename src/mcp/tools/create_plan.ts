/**
 * create_plan — create an exclusive candidate group (SDD §3.1, §7).
 *
 * `confirm_quota` defaults to 1 (the usual "one of these candidates wins"
 * case). The plan starts `open` with no reservations; use `add_to_plan` to
 * attach candidates.
 */
import { planSchema } from "../../core/schema/mod.ts";
import type { ToolContext } from "../context.ts";
import { nowIso, ok, type ToolDefinition } from "./shared.ts";

const inputSchema = planSchema
  .omit({ id: true, status: true, reservation_ids: true, created_at: true, updated_at: true })
  .extend({
    event_id: planSchema.shape.event_id.default(null),
    date_range: planSchema.shape.date_range.default(null),
    confirm_quota: planSchema.shape.confirm_quota.default(1),
  });

export const createPlanTool: ToolDefinition<typeof inputSchema> = {
  name: "create_plan",
  description: "Create a Plan: an exclusive candidate group. Once confirm_quota (default " +
    "1) reservations are confirmed, remaining candidates auto-move to " +
    "to_cancel. Starts open with no reservations.",
  inputSchema,
  run(ctx: ToolContext, input) {
    const at = nowIso(ctx);
    const plan = planSchema.parse({
      ...input,
      id: ctx.ids.newUlid(),
      status: "open",
      reservation_ids: [],
      created_at: at,
      updated_at: at,
    });
    return ctx.store.putPlan(plan).then(() => ok({ plan }));
  },
};

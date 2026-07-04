/**
 * get_event — an Event with all its constituent Plans and Reservations plus a
 * status aggregation (SDD §3.0, §7).
 *
 * Event holds no persisted status of its own (§3.0: stateless aggregation
 * view), so this walks the Plans that belong to the Event and the Reservations
 * attached either directly (`event_id`) or via one of those Plans, and computes
 * the status rollup from that union.
 */
import { z } from "zod";
import { ulidSchema } from "../../core/schema/mod.ts";
import type { Reservation } from "../../core/schema/mod.ts";
import type { ToolContext } from "../context.ts";
import { ok, statusRollup, type ToolDefinition, type ToolRunResult } from "./shared.ts";

const inputSchema = z.object({ event_id: ulidSchema });

export const getEventTool: ToolDefinition<typeof inputSchema> = {
  name: "get_event",
  description: "Get an Event with its Plans and all Reservations belonging to it " +
    "(directly or via a Plan), plus an aggregated status rollup. Event status " +
    "is computed, not stored.",
  inputSchema,
  async run(ctx: ToolContext, input): Promise<ToolRunResult> {
    const event = await ctx.store.getEvent(input.event_id);
    if (event === null) {
      return {
        ok: false,
        error: {
          code: "not_found",
          message: `event ${input.event_id} not found`,
          issues: [{ path: "event_id", message: `event ${input.event_id} not found` }],
        },
      };
    }

    const allPlans = await ctx.store.listPlans();
    const plans = allPlans.filter((p) => p.event_id === event.id);
    const planIds = new Set(plans.map((p) => p.id));

    const allReservations = await ctx.store.listReservations();
    const reservations = allReservations.filter(
      (r: Reservation) => r.event_id === event.id || (r.plan_id !== null && planIds.has(r.plan_id)),
    );

    return ok({ event, plans, reservations, status_rollup: statusRollup(reservations) });
  },
};

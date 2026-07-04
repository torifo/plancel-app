/**
 * add_to_plan — attach a reservation to an existing Plan (SDD §3.1, §7).
 *
 * Two mutually-exclusive branches:
 *   - `reservation_id`: reference an existing reservation and link it to the
 *     plan (sets its `plan_id`, adds it to the plan's `reservation_ids`).
 *   - `reservation`: an inline reservation input, created via the same domain
 *     `createReservation` path as `create_reservation`, with `plan_id` forced
 *     to this plan.
 */
import { z } from "zod";
import { ulidSchema } from "../../core/schema/mod.ts";
import type { ToolContext } from "../context.ts";
import {
  buildReservation,
  nowIso,
  ok,
  pastStartWarning,
  persistNewReservation,
  reservationInputSchema,
  type ToolDefinition,
  type ToolRunResult,
} from "./shared.ts";

const inputSchema = z
  .object({
    plan_id: ulidSchema,
    reservation_id: ulidSchema.optional(),
    reservation: reservationInputSchema.optional(),
  })
  .refine(
    (v) => (v.reservation_id === undefined) !== (v.reservation === undefined),
    {
      message: "provide exactly one of reservation_id or reservation",
      path: ["reservation_id"],
    },
  );

function notFound(path: string, message: string): ToolRunResult {
  return { ok: false, error: { code: "not_found", message, issues: [{ path, message }] } };
}

export const addToPlanTool: ToolDefinition<typeof inputSchema> = {
  name: "add_to_plan",
  description: "Add a reservation to a Plan. Provide either reservation_id (link an " +
    "existing reservation) or an inline reservation object (created inline). " +
    "Returns the updated plan and the reservation.",
  inputSchema,
  async run(ctx: ToolContext, input) {
    const plan = await ctx.store.getPlan(input.plan_id);
    if (plan === null) {
      return notFound("plan_id", `plan ${input.plan_id} not found`);
    }

    let reservation;
    let warning: string[] | undefined;

    if (input.reservation !== undefined) {
      // Inline: create through the domain createReservation path.
      const built = buildReservation(ctx, input.reservation, { plan_id: plan.id });
      reservation = await persistNewReservation(ctx, built);
      warning = pastStartWarning(ctx, reservation.starts_at);
    } else {
      const existing = await ctx.store.getReservation(input.reservation_id as string);
      if (existing === null) {
        return notFound("reservation_id", `reservation ${input.reservation_id} not found`);
      }
      reservation = { ...existing, plan_id: plan.id, updated_at: nowIso(ctx) };
      await ctx.store.putReservation(reservation);
    }

    // Keep the plan's reservation_ids index in sync (idempotent).
    if (!plan.reservation_ids.includes(reservation.id)) {
      const updatedPlan = {
        ...plan,
        reservation_ids: [...plan.reservation_ids, reservation.id],
        updated_at: nowIso(ctx),
      };
      await ctx.store.putPlan(updatedPlan);
      return ok({ plan: updatedPlan, reservation }, warning);
    }
    return ok({ plan, reservation }, warning);
  },
};

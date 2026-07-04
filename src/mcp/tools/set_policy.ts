/**
 * set_policy — provide a concrete cancellation policy for a reservation
 * (SDD §7 / ADR-7, US-005, FR-007, Task 3.4).
 *
 * APPEND-style, never an overwrite of history: a `policy.provided`
 * DomainEvent is appended (the event log is the first-class record, §10.2)
 * and the stored reservation's `cancellation_policy` projection is updated —
 * resolving an `"unknown"` policy, or replacing a previously provided one.
 *
 * Allowed only while the policy can still matter: `candidate`, `confirmed`,
 * `to_cancel`. On `cancelled` / `done` / `voided` reservations the policy is
 * moot (the reservation's lifecycle is over), so the tool rejects with
 * `illegal_transition` rather than silently rewriting a closed record.
 */
import { z } from "zod";
import type { DomainEvent } from "../../core/schema/mod.ts";
import { cancellationPolicySchema, ulidSchema } from "../../core/schema/mod.ts";
import { append } from "../../core/eventlog/mod.ts";
import type { ToolContext } from "../context.ts";
import {
  notFound,
  nowIso,
  ok,
  type ToolDefinition,
  type ToolRunResult,
  transitionIds,
} from "./shared.ts";

const inputSchema = z.object({
  reservation_id: ulidSchema,
  policy: cancellationPolicySchema,
});

/** Statuses on which providing a policy still makes sense. */
const SETTABLE_STATUSES = new Set(["candidate", "confirmed", "to_cancel"]);

export const setPolicyTool: ToolDefinition<typeof inputSchema> = {
  name: "set_policy",
  description: "Provide a concrete cancellation policy for a reservation (resolving an " +
    '"unknown" policy or replacing a previously provided one). Appends a ' +
    "policy.provided event. Allowed only on candidate / confirmed / to_cancel reservations.",
  inputSchema,
  async run(ctx: ToolContext, input): Promise<ToolRunResult> {
    const reservation = await ctx.store.getReservation(input.reservation_id);
    if (reservation === null) {
      return notFound("reservation_id", `reservation ${input.reservation_id} not found`);
    }
    if (!SETTABLE_STATUSES.has(reservation.status)) {
      return {
        ok: false,
        error: {
          code: "illegal_transition",
          message: `illegal transition: cannot set_policy on a reservation in ` +
            `"${reservation.status}" state (allowed from: candidate|confirmed|to_cancel)`,
        },
      };
    }

    const ids = transitionIds(ctx);
    const at = nowIso(ctx);
    const event: DomainEvent = {
      id: ids.newId(),
      type: "policy.provided",
      entity_id: reservation.id,
      payload: {
        reservation_id: reservation.id,
        policy: input.policy,
        previous_policy_known: reservation.cancellation_policy !== "unknown",
      },
      caused_by: null,
      correlation_id: ids.correlationId,
      occurred_at: at,
    };
    await append(ctx.store, [event]);

    const updated = { ...reservation, cancellation_policy: input.policy, updated_at: at };
    await ctx.store.putReservation(updated);
    return ok({ reservation: updated, event });
  },
};

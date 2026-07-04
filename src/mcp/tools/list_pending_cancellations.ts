/**
 * list_pending_cancellations — the "要キャンセル一覧（期限順・損失額付き）"
 * (SDD §7, design.md). Lists `to_cancel` reservations ordered by the soonest
 * free-cancellation deadline, with a loss estimate per reservation.
 *
 * Ordering rules:
 *   1. Reservations whose policy is known and has a free-cancellation deadline,
 *      soonest deadline first (computed via `freeCancellationDeadline`).
 *   2. Reservations whose policy is known but structurally never charges (no
 *      deadline), after the above.
 *   3. Reservations with policy "unknown" LAST, flagged `unknown_policy: true`.
 *
 * The underlying `to_cancel` query is delegated to `store.listPendingCancellations`
 * (not reimplemented). Loss estimates come from the domain `estimateLoss`.
 */
import { z } from "zod";
import type { Reservation } from "../../core/schema/mod.ts";
import { estimateLoss, freeCancellationDeadline } from "../../core/domain/mod.ts";
import type { ToolContext } from "../context.ts";
import { ok, type ToolDefinition } from "./shared.ts";

const inputSchema = z.object({}).default({});

interface PendingItem {
  reservation: Reservation;
  unknown_policy: boolean;
  free_cancellation_deadline: string | null;
  loss_estimate: {
    policy_known: boolean;
    now_jpy: number | null;
    after_next_boundary_jpy: number | null;
  };
  // Sort key (not serialized): deadline instant, or null.
  _deadline: Temporal.Instant | null;
}

export const listPendingCancellationsTool: ToolDefinition<typeof inputSchema> = {
  name: "list_pending_cancellations",
  description: "List reservations awaiting cancellation (status to_cancel), ordered by " +
    "soonest free-cancellation deadline first, each with a loss estimate. " +
    'Reservations with an "unknown" policy are placed last and flagged.',
  inputSchema,
  async run(ctx: ToolContext) {
    const now = ctx.clock.now();
    const pending = await ctx.store.listPendingCancellations();

    const items: PendingItem[] = pending.map((reservation) => {
      const policy = reservation.cancellation_policy;
      const unknown = policy === "unknown";
      const startsAt = Temporal.Instant.from(reservation.starts_at);
      const deadline = unknown ? null : freeCancellationDeadline(policy, startsAt);
      const loss = estimateLoss(policy, startsAt, reservation.amount_jpy, now);
      return {
        reservation,
        unknown_policy: unknown,
        free_cancellation_deadline: deadline === null
          ? null
          : deadline.toString({ smallestUnit: "millisecond" }),
        loss_estimate: {
          policy_known: loss.policyKnown,
          now_jpy: loss.nowJpy,
          after_next_boundary_jpy: loss.afterNextBoundaryJpy,
        },
        _deadline: deadline,
      };
    });

    // Rank: known+deadline (0) < known+no-deadline (1) < unknown (2).
    function rank(item: PendingItem): number {
      if (item.unknown_policy) return 2;
      return item._deadline === null ? 1 : 0;
    }

    items.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (a._deadline !== null && b._deadline !== null) {
        return Temporal.Instant.compare(a._deadline, b._deadline);
      }
      // Same rank without deadlines: stable-ish fallback by starts_at.
      return a.reservation.starts_at.localeCompare(b.reservation.starts_at);
    });

    const pending_cancellations = items.map(({ _deadline: _drop, ...rest }) => rest);
    return ok({ pending_cancellations });
  },
};

/**
 * Debug tools (SDD §10.5, Task 3.4). Registered ONLY when the server is
 * built with the debug flag on (env `PLANCEL_DEBUG=1`, injectable in tests —
 * see `buildServer`). Never exposed in normal operation.
 *
 *   - debug_dump_state: every entity + the full domain event log.
 *   - debug_advance_clock: advance a VirtualClock by an ISO-8601 duration
 *     (errors when the context clock is not virtual, i.e. in production).
 *   - debug_preview_notifications: pure simulation of what WOULD fire in
 *     [as_of, as_of + horizon] (FR-010, SDD §10.3) — nothing is sent.
 *   - debug_causal_chain: walk an event's caused_by chain back to its root
 *     cause (SDD §10.2 — "why is this to_cancel" must be explainable).
 */
import { z } from "zod";
import { isoDateTimeSchema, ulidSchema } from "../../core/schema/mod.ts";
import { VirtualClock } from "../../core/clock/mod.ts";
import { causalChain } from "../../core/eventlog/mod.ts";
import { previewNotifications } from "../../notify/mod.ts";
import type { ToolContext } from "../context.ts";
import { notFound, nowIso, ok, type ToolDefinition } from "./shared.ts";

const emptySchema = z.object({}).default({});

/** ISO-8601 duration string, e.g. "P3D" or "PT12H". */
const isoDurationSchema = z.string().superRefine((value, ctx) => {
  try {
    Temporal.Duration.from(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `"${value}" is not a valid ISO-8601 duration (e.g. "P3D", "PT12H")`,
    });
  }
});

export const debugDumpStateTool: ToolDefinition<typeof emptySchema> = {
  name: "debug_dump_state",
  description: "DEBUG: dump all stored entities (events, plans, reservations, policy " +
    "templates, parse jobs, outbox) plus the full domain event log.",
  inputSchema: emptySchema,
  async run(ctx: ToolContext) {
    return ok({
      now: nowIso(ctx),
      events: await ctx.store.listEventEntities(),
      plans: await ctx.store.listPlans(),
      reservations: await ctx.store.listReservations(),
      policy_templates: await ctx.store.listPolicyTemplates(),
      parse_jobs: await ctx.store.listParseJobs(),
      outbox: await ctx.store.listOutboxEntries(),
      event_log: await ctx.store.listEvents(),
    });
  },
};

const advanceClockSchema = z.object({ duration: isoDurationSchema });

export const debugAdvanceClockTool: ToolDefinition<typeof advanceClockSchema> = {
  name: "debug_advance_clock",
  description: 'DEBUG: advance the VirtualClock by an ISO-8601 duration (e.g. "P3D"). ' +
    "Errors when the server runs on a real system clock.",
  inputSchema: advanceClockSchema,
  run(ctx: ToolContext, input) {
    if (!(ctx.clock instanceof VirtualClock)) {
      return Promise.resolve({
        ok: false as const,
        error: {
          code: "not_virtual_clock",
          message: "debug_advance_clock requires a VirtualClock; this server runs on a real clock",
        },
      });
    }
    ctx.clock.advance(input.duration);
    return Promise.resolve(ok({ now: nowIso(ctx) }));
  },
};

const previewSchema = z.object({
  as_of: isoDateTimeSchema.optional(),
  horizon: isoDurationSchema.optional(),
});

export const debugPreviewNotificationsTool: ToolDefinition<typeof previewSchema> = {
  name: "debug_preview_notifications",
  description: "DEBUG: simulate every notification that WOULD fire in [as_of, as_of + horizon] " +
    "(defaults: now, P7D) without sending anything.",
  inputSchema: previewSchema,
  async run(ctx: ToolContext, input) {
    const asOf = input.as_of === undefined ? ctx.clock.now() : Temporal.Instant.from(input.as_of);
    const horizon = input.horizon === undefined ? undefined : Temporal.Duration.from(input.horizon);
    const notifications = previewNotifications(
      {
        reservations: await ctx.store.listReservations(),
        plans: await ctx.store.listPlans(),
      },
      asOf,
      horizon,
    );
    return ok({
      as_of: asOf.toString({ smallestUnit: "millisecond" }),
      horizon: (horizon ?? Temporal.Duration.from("P7D")).toString(),
      notifications,
    });
  },
};

const causalChainSchema = z.object({ event_id: ulidSchema });

export const debugCausalChainTool: ToolDefinition<typeof causalChainSchema> = {
  name: "debug_causal_chain",
  description: "DEBUG: return the caused_by chain ending at a domain event, root cause first " +
    "(explains e.g. why a reservation became to_cancel).",
  inputSchema: causalChainSchema,
  async run(ctx: ToolContext, input) {
    const events = await ctx.store.listEvents();
    const chain = causalChain(events, input.event_id);
    if (chain.length === 0) {
      return notFound("event_id", `domain event ${input.event_id} not found`);
    }
    return ok({ chain });
  },
};

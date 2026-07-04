/**
 * create_event — create a non-exclusive Event bundle (SDD §3.0, §7).
 *
 * Event has no independent lifecycle state (§3.0: it is a stateless aggregation
 * view over its Plans/Reservations), so this simply validates the input,
 * stamps id/created_at/updated_at, and persists the record via `putEvent`.
 */
import { eventSchema } from "../../core/schema/mod.ts";
import type { ToolContext } from "../context.ts";
import { nowIso, ok, type ToolDefinition } from "./shared.ts";

const inputSchema = eventSchema
  .omit({ id: true, created_at: true, updated_at: true })
  .extend({
    date_range: eventSchema.shape.date_range.default(null),
    notes: eventSchema.shape.notes.default(null),
  });

export const createEventTool: ToolDefinition<typeof inputSchema> = {
  name: "create_event",
  description: "Create an Event: a non-exclusive bundle that groups related Plans and " +
    "Reservations (e.g. a trip or a business visit). Events hold no status of " +
    "their own; status is aggregated from their contents.",
  inputSchema,
  run(ctx: ToolContext, input) {
    const at = nowIso(ctx);
    const event = eventSchema.parse({
      ...input,
      id: ctx.ids.newUlid(),
      created_at: at,
      updated_at: at,
    });
    return ctx.store.putEvent(event).then(() => ok({ event }));
  },
};

/**
 * OutboxEntry (Task 3.2, SDD §6, design.md Data Models).
 *
 * Storage-layer shape of a queued notification: `PendingNotification`
 * (notify/types.ts) plus delivery state (`status` / `attempts` /
 * `delivered_at`). Deliberately kept in `core/schema` rather than importing
 * `notify/types.ts` here — `core` must not depend on `notify` (layering,
 * design.md Implementation Order) — so `trigger` is a plain non-empty
 * string rather than the closed `NotificationTrigger` union; `notify/outbox.ts`
 * narrows it back when reconstituting a `PendingNotification`.
 */
import { z } from "zod";
import { isoDateTimeSchema } from "./common.ts";

export const outboxStatusSchema = z.enum(["pending", "delivered", "failed"]);
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

export const outboxEntrySchema = z.object({
  /** `reservation_id (or plan/digest key) + trigger + 境界時刻(or day)`. */
  idempotency_key: z.string().min(1),
  trigger: z.string().min(1),
  reservation_id: z.string().min(1),
  fire_at: isoDateTimeSchema,
  message: z.string().min(1),

  // --- optional structured context, mirrors PendingNotification ---
  boundary_at: isoDateTimeSchema.optional(),
  now_loss_jpy: z.number().nullable().optional(),
  after_loss_jpy: z.number().nullable().optional(),
  reservation_ids: z.array(z.string()).optional(),
  remaining_to_cancel: z.number().optional(),

  // --- delivery state ---
  status: outboxStatusSchema,
  attempts: z.number().int().min(0),
  delivered_at: isoDateTimeSchema.nullable(),
});

export type OutboxEntry = z.infer<typeof outboxEntrySchema>;

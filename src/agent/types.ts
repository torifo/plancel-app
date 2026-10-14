/** Records the cancellation agent leaves behind: the decision log, proposals and notifications. */
import { z } from "zod";

export const stepSchema = z.object({
  seq: z.number().int(),
  phase: z.enum(["observe", "decide", "act"]),
  at: z.string(),
  tool: z.string().nullable().default(null),
  /** Arguments as sent, clipped (see sanitizeArgs). */
  args: z.record(z.unknown()).nullable().default(null),
  /** One short line: what the tool said, or what the model decided. */
  result: z.string().nullable().default(null),
});
export type Step = z.infer<typeof stepSchema>;

export const urgencySchema = z.enum(["low", "normal", "high"]);
export type Urgency = z.infer<typeof urgencySchema>;

export const proposalStatusSchema = z.enum(["pending", "approved", "rejected", "stale"]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const proposalSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  reservationId: z.string().min(1),
  /** Snapshot of the reservation when proposed (the row may change or vanish later). */
  service: z.string(),
  startsAt: z.string(),
  reason: z.string(),
  /** Japanese message to the venue, drafted for the user to send. Never sent by plancel. */
  draftMessage: z.string(),
  urgency: urgencySchema,
  /** Server-computed at proposal time, not taken from the model. */
  estimate: z.object({
    pctNow: z.number().nullable(),
    lossNowYen: z.number().nullable(),
    lossAfterNextBoundaryYen: z.number().nullable(),
    nextBoundaryAt: z.string().nullable(),
    freeUntil: z.string().nullable(),
  }),
  status: proposalStatusSchema,
  createdAt: z.string(),
  decidedAt: z.string().nullable().default(null),
  /** What approving or rejecting did, in words (or why it went stale). */
  outcome: z.string().nullable().default(null),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const notificationLevelSchema = z.enum(["info", "warning", "urgent"]);
export type NotificationLevel = z.infer<typeof notificationLevelSchema>;

/** Recorded in the log only: this build sends nothing to LINE or e-mail. */
export const notificationSchema = z.object({
  id: z.string().min(1),
  at: z.string(),
  level: notificationLevelSchema,
  title: z.string(),
  body: z.string(),
  reservationIds: z.array(z.string()),
});
export type Notification = z.infer<typeof notificationSchema>;

export const runTriggerSchema = z.enum(["scheduler", "manual"]);
export type RunTrigger = z.infer<typeof runTriggerSchema>;

export const runSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  trigger: runTriggerSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(["ok", "error"]),
  model: z.string(),
  transport: z.string(),
  steps: z.array(stepSchema),
  /** The agent's own closing report (Japanese). */
  summary: z.string().nullable(),
  error: z.string().nullable().default(null),
  toolCalls: z.number().int(),
  proposalIds: z.array(z.string()),
  notifications: z.array(notificationSchema),
  /** Hash of the ledger this run saw; lets the scheduler skip an unchanged ledger. */
  fingerprint: z.string(),
  usage: z.object({ promptTokens: z.number(), outputTokens: z.number() }).nullable().default(null),
});
export type Run = z.infer<typeof runSchema>;

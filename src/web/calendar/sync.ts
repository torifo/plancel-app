/**
 * Reservation → Google Calendar sync (spec §5).
 *
 * Reconcile-shaped: a sync message only says "look at (userId, resvId)";
 * the handler reads the reservation's CURRENT state and makes Google
 * match it (confirmed → upsert, anything else/deleted → remove event).
 * That makes retries and reordering harmless.
 *
 * Sync must never fail a user's request: the API layer fire-and-forgets
 * `requestSync`, failures re-enqueue with exponential backoff (30s·2^n,
 * max 5 tries). `invalid_grant` (revoked / 7-day testing expiry) is not
 * retried — the user record is marked `reauth` and the UI shows 要再接続.
 */
import { z } from "zod";
import { logger } from "../../lib/log.ts";
import { unseal } from "../../lib/seal.ts";
import { getReservation } from "../store.ts";
import {
  deleteGcalEvent,
  getGcalEvent,
  getUser,
  setGcalEvent,
  updateUser,
  type AuthIds,
} from "../users.ts";
import { GoogleAuthError, type GoogleOauthApp, refreshAccessToken } from "../auth/google.ts";
import { deleteEvent, ensureCalendar, upsertEvent } from "./gcal.ts";

export const syncMsgSchema = z.object({
  type: z.literal("gcal-sync"),
  userId: z.string().min(1),
  resvId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
});
export type SyncMsg = z.infer<typeof syncMsgSchema>;

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;

export interface SyncDeps {
  kv: Deno.Kv;
  ids: AuthIds;
  fetchFn: typeof fetch;
  google: GoogleOauthApp | null;
  kek: string | undefined;
  /** kv.enqueue in production; injected so tests capture messages. */
  enqueue(msg: SyncMsg, delayMs: number): Promise<void>;
}

const log = logger("web.gcal-sync");

/** Queues a reconcile for one reservation (call after any mutation). */
export async function requestSync(deps: SyncDeps, userId: string, resvId: string): Promise<void> {
  await deps.enqueue({ type: "gcal-sync", userId, resvId, attempt: 0 }, 0);
}

/** One reconcile pass; throws on retryable failure. */
export async function processSync(deps: SyncDeps, msg: SyncMsg): Promise<void> {
  if (deps.google === null) return;
  const user = await getUser(deps.kv, msg.userId);
  if (user === null || user.google === null || user.google.error !== null) return;

  let accessToken: string;
  try {
    const refreshToken = await unseal(user.google.refreshTokenSealed, deps.kek);
    if (refreshToken === "") throw new GoogleAuthError("invalid_grant", "empty refresh token");
    accessToken = await refreshAccessToken(deps.google, refreshToken, deps.fetchFn);
  } catch (err) {
    if (err instanceof GoogleAuthError && err.code === "invalid_grant") {
      log.warn("refresh token dead; marking reauth", { userId: msg.userId });
      await updateUser(deps.kv, msg.userId, (u) => ({
        ...u,
        google: u.google === null ? null : { ...u.google, error: "reauth" },
      }), deps.ids);
      return; // permanent — do not retry
    }
    throw err;
  }

  const gdeps = { fetchFn: deps.fetchFn, accessToken };
  const resv = await getReservation(deps.kv, user.ledgerId, msg.resvId);
  const mapping = await getGcalEvent(deps.kv, msg.userId, msg.resvId);

  if (resv !== null && resv.status === "confirmed") {
    const calendarId = await ensureCalendar(gdeps, user.google.calendarId);
    if (calendarId !== user.google.calendarId) {
      await updateUser(deps.kv, msg.userId, (u) => ({
        ...u,
        google: u.google === null ? null : { ...u.google, calendarId },
      }), deps.ids);
    }
    const eventId = await upsertEvent(gdeps, calendarId, mapping?.eventId ?? null, resv);
    await setGcalEvent(deps.kv, msg.userId, msg.resvId, {
      eventId,
      syncedAt: deps.ids.nowIso(),
    });
    return;
  }

  if (mapping !== null && user.google.calendarId !== null) {
    await deleteEvent(gdeps, user.google.calendarId, mapping.eventId);
    await deleteGcalEvent(deps.kv, msg.userId, msg.resvId);
  }
}

/**
 * Queue entrypoint: validates the raw message, runs a pass, re-enqueues
 * with backoff on retryable failure. Never throws (queue handlers that
 * throw would re-deliver forever).
 */
export async function handleSyncMessage(deps: SyncDeps, raw: unknown): Promise<void> {
  const parsed = syncMsgSchema.safeParse(raw);
  if (!parsed.success) return;
  const msg = parsed.data;
  try {
    await processSync(deps, msg);
  } catch (err) {
    if (msg.attempt + 1 >= MAX_ATTEMPTS) {
      log.error("sync gave up", { userId: msg.userId, resvId: msg.resvId, err: String(err) });
      return;
    }
    const delay = BACKOFF_BASE_MS * 2 ** msg.attempt;
    log.warn("sync failed; retrying", {
      userId: msg.userId,
      resvId: msg.resvId,
      attempt: msg.attempt + 1,
      delayMs: delay,
      err: String(err),
    });
    await deps.enqueue({ ...msg, attempt: msg.attempt + 1 }, delay);
  }
}

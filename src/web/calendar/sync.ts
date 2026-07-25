/**
 * Reservation → Google Calendar sync (spec §5).
 *
 * Reconcile-shaped: a sync task only says "look at (userId, resvId)";
 * the handler reads the reservation's CURRENT state and makes Google
 * match it (confirmed → upsert, anything else/deleted → remove event).
 * That makes retries and reordering harmless.
 *
 * QUEUE-FREE (2026-07-25): Deno Deploy's KV Connect does not support
 * kv.enqueue/listenQueue in production, so retries use a KV dirty flag
 * instead: `requestSync` marks ["gcal_dirty", userId, resvId], runs one
 * reconcile inline (never failing the user's request), and clears the
 * flag on success. Entries left dirty are retried by `sweepDirtySync`
 * from the existing 15-minute cron. `invalid_grant` (revoked / expiry)
 * is permanent — the user record is marked `reauth` (UI: 要再接続) and
 * the flag is cleared.
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

const DIRTY = "gcal_dirty";

export interface SyncDeps {
  kv: Deno.Kv;
  ids: AuthIds;
  fetchFn: typeof fetch;
  google: GoogleOauthApp | null;
  kek: string | undefined;
}

const log = logger("web.gcal-sync");

/**
 * Reconciles one reservation now (call after any mutation). Never throws:
 * a transient failure leaves the dirty flag for the cron sweep to retry.
 */
export async function requestSync(deps: SyncDeps, userId: string, resvId: string): Promise<void> {
  await deps.kv.set([DIRTY, userId, resvId], { at: deps.ids.nowIso() });
  try {
    await processSync(deps, { type: "gcal-sync", userId, resvId, attempt: 0 });
    await deps.kv.delete([DIRTY, userId, resvId]);
  } catch (err) {
    log.warn("sync failed; left dirty for the cron sweep", {
      userId,
      resvId,
      err: String(err),
    });
  }
}

/** Retries every dirty entry (wired into the 15-minute cron). */
export async function sweepDirtySync(deps: SyncDeps): Promise<number> {
  let repaired = 0;
  for await (const e of deps.kv.list({ prefix: [DIRTY] })) {
    const [, userId, resvId] = e.key as [string, string, string];
    try {
      await processSync(deps, { type: "gcal-sync", userId, resvId, attempt: 0 });
      await deps.kv.delete(e.key);
      repaired++;
    } catch (err) {
      log.warn("sweep retry failed; staying dirty", { userId, resvId, err: String(err) });
    }
  }
  return repaired;
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

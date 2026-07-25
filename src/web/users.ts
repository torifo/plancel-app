/**
 * Web user store — the identity layer that login (Google / magic link)
 * resolves through (spec: docs/superpowers/specs/2026-07-21-login-calendar-sync-design.md).
 *
 * A `WebUser` is an indirection over the reservation store: reservations
 * stay keyed by `ledgerId` (the value store.ts calls "token"), so the
 * reservation store is untouched by login. First login can ADOPT an
 * existing browser token as the user's ledgerId (zero-copy migration).
 *
 * Also owns: sessions (90d), magic-link tokens (15min, single-use, rate
 * limited), OAuth state (10min), iCal feed secrets, and the reservation ⇄
 * Google Calendar event mapping.
 */
import { z } from "zod";
import type { WebIds } from "./store.ts";

export const webUserGoogleSchema = z.object({
  sub: z.string().min(1),
  refreshTokenSealed: z.string(),
  calendarId: z.string().nullable(),
  /** null = healthy; "reauth" = refresh token dead, user must re-connect. */
  error: z.string().nullable(),
});
export type WebUserGoogle = z.infer<typeof webUserGoogleSchema>;

export const webUserSchema = z.object({
  id: z.string().min(1),
  // Lenient at rest (the /auth/email route validates strictly at the edge):
  // dev users like `dev@local` (PLANCEL_DEV_USER) must survive a re-read.
  email: z.string().regex(/^\S+@\S+$/),
  ledgerId: z.string().min(1),
  icsSecret: z.string().min(1),
  /** Personal API token (MCP 連携). Defaulted so older records still parse. */
  apiToken: z.string().nullable().default(null),
  google: webUserGoogleSchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type WebUser = z.infer<typeof webUserSchema>;

/** WebIds + the extra generators auth needs (all injected for tests). */
export interface AuthIds extends WebIds {
  nowMs(): number;
  /** Cryptographically random, URL-safe token (sessions, secrets, state). */
  randomToken(): string;
}

const USER = "webuser";
const BY_EMAIL = "webuser_email";
const BY_GOOGLE = "webuser_google";
const SESSION = "websession";
const MAGIC = "magic";
const MAGIC_RATE = "magic_rate";
const OAUTH_STATE = "oauth_state";
const ICS = "ics_secret";
const APITOKEN = "apitoken";
const GCAL = "gcal_map";

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const MAGIC_TTL_MS = 15 * 60 * 1000;
export const MAGIC_RATE_LIMIT = 3; // per hour per address
const MAGIC_RATE_WINDOW_MS = 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// ---------- users ----------

export async function getUser(kv: Deno.Kv, id: string): Promise<WebUser | null> {
  const e = await kv.get<WebUser>([USER, id]);
  const parsed = webUserSchema.safeParse(e.value);
  return parsed.success ? parsed.data : null;
}

async function userIdFromIndex(kv: Deno.Kv, key: Deno.KvKey): Promise<WebUser | null> {
  const e = await kv.get<string>(key);
  return e.value === null ? null : await getUser(kv, e.value);
}

export function findUserByEmail(kv: Deno.Kv, email: string): Promise<WebUser | null> {
  return userIdFromIndex(kv, [BY_EMAIL, normalizeEmail(email)]);
}

export function findUserByGoogleSub(kv: Deno.Kv, sub: string): Promise<WebUser | null> {
  return userIdFromIndex(kv, [BY_GOOGLE, sub]);
}

export function findUserByIcsSecret(kv: Deno.Kv, secret: string): Promise<WebUser | null> {
  return userIdFromIndex(kv, [ICS, secret]);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Total registered users — the signup-cap gate (owner 2026-07-23). */
export async function countUsers(kv: Deno.Kv): Promise<number> {
  let n = 0;
  for await (const _ of kv.list({ prefix: [USER] })) n++;
  return n;
}

async function putUser(kv: Deno.Kv, user: WebUser): Promise<void> {
  await kv.set([USER, user.id], user);
}

export async function getOrCreateUserByEmail(
  kv: Deno.Kv,
  email: string,
  ids: AuthIds,
): Promise<WebUser> {
  const norm = normalizeEmail(email);
  const existing = await findUserByEmail(kv, norm);
  if (existing !== null) return existing;
  const now = ids.nowIso();
  const user: WebUser = {
    id: ids.newId(),
    email: norm,
    ledgerId: ids.newId(),
    icsSecret: ids.randomToken(),
    apiToken: null,
    google: null,
    created_at: now,
    updated_at: now,
  };
  await kv.atomic()
    .set([USER, user.id], user)
    .set([BY_EMAIL, norm], user.id)
    .set([ICS, user.icsSecret], user.id)
    .commit();
  return user;
}

export async function updateUser(
  kv: Deno.Kv,
  id: string,
  mutate: (u: WebUser) => WebUser,
  ids: AuthIds,
): Promise<WebUser | null> {
  const cur = await getUser(kv, id);
  if (cur === null) return null;
  const next = { ...mutate(cur), updated_at: ids.nowIso() };
  await putUser(kv, next);
  return next;
}

/** Links a Google account (sub index + sealed refresh token) to a user. */
export async function linkGoogle(
  kv: Deno.Kv,
  userId: string,
  google: WebUserGoogle,
  ids: AuthIds,
): Promise<WebUser | null> {
  const user = await updateUser(kv, userId, (u) => ({ ...u, google }), ids);
  if (user !== null) await kv.set([BY_GOOGLE, google.sub], userId);
  return user;
}

/**
 * Adopts a pre-login browser token as the user's ledgerId. Only allowed
 * while the user's own ledger is still empty (checked by the caller via
 * `ledgerIsEmpty` to keep this module free of store.ts imports).
 */
export async function adoptLedger(
  kv: Deno.Kv,
  userId: string,
  token: string,
  ids: AuthIds,
): Promise<WebUser | null> {
  return await updateUser(kv, userId, (u) => ({ ...u, ledgerId: token }), ids);
}

export async function rotateIcsSecret(
  kv: Deno.Kv,
  userId: string,
  ids: AuthIds,
): Promise<WebUser | null> {
  const cur = await getUser(kv, userId);
  if (cur === null) return null;
  const secret = ids.randomToken();
  const next: WebUser = { ...cur, icsSecret: secret, updated_at: ids.nowIso() };
  await kv.atomic()
    .delete([ICS, cur.icsSecret])
    .set([ICS, secret], userId)
    .set([USER, userId], next)
    .commit();
  return next;
}

// ---------- personal API tokens (MCP 連携, owner 2026-07-23) ----------

export function findUserByApiToken(kv: Deno.Kv, token: string): Promise<WebUser | null> {
  return userIdFromIndex(kv, [APITOKEN, token]);
}

/** Issues (or rotates) the user's single personal API token. */
export async function issueApiToken(
  kv: Deno.Kv,
  userId: string,
  ids: AuthIds,
): Promise<string | null> {
  const cur = await getUser(kv, userId);
  if (cur === null) return null;
  const token = ids.randomToken();
  const next: WebUser = { ...cur, apiToken: token, updated_at: ids.nowIso() };
  const tx = kv.atomic().set([APITOKEN, token], userId).set([USER, userId], next);
  if (cur.apiToken !== null) tx.delete([APITOKEN, cur.apiToken]);
  await tx.commit();
  return token;
}

export async function revokeApiToken(kv: Deno.Kv, userId: string, ids: AuthIds): Promise<void> {
  const cur = await getUser(kv, userId);
  if (cur === null || cur.apiToken === null) return;
  await kv.atomic()
    .delete([APITOKEN, cur.apiToken])
    .set([USER, userId], { ...cur, apiToken: null, updated_at: ids.nowIso() })
    .commit();
}

// ---------- sessions ----------

const sessionSchema = z.object({ userId: z.string(), expiresAt: z.number() });

export async function createSession(kv: Deno.Kv, userId: string, ids: AuthIds): Promise<string> {
  const sid = ids.randomToken();
  await kv.set([SESSION, sid], { userId, expiresAt: ids.nowMs() + SESSION_TTL_MS }, {
    expireIn: SESSION_TTL_MS,
  });
  return sid;
}

export async function getSessionUser(
  kv: Deno.Kv,
  sid: string,
  nowMs: number,
): Promise<WebUser | null> {
  const e = await kv.get([SESSION, sid]);
  const parsed = sessionSchema.safeParse(e.value);
  if (!parsed.success) return null;
  if (parsed.data.expiresAt <= nowMs) {
    await kv.delete([SESSION, sid]);
    return null;
  }
  return await getUser(kv, parsed.data.userId);
}

export async function deleteSession(kv: Deno.Kv, sid: string): Promise<void> {
  await kv.delete([SESSION, sid]);
}

// ---------- magic links ----------

const magicSchema = z.object({ email: z.string(), expiresAt: z.number() });
const magicRateSchema = z.object({ count: z.number() });

/** True if this address may be sent another link (counts the attempt). */
export async function allowMagicSend(kv: Deno.Kv, email: string): Promise<boolean> {
  const key = [MAGIC_RATE, normalizeEmail(email)];
  const cur = magicRateSchema.safeParse((await kv.get(key)).value);
  const count = cur.success ? cur.data.count : 0;
  if (count >= MAGIC_RATE_LIMIT) return false;
  await kv.set(key, { count: count + 1 }, { expireIn: MAGIC_RATE_WINDOW_MS });
  return true;
}

export async function createMagicLink(kv: Deno.Kv, email: string, ids: AuthIds): Promise<string> {
  const token = ids.randomToken();
  await kv.set([MAGIC, token], {
    email: normalizeEmail(email),
    expiresAt: ids.nowMs() + MAGIC_TTL_MS,
  }, { expireIn: MAGIC_TTL_MS });
  return token;
}

/** Single-use: deletes the token on read; null when unknown or expired. */
export async function consumeMagicLink(
  kv: Deno.Kv,
  token: string,
  nowMs: number,
): Promise<string | null> {
  const e = await kv.get([MAGIC, token]);
  const parsed = magicSchema.safeParse(e.value);
  if (!parsed.success) return null;
  await kv.delete([MAGIC, token]);
  return parsed.data.expiresAt > nowMs ? parsed.data.email : null;
}

// ---------- oauth state ----------

const oauthStateSchema = z.object({ verifier: z.string() });

export async function saveOauthState(kv: Deno.Kv, state: string, verifier: string): Promise<void> {
  await kv.set([OAUTH_STATE, state], { verifier }, { expireIn: OAUTH_STATE_TTL_MS });
}

/** Single-use: returns the PKCE verifier and deletes the state. */
export async function takeOauthState(kv: Deno.Kv, state: string): Promise<string | null> {
  const e = await kv.get([OAUTH_STATE, state]);
  const parsed = oauthStateSchema.safeParse(e.value);
  if (!parsed.success) return null;
  await kv.delete([OAUTH_STATE, state]);
  return parsed.data.verifier;
}

// ---------- reservation ⇄ Google Calendar event mapping ----------

const gcalMapSchema = z.object({ eventId: z.string(), syncedAt: z.string() });
export type GcalMapEntry = z.infer<typeof gcalMapSchema>;

export async function getGcalEvent(
  kv: Deno.Kv,
  userId: string,
  resvId: string,
): Promise<GcalMapEntry | null> {
  const parsed = gcalMapSchema.safeParse((await kv.get([GCAL, userId, resvId])).value);
  return parsed.success ? parsed.data : null;
}

export async function setGcalEvent(
  kv: Deno.Kv,
  userId: string,
  resvId: string,
  entry: GcalMapEntry,
): Promise<void> {
  await kv.set([GCAL, userId, resvId], entry);
}

export async function deleteGcalEvent(kv: Deno.Kv, userId: string, resvId: string): Promise<void> {
  await kv.delete([GCAL, userId, resvId]);
}

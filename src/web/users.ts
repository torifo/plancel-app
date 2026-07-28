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
 * limited), OAuth state (10min), iCal feed secrets, the per-user mail-intake
 * secret (the forward-to address, see ./email-intake.ts), the per-user LINE
 * link (+ its one-time 10min link code), and the reservation ⇄ Google Calendar
 * event mapping.
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
  /**
   * Secret in the user's mail-intake address (`p-<mailSecret>@<domain>`, see
   * ./email-intake.ts). Nullable and defaulted because accounts created before
   * 2026-07-28 have none: `ensureMailSecret` issues one on first read, exactly
   * as `issueApiToken` issues on demand.
   */
  mailSecret: z.string().nullable().default(null),
  /** Personal API token (MCP 連携). Defaulted so older records still parse. */
  apiToken: z.string().nullable().default(null),
  /** 表示名 (non-unique) — invites show this; null falls back to the email. */
  displayName: z.string().nullable().default(null),
  /** Unique handle the user picks on マイページ (invite lookup, ^[a-z0-9_-]{3,20}$). */
  uid: z.string().nullable().default(null),
  /**
   * Linked LINE userId — the per-user LINE binding (owner 2026-07-27). At most
   * one web user per LINE id (enforced by the `line_user` index).
   */
  lineUserId: z.string().nullable().default(null),
  /**
   * The user's outstanding one-time LINE link code, i.e. the key stored at
   * `["line_link_code", code]`. Held on the record for the same reason
   * `apiToken` is: KV cannot look a key up by its value, so re-issuing has to
   * know the previous code in order to invalidate it. Goes stale once the KV
   * entry's 10-minute TTL lapses — only `issueLineLinkCode` and
   * `deleteAccount` ever read it, never the link check itself.
   */
  lineLinkCode: z.string().nullable().default(null),
  /** Additional login address (e.g. icloud.com) — shares the email index. */
  altEmail: z.string().nullable().default(null),
  /** PBKDF2 hash; null = password login not set up. */
  passwordHash: z.string().nullable().default(null),
  /**
   * True when the primary email's ownership was proven (Google id_token /
   * magic link). Password-signup accounts are false until linked — and an
   * UNVERIFIED account is never auto-merged into a Google login with the
   * same address (account-takeover guard; linking is explicit).
   */
  emailVerified: z.boolean().default(true),
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
const MAIL = "mail_secret";
const APITOKEN = "apitoken";
const BY_UID = "webuser_uid";
const BY_LINE = "line_user";
const LINE_CODE = "line_link_code";
const GCAL = "gcal_map";
// Per-user prefixes cleared on 退会. `gcal_dirty` mirrors sync.ts's DIRTY;
// shared_in / resv_members are future sharing tables — listing a prefix that
// no code writes yet is simply empty, so sweeping them here is a harmless no-op.
const DIRTY = "gcal_dirty";
const SHARED_IN = "shared_in";
const RESV_MEMBERS = "resv_members";
// Reservation store layout (mirrors store.ts NS/RESV) — kept local so this
// module stays free of a store.ts import.
const WEB_NS = "web";
const WEB_RESV = "resv";

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const MAGIC_TTL_MS = 15 * 60 * 1000;
export const LINE_CODE_TTL_MS = 10 * 60 * 1000;
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

/**
 * Resolves the ledger a forwarded mail belongs to. This index — never the
 * envelope's `from`, which anyone can forge — is the identity of an inbound
 * mail (see ./email-intake.ts).
 */
export function findUserByMailSecret(kv: Deno.Kv, secret: string): Promise<WebUser | null> {
  return userIdFromIndex(kv, [MAIL, secret]);
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
  opts: { emailVerified?: boolean; passwordHash?: string | null } = {},
): Promise<WebUser> {
  const norm = normalizeEmail(email);
  const existing = await findUserByEmail(kv, norm);
  if (existing !== null) return existing;
  const now = ids.nowIso();
  const mailSecret = ids.randomToken();
  const user: WebUser = {
    id: ids.newId(),
    email: norm,
    ledgerId: ids.newId(),
    icsSecret: ids.randomToken(),
    mailSecret,
    apiToken: null,
    displayName: null,
    uid: null,
    lineUserId: null,
    lineLinkCode: null,
    altEmail: null,
    passwordHash: opts.passwordHash ?? null,
    emailVerified: opts.emailVerified ?? true,
    google: null,
    created_at: now,
    updated_at: now,
  };
  await kv.atomic()
    .set([USER, user.id], user)
    .set([BY_EMAIL, norm], user.id)
    .set([ICS, user.icsSecret], user.id)
    .set([MAIL, mailSecret], user.id)
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

// ---------- mail intake address (メール転送, owner 2026-07-27) ----------

/**
 * Local-part prefix of the forward-to address. A leading letter keeps the
 * local part valid for every mail client, and the fixed prefix is what tells
 * the webhook that a recipient is a plancel intake address at all.
 */
export const MAIL_LOCAL_PREFIX = "p-";

/** The address a user forwards reservation mail to: `p-<secret>@<domain>`. */
export function mailAddressFor(secret: string, domain: string): string {
  return `${MAIL_LOCAL_PREFIX}${secret}@${domain}`;
}

/**
 * The secret inside a recipient address, or null when it is not an intake
 * address. Accepts `Name <addr>` display forms (what forwarding clients and
 * Resend put in `to`), and matches the prefix case-insensitively while keeping
 * the secret verbatim — the secret is the KV key and must not be folded.
 *
 * The domain is deliberately ignored: Resend only delivers mail addressed to
 * plancel's own receiving domains, so the secret alone decides the ledger, and
 * adding a custom domain later needs no code change.
 */
export function mailSecretFromAddress(address: string): string | null {
  const angled = address.match(/<([^>]*)>/);
  const bare = (angled?.[1] ?? address).trim();
  const at = bare.lastIndexOf("@");
  const local = at < 0 ? bare : bare.slice(0, at);
  if (!local.toLowerCase().startsWith(MAIL_LOCAL_PREFIX)) return null;
  const secret = local.slice(MAIL_LOCAL_PREFIX.length);
  return secret === "" ? null : secret;
}

/**
 * The user's mail-intake secret, issued on first use. Accounts predating the
 * feature carry none, and `/auth/me` is where the address becomes visible — so
 * the issue happens there (one write, once per account) rather than in a
 * migration.
 */
export async function ensureMailSecret(
  kv: Deno.Kv,
  userId: string,
  ids: AuthIds,
): Promise<string | null> {
  const cur = await getUser(kv, userId);
  if (cur === null) return null;
  if (cur.mailSecret !== null) return cur.mailSecret;
  const mailSecret = ids.randomToken();
  await kv.atomic()
    .set([MAIL, mailSecret], userId)
    .set([USER, userId], { ...cur, mailSecret, updated_at: ids.nowIso() })
    .commit();
  return mailSecret;
}

/**
 * Issues a fresh mail-intake secret and retires the old index — the recovery
 * path for an address that leaked (anyone holding it can add candidates to the
 * ledger).
 */
export async function rotateMailSecret(
  kv: Deno.Kv,
  userId: string,
  ids: AuthIds,
): Promise<WebUser | null> {
  const cur = await getUser(kv, userId);
  if (cur === null) return null;
  const mailSecret = ids.randomToken();
  const next: WebUser = { ...cur, mailSecret, updated_at: ids.nowIso() };
  const tx = kv.atomic()
    .set([MAIL, mailSecret], userId)
    .set([USER, userId], next);
  if (cur.mailSecret !== null) tx.delete([MAIL, cur.mailSecret]);
  await tx.commit();
  return next;
}

// ---------- profile: uid / alt email / password (owner 2026-07-23) ----------

// Lowercase letters only (owner 2026-07-23): with the signup cap this is
// plenty, and it keeps ids readable/typeable. Storage accepts 3+ so admin
// accounts can claim short RESERVED uids (e.g. `admin`); ordinary users
// are held to 6+ at the route (MIN_PUBLIC_UID_LEN).
export const uidSchema = z.string().regex(/^[a-z]{3,20}$/);
export const MIN_PUBLIC_UID_LEN = 6;

/**
 * Uids ordinary users may NOT claim (owner 2026-07-23). Admin accounts
 * (PLANCEL_ADMIN_EMAILS) may claim them — the developer plans to take
 * `admin` (開発者アカウント) and `torifo` (開発者の使用アカウント).
 */
export const RESERVED_UIDS = new Set([
  "admin",
  "administrator",
  "root",
  "system",
  "support",
  "help",
  "info",
  "official",
  "staff",
  "owner",
  "moderator",
  "operator",
  "dev",
  "developer",
  "plancel",
  "torifo",
]);

export function findUserByUid(kv: Deno.Kv, uid: string): Promise<WebUser | null> {
  return userIdFromIndex(kv, [BY_UID, uid]);
}

/** Claims a unique uid for the user. False when the uid is already taken. */
export async function setUid(
  kv: Deno.Kv,
  userId: string,
  uid: string,
  ids: AuthIds,
): Promise<boolean> {
  const cur = await getUser(kv, userId);
  if (cur === null) return false;
  if (cur.uid === uid) return true;
  const key = [BY_UID, uid];
  const tx = kv.atomic()
    .check({ key, versionstamp: null }) // fails when someone owns this uid
    .set(key, userId)
    .set([USER, userId], { ...cur, uid, updated_at: ids.nowIso() });
  if (cur.uid !== null) tx.delete([BY_UID, cur.uid]);
  return (await tx.commit()).ok;
}

/** Registers an additional login address. False when the address is taken. */
export async function setAltEmail(
  kv: Deno.Kv,
  userId: string,
  email: string,
  ids: AuthIds,
): Promise<boolean> {
  const cur = await getUser(kv, userId);
  if (cur === null) return false;
  const norm = normalizeEmail(email);
  if (norm === cur.email || norm === cur.altEmail) return true;
  const key = [BY_EMAIL, norm];
  const tx = kv.atomic()
    .check({ key, versionstamp: null })
    .set(key, userId)
    .set([USER, userId], { ...cur, altEmail: norm, updated_at: ids.nowIso() });
  if (cur.altEmail !== null) tx.delete([BY_EMAIL, cur.altEmail]);
  return (await tx.commit()).ok;
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

// ---------- LINE linking (per-user, owner 2026-07-27) ----------

/**
 * Every plancel user has their OWN LINE account, so the LINE binding is a
 * per-user link (it used to be one env-configured owner). The `line_user`
 * index is the authorization the webhook reads: a LINE userId resolves to at
 * most one web user, and that user's ledger is the only one the sender can
 * touch.
 */
export function findUserByLineUserId(kv: Deno.Kv, lineUserId: string): Promise<WebUser | null> {
  return userIdFromIndex(kv, [BY_LINE, lineUserId]);
}

/**
 * Result of a link attempt. `taken` = that LINE id already belongs to a
 * DIFFERENT web user (the caller reports it rather than stealing the link).
 */
export type LinkLineOutcome = "linked" | "taken" | "no_user";

/** Links a LINE userId to a web user. Re-linking the same pair is a no-op. */
export async function linkLineUser(
  kv: Deno.Kv,
  userId: string,
  lineUserId: string,
  ids: AuthIds,
): Promise<LinkLineOutcome> {
  const cur = await getUser(kv, userId);
  if (cur === null) return "no_user";
  if (cur.lineUserId === lineUserId) return "linked";
  const key = [BY_LINE, lineUserId];
  const tx = kv.atomic()
    .check({ key, versionstamp: null }) // fails when another user owns this LINE id
    .set(key, userId)
    .set([USER, userId], { ...cur, lineUserId, updated_at: ids.nowIso() });
  if (cur.lineUserId !== null) tx.delete([BY_LINE, cur.lineUserId]);
  return (await tx.commit()).ok ? "linked" : "taken";
}

export async function unlinkLineUser(kv: Deno.Kv, userId: string, ids: AuthIds): Promise<void> {
  const cur = await getUser(kv, userId);
  if (cur === null || cur.lineUserId === null) return;
  await kv.atomic()
    .delete([BY_LINE, cur.lineUserId])
    .set([USER, userId], { ...cur, lineUserId: null, updated_at: ids.nowIso() })
    .commit();
}

// Unambiguous alphabet: no O/0/I/l/1 — the code is read off a screen and typed
// into a phone keyboard.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;

const lineCodeSchema = z.object({ userId: z.string(), created_at: z.string() });

/**
 * Folds the injected random token (32 random bytes hex in production) into
 * `CODE_LEN` characters of the typable alphabet. Entropy comes only from
 * `ids.randomToken` so tests stay deterministic; ~40 bits over a 10-minute
 * single-use window is far beyond guessing through a chat channel.
 */
function lineLinkCodeFrom(token: string): string {
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    const a = token.charCodeAt((i * 2) % token.length);
    const b = token.charCodeAt((i * 2 + 1) % token.length);
    out += CODE_ALPHABET[(a * 257 + b) % CODE_ALPHABET.length];
  }
  return out;
}

/** Accepts what a human types: casing, spaces and hyphens are all forgiven. */
export function normalizeLineLinkCode(text: string): string {
  return text.trim().toUpperCase().replaceAll(/[\s-]/g, "");
}

/** True when the text could be a link code at all (cheap pre-check). */
export function looksLikeLineLinkCode(text: string): boolean {
  const code = normalizeLineLinkCode(text);
  return code.length === CODE_LEN && [...code].every((c) => CODE_ALPHABET.includes(c));
}

/**
 * Issues the user's one-time LINE link code, invalidating the previous one.
 * The LINE `userId` in a webhook event is never trusted as proof of identity —
 * this code, typed into the chat from a logged-in session, is.
 */
export async function issueLineLinkCode(
  kv: Deno.Kv,
  userId: string,
  ids: AuthIds,
): Promise<string | null> {
  const cur = await getUser(kv, userId);
  if (cur === null) return null;
  const code = lineLinkCodeFrom(ids.randomToken());
  const tx = kv.atomic()
    .set([LINE_CODE, code], { userId, created_at: ids.nowIso() }, { expireIn: LINE_CODE_TTL_MS })
    .set([USER, userId], { ...cur, lineLinkCode: code, updated_at: ids.nowIso() });
  if (cur.lineLinkCode !== null && cur.lineLinkCode !== code) {
    tx.delete([LINE_CODE, cur.lineLinkCode]);
  }
  await tx.commit();
  return code;
}

/**
 * Single-use: deletes the code on read and returns its userId; null when
 * unknown or expired. KV's `expireIn` is the primary TTL; `created_at` is
 * re-checked against the injected clock so expiry is deterministic in tests
 * (same belt-and-braces as `consumeMagicLink`).
 */
export async function consumeLineLinkCode(
  kv: Deno.Kv,
  code: string,
  nowMs: number,
): Promise<string | null> {
  const key = [LINE_CODE, normalizeLineLinkCode(code)];
  const parsed = lineCodeSchema.safeParse((await kv.get(key)).value);
  if (!parsed.success) return null;
  await kv.delete(key);
  const createdMs = Temporal.Instant.from(parsed.data.created_at).epochMilliseconds;
  return createdMs + LINE_CODE_TTL_MS > nowMs ? parsed.data.userId : null;
}

// ---------- account deletion (退会, owner 2026-07-25) ----------

/**
 * Permanently deletes a user and everything keyed to them. Sequential deletes
 * (not one atomic): the reservation / index sets are unbounded, so this stays
 * clear of KV's atomic-batch limits and is idempotent if a retry re-runs it.
 *
 * Sessions are deliberately NOT swept (that would need a full-KV scan). Once
 * this user record is gone, getSessionUser → getUser returns null for any
 * surviving session, so a stale cookie is already inert; the route also
 * expires the caller's own cookie in its response.
 *
 * `ids` is accepted for signature parity with the other user mutators (no
 * timestamps are written on a delete, so it is unused here).
 */
export async function deleteAccount(
  kv: Deno.Kv,
  userId: string,
  _ids: AuthIds,
): Promise<void> {
  const user = await getUser(kv, userId);
  if (user === null) return;

  // 1. reservations in the user's own ledger AND its demo namespace.
  for (const ledger of [user.ledgerId, `${user.ledgerId}::demo`]) {
    for await (const e of kv.list({ prefix: [WEB_NS, ledger, WEB_RESV] })) {
      await kv.delete(e.key);
    }
  }

  // 1.5 share MIRRORS (integration with sharing.ts): the per-user prefixes
  // below only cover this user's own side of each share, so delete the
  // counterpart rows first — the owner-side member rows where this user was
  // a member, and each member's shared_in row where this user was the owner.
  for await (const e of kv.list({ prefix: [SHARED_IN, userId] })) {
    const [, , ownerId, resvId] = e.key as [string, string, string, string];
    await kv.delete([RESV_MEMBERS, ownerId, resvId, userId]);
  }
  for await (const e of kv.list({ prefix: [RESV_MEMBERS, userId] })) {
    const [, , resvId, memberId] = e.key as [string, string, string, string];
    await kv.delete([SHARED_IN, memberId, userId, resvId]);
  }

  // 2. per-user prefixes (a prefix no code writes lists as empty — safe).
  for (
    const prefix of [[GCAL, userId], [DIRTY, userId], [SHARED_IN, userId], [RESV_MEMBERS, userId]]
  ) {
    for await (const e of kv.list({ prefix })) {
      await kv.delete(e.key);
    }
  }

  // 3. the user record + every unique index that resolves to it.
  await kv.delete([USER, userId]);
  await kv.delete([BY_EMAIL, user.email]);
  if (user.altEmail !== null) await kv.delete([BY_EMAIL, user.altEmail]);
  if (user.google !== null) await kv.delete([BY_GOOGLE, user.google.sub]);
  if (user.uid !== null) await kv.delete([BY_UID, user.uid]);
  await kv.delete([ICS, user.icsSecret]);
  // Leaving this behind would let a forwarded mail resolve to a deleted user.
  if (user.mailSecret !== null) await kv.delete([MAIL, user.mailSecret]);
  if (user.apiToken !== null) await kv.delete([APITOKEN, user.apiToken]);
  // The LINE link must go with the account: leaving the reverse index behind
  // would let that LINE sender resolve to a deleted user.
  if (user.lineUserId !== null) await kv.delete([BY_LINE, user.lineUserId]);
  if (user.lineLinkCode !== null) await kv.delete([LINE_CODE, user.lineLinkCode]);
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

const oauthStateSchema = z.object({
  verifier: z.string(),
  /** Set when this flow LINKS Google to an existing logged-in user. */
  linkUserId: z.string().nullable().default(null),
});
export type OauthState = z.infer<typeof oauthStateSchema>;

export async function saveOauthState(
  kv: Deno.Kv,
  state: string,
  verifier: string,
  linkUserId: string | null = null,
): Promise<void> {
  await kv.set([OAUTH_STATE, state], { verifier, linkUserId }, { expireIn: OAUTH_STATE_TTL_MS });
}

/** Single-use: returns the PKCE verifier (+link target) and deletes the state. */
export async function takeOauthState(kv: Deno.Kv, state: string): Promise<OauthState | null> {
  const e = await kv.get([OAUTH_STATE, state]);
  const parsed = oauthStateSchema.safeParse(e.value);
  if (!parsed.success) return null;
  await kv.delete([OAUTH_STATE, state]);
  return parsed.data;
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

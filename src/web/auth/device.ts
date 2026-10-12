/**
 * Device pairing — RFC 8628 (OAuth 2.0 Device Authorization Grant) in
 * plancel's own shape (issue #1, owner 2026-10-12).
 *
 * The problem: the MCP server runs on a PC, the person lives in the phone's
 * PWA, and they should not have to log the phone's account into the PC's
 * browser just to hand Claude a token. So the PC shows a short code and the
 * phone — already logged in — approves it. Same move as a TV app.
 *
 * Two parties, four verbs:
 *   the PC   POST /auth/device/code   → { device_code, user_code, … }   (no auth)
 *            POST /auth/device/token  → poll until approved             (no auth)
 *   the phone GET  /auth/device/pending?code=  → who is asking          (session)
 *            POST /auth/device/approve | deny                           (session)
 *
 * The phone side runs on `requestUser` ONLY — a session cookie, never a
 * header token. If a header token could approve, one leaked token would
 * mint unlimited new ones. Listing and revoking tokens live under the same
 * rule (../users.ts).
 *
 * Phishing (RFC 8628 §5.4): an attacker runs their own MCP, gets a code, and
 * talks the victim into approving it on the victim's phone. Nothing here can
 * stop a person who decides to type a stranger's code, so the approval
 * screen has to make the decision legible: who is asking (their own words,
 * never trusted), when, and which account is about to be exposed. The server
 * does its part by never accepting a code from a URL — there is no
 * `verification_uri_complete` on purpose — and by binding the exchange to
 * exactly one successful token.
 *
 * KV:
 *   ["device_code", device_code] → DeviceRecord            expireIn 10 min
 *   ["device_user_code", user_code] → device_code          expireIn 10 min
 */
import { z } from "zod";
import {
  API_TOKEN_LIMIT,
  ApiTokenLimitError,
  type AuthIds,
  getUser,
  issueApiToken,
  looksLikeTypableCode,
  normalizeTypableCode,
  typableCodeFrom,
  type WebUser,
} from "../users.ts";

const DEVICE = "device_code";
const BY_USER_CODE = "device_user_code";

/** How long a code lives (RFC 8628 `expires_in`). Pinned by the UI mirror test. */
export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
/** The polling interval the PC is told to keep (RFC 8628 `interval`). */
export const DEVICE_POLL_INTERVAL_SEC = 5;
/** Polls past this count end the record: a client that will not slow down is done. */
export const DEVICE_MAX_POLLS = 200;
/** How much a `slow_down` adds to the interval (RFC 8628 §3.5). */
const SLOW_DOWN_STEP_SEC = 5;

const statusSchema = z.enum(["pending", "approved", "denied"]);

const recordSchema = z.object({
  userCode: z.string(),
  /** The PC's own description of itself. Displayed, never trusted. */
  clientName: z.string(),
  created_at: z.string(),
  status: statusSchema,
  /** Set on approval. */
  userId: z.string().nullable().default(null),
  tokenId: z.string().nullable().default(null),
  /** The issued token, held only until the one exchange that consumes the record. */
  token: z.string().nullable().default(null),
  accountLabel: z.string().nullable().default(null),
  lastPollMs: z.number().nullable().default(null),
  pollCount: z.number().int().default(0),
  /** Current required spacing between polls; grows on slow_down. */
  intervalSec: z.number().int().default(DEVICE_POLL_INTERVAL_SEC),
});
export type DeviceRecord = z.infer<typeof recordSchema>;

export interface DeviceDeps {
  kv: Deno.Kv;
  ids: AuthIds;
}

const clientNameSchema = z.string()
  .transform((v) => v.replaceAll(/[\p{Cc}]/gu, "").trim())
  .pipe(z.string().min(1).max(60));

/** `WXYZ-2345` — the dashed form people read off a screen. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function expired(rec: DeviceRecord, nowMs: number): boolean {
  return Temporal.Instant.from(rec.created_at).epochMilliseconds + DEVICE_CODE_TTL_MS <= nowMs;
}

async function readRecord(kv: Deno.Kv, deviceCode: string): Promise<DeviceRecord | null> {
  const parsed = recordSchema.safeParse((await kv.get([DEVICE, deviceCode])).value);
  return parsed.success ? parsed.data : null;
}

async function readByUserCode(kv: Deno.Kv, typed: string): Promise<
  { deviceCode: string; rec: DeviceRecord } | null
> {
  if (!looksLikeTypableCode(typed)) return null;
  const userCode = normalizeTypableCode(typed);
  const deviceCode = (await kv.get<string>([BY_USER_CODE, userCode])).value;
  if (deviceCode === null) return null;
  const rec = await readRecord(kv, deviceCode);
  return rec === null ? null : { deviceCode, rec };
}

/**
 * The PC asks for a code. Anonymous by design: the PC has nothing yet. The
 * user_code's ~40 bits over a ten-minute single-use window are beyond
 * guessing; a collision with a live code is detected and retried once.
 */
export async function createDeviceCode(
  deps: DeviceDeps,
  clientNameRaw: unknown,
): Promise<
  | { ok: true; device_code: string; user_code: string; expires_in: number; interval: number }
  | { ok: false; error: "invalid_client_name" | "unavailable" }
> {
  const name = clientNameSchema.safeParse(clientNameRaw);
  if (!name.success) return { ok: false, error: "invalid_client_name" };
  const deviceCode = deps.ids.randomToken();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const userCode = typableCodeFrom(deps.ids.randomToken());
    const rec: DeviceRecord = {
      userCode,
      clientName: name.data,
      created_at: deps.ids.nowIso(),
      status: "pending",
      userId: null,
      tokenId: null,
      token: null,
      accountLabel: null,
      lastPollMs: null,
      pollCount: 0,
      intervalSec: DEVICE_POLL_INTERVAL_SEC,
    };
    const res = await deps.kv.atomic()
      .check({ key: [BY_USER_CODE, userCode], versionstamp: null })
      .set([BY_USER_CODE, userCode], deviceCode, { expireIn: DEVICE_CODE_TTL_MS })
      .set([DEVICE, deviceCode], rec, { expireIn: DEVICE_CODE_TTL_MS })
      .commit();
    if (res.ok) {
      return {
        ok: true,
        device_code: deviceCode,
        user_code: formatUserCode(userCode),
        expires_in: DEVICE_CODE_TTL_MS / 1000,
        interval: DEVICE_POLL_INTERVAL_SEC,
      };
    }
  }
  return { ok: false, error: "unavailable" };
}

export type PollResult =
  | { ok: true; access_token: string; token_id: string; account: { label: string } }
  | {
    ok: false;
    error:
      | "authorization_pending"
      | "slow_down"
      | "expired_token"
      | "access_denied"
      | "invalid_grant";
  };

/**
 * The PC polls. Every outcome but success leaves the record in place; success
 * consumes it under an atomic check so the token is handed out exactly once.
 * An unknown device_code writes nothing (a scanner must not fill KV).
 */
export async function pollDeviceToken(deps: DeviceDeps, deviceCode: string): Promise<PollResult> {
  const key = [DEVICE, deviceCode];
  const entry = await deps.kv.get(key);
  const parsed = recordSchema.safeParse(entry.value);
  if (!parsed.success) return { ok: false, error: "invalid_grant" };
  const rec = parsed.data;
  const nowMs = deps.ids.nowMs();

  if (expired(rec, nowMs) || rec.pollCount >= DEVICE_MAX_POLLS) {
    await deps.kv.atomic().delete(key).delete([BY_USER_CODE, rec.userCode]).commit();
    return { ok: false, error: "expired_token" };
  }

  const tooSoon = rec.lastPollMs !== null && nowMs - rec.lastPollMs < rec.intervalSec * 1000;
  const next: DeviceRecord = {
    ...rec,
    lastPollMs: nowMs,
    pollCount: rec.pollCount + 1,
    intervalSec: tooSoon ? rec.intervalSec + SLOW_DOWN_STEP_SEC : rec.intervalSec,
  };

  if (tooSoon) {
    await deps.kv.set(key, next, { expireIn: remainingTtl(rec, nowMs) });
    return { ok: false, error: "slow_down" };
  }
  if (rec.status === "denied") {
    await deps.kv.atomic().delete(key).delete([BY_USER_CODE, rec.userCode]).commit();
    return { ok: false, error: "access_denied" };
  }
  if (rec.status === "pending" || rec.token === null || rec.tokenId === null) {
    await deps.kv.set(key, next, { expireIn: remainingTtl(rec, nowMs) });
    return { ok: false, error: "authorization_pending" };
  }
  // Approved: hand the token out once. The check against the versionstamp we
  // read is what makes a second concurrent poll lose.
  const taken = await deps.kv.atomic()
    .check(entry)
    .delete(key)
    .delete([BY_USER_CODE, rec.userCode])
    .commit();
  if (!taken.ok) return { ok: false, error: "invalid_grant" };
  return {
    ok: true,
    access_token: rec.token,
    token_id: rec.tokenId,
    account: { label: rec.accountLabel ?? "" },
  };
}

function remainingTtl(rec: DeviceRecord, nowMs: number): number {
  const until = Temporal.Instant.from(rec.created_at).epochMilliseconds + DEVICE_CODE_TTL_MS;
  return Math.max(1000, until - nowMs);
}

/** What the phone shows before the person decides. */
export interface PendingView {
  client_name: string;
  requested_at: string;
  expires_in_sec: number;
}

export async function lookupPending(
  deps: DeviceDeps,
  typedCode: string,
): Promise<PendingView | null> {
  const found = await readByUserCode(deps.kv, typedCode);
  if (found === null) return null;
  const nowMs = deps.ids.nowMs();
  if (found.rec.status !== "pending" || expired(found.rec, nowMs)) return null;
  const until = Temporal.Instant.from(found.rec.created_at).epochMilliseconds + DEVICE_CODE_TTL_MS;
  return {
    client_name: found.rec.clientName,
    requested_at: found.rec.created_at,
    expires_in_sec: Math.max(0, Math.floor((until - nowMs) / 1000)),
  };
}

/** Same as the invite box: @uid, else the display name, else the email. */
export function accountLabelOf(user: WebUser): string {
  if (user.uid !== null) return `@${user.uid}`;
  return user.displayName ?? user.email;
}

export type DecisionResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "already_decided" | "token_limit" };

/**
 * The phone approves. Issues a device-kind token for `user` and parks it on
 * the record for the PC's next poll. The decision is made once: a record
 * that is no longer pending answers already_decided.
 */
export async function approveDevice(
  deps: DeviceDeps,
  user: WebUser,
  typedCode: string,
  deviceName: string | undefined,
): Promise<DecisionResult> {
  const found = await readByUserCode(deps.kv, typedCode);
  if (found === null || expired(found.rec, deps.ids.nowMs())) {
    return { ok: false, error: "not_found" };
  }
  if (found.rec.status !== "pending") return { ok: false, error: "already_decided" };
  const fresh = await getUser(deps.kv, user.id);
  if (fresh === null) return { ok: false, error: "not_found" };
  let issued: Awaited<ReturnType<typeof issueApiToken>>;
  try {
    issued = await issueApiToken(deps.kv, user.id, deps.ids, {
      name: (deviceName ?? "").trim() || found.rec.clientName,
      kind: "device",
    });
  } catch (err) {
    if (err instanceof ApiTokenLimitError) return { ok: false, error: "token_limit" };
    throw err;
  }
  if (issued === null) return { ok: false, error: "not_found" };
  const next: DeviceRecord = {
    ...found.rec,
    status: "approved",
    userId: user.id,
    tokenId: issued.record.id,
    token: issued.token,
    accountLabel: accountLabelOf(fresh),
  };
  await deps.kv.set([DEVICE, found.deviceCode], next, {
    expireIn: remainingTtl(found.rec, deps.ids.nowMs()),
  });
  return { ok: true };
}

export async function denyDevice(deps: DeviceDeps, typedCode: string): Promise<DecisionResult> {
  const found = await readByUserCode(deps.kv, typedCode);
  if (found === null || expired(found.rec, deps.ids.nowMs())) {
    return { ok: false, error: "not_found" };
  }
  if (found.rec.status !== "pending") return { ok: false, error: "already_decided" };
  await deps.kv.set([DEVICE, found.deviceCode], { ...found.rec, status: "denied" }, {
    expireIn: remainingTtl(found.rec, deps.ids.nowMs()),
  });
  return { ok: true };
}

export { API_TOKEN_LIMIT };

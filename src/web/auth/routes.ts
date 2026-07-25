/**
 * `/auth/*` routes + request identity resolution (spec §3, §6).
 *
 * Login is the only way in for real users (owner 2026-07-21): Google
 * OAuth or an emailed magic link. Both resolve to the same WebUser by
 * email. Dev/verification bypasses (env-gated, resolveIdentity):
 *   - `PLANCEL_DEV_USER=<email>` — every request acts as that user
 *   - `x-plancel-admin: <PLANCEL_ADMIN_TOKEN>` — the raw
 *     `x-plancel-token` header is used as the ledger (prod smoke tests)
 *
 * Routes:
 *   GET  /auth/google            start OAuth (302 to Google)
 *   GET  /auth/callback          OAuth return → session cookie → /
 *   POST /auth/email {email}     send magic link (rate limited)
 *   GET  /auth/verify?token=     magic link landing → session cookie → /
 *   GET  /auth/me                session info (401 when logged out)
 *   POST /auth/logout            drop session
 *   POST /auth/adopt {token}     adopt a pre-login browser-token ledger
 *   POST /auth/ics/rotate        rotate the iCal feed secret
 */
import { z } from "zod";
import { listReservations } from "../store.ts";
import {
  adoptLedger,
  type AuthIds,
  allowMagicSend,
  consumeMagicLink,
  countUsers,
  createMagicLink,
  createSession,
  deleteSession,
  findUserByEmail,
  findUserByGoogleSub,
  getOrCreateUserByEmail,
  getSessionUser,
  linkGoogle,
  normalizeEmail,
  rotateIcsSecret,
  saveOauthState,
  SESSION_TTL_MS,
  takeOauthState,
  updateUser,
  type WebUser,
} from "../users.ts";
import { seal } from "../../lib/seal.ts";
import {
  exchangeCode,
  type GoogleOauthApp,
  googleAuthUrl,
  makePkce,
} from "./google.ts";
import {
  getCookie,
  isSecureRequest,
  SESSION_COOKIE,
  sessionClearCookie,
  sessionSetCookie,
} from "./session.ts";

export interface AuthDeps {
  kv: Deno.Kv;
  ids: AuthIds;
  fetchFn: typeof fetch;
  /** null → Google login disabled (route answers 503). */
  google: GoogleOauthApp | null;
  /** null → email login disabled (route answers 503). */
  sendMagicLink: ((email: string, url: string) => Promise<void>) | null;
  /** Overrides the redirect/link origin; defaults to the request origin. */
  baseUrl?: string;
  kek: string | undefined;
  devUserEmail?: string;
  adminToken?: string;
  /**
   * Signup cap (owner 2026-07-23): the Google side stays open to anyone,
   * so the app itself limits how many accounts may EXIST. Existing users
   * always get in; only new-account creation is refused at the cap.
   * undefined / <= 0 disables the cap.
   */
  maxUsers?: number;
  /**
   * Guaranteed members (owner 2026-07-23, runs in PARALLEL with the cap):
   * normalized addresses that may always create an account, even when the
   * cap is already filled by strangers. 家族を確実に入れるための保険。
   */
  allowedEmails?: Set<string>;
}

/** True when signing in this identity would create a user past the cap. */
async function atCapacity(deps: AuthDeps, email: string, sub?: string): Promise<boolean> {
  if (deps.maxUsers === undefined || deps.maxUsers <= 0) return false;
  if (deps.allowedEmails?.has(normalizeEmail(email))) return false;
  const existing = (sub !== undefined ? await findUserByGoogleSub(deps.kv, sub) : null) ??
    await findUserByEmail(deps.kv, email);
  if (existing !== null) return false;
  return (await countUsers(deps.kv)) >= deps.maxUsers;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const redirect = (to: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 302, headers: { location: to, ...headers } });

export function isAuthPath(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/");
}

function origin(req: Request, deps: AuthDeps): string {
  return deps.baseUrl ?? new URL(req.url).origin;
}

async function sessionResponse(
  deps: AuthDeps,
  req: Request,
  userId: string,
  to: string,
): Promise<Response> {
  const sid = await createSession(deps.kv, userId, deps.ids);
  return redirect(to, {
    "set-cookie": sessionSetCookie(sid, SESSION_TTL_MS / 1000, isSecureRequest(req)),
  });
}

/** The logged-in user for a request (session cookie or dev bypass). */
export async function requestUser(req: Request, deps: AuthDeps): Promise<WebUser | null> {
  const sid = getCookie(req, SESSION_COOKIE);
  if (sid !== null) {
    const user = await getSessionUser(deps.kv, sid, deps.ids.nowMs());
    if (user !== null) return user;
  }
  if (deps.devUserEmail !== undefined && deps.devUserEmail !== "") {
    return await getOrCreateUserByEmail(deps.kv, deps.devUserEmail, deps.ids);
  }
  return null;
}

export interface Identity {
  user: WebUser | null;
  /** Ledger the reservation API should read/write, null = unauthenticated. */
  ledger: string | null;
}

/**
 * Resolves who a request acts as. Session (or dev user) wins; the demo
 * namespace (`…::demo` header, see web/index.html) maps onto the user's
 * OWN ledger + "::demo". The admin header keeps raw-token access for
 * production smoke tests.
 */
export async function resolveIdentity(req: Request, deps: AuthDeps): Promise<Identity> {
  const user = await requestUser(req, deps);
  const headerToken = req.headers.get("x-plancel-token")?.trim();
  if (user !== null) {
    const demo = headerToken !== undefined && headerToken.endsWith("::demo");
    return { user, ledger: demo ? `${user.ledgerId}::demo` : user.ledgerId };
  }
  const admin = req.headers.get("x-plancel-admin")?.trim();
  if (
    deps.adminToken !== undefined && deps.adminToken !== "" && admin === deps.adminToken &&
    headerToken !== undefined && headerToken !== ""
  ) {
    return { user: null, ledger: headerToken };
  }
  return { user: null, ledger: null };
}

const emailReqSchema = z.object({ email: z.string().email() });
const adoptReqSchema = z.object({ token: z.string().min(1) });

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export async function handleAuthApi(req: Request, deps: AuthDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/auth/google" && req.method === "GET") {
    if (deps.google === null) return json({ error: "google login not configured" }, 503);
    const state = deps.ids.randomToken();
    const { verifier, challenge } = await makePkce(deps.ids.randomToken);
    await saveOauthState(deps.kv, state, verifier);
    return redirect(
      googleAuthUrl(deps.google, `${origin(req, deps)}/auth/callback`, state, challenge),
    );
  }

  if (path === "/auth/callback" && req.method === "GET") {
    if (deps.google === null) return json({ error: "google login not configured" }, 503);
    const errParam = url.searchParams.get("error");
    if (errParam !== null) return redirect(`/?auth_error=${encodeURIComponent(errParam)}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code === null || state === null) return redirect("/?auth_error=missing_code");
    const verifier = await takeOauthState(deps.kv, state);
    if (verifier === null) return redirect("/?auth_error=state_expired");
    let tokens;
    try {
      tokens = await exchangeCode(
        deps.google,
        `${origin(req, deps)}/auth/callback`,
        code,
        verifier,
        deps.fetchFn,
      );
    } catch (err) {
      console.error("auth: code exchange failed:", err);
      return redirect("/?auth_error=exchange_failed");
    }
    if (await atCapacity(deps, tokens.claims.email, tokens.claims.sub)) {
      return redirect("/?auth_error=capacity");
    }
    const user = await findUserByGoogleSub(deps.kv, tokens.claims.sub) ??
      await getOrCreateUserByEmail(deps.kv, tokens.claims.email, deps.ids);
    await linkGoogle(deps.kv, user.id, {
      sub: tokens.claims.sub,
      refreshTokenSealed: await seal(tokens.refreshToken ?? "", deps.kek),
      calendarId: user.google?.calendarId ?? null,
      // No refresh token (e.g. consent skipped) → calendar sync can't run.
      error: tokens.refreshToken === null ? "reauth" : null,
    }, deps.ids);
    return await sessionResponse(deps, req, user.id, "/");
  }

  if (path === "/auth/email" && req.method === "POST") {
    if (deps.sendMagicLink === null) return json({ error: "email login not configured" }, 503);
    const parsed = emailReqSchema.safeParse(await readJson(req));
    if (!parsed.success) return json({ error: "invalid email" }, 400);
    if (await atCapacity(deps, parsed.data.email)) return json({ error: "capacity" }, 403);
    if (!await allowMagicSend(deps.kv, parsed.data.email)) {
      return json({ error: "rate limited" }, 429);
    }
    const token = await createMagicLink(deps.kv, parsed.data.email, deps.ids);
    await deps.sendMagicLink(
      parsed.data.email,
      `${origin(req, deps)}/auth/verify?token=${token}`,
    );
    return json({ ok: true });
  }

  if (path === "/auth/verify" && req.method === "GET") {
    const token = url.searchParams.get("token");
    if (token === null) return redirect("/?auth_error=missing_token");
    const email = await consumeMagicLink(deps.kv, token, deps.ids.nowMs());
    if (email === null) return redirect("/?auth_error=link_expired");
    // Re-check at redeem time: the cap may have filled since the link was sent.
    if (await atCapacity(deps, email)) return redirect("/?auth_error=capacity");
    const user = await getOrCreateUserByEmail(deps.kv, email, deps.ids);
    return await sessionResponse(deps, req, user.id, "/");
  }

  if (path === "/auth/me" && req.method === "GET") {
    const user = await requestUser(req, deps);
    if (user === null) return json({ error: "not logged in" }, 401);
    return json({
      email: user.email,
      google: user.google !== null && user.google.error === null,
      googleError: user.google?.error ?? null,
      icsPath: `/calendar/${user.icsSecret}.ics`,
    });
  }

  if (path === "/auth/logout" && req.method === "POST") {
    const sid = getCookie(req, SESSION_COOKIE);
    if (sid !== null) await deleteSession(deps.kv, sid);
    return json({ ok: true }, 200, { "set-cookie": sessionClearCookie(isSecureRequest(req)) });
  }

  if (path === "/auth/adopt" && req.method === "POST") {
    const user = await requestUser(req, deps);
    if (user === null) return json({ error: "not logged in" }, 401);
    const parsed = adoptReqSchema.safeParse(await readJson(req));
    if (!parsed.success) return json({ error: "invalid" }, 400);
    const token = parsed.data.token;
    if (token === user.ledgerId) return json({ adopted: false, reason: "same" });
    if ((await listReservations(deps.kv, user.ledgerId)).length > 0) {
      return json({ adopted: false, reason: "ledger_not_empty" });
    }
    if ((await listReservations(deps.kv, token)).length === 0) {
      return json({ adopted: false, reason: "token_empty" });
    }
    await adoptLedger(deps.kv, user.id, token, deps.ids);
    return json({ adopted: true });
  }

  if (path === "/auth/ics/rotate" && req.method === "POST") {
    const user = await requestUser(req, deps);
    if (user === null) return json({ error: "not logged in" }, 401);
    const next = await rotateIcsSecret(deps.kv, user.id, deps.ids);
    return json({ icsPath: `/calendar/${next?.icsSecret}.ics` });
  }

  // Lets the UI clear a broken Google link ("再接続" flow restarts OAuth).
  if (path === "/auth/google/unlink" && req.method === "POST") {
    const user = await requestUser(req, deps);
    if (user === null) return json({ error: "not logged in" }, 401);
    await updateUser(deps.kv, user.id, (u) => ({ ...u, google: null }), deps.ids);
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

/**
 * Google OAuth 2.0 code flow (login + calendar consent) — pure functions
 * over an injected fetch so tests can fake Google's endpoints.
 *
 * Scopes: `openid email` for identity, `calendar.app.created` so plancel
 * may create and manage ONLY its own "plancel" calendar (least privilege;
 * spec §3). `access_type=offline&prompt=consent` forces a refresh token
 * on every (re)link.
 *
 * The id_token signature is NOT verified: it is received directly from
 * Google's token endpoint over TLS in the same request that authenticated
 * with our client secret, so its payload is trusted by provenance.
 */
import { b64urlDecodeToString, b64urlEncode } from "../../lib/encoding.ts";

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_SCOPES = "openid email https://www.googleapis.com/auth/calendar.app.created";

export interface GoogleOauthApp {
  clientId: string;
  clientSecret: string;
}

export class GoogleAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function makePkce(
  random: () => string,
): Promise<{ verifier: string; challenge: string }> {
  const verifier = random();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64urlEncode(new Uint8Array(digest)) };
}

export function googleAuthUrl(
  app: GoogleOauthApp,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const u = new URL(GOOGLE_AUTH_ENDPOINT);
  u.searchParams.set("client_id", app.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
  claims: { sub: string; email: string };
}

async function tokenRequest(
  fetchFn: typeof fetch,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
    throw new GoogleAuthError(code, `google token endpoint: ${code}`);
  }
  return json as Record<string, unknown>;
}

export async function exchangeCode(
  app: GoogleOauthApp,
  redirectUri: string,
  code: string,
  verifier: string,
  fetchFn: typeof fetch,
): Promise<GoogleTokens> {
  const json = await tokenRequest(fetchFn, {
    grant_type: "authorization_code",
    code,
    client_id: app.clientId,
    client_secret: app.clientSecret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const idToken = typeof json.id_token === "string" ? json.id_token : null;
  const accessToken = typeof json.access_token === "string" ? json.access_token : null;
  if (idToken === null || accessToken === null) {
    throw new GoogleAuthError("bad_response", "token response missing id_token/access_token");
  }
  const payload = idToken.split(".")[1];
  if (payload === undefined) throw new GoogleAuthError("bad_id_token", "malformed id_token");
  const claims = JSON.parse(b64urlDecodeToString(payload)) as { sub?: string; email?: string };
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
    throw new GoogleAuthError("bad_id_token", "id_token missing sub/email");
  }
  return {
    accessToken,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    claims: { sub: claims.sub, email: claims.email },
  };
}

/** Throws GoogleAuthError("invalid_grant") when the refresh token is dead. */
export async function refreshAccessToken(
  app: GoogleOauthApp,
  refreshToken: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const json = await tokenRequest(fetchFn, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  const token = typeof json.access_token === "string" ? json.access_token : null;
  if (token === null) throw new GoogleAuthError("bad_response", "refresh response missing token");
  return token;
}

/**
 * Svix-style webhook signature verification — Resend's inbound-mail webhook
 * (`POST /webhook/email`, see ./email-intake.ts).
 *
 * Resend signs each delivery with HMAC-SHA256 over
 * `${svix-id}.${svix-timestamp}.${rawBody}`. The signing secret arrives as
 * `whsec_<base64>` and the KEY IS THE DECODED BYTES of that base64 part, not
 * its ASCII text. `svix-signature` carries a space-separated list of
 * `v1,<base64sig>` entries and ANY matching `v1` entry is sufficient — during a
 * secret rotation Svix sends the old and the new signature together.
 *
 * Same discipline as src/line/signature.ts: the raw body bytes as received
 * (re-serialized JSON would break the digest), Web Crypto only (no SDK),
 * constant-time comparison. The timestamp is checked against an injected clock
 * so a captured delivery cannot be replayed later.
 */
import { b64decode, b64encode } from "../lib/encoding.ts";

const encoder = new TextEncoder();

/** Replay window either side of `svix-timestamp` (Svix's own recommendation). */
export const SVIX_TOLERANCE_MS = 5 * 60 * 1000;

const SIGNATURE_VERSION = "v1";
const SECRET_PREFIX = "whsec_";

/**
 * Key bytes for a `whsec_<base64>` secret. A value pasted without the wrapper
 * still works, and a value that is not base64 at all falls back to its UTF-8
 * bytes — a wrong key simply fails verification, so guessing here is safe and
 * keeps a hand-copied secret from turning into a permanent 401.
 */
function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const body = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  try {
    return b64decode(body);
  } catch {
    return encoder.encode(body);
  }
}

/** Base64 HMAC-SHA256 of `${id}.${timestamp}.${rawBody}` — the `v1` payload. */
export async function signSvix(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = encoder.encode(`${id}.${timestamp}.${rawBody}`);
  return b64encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, signed)));
}

/** The three signature headers, as read off the request (null when absent). */
export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function readSvixHeaders(headers: Headers): SvixHeaders {
  return {
    id: headers.get("svix-id"),
    timestamp: headers.get("svix-timestamp"),
    signature: headers.get("svix-signature"),
  };
}

/**
 * Why a delivery was rejected. All non-`ok` verdicts are one HTTP status (401)
 * — the distinction exists for the log line, never for the response body.
 */
export type SvixVerdict = "ok" | "missing" | "stale" | "mismatch";

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies the Svix headers against the raw body. `nowMs` comes from the
 * injected clock; a `svix-timestamp` further away than SVIX_TOLERANCE_MS in
 * either direction is refused even when its signature is valid (replay guard).
 */
export async function verifySvixSignature(
  secret: string,
  rawBody: string,
  headers: SvixHeaders,
  nowMs: number,
): Promise<SvixVerdict> {
  const { id, timestamp, signature } = headers;
  if (id === null || timestamp === null || signature === null) return "missing";
  if (id === "" || signature === "") return "missing";

  // Svix sends seconds since the epoch.
  const sentMs = Number(timestamp) * 1000;
  if (!Number.isFinite(sentMs)) return "missing";
  if (Math.abs(nowMs - sentMs) > SVIX_TOLERANCE_MS) return "stale";

  const expected = await signSvix(secret, id, timestamp, rawBody);
  for (const part of signature.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    if (part.slice(0, comma) !== SIGNATURE_VERSION) continue; // unknown version
    if (constantTimeEquals(expected, part.slice(comma + 1))) return "ok";
  }
  return "mismatch";
}

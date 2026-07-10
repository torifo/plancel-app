/**
 * LINE webhook signature verification (Task 6.2, SDD §7 セキュリティ).
 *
 * LINE signs every webhook body with HMAC-SHA256 over the raw request body
 * using the channel secret, base64-encoded into the `x-line-signature`
 * header. Verification MUST use the raw body bytes as received (before any
 * JSON parsing) — re-serializing would break the digest.
 */

const encoder = new TextEncoder();

async function hmacSha256(secret: string, body: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return new Uint8Array(mac);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Computes the expected `x-line-signature` value for a raw body. */
export async function signLineBody(channelSecret: string, rawBody: string): Promise<string> {
  return toBase64(await hmacSha256(channelSecret, rawBody));
}

/**
 * Verifies an `x-line-signature` header against the raw body.
 * Constant-time comparison over the base64 strings (length check first) so
 * signature guessing cannot use timing.
 */
export async function verifyLineSignature(
  channelSecret: string,
  rawBody: string,
  signature: string | null,
): Promise<boolean> {
  if (signature === null || signature === "") return false;
  const expected = await signLineBody(channelSecret, rawBody);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

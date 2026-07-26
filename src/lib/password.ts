/**
 * Password hashing (PBKDF2-HMAC-SHA256 via WebCrypto — no dependencies).
 *
 * Stored form: `pbkdf2$<iterations>$<salt b64>$<hash b64>` so parameters can
 * be raised later without invalidating existing hashes.
 */
import { b64decode, b64encode } from "./encoding.ts";

const DEFAULT_ITERATIONS = 210_000;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2$${iterations}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
  if (
    scheme !== "pbkdf2" || iterStr === undefined || saltB64 === undefined || hashB64 === undefined
  ) {
    return false;
  }
  const expected = b64decode(hashB64);
  const actual = await derive(password, b64decode(saltB64), Number(iterStr));
  if (expected.length !== actual.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ actual[i]!;
  return diff === 0;
}

/**
 * Secret sealing for values stored in KV (Google refresh tokens).
 *
 * AES-GCM with a key from `PLANCEL_KEK` (base64, 32 bytes). Sealed values
 * are `v1:<iv b64>:<ciphertext b64>`. When no KEK is configured the value
 * is stored as `plain:<value>` so a 家族/身内 deployment still works —
 * the caller should log a warning in that case.
 */
import { b64decode, b64encode } from "./encoding.ts";

const PLAIN_PREFIX = "plain:";
const V1_PREFIX = "v1:";

async function importKek(kekB64: string): Promise<CryptoKey> {
  const raw = b64decode(kekB64);
  if (raw.length !== 32) throw new Error("PLANCEL_KEK must be 32 bytes of base64");
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(plain: string, kekB64: string | undefined): Promise<string> {
  if (kekB64 === undefined || kekB64 === "") return PLAIN_PREFIX + plain;
  const key = await importKek(kekB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)),
  );
  return `${V1_PREFIX}${b64encode(iv)}:${b64encode(ct)}`;
}

export async function unseal(sealed: string, kekB64: string | undefined): Promise<string> {
  if (sealed.startsWith(PLAIN_PREFIX)) return sealed.slice(PLAIN_PREFIX.length);
  if (!sealed.startsWith(V1_PREFIX)) throw new Error("unknown sealed format");
  if (kekB64 === undefined || kekB64 === "") throw new Error("PLANCEL_KEK required to unseal");
  const [ivB64, ctB64] = sealed.slice(V1_PREFIX.length).split(":");
  if (ivB64 === undefined || ctB64 === undefined) throw new Error("malformed sealed value");
  const key = await importKek(kekB64);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(ivB64) },
    key,
    b64decode(ctB64),
  );
  return new TextDecoder().decode(pt);
}

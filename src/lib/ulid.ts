/**
 * Minimal ULID (Universally Unique Lexicographically Sortable Identifier)
 * generator. https://github.com/ulid/spec
 *
 * A ULID is 26 characters, Crockford Base32 encoded:
 *   - 48 bits (10 chars) timestamp in ms since epoch
 *   - 80 bits (16 chars) randomness
 *
 * Time and randomness are injectable so callers (e.g. tests, or domain code
 * that must not call Date.now()/Math.random() directly) can control both.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32 (32 chars)
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export interface UlidOptions {
  /** Milliseconds since Unix epoch. Defaults to system time (Date.now()). */
  now?: () => number;
  /** Returns a float in [0, 1). Defaults to Math.random(). */
  random?: () => number;
}

function encodeTime(time: number, len: number): string {
  let mod: number;
  let str = "";
  let t = time;
  for (let i = len - 1; i >= 0; i--) {
    mod = t % ENCODING_LEN;
    str = ENCODING[mod] + str;
    t = Math.floor(t / ENCODING_LEN);
  }
  return str;
}

function encodeRandom(len: number, random: () => number): string {
  let str = "";
  for (let i = 0; i < len; i++) {
    const rand = Math.floor(random() * ENCODING_LEN);
    str += ENCODING[rand];
  }
  return str;
}

/**
 * Generates a new ULID string. `now`/`random` may be injected for
 * deterministic, testable generation.
 */
export function ulid(options: UlidOptions = {}): string {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  return encodeTime(now(), TIME_LEN) + encodeRandom(RANDOM_LEN, random);
}

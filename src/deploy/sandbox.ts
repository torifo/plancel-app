/**
 * Demo sandboxes: a visitor presses one button and gets a private, seeded ledger, with no
 * credentials to type. Demo mode only (the route is not wired otherwise).
 *
 * A sandbox is an ordinary user (no password, so nobody can log in to it) plus a registry
 * record `["sandbox", userId]`. The registry is what marks it as a sandbox, ages it out and
 * keeps it out of the open-signup count.
 */
import { z } from "zod";
import type { Clock } from "../core/clock/mod.ts";
import { logger } from "../lib/log.ts";
import { isSecureRequest, sessionSetCookie } from "../web/auth/session.ts";
import {
  type AuthIds,
  createSession,
  deleteAccount,
  findUserByEmail,
  getOrCreateUserByEmail,
  getUser,
  SANDBOX_PREFIX,
  updateUser,
  type WebUser,
} from "../web/users.ts";
import { DEMO_EMAIL, seedDemoLedger } from "./demo.ts";

const log = logger("deploy.sandbox");

const HOUR_MS = 3_600_000;
export const SANDBOX_MAX_DEFAULT = 100;
/** A sandbox is removed this long after it was made, active or not. */
export const SANDBOX_TTL_MS = 48 * HOUR_MS;
/** The scheduler only looks at sandboxes active (or created) within this window. */
export const SANDBOX_ACTIVE_MS = 24 * HOUR_MS;
export const START_PER_HOUR_DEFAULT = 10;
const TOUCH_EVERY_MS = 5 * 60_000;

export const SANDBOX_EMAIL_DOMAIN = "plancel.example";
const SANDBOX_DISPLAY_NAME = "デモ体験";

const recordSchema = z.object({ createdAt: z.number(), lastActiveAt: z.number() });
type SandboxRecord = z.infer<typeof recordSchema>;

export interface SandboxEntry extends SandboxRecord {
  userId: string;
}

export async function isSandbox(kv: Deno.Kv, userId: string): Promise<boolean> {
  return (await kv.get([SANDBOX_PREFIX, userId])).value !== null;
}

/** Oldest first. */
export async function listSandboxes(kv: Deno.Kv): Promise<SandboxEntry[]> {
  const out: SandboxEntry[] = [];
  for await (const e of kv.list({ prefix: [SANDBOX_PREFIX] })) {
    const parsed = recordSchema.safeParse(e.value);
    const userId = e.key[1];
    if (parsed.success && typeof userId === "string") out.push({ userId, ...parsed.data });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.userId.localeCompare(b.userId));
}

/** Records that the sandbox was just used, at most once per few minutes. */
export async function touchSandbox(kv: Deno.Kv, userId: string, nowMs: number): Promise<void> {
  const key = [SANDBOX_PREFIX, userId];
  const entry = await kv.get(key);
  const parsed = recordSchema.safeParse(entry.value);
  if (!parsed.success || nowMs - parsed.data.lastActiveAt < TOUCH_EVERY_MS) return;
  await kv.set(key, { ...parsed.data, lastActiveAt: nowMs });
}

/** Removes a sandbox and everything it owns, including the plan guards deleteAccount leaves. */
export async function deleteSandbox(kv: Deno.Kv, userId: string, ids: AuthIds): Promise<void> {
  const user = await getUser(kv, userId);
  if (user !== null) {
    for (const ledger of [user.ledgerId, `${user.ledgerId}::demo`]) {
      for await (const e of kv.list({ prefix: ["web", ledger] })) await kv.delete(e.key);
    }
  }
  await deleteAccount(kv, userId, ids);
  await kv.delete([SANDBOX_PREFIX, userId]);
}

/**
 * Makes room for one more: drops sandboxes past their lifetime, then the oldest while the
 * count would exceed `max`. Returns how many were removed.
 */
export async function pruneSandboxes(
  kv: Deno.Kv,
  ids: AuthIds,
  nowMs: number,
  max: number,
): Promise<number> {
  let all = await listSandboxes(kv);
  const expired = all.filter((s) => nowMs - s.createdAt >= SANDBOX_TTL_MS);
  for (const s of expired) await deleteSandbox(kv, s.userId, ids);
  all = all.filter((s) => !expired.includes(s));
  let removed = expired.length;
  while (all.length >= Math.max(1, max)) {
    await deleteSandbox(kv, all.shift()!.userId, ids);
    removed += 1;
  }
  return removed;
}

export interface SandboxDeps {
  kv: Deno.Kv;
  clock: Clock;
  ids: AuthIds;
  max: number;
  limiter: StartRateLimiter;
}

/** A fresh user with no usable password, a seeded ledger, a registry record and a session. */
export async function createSandbox(
  deps: Pick<SandboxDeps, "kv" | "clock" | "ids">,
): Promise<{ user: WebUser; sid: string }> {
  const { kv, clock, ids } = deps;
  const nowMs = clock.now().epochMilliseconds;
  const email = `sandbox-${ids.newId().toLowerCase()}@${SANDBOX_EMAIL_DOMAIN}`;
  const created = await getOrCreateUserByEmail(kv, email, ids, {
    emailVerified: true,
    passwordHash: null,
  });
  try {
    await kv.set([SANDBOX_PREFIX, created.id], { createdAt: nowMs, lastActiveAt: nowMs });
    const user = await updateUser(kv, created.id, (u) => ({
      ...u,
      displayName: SANDBOX_DISPLAY_NAME,
    }), ids) ?? created;
    await seedDemoLedger(kv, user.ledgerId, clock, ids);
    return { user, sid: await createSession(kv, user.id, ids, SANDBOX_TTL_MS) };
  } catch (err) {
    await deleteSandbox(kv, created.id, ids);
    throw err;
  }
}

/**
 * Who the scheduler may run the agent for in demo mode: the fixed demo account, and sandboxes
 * made or used in the last 24 hours. Everyone else (open signups, stale sandboxes) is left alone.
 */
export async function demoSweepUsers(kv: Deno.Kv, nowMs: number): Promise<WebUser[]> {
  const users: WebUser[] = [];
  const demo = await findUserByEmail(kv, DEMO_EMAIL);
  if (demo !== null) users.push(demo);
  for (const s of await listSandboxes(kv)) {
    if (nowMs - Math.max(s.createdAt, s.lastActiveAt) >= SANDBOX_ACTIVE_MS) continue;
    const user = await getUser(kv, s.userId);
    if (user !== null) users.push(user);
  }
  return users;
}

/** Sliding-window limiter: at most `limit` events per key in any `windowMs`. In memory. */
export class StartRateLimiter {
  #hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number = HOUR_MS,
    private readonly maxKeys: number = 10_000,
  ) {}

  allow(key: string, nowMs: number): boolean {
    const recent = (this.#hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.#hits.delete(key); // re-insert so the Map stays ordered by recency
    this.#hits.set(key, recent);
    if (this.#hits.size > this.maxKeys) {
      this.#hits.delete(this.#hits.keys().next().value as string);
    }
    return true;
  }
}

/**
 * The caller's address. Behind Cloud Run the proxy appends the real client address to
 * x-forwarded-for, so the rightmost entry is the trustworthy one; anything to its left is
 * whatever the client claimed.
 */
export function clientIp(req: Request, remoteIp: string | undefined): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(
    Boolean,
  );
  return forwarded?.at(-1) ?? remoteIp ?? "unknown";
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/** POST /api/demo/start. `deps` is null outside demo mode, where the route does not exist. */
export async function handleDemoStart(
  req: Request,
  deps: SandboxDeps | null,
  remoteIp?: string,
): Promise<Response> {
  if (deps === null) return json({ error: "not found" }, 404);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const nowMs = deps.clock.now().epochMilliseconds;
  if (!deps.limiter.allow(clientIp(req, remoteIp), nowMs)) {
    return json({ error: "rate limited" }, 429, { "retry-after": "3600" });
  }
  const removed = await pruneSandboxes(deps.kv, deps.ids, nowMs, deps.max);
  const { user, sid } = await createSandbox(deps);
  log.info("sandbox started", { userId: user.id, pruned: removed });
  return json({ ok: true }, 200, {
    "set-cookie": sessionSetCookie(sid, SANDBOX_TTL_MS / 1000, isSecureRequest(req)),
  });
}

/** Serves the page with the demo flag the login view reads (a marker, not a template engine). */
export function markDemoHtml(html: string): string {
  return html.replace('<html lang="ja">', '<html lang="ja" data-demo="1">');
}

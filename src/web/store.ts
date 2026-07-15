/**
 * Per-user web reservation store (KV-backed, namespaced by browser token).
 *
 * The web UI (web/index.html, the MVP) is a per-user ledger: each browser
 * holds a random token (localStorage) and its reservations live in the
 * shared Deno KV under `["web", token, "resv", <id>]`. This is a deliberately
 * simpler shape than the event-sourced core domain (`src/core`) — it stores
 * plain reservation records the UI edits directly. Wiring it into the core's
 * event log / cron notifications is a later step; for now it is a
 * self-contained per-user store that the same KV database backs.
 */
import { z } from "zod";

export const webPolicySchema = z.enum(["unknown", "none", "free24", "staged"]);
export type WebPolicy = z.infer<typeof webPolicySchema>;

export const webStatusSchema = z.enum(["candidate", "confirmed", "to_cancel", "cancelled"]);
export type WebStatus = z.infer<typeof webStatusSchema>;

export const webReservationSchema = z.object({
  id: z.string().min(1),
  plan: z.string().nullable(),
  service: z.string().min(1),
  startsAt: z.string().min(1),
  amount: z.number().nullable(),
  policy: webPolicySchema,
  status: webStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type WebReservation = z.infer<typeof webReservationSchema>;

/** Fields a client may set on create; server owns id/status/timestamps. */
export const webCreateSchema = z.object({
  plan: z.string().nullable().default(null),
  service: z.string().min(1),
  startsAt: z.string().min(1),
  amount: z.number().nullable().default(null),
  policy: webPolicySchema.default("unknown"),
  confirmed: z.boolean().default(false),
});

/** Fields a client may change on edit (all optional). */
export const webPatchSchema = z.object({
  plan: z.string().nullable().optional(),
  service: z.string().min(1).optional(),
  startsAt: z.string().min(1).optional(),
  amount: z.number().nullable().optional(),
  policy: webPolicySchema.optional(),
});

/** Injected id + clock so handlers stay deterministic in tests. */
export interface WebIds {
  newId(): string;
  nowIso(): string;
}

const NS = "web";
const RESV = "resv";
const key = (token: string, id: string) => [NS, token, RESV, id];
const prefix = (token: string) => [NS, token, RESV];

export async function listReservations(kv: Deno.Kv, token: string): Promise<WebReservation[]> {
  const out: WebReservation[] = [];
  for await (const e of kv.list<WebReservation>({ prefix: prefix(token) })) {
    const parsed = webReservationSchema.safeParse(e.value);
    if (parsed.success) out.push(parsed.data);
  }
  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return out;
}

export async function getReservation(
  kv: Deno.Kv,
  token: string,
  id: string,
): Promise<WebReservation | null> {
  const e = await kv.get<WebReservation>(key(token, id));
  return e.value ?? null;
}

async function put(kv: Deno.Kv, token: string, r: WebReservation): Promise<void> {
  await kv.set(key(token, r.id), r);
}

/** Settles a plan: every other candidate in the same plan becomes to_cancel. */
async function settleSiblings(
  kv: Deno.Kv,
  token: string,
  confirmed: WebReservation,
  ids: WebIds,
): Promise<void> {
  if (confirmed.plan === null) return;
  const all = await listReservations(kv, token);
  for (const r of all) {
    if (r.id !== confirmed.id && r.plan === confirmed.plan && r.status === "candidate") {
      await put(kv, token, { ...r, status: "to_cancel", updated_at: ids.nowIso() });
    }
  }
}

export async function createReservation(
  kv: Deno.Kv,
  token: string,
  input: z.infer<typeof webCreateSchema>,
  ids: WebIds,
): Promise<WebReservation> {
  const now = ids.nowIso();
  const r: WebReservation = {
    id: ids.newId(),
    plan: input.plan,
    service: input.service,
    startsAt: input.startsAt,
    amount: input.amount,
    policy: input.policy,
    status: input.confirmed ? "confirmed" : "candidate",
    created_at: now,
    updated_at: now,
  };
  await put(kv, token, r);
  if (r.status === "confirmed") await settleSiblings(kv, token, r, ids);
  return r;
}

export async function patchReservation(
  kv: Deno.Kv,
  token: string,
  id: string,
  patch: z.infer<typeof webPatchSchema>,
  ids: WebIds,
): Promise<WebReservation | null> {
  const cur = await getReservation(kv, token, id);
  if (cur === null) return null;
  // Explicit per-field merge: under exactOptionalPropertyTypes a blanket
  // `...patch` spread could assign `undefined` to required fields.
  const next: WebReservation = {
    ...cur,
    ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
    ...(patch.service !== undefined ? { service: patch.service } : {}),
    ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
    ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
    ...(patch.policy !== undefined ? { policy: patch.policy } : {}),
    updated_at: ids.nowIso(),
  };
  await put(kv, token, next);
  return next;
}

export async function confirmReservation(
  kv: Deno.Kv,
  token: string,
  id: string,
  ids: WebIds,
): Promise<WebReservation | null> {
  const cur = await getReservation(kv, token, id);
  if (cur === null) return null;
  const next: WebReservation = { ...cur, status: "confirmed", updated_at: ids.nowIso() };
  await put(kv, token, next);
  await settleSiblings(kv, token, next, ids);
  return next;
}

export async function cancelReservation(
  kv: Deno.Kv,
  token: string,
  id: string,
  ids: WebIds,
): Promise<WebReservation | null> {
  const cur = await getReservation(kv, token, id);
  if (cur === null) return null;
  const next: WebReservation = { ...cur, status: "cancelled", updated_at: ids.nowIso() };
  await put(kv, token, next);
  return next;
}

/** Physical delete (the web store is not the append-only event log). */
export async function deleteReservation(
  kv: Deno.Kv,
  token: string,
  id: string,
): Promise<boolean> {
  const cur = await getReservation(kv, token, id);
  if (cur === null) return false;
  await kv.delete(key(token, id));
  return true;
}

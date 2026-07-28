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
import { webPolicySchema } from "./policy.ts";
import { getTemplate } from "./policy-template.ts";

// The policy model (presets + arbitrary stage tables) and its math live in
// ./policy.ts; re-exported here because the record schema is this module's.
export { type WebPolicy, webPolicySchema } from "./policy.ts";

export const webStatusSchema = z.enum(["candidate", "confirmed", "to_cancel", "cancelled"]);
export type WebStatus = z.infer<typeof webStatusSchema>;

export const webReservationSchema = z.object({
  id: z.string().min(1),
  plan: z.string().nullable(),
  service: z.string().min(1),
  startsAt: z.string().min(1),
  amount: z.number().nullable(),
  // Optional venue (店名/住所). Defaulted so pre-2026-07-22 records still parse.
  location: z.string().nullable().default(null),
  policy: webPolicySchema,
  status: webStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  /**
   * userId of whoever wrote the record last — an invited editor (sharing.ts)
   * is not always the owner. Defaulted so pre-2026-07-28 records still parse
   * (they carry no attribution, hence null).
   */
  updated_by: z.string().nullable().default(null),
});
export type WebReservation = z.infer<typeof webReservationSchema>;

/**
 * Who a write is attributed to (`updated_by`): the acting userId, or null for
 * callers with no user identity (header-token / admin tooling).
 */
export type WebActor = string | null;

/** Fields a client may set on create; server owns id/status/timestamps. */
export const webCreateSchema = z.object({
  plan: z.string().nullable().default(null),
  service: z.string().min(1),
  startsAt: z.string().min(1),
  amount: z.number().nullable().default(null),
  location: z.string().nullable().default(null),
  policy: webPolicySchema.default("unknown"),
  confirmed: z.boolean().default(false),
});

/** Fields a client may change on edit (all optional). */
export const webPatchSchema = z.object({
  plan: z.string().nullable().optional(),
  service: z.string().min(1).optional(),
  startsAt: z.string().min(1).optional(),
  amount: z.number().nullable().optional(),
  location: z.string().nullable().optional(),
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
const PLAN_CONFIRMED = "plan_confirmed";
const planConfirmedKey = (token: string, plan: string) => [
  NS,
  token,
  PLAN_CONFIRMED,
  plan,
];

/** An attempted web-ledger state transition is not legal. */
export class WebTransitionError extends Error {
  constructor(
    readonly command: "confirm" | "patch_plan",
    readonly from: WebStatus,
    message = `cannot ${command} reservation from ${from}`,
  ) {
    super(message);
    this.name = "WebTransitionError";
  }
}

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

export async function createReservation(
  kv: Deno.Kv,
  token: string,
  input: z.infer<typeof webCreateSchema>,
  ids: WebIds,
  actor: WebActor = null,
): Promise<WebReservation> {
  const now = ids.nowIso();
  // 規定が「不明」のときだけ施設の既定規定に落ちる（オーナー 2026-07-27）。
  // 予約を作る経路は web API（フォームと MCP）・メール転送・LINE の3つあり、
  // この規則をそれぞれが自前で書いていた結果、LINE だけが引き忘れていて「同じ宿
  // でも web から入れると規定が入り、LINE から入れると不明」になっていた
  // （2026-07-28）。作る場所は1つなので、規則もここ1か所に置く。
  // 読み取れた規定は塗り替えない — その予約に固有の料率表のほうが強い。
  const policy = input.policy === "unknown"
    ? (await getTemplate(kv, token, input.service))?.policy ?? "unknown"
    : input.policy;
  const r: WebReservation = {
    id: ids.newId(),
    plan: input.plan,
    service: input.service,
    startsAt: input.startsAt,
    amount: input.amount,
    location: input.location,
    policy,
    // Confirm through confirmReservation below so create-with-confirmed uses
    // exactly the same transition validation and atomic plan settlement.
    status: "candidate",
    created_at: now,
    updated_at: now,
    updated_by: actor,
  };
  await put(kv, token, r);
  if (!input.confirmed) return r;
  try {
    return (await confirmReservation(kv, token, r.id, ids, actor))!;
  } catch (error) {
    // The generated id has not been returned to a caller yet, so failed
    // create-with-confirmed must not leave a surprise candidate behind.
    await kv.delete(key(token, r.id));
    throw error;
  }
}

export async function patchReservation(
  kv: Deno.Kv,
  token: string,
  id: string,
  patch: z.infer<typeof webPatchSchema>,
  ids: WebIds,
  actor: WebActor = null,
): Promise<WebReservation | null> {
  const cur = await getReservation(kv, token, id);
  if (cur === null) return null;
  if (
    cur.status === "confirmed" &&
    patch.plan !== undefined &&
    patch.plan !== cur.plan
  ) {
    throw new WebTransitionError(
      "patch_plan",
      cur.status,
      "cannot move a confirmed reservation to another plan",
    );
  }
  // Explicit per-field merge: under exactOptionalPropertyTypes a blanket
  // `...patch` spread could assign `undefined` to required fields.
  const next: WebReservation = {
    ...cur,
    ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
    ...(patch.service !== undefined ? { service: patch.service } : {}),
    ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
    ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
    ...(patch.location !== undefined ? { location: patch.location } : {}),
    ...(patch.policy !== undefined ? { policy: patch.policy } : {}),
    updated_at: ids.nowIso(),
    updated_by: actor,
  };
  await put(kv, token, next);
  return next;
}

export async function confirmReservation(
  kv: Deno.Kv,
  token: string,
  id: string,
  ids: WebIds,
  actor: WebActor = null,
): Promise<WebReservation | null> {
  // Retry optimistic conflicts. A competing confirmation is observed on the
  // next read as either a non-candidate target or a claimed plan guard.
  for (let attempt = 0; attempt < 4; attempt++) {
    const targetEntry = await kv.get<WebReservation>(key(token, id));
    if (targetEntry.value === null) return null;
    const cur = webReservationSchema.parse(targetEntry.value);
    if (cur.status !== "candidate") {
      throw new WebTransitionError("confirm", cur.status);
    }

    const now = ids.nowIso();
    const next: WebReservation = {
      ...cur,
      status: "confirmed",
      updated_at: now,
      updated_by: actor,
    };
    let tx = kv.atomic().check(targetEntry);

    if (cur.plan !== null) {
      const guard = await kv.get<string>(planConfirmedKey(token, cur.plan));
      if (guard.value !== null) {
        // Cancellation and plan edits intentionally remain separate existing
        // API operations, so an old guard can outlive its winner. Only a guard
        // that still points at a confirmed reservation in this plan blocks.
        const guarded = await kv.get<WebReservation>(key(token, guard.value));
        const parsedGuarded = webReservationSchema.safeParse(guarded.value);
        if (
          parsedGuarded.success &&
          parsedGuarded.data.plan === cur.plan &&
          parsedGuarded.data.status === "confirmed"
        ) {
          throw new WebTransitionError(
            "confirm",
            cur.status,
            `plan "${cur.plan}" already has a confirmed reservation`,
          );
        }
      }

      // Version-check and update all candidate siblings in the same commit as
      // the winner. There can be neither two winners nor partial settlement.
      const siblings: Deno.KvEntry<WebReservation>[] = [];
      for await (const entry of kv.list<WebReservation>({ prefix: prefix(token) })) {
        const parsed = webReservationSchema.safeParse(entry.value);
        if (!parsed.success || parsed.data.id === id || parsed.data.plan !== cur.plan) continue;
        if (parsed.data.status === "confirmed") {
          throw new WebTransitionError(
            "confirm",
            cur.status,
            `plan "${cur.plan}" already has a confirmed reservation`,
          );
        }
        if (parsed.data.status === "candidate") siblings.push(entry);
      }

      tx = tx.check(guard);
      for (const sibling of siblings) {
        tx = tx.check(sibling).set(key(token, sibling.value.id), {
          ...sibling.value,
          status: "to_cancel",
          updated_at: now,
          updated_by: actor,
        });
      }
      tx = tx.set(planConfirmedKey(token, cur.plan), id);
    }

    const committed = await tx.set(key(token, id), next).commit();
    if (committed.ok) return next;
  }

  throw new WebTransitionError(
    "confirm",
    "candidate",
    "reservation changed while it was being confirmed",
  );
}

/**
 * Brings a cancelled / to_cancel reservation back to candidate (owner
 * 2026-07-22: nothing vanishes on its own — cancelled items stay listed
 * until the user restores, reschedules, or explicitly hard-deletes them).
 * Other statuses are returned unchanged (no-op).
 */
export async function restoreReservation(
  kv: Deno.Kv,
  token: string,
  id: string,
  ids: WebIds,
  actor: WebActor = null,
): Promise<WebReservation | null> {
  const cur = await getReservation(kv, token, id);
  if (cur === null) return null;
  if (cur.status !== "cancelled" && cur.status !== "to_cancel") return cur;
  const next: WebReservation = {
    ...cur,
    status: "candidate",
    updated_at: ids.nowIso(),
    updated_by: actor,
  };
  await put(kv, token, next);
  return next;
}

export async function cancelReservation(
  kv: Deno.Kv,
  token: string,
  id: string,
  ids: WebIds,
  actor: WebActor = null,
): Promise<WebReservation | null> {
  const cur = await getReservation(kv, token, id);
  if (cur === null) return null;
  const next: WebReservation = {
    ...cur,
    status: "cancelled",
    updated_at: ids.nowIso(),
    updated_by: actor,
  };
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

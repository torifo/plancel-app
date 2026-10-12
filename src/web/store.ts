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
import { isFinished } from "./lifecycle.ts";
import {
  normalizeInstant,
  normalizeRequiredInstant,
  readableInstantSchema,
  toInstantOrNull,
} from "./instant.ts";
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
  /**
   * When it ends — a stay's checkout. Only the day matters (see
   * ./lifecycle.ts), and without it the start's own day has to stand for the
   * whole reservation, which files a multi-night trip into history on its first
   * morning. The parser has always extracted it (`ends_at` in src/parse/llm.ts);
   * this ledger was the one place dropping it. Defaulted so pre-2026-08-12
   * records still parse.
   */
  endsAt: z.string().nullable().default(null),
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

/**
 * Yen: a whole number, zero or more. A model once sent -500 and 1.5 and the UI
 * printed 「¥-500」 and 「¥1.5」 (issue #5). The stored record stays `z.number()`
 * so an old row never fails to load.
 */
const yenSchema = z.number().int("金額は円の整数で").min(0, "金額は 0 以上で");

/** Fields a client may set on create; server owns id/status/timestamps. */
export const webCreateSchema = z.object({
  plan: z.string().nullable().default(null),
  service: z.string().min(1),
  // Readable or refused (./instant.ts): the stored record stays `z.string()` so
  // a legacy row never vanishes, but no new unreadable value gets in.
  startsAt: readableInstantSchema,
  endsAt: readableInstantSchema.nullable().default(null),
  amount: yenSchema.nullable().default(null),
  location: z.string().nullable().default(null),
  policy: webPolicySchema.default("unknown"),
  confirmed: z.boolean().default(false),
});

/** Fields a client may change on edit (all optional). */
export const webPatchSchema = z.object({
  plan: z.string().nullable().optional(),
  service: z.string().min(1).optional(),
  startsAt: readableInstantSchema.optional(),
  endsAt: readableInstantSchema.nullable().optional(),
  amount: yenSchema.nullable().optional(),
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
/**
 * A refused transition. `message` is the stable English form the web UI maps
 * to Japanese (web/index.html `transitionText`); `hint` is the next step in
 * Japanese for a caller with no such table — the MCP relays it to the model
 * (issue #6: 「先に ○○ をキャンセルしてから」 is what it could not work out alone).
 * `blockingId` names the confirmed reservation standing in the way.
 */
export class WebTransitionError extends Error {
  readonly hint: string;
  readonly blockingId: string | null;
  constructor(
    readonly command: "confirm" | "patch_plan",
    readonly from: WebStatus,
    message = `cannot ${command} reservation from ${from}`,
    extra: { hint?: string; blockingId?: string } = {},
  ) {
    super(message);
    this.name = "WebTransitionError";
    this.blockingId = extra.blockingId ?? null;
    this.hint = extra.hint ??
      (command === "patch_plan"
        ? "確定済みの予約は別のプランへ移せません。先に cancel_reservation で確定を外してください。"
        : from === "confirmed"
        ? "この予約はすでに確定しています。"
        : "確定できるのは候補（candidate）だけです。restore_reservation で候補に戻してから確定してください。");
  }
}

/** A reservation a settlement changed alongside the one that was acted on. */
export interface AffectedReservation {
  id: string;
  service: string;
  status: WebStatus;
}

export interface ConfirmOutcome {
  reservation: WebReservation;
  /** Siblings in the plan this confirmation turned to_cancel (issue #6). */
  affected: AffectedReservation[];
}

export interface CreateOutcome extends ConfirmOutcome {
  /**
   * The plan's already-confirmed reservation when a CANDIDATE was added to a
   * settled plan — allowed, but the caller should say so (issue #6).
   */
  planAlreadyConfirmed: WebReservation | null;
}

/** The confirmed reservation in `plan`, if any (other than `excludeId`). */
export async function findConfirmedInPlan(
  kv: Deno.Kv,
  token: string,
  plan: string,
  excludeId: string | null = null,
): Promise<WebReservation | null> {
  for await (const e of kv.list<WebReservation>({ prefix: prefix(token) })) {
    const parsed = webReservationSchema.safeParse(e.value);
    if (!parsed.success) continue;
    const r = parsed.data;
    if (r.plan === plan && r.status === "confirmed" && r.id !== excludeId) return r;
  }
  return null;
}

export async function listReservations(kv: Deno.Kv, token: string): Promise<WebReservation[]> {
  const out: WebReservation[] = [];
  for await (const e of kv.list<WebReservation>({ prefix: prefix(token) })) {
    const parsed = webReservationSchema.safeParse(e.value);
    if (parsed.success) out.push(parsed.data);
  }
  // 並べるのは瞬間で。文字列比較だと、同じ時刻を "…+09:00" と "…Z" で持つ2件の
  // 前後が入れ替わる（正規化前に書かれた記録が混ざり得る）。読めない開始は最後に。
  const at = (r: WebReservation) =>
    toInstantOrNull(r.startsAt)?.epochMilliseconds ?? Number.MAX_SAFE_INTEGER;
  out.sort((a, b) => at(a) - at(b) || a.startsAt.localeCompare(b.startsAt));
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
  return (await createReservationWithEffects(kv, token, input, ids, actor)).reservation;
}

/** createReservation, plus what else the write changed or found (issue #6). */
export async function createReservationWithEffects(
  kv: Deno.Kv,
  token: string,
  input: z.infer<typeof webCreateSchema>,
  ids: WebIds,
  actor: WebActor = null,
): Promise<CreateOutcome> {
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
    // 保存する時刻は正規形にそろえる（./instant.ts）。オフセットの無い文字列や
    // "+09" のような書き方は、読む側によって意味が変わる（サーバは Temporal、
    // ブラウザは Date.parse）ので、同じ台帳を見て終わった予約の判定が食い違う。
    startsAt: normalizeRequiredInstant(input.startsAt),
    endsAt: normalizeInstant(input.endsAt),
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
  if (!input.confirmed) {
    return {
      reservation: r,
      affected: [],
      planAlreadyConfirmed: r.plan === null ? null : await findConfirmedInPlan(kv, token, r.plan),
    };
  }
  try {
    const outcome = (await confirmReservationWithEffects(kv, token, r.id, ids, actor))!;
    return { ...outcome, planAlreadyConfirmed: null };
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
    ...(patch.startsAt !== undefined ? { startsAt: normalizeRequiredInstant(patch.startsAt) } : {}),
    ...(patch.endsAt !== undefined ? { endsAt: normalizeInstant(patch.endsAt) } : {}),
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
  return (await confirmReservationWithEffects(kv, token, id, ids, actor))?.reservation ?? null;
}

/**
 * confirmReservation, reporting the siblings it settled. With `replace`, a
 * sibling that is already confirmed is turned to_cancel in the same commit
 * instead of blocking — the one-step 「確定を差し替える」 (issue #6), which
 * otherwise took a cancel and a confirm with a window of no winner between.
 */
export async function confirmReservationWithEffects(
  kv: Deno.Kv,
  token: string,
  id: string,
  ids: WebIds,
  actor: WebActor = null,
  opts: { replace?: boolean } = {},
): Promise<ConfirmOutcome | null> {
  const replace = opts.replace === true;
  const blocked = (plan: string, winner: WebReservation) =>
    new WebTransitionError(
      "confirm",
      "candidate",
      `plan "${plan}" already has a confirmed reservation`,
      {
        blockingId: winner.id,
        hint: `このプランでは「${winner.service}」（${winner.id}）が確定済みです。差し替えるなら ` +
          "confirm_reservation を replace: true で呼ぶ（確定済みの方は要キャンセルになる）か、" +
          "先に cancel_reservation で外してから確定してください。",
      },
    );
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
    const nowMs = Temporal.Instant.from(now).epochMilliseconds;
    const next: WebReservation = {
      ...cur,
      status: "confirmed",
      updated_at: now,
      updated_by: actor,
    };
    let tx = kv.atomic().check(targetEntry);
    // Siblings this commit turns to_cancel (reported as `affected`).
    const siblings: Deno.KvEntry<WebReservation>[] = [];

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
          parsedGuarded.data.status === "confirmed" &&
          !replace
        ) {
          throw blocked(cur.plan, parsedGuarded.data);
        }
      }

      // Version-check and update all candidate siblings in the same commit as
      // the winner. There can be neither two winners nor partial settlement.
      for await (const entry of kv.list<WebReservation>({ prefix: prefix(token) })) {
        const parsed = webReservationSchema.safeParse(entry.value);
        if (!parsed.success || parsed.data.id === id || parsed.data.plan !== cur.plan) continue;
        if (parsed.data.status === "confirmed") {
          if (!replace) throw blocked(cur.plan, parsed.data);
          // Replacing: the old winner steps down in the same commit.
          siblings.push(entry);
          continue;
        }
        // 日が過ぎた候補は巻き添えにしない。もう電話するところが無いのに
        // to_cancel を書くと、履歴が「要キャンセルのまま放置した」と、実際には
        // 起きていないことを言い出す（終わった予約の状態は過去についての事実）。
        if (parsed.data.status === "candidate" && !isFinished(parsed.data, nowMs)) {
          siblings.push(entry);
        }
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
    if (committed.ok) {
      return {
        reservation: next,
        affected: siblings.map((e) => ({
          id: e.value.id,
          service: e.value.service,
          status: "to_cancel" as const,
        })),
      };
    }
  }

  throw new WebTransitionError(
    "confirm",
    "candidate",
    "reservation changed while it was being confirmed",
    { hint: "同時に別の操作が入りました。台帳を読み込み直してから、もう一度確定してください。" },
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

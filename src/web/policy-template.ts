/**
 * 施設ごとのキャンセル規定テンプレ（オーナー 2026-07-27:
 * 「ホテルごとに規定(ベース)を設定できるといいかも。プランごとになるかもだけど
 * 基本的に同じことが多いため」）— 同じ宿・同じ店の料率表を予約ごとに入れ直させ
 * ないための、台帳ごとのライブラリ。
 *
 * KV: `["web", <ledgerToken>, "policy_tpl", <facilityKey(facility)>]` →
 * `{ facility, policy, updated_at }`. The KEY is the normalized facility name,
 * so 「ＡＢＣ」and 「ABC」, or 「湖畔の湯宿 蛍」 written with an ideographic
 * space (U+3000) and with an ASCII one, share a single template; the VALUE
 * keeps the name as typed, because that is what the UI shows and re-fills.
 *
 * A facility has exactly one base policy: saving over an existing key
 * overwrites it (last write wins). Per-plan variation stays on the reservation
 * — the template is only the starting point the form pre-fills.
 *
 * Templates are private to the ledger they live under. Sharing a reservation
 * shares no templates: a member acts on their OWN ledger token, so they can
 * never address the owner's key (see api.ts).
 *
 * Distinct from the core domain's `PolicyTemplate`
 * (src/core/schema/policy-template.ts, SDD §3.4): that is the event-sourced
 * side's per-`service_key` cache with hit counts, wired to the core store. This
 * module is the web ledger's own simpler store, the same split store.ts has
 * from the core reservation aggregate.
 */
import { z } from "zod";
import {
  normalizePolicy,
  webCustomPolicySchema,
  type WebPolicy,
  webPolicyPresetSchema,
} from "./policy.ts";
import type { WebIds } from "./store.ts";

/**
 * What a client may send as a template policy: every policy EXCEPT "unknown".
 * A template that says nothing is worse than no template — it would pre-fill
 * the form with 不明 and hide the fact that the fee table was never entered,
 * so the model refuses to store one (the HTTP layer maps that to 400).
 */
export const templatePolicyInputSchema = z.union([
  webPolicyPresetSchema.exclude(["unknown"]),
  webCustomPolicySchema,
]);

/** The stored policy: canonicalized on write, exactly like the ledger's. */
export const templatePolicySchema = templatePolicyInputSchema.transform(normalizePolicy);

/** Display name bounds; the key is derived from it via `facilityKey`. */
export const facilitySchema = z.string().trim().min(1).max(100);

export const policyTemplateSchema = z.object({
  /** The facility name as the user typed it (display + re-fill). */
  facility: facilitySchema,
  policy: templatePolicySchema,
  updated_at: z.string().min(1),
});
export type WebPolicyTemplate = z.infer<typeof policyTemplateSchema>;

/** Body of `PUT /api/policy-templates/<facility>`. */
export const policyTemplateBodySchema = z.object({ policy: templatePolicySchema });

const NS = "web";
const TPL = "policy_tpl";
const key = (token: string, facilityKey: string) => [NS, token, TPL, facilityKey];
const prefix = (token: string) => [NS, token, TPL];

/**
 * The template key for a facility name: NFKC (full-width → ASCII, U+3000 →
 * space), trimmed, internal whitespace collapsed to one space, lowercased.
 * Lowercasing is the locale-independent `toLowerCase`, and only the ASCII part
 * of a name is affected — Japanese has no case.
 */
export function facilityKey(facility: string): string {
  return facility.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Stores (or overwrites) a facility's base policy. Throws `ZodError` on an
 * invalid or "unknown" policy and on an out-of-bounds name — validating here
 * as well as at the HTTP edge is what keeps such records out of KV whatever
 * the caller is.
 */
export async function saveTemplate(
  kv: Deno.Kv,
  token: string,
  facility: string,
  policy: WebPolicy,
  ids: WebIds,
): Promise<WebPolicyTemplate> {
  const rec = policyTemplateSchema.parse({
    facility,
    policy,
    updated_at: ids.nowIso(),
  });
  const k = facilityKey(rec.facility);
  if (k === "") throw new Error("facility name normalizes to an empty template key");
  await kv.set(key(token, k), rec);
  return rec;
}

/** A facility's template, or null when there is none. Exact normalized match. */
export async function getTemplate(
  kv: Deno.Kv,
  token: string,
  facility: string,
): Promise<WebPolicyTemplate | null> {
  const k = facilityKey(facility);
  if (k === "") return null;
  const entry = await kv.get<unknown>(key(token, k));
  // Validated on read like the ledger's records: a record written by an older
  // shape is skipped rather than served half-parsed.
  const parsed = policyTemplateSchema.safeParse(entry.value);
  return parsed.success ? parsed.data : null;
}

/** Every template in this ledger, sorted by display name. */
export async function listTemplates(kv: Deno.Kv, token: string): Promise<WebPolicyTemplate[]> {
  const out: WebPolicyTemplate[] = [];
  for await (const entry of kv.list<unknown>({ prefix: prefix(token) })) {
    const parsed = policyTemplateSchema.safeParse(entry.value);
    if (parsed.success) out.push(parsed.data);
  }
  out.sort((a, b) => a.facility.localeCompare(b.facility));
  return out;
}

/** Drops a facility's template. Idempotent — a missing key is still success. */
export async function deleteTemplate(
  kv: Deno.Kv,
  token: string,
  facility: string,
): Promise<void> {
  const k = facilityKey(facility);
  if (k === "") return;
  await kv.delete(key(token, k));
}

/**
 * 予約の共有（招待）— reservations stay in the OWNER's ledger
 * (`["web", ledgerId, "resv", id]`); sharing is expressed purely by
 * reference so nothing is copied and the owner keeps single-writer control
 * (owner 2026-07-25).
 *
 * Two mirrored index keys, written/removed together in one `kv.atomic()`:
 *   ["resv_members", ownerUserId, resvId, memberUserId] → { addedAt }
 *     — the owner-side member roster of a reservation.
 *   ["shared_in", memberUserId, ownerUserId, resvId]     → { addedAt }
 *     — the member-side reverse lookup ("what is shared WITH me").
 *
 * Owner identity is stored as the stable userId (not the ledgerId, which a
 * user may still adopt/replace); the ledgerId is resolved at read time via
 * getUser, so the link survives a ledger swap.
 */
import { getReservation, type WebIds, type WebReservation } from "./store.ts";
import {
  findUserByEmail,
  findUserByUid,
  getUser,
  normalizeEmail,
  uidSchema,
  type WebUser,
} from "./users.ts";

const MEMBERS = "resv_members";
const SHARED_IN = "shared_in";

/** A reservation shared with some member: which owner, which reservation. */
export interface SharedRef {
  ownerUserId: string;
  resvId: string;
}

/** Adds `memberUserId` to a reservation's roster (both index keys). */
export async function addMember(
  kv: Deno.Kv,
  ownerUserId: string,
  resvId: string,
  memberUserId: string,
  ids: WebIds,
): Promise<void> {
  const val = { addedAt: ids.nowIso() };
  await kv.atomic()
    .set([MEMBERS, ownerUserId, resvId, memberUserId], val)
    .set([SHARED_IN, memberUserId, ownerUserId, resvId], val)
    .commit();
}

/** Removes a member (both index keys); a no-op when they were not a member. */
export async function removeMember(
  kv: Deno.Kv,
  ownerUserId: string,
  resvId: string,
  memberUserId: string,
): Promise<void> {
  await kv.atomic()
    .delete([MEMBERS, ownerUserId, resvId, memberUserId])
    .delete([SHARED_IN, memberUserId, ownerUserId, resvId])
    .commit();
}

export async function isMember(
  kv: Deno.Kv,
  ownerUserId: string,
  resvId: string,
  memberUserId: string,
): Promise<boolean> {
  return (await kv.get([MEMBERS, ownerUserId, resvId, memberUserId])).value !== null;
}

/** The member userIds on a reservation's roster. */
export async function listMemberIds(
  kv: Deno.Kv,
  ownerUserId: string,
  resvId: string,
): Promise<string[]> {
  const out: string[] = [];
  for await (const e of kv.list({ prefix: [MEMBERS, ownerUserId, resvId] })) {
    const memberUserId = e.key[3];
    if (typeof memberUserId === "string") out.push(memberUserId);
  }
  return out;
}

/** Every reservation shared WITH `memberUserId` (owner + resv id pairs). */
export async function listSharedIn(kv: Deno.Kv, memberUserId: string): Promise<SharedRef[]> {
  const out: SharedRef[] = [];
  for await (const e of kv.list({ prefix: [SHARED_IN, memberUserId] })) {
    const ownerUserId = e.key[2];
    const resvId = e.key[3];
    if (typeof ownerUserId === "string" && typeof resvId === "string") {
      out.push({ ownerUserId, resvId });
    }
  }
  return out;
}

/** A shared reservation resolved to its record + the owner's display name. */
export interface SharedReservation {
  reservation: WebReservation;
  ownerDisplayName: string;
}

/**
 * Resolves every reservation shared with `memberUserId` to its live record.
 * Dangling refs (owner or reservation gone) are skipped. The owner name
 * falls back uid → email so the member can still tell whose it is.
 */
export async function listSharedReservations(
  kv: Deno.Kv,
  memberUserId: string,
): Promise<SharedReservation[]> {
  const out: SharedReservation[] = [];
  for (const { ownerUserId, resvId } of await listSharedIn(kv, memberUserId)) {
    const owner = await getUser(kv, ownerUserId);
    if (owner === null) continue;
    const reservation = await getReservation(kv, owner.ledgerId, resvId);
    if (reservation === null) continue;
    out.push({
      reservation,
      ownerDisplayName: owner.displayName ?? owner.uid ?? owner.email,
    });
  }
  return out;
}

/** Drops every share of a reservation (called when the owner deletes it). */
export async function cleanupReservationShares(
  kv: Deno.Kv,
  ownerUserId: string,
  resvId: string,
): Promise<void> {
  const members = await listMemberIds(kv, ownerUserId, resvId);
  if (members.length === 0) return;
  let tx = kv.atomic();
  for (const memberUserId of members) {
    tx = tx
      .delete([MEMBERS, ownerUserId, resvId, memberUserId])
      .delete([SHARED_IN, memberUserId, ownerUserId, resvId]);
  }
  await tx.commit();
}

/**
 * Exact-match user lookup for invites (owner 2026-07-25): `q` with an `@` is
 * an email (normalized; primary/alt both indexed), otherwise a uid — and
 * only when it passes uidSchema. Partial matching / enumeration is never
 * offered. Returns null when nothing matches exactly.
 */
export async function lookupUser(kv: Deno.Kv, q: string): Promise<WebUser | null> {
  const query = q.trim();
  if (query === "") return null;
  if (query.includes("@")) return await findUserByEmail(kv, normalizeEmail(query));
  if (uidSchema.safeParse(query).success) return await findUserByUid(kv, query);
  return null;
}

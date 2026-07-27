/**
 * 予約の共有（招待）— reservations stay in the OWNER's ledger
 * (`["web", ledgerId, "resv", id]`); sharing is expressed purely by
 * reference so nothing is copied and the owner keeps single-writer control
 * (owner 2026-07-25).
 *
 * Two mirrored index keys, written/removed together in one `kv.atomic()`,
 * both holding the SAME membership value:
 *   ["resv_members", ownerUserId, resvId, memberUserId] → { addedAt, role }
 *     — the owner-side member roster of a reservation.
 *   ["shared_in", memberUserId, ownerUserId, resvId]     → { addedAt, role }
 *     — the member-side reverse lookup ("what is shared WITH me").
 *
 * Owner identity is stored as the stable userId (not the ledgerId, which a
 * user may still adopt/replace); the ledgerId is resolved at read time via
 * getUser, so the link survives a ledger swap.
 */
import { z } from "zod";
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

/**
 * What an invited member may do. "viewer" is read-only; "editor" is the
 * 「編集を許可」 grant (owner 2026-07-28) — see api.ts for the exact split.
 */
export const memberRoleSchema = z.enum(["viewer", "editor"]);
export type MemberRole = z.infer<typeof memberRoleSchema>;

/** The stored membership value; `role` defaults so pre-role rows stay viewers. */
export const membershipSchema = z.object({
  addedAt: z.string(),
  role: memberRoleSchema.default("viewer"),
});
export type Membership = z.infer<typeof membershipSchema>;

/** Validated on read (like the ledger records): an unparsable row is no share. */
function readMembership(value: unknown): Membership | null {
  const parsed = membershipSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A reservation shared with some member: which owner, which one, what role. */
export interface SharedRef {
  ownerUserId: string;
  resvId: string;
  role: MemberRole;
}

/** Adds `memberUserId` to a reservation's roster (both index keys). */
export async function addMember(
  kv: Deno.Kv,
  ownerUserId: string,
  resvId: string,
  memberUserId: string,
  ids: WebIds,
  role: MemberRole = "viewer",
): Promise<void> {
  const val: Membership = { addedAt: ids.nowIso(), role };
  await kv.atomic()
    .set([MEMBERS, ownerUserId, resvId, memberUserId], val)
    .set([SHARED_IN, memberUserId, ownerUserId, resvId], val)
    .commit();
}

/** The membership row for one member, or null when they are not a member. */
export async function getMembership(
  kv: Deno.Kv,
  ownerUserId: string,
  resvId: string,
  memberUserId: string,
): Promise<Membership | null> {
  return readMembership((await kv.get([MEMBERS, ownerUserId, resvId, memberUserId])).value);
}

/**
 * Re-grades an existing member (both index keys in one commit, as add/remove
 * do). Null when that user is not on this reservation's roster.
 */
export async function setMemberRole(
  kv: Deno.Kv,
  ownerUserId: string,
  resvId: string,
  memberUserId: string,
  role: MemberRole,
): Promise<Membership | null> {
  const cur = await getMembership(kv, ownerUserId, resvId, memberUserId);
  if (cur === null) return null;
  const val: Membership = { ...cur, role };
  await kv.atomic()
    .set([MEMBERS, ownerUserId, resvId, memberUserId], val)
    .set([SHARED_IN, memberUserId, ownerUserId, resvId], val)
    .commit();
  return val;
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
  return (await getMembership(kv, ownerUserId, resvId, memberUserId)) !== null;
}

/** A reservation's roster: member userIds with their role. */
export async function listMembers(
  kv: Deno.Kv,
  ownerUserId: string,
  resvId: string,
): Promise<{ userId: string; role: MemberRole }[]> {
  const out: { userId: string; role: MemberRole }[] = [];
  for await (const e of kv.list({ prefix: [MEMBERS, ownerUserId, resvId] })) {
    const userId = e.key[3];
    const membership = readMembership(e.value);
    if (typeof userId === "string" && membership !== null) {
      out.push({ userId, role: membership.role });
    }
  }
  return out;
}

/** Every reservation shared WITH `memberUserId`, with that member's role. */
export async function listSharedIn(kv: Deno.Kv, memberUserId: string): Promise<SharedRef[]> {
  const out: SharedRef[] = [];
  for await (const e of kv.list({ prefix: [SHARED_IN, memberUserId] })) {
    const ownerUserId = e.key[2];
    const resvId = e.key[3];
    const membership = readMembership(e.value);
    if (typeof ownerUserId === "string" && typeof resvId === "string" && membership !== null) {
      out.push({ ownerUserId, resvId, role: membership.role });
    }
  }
  return out;
}

/** This member's share of one reservation (null when it is not shared with them). */
export async function findShare(
  kv: Deno.Kv,
  memberUserId: string,
  resvId: string,
): Promise<SharedRef | null> {
  return (await listSharedIn(kv, memberUserId)).find((r) => r.resvId === resvId) ?? null;
}

/** A shared reservation resolved to its record + how it is shared. */
export interface SharedReservation {
  reservation: WebReservation;
  ownerDisplayName: string;
  role: MemberRole;
}

/**
 * How a user may be named to someone who is not them. NEVER the e-mail
 * address: the invite lookup treats it as non-returnable, so a member-facing
 * label must not reintroduce it (owner 2026-07-28).
 */
export function displayLabel(user: WebUser): string {
  return user.displayName ?? (user.uid === null ? "共有ユーザー" : `@${user.uid}`);
}

/**
 * Resolves every reservation shared with `memberUserId` to its live record.
 * Dangling refs (owner or reservation gone) are skipped.
 */
export async function listSharedReservations(
  kv: Deno.Kv,
  memberUserId: string,
): Promise<SharedReservation[]> {
  const out: SharedReservation[] = [];
  for (const { ownerUserId, resvId, role } of await listSharedIn(kv, memberUserId)) {
    const owner = await getUser(kv, ownerUserId);
    if (owner === null) continue;
    const reservation = await getReservation(kv, owner.ledgerId, resvId);
    if (reservation === null) continue;
    out.push({ reservation, ownerDisplayName: displayLabel(owner), role });
  }
  return out;
}

/** Drops every share of a reservation (called when the owner deletes it). */
export async function cleanupReservationShares(
  kv: Deno.Kv,
  ownerUserId: string,
  resvId: string,
): Promise<void> {
  const members = await listMembers(kv, ownerUserId, resvId);
  if (members.length === 0) return;
  let tx = kv.atomic();
  for (const { userId: memberUserId } of members) {
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

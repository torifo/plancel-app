/**
 * Web HTTP API (`/api/*`) — per-user reservation CRUD backed by the shared
 * Deno KV, namespaced by the browser token (see store.ts).
 *
 * Identity (owner 2026-07-21, login era): the entrypoint resolves the
 * session/dev/admin identity to a ledger id and passes it via
 * `opts.ledger`. The `x-plancel-token` header remains as a fallback so
 * handler-level tests and header-based tooling keep working; with
 * neither → 400. `opts.onMutate(id)` fires after any successful write so
 * the caller can kick the Google Calendar sync (best-effort, never blocks
 * the response).
 *
 * Routes (all under /api):
 *   GET    /api/reservations              list
 *   POST   /api/reservations              create   {plan,service,startsAt,amount,policy,confirmed}
 *   PATCH  /api/reservations/:id          edit     {plan?,service?,startsAt?,amount?,policy?}
 *   DELETE /api/reservations/:id          delete
 *   POST   /api/reservations/:id/confirm  confirm  (siblings in plan -> to_cancel)
 *   POST   /api/reservations/:id/cancel   report cancelled
 *   POST   /api/reservations/:id/restore  restore  (cancelled|to_cancel -> candidate)
 *
 * Sharing (invite) routes — reservations stay in the owner's ledger, shares
 * are references (see sharing.ts). Available only when the acting ledger IS
 * the logged-in user's own ledger (opts.user); header-token / demo callers
 * get no sharing surface:
 *   GET    /api/reservations/:id/members             list (owner OR member)
 *   POST   /api/reservations/:id/members {q,role?}   invite (owner only)
 *   PATCH  /api/reservations/:id/members/:userId {role}  re-grade (owner only)
 *   DELETE /api/reservations/:id/members/me          leave (member)
 *   DELETE /api/reservations/:id/members/:userId     remove (owner only)
 * Plus the exact-match lookup used by the invite box:
 *   GET    /api/users/lookup?q=<email|uid>         (login required)
 *
 * Policy templates (施設の既定規定, see policy-template.ts) — private to
 * the acting ledger, no calendar side effects, so no `mutated()` hook:
 *   GET    /api/policy-templates                       list
 *   PUT    /api/policy-templates/<facility>   {policy} save/overwrite
 *   DELETE /api/policy-templates/<facility>            delete (204, idempotent)
 *   GET    /api/policy-templates/lookup?service=<name> pre-fill lookup
 */
import { z } from "zod";
import {
  deleteTemplate,
  facilitySchema,
  getTemplate,
  listTemplates,
  policyTemplateBodySchema,
  saveTemplate,
} from "./policy-template.ts";
import {
  cancelReservation,
  confirmReservation,
  createReservation,
  deleteReservation,
  getReservation,
  listReservations,
  patchReservation,
  restoreReservation,
  webCreateSchema,
  type WebIds,
  webPatchSchema,
  type WebReservation,
  WebTransitionError,
} from "./store.ts";
import { getUser, type WebUser } from "./users.ts";
import {
  addMember,
  cleanupReservationShares,
  displayLabel,
  findShare,
  isMember,
  listMembers,
  listSharedReservations,
  lookupUser,
  type MemberRole,
  memberRoleSchema,
  removeMember,
  setMemberRole,
} from "./sharing.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * What the roster tells one member about another. `label` is the ready-to-show
 * name; the e-mail address is never part of a member-facing response.
 */
const memberView = (u: WebUser, role: MemberRole) => ({
  userId: u.id,
  displayName: u.displayName,
  uid: u.uid,
  label: displayLabel(u),
  role,
});

/** True if this request targets a route `handleWebApi` serves. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api/reservations" || pathname.startsWith("/api/reservations/") ||
    pathname === "/api/policy-templates" || pathname.startsWith("/api/policy-templates/");
}

/** True if this request targets the exact-match user lookup (invite box). */
export function isUsersLookupPath(pathname: string): boolean {
  return pathname === "/api/users/lookup";
}

export interface WebApiOptions {
  /** Ledger resolved by the entrypoint (session/dev/admin); overrides the header. */
  ledger?: string;
  /**
   * The logged-in user, when there is one. Sharing (invite) routes are
   * enabled only when this is set AND the acting ledger is the user's OWN
   * ledger (not the ::demo namespace).
   */
  user?: WebUser | null;
  /**
   * Called with the reservation id after each successful mutation.
   * `ledgerOwner` is set when the write landed in ANOTHER user's ledger (an
   * editor member's edit), so the caller syncs the OWNER's calendar.
   */
  onMutate?: (resvId: string, ledgerOwner?: WebUser) => void;
}

/** Where an editor member's write goes: the OWNER's ledger, never a copy. */
interface MemberGrant {
  ledger: string;
  ownerUser: WebUser;
}

/**
 * THE permission gate for a reservation request the acting ledger could not
 * serve itself (i.e. the record is not in it). It is the only place that reads
 * a membership role, so the capability split lives here and nowhere else.
 *
 * Capability split (owner 2026-07-28「招待する時に編集を許可すれば細かい修正を
 * 参加者もできるように」): an "editor" may PATCH the reservation's own fields.
 * confirm / cancel / restore / delete / invite / re-grade stay owner-only —
 * confirming settles a whole plan (siblings → to_cancel) and deletion is
 * irreversible, neither of which is the 細かい修正 the owner delegated.
 *
 * 403 distinguishes "you are on this share but not allowed" from the 404 that
 * a non-member gets (which must not confirm the reservation exists).
 */
async function memberGate(
  kv: Deno.Kv,
  actor: WebUser | null,
  resvId: string,
  need: "edit",
): Promise<MemberGrant | Response>;
async function memberGate(
  kv: Deno.Kv,
  actor: WebUser | null,
  resvId: string,
  need: "owner",
): Promise<Response>;
async function memberGate(
  kv: Deno.Kv,
  actor: WebUser | null,
  resvId: string,
  need: "edit" | "owner",
): Promise<MemberGrant | Response> {
  const share = actor === null ? null : await findShare(kv, actor.id, resvId);
  if (share === null) return json({ error: "not found" }, 404);
  if (need === "owner" || share.role !== "editor") {
    return json({ error: "forbidden", reason: "role", role: share.role }, 403);
  }
  const ownerUser = await getUser(kv, share.ownerUserId);
  // Dangling share (the owner 退会'd): there is no ledger left to write to.
  if (ownerUser === null) return json({ error: "not found" }, 404);
  return { ledger: ownerUser.ledgerId, ownerUser };
}

/**
 * Exact-match user lookup for the invite box (login required). Never leaks
 * email — a hit returns only { userId, displayName, uid }.
 */
export async function handleUserLookup(
  kv: Deno.Kv,
  req: Request,
  user: WebUser | null,
): Promise<Response> {
  if (user === null) return json({ error: "login required" }, 401);
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const found = await lookupUser(kv, q);
  if (found === null) return json({ found: false });
  return json({ found: true, userId: found.id, displayName: found.displayName, uid: found.uid });
}

// Role is optional on invite and defaults to read-only: an owner who does not
// say 「編集を許可」 must never hand out write access by omission.
const inviteSchema = z.object({ q: z.string().min(1), role: memberRoleSchema.default("viewer") });
const roleSchema = z.object({ role: memberRoleSchema });

/**
 * Handles one `/api/*` request. `kv` is the shared Deno KV; `ids` supplies id
 * + timestamp (injected for deterministic tests). Never throws on bad input —
 * returns 4xx JSON instead.
 */
export async function handleWebApi(
  kv: Deno.Kv,
  req: Request,
  ids: WebIds,
  opts: WebApiOptions = {},
): Promise<Response> {
  const token = opts.ledger ?? req.headers.get("x-plancel-token")?.trim();
  if (!token) return json({ error: "missing x-plancel-token" }, 400);
  const mutated = (id: string, ledgerOwner?: WebUser) => opts.onMutate?.(id, ledgerOwner);

  const user = opts.user ?? null;
  // Sharing is available only when the acting ledger IS this user's OWN
  // ledger. Demo (`ledgerId::demo`) and header/admin callers get `owner === null`.
  const owner = user !== null && token === user.ledgerId ? user : null;
  // Attribution for `updated_by`; null for header-token / admin tooling.
  const actor = user?.id ?? null;

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","reservations",id?,action?,sub?]

  // Policy templates are keyed by the ACTING ledger, so ownership needs no
  // extra check: a shared-reservation member calls with their own token and
  // reaches their own templates, never the owner's.
  if (parts[1] === "policy-templates") {
    // A facility has no sub-resources, so a deeper path is not a route.
    if (parts.length > 3) return json({ error: "not found" }, 404);
    return await handlePolicyTemplates(kv, req, ids, token, parts[2], url);
  }

  const id = parts[2];
  const action = parts[3];
  const sub = parts[4];

  // Collection: /api/reservations
  if (id === undefined) {
    if (req.method === "GET") {
      const own = await listReservations(kv, token);
      // Merge reservations shared WITH this user (own ledger only). Own
      // reservations carry no `shared` field; shared ones carry the owner name.
      if (owner !== null) {
        const shared = (await listSharedReservations(kv, owner.id)).map((s) => ({
          ...s.reservation,
          shared: { ownerDisplayName: s.ownerDisplayName, role: s.role },
        }));
        return json({ reservations: [...own, ...shared] });
      }
      return json({ reservations: own });
    }
    if (req.method === "POST") {
      const parsed = webCreateSchema.safeParse(await readJson(req));
      if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues }, 400);
      let r;
      try {
        r = await createReservation(kv, token, parsed.data, ids, actor);
      } catch (error) {
        if (error instanceof WebTransitionError) {
          return json({ error: "invalid_transition", message: error.message }, 409);
        }
        throw error;
      }
      mutated(r.id);
      return json({ reservation: r }, 201);
    }
    return json({ error: "method not allowed" }, 405);
  }

  // Members (invite): /api/reservations/:id/members[/(me|:userId)]
  if (action === "members") {
    // List — visible to the owner OR any member of the reservation.
    if (sub === undefined && req.method === "GET") {
      let ownerUserId: string | null = null;
      if (owner !== null && (await getReservation(kv, token, id)) !== null) {
        ownerUserId = owner.id;
      } else if (user !== null) {
        const share = await findShare(kv, user.id, id);
        if (share !== null) ownerUserId = share.ownerUserId;
      }
      if (ownerUserId === null) return json({ error: "not found" }, 404);
      const members = [];
      for (const m of await listMembers(kv, ownerUserId, id)) {
        const u = await getUser(kv, m.userId);
        if (u !== null) members.push(memberView(u, m.role));
      }
      return json({ members });
    }
    // Invite — owner only. Self / duplicate are no-op successes.
    if (sub === undefined && req.method === "POST") {
      if (owner === null) return json({ error: "forbidden" }, 403);
      if ((await getReservation(kv, token, id)) === null) {
        return await memberGate(kv, user, id, "owner");
      }
      const parsed = inviteSchema.safeParse(await readJson(req));
      if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues }, 400);
      const target = await lookupUser(kv, parsed.data.q);
      if (target === null) return json({ error: "user_not_found" }, 404);
      if (target.id === owner.id) return json({ ok: true });
      // A re-invite must not silently re-grade an existing member: the owner
      // changes a role through the explicit PATCH below.
      if (await isMember(kv, owner.id, id, target.id)) return json({ ok: true });
      await addMember(kv, owner.id, id, target.id, ids, parsed.data.role);
      return json({ ok: true, member: memberView(target, parsed.data.role) });
    }
    // Re-grade a member (編集を許可 / 閲覧のみ) — owner only.
    if (sub !== undefined && sub !== "me" && req.method === "PATCH") {
      if (owner === null) return json({ error: "forbidden" }, 403);
      if ((await getReservation(kv, token, id)) === null) {
        return await memberGate(kv, user, id, "owner");
      }
      const parsed = roleSchema.safeParse(await readJson(req));
      if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues }, 400);
      const updated = await setMemberRole(kv, owner.id, id, sub, parsed.data.role);
      if (updated === null) return json({ error: "not found" }, 404);
      const u = await getUser(kv, sub);
      if (u === null) return json({ error: "not found" }, 404);
      return json({ member: memberView(u, updated.role) });
    }
    // Leave — a member removes themselves.
    if (sub === "me" && req.method === "DELETE") {
      const share = user === null ? null : await findShare(kv, user.id, id);
      if (share === null || user === null) return json({ error: "not found" }, 404);
      await removeMember(kv, share.ownerUserId, id, user.id);
      return json({ ok: true });
    }
    // Remove — owner drops a member by userId.
    if (sub !== undefined && sub !== "me" && req.method === "DELETE") {
      if (owner === null) return json({ error: "forbidden" }, 403);
      if ((await getReservation(kv, token, id)) === null) {
        return await memberGate(kv, user, id, "owner");
      }
      await removeMember(kv, owner.id, id, sub);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  // Item action: /api/reservations/:id/(confirm|cancel|restore) — settling a
  // shared reservation stays with its owner, whatever the member's role.
  if (action === "confirm" && req.method === "POST") {
    let r;
    try {
      r = await confirmReservation(kv, token, id, ids, actor);
    } catch (error) {
      if (error instanceof WebTransitionError) {
        return json({ error: "invalid_transition", message: error.message }, 409);
      }
      throw error;
    }
    if (r) {
      mutated(r.id);
      return json({ reservation: r });
    }
    return await memberGate(kv, user, id, "owner");
  }
  if (action === "cancel" && req.method === "POST") {
    const r = await cancelReservation(kv, token, id, ids, actor);
    if (r) {
      mutated(r.id);
      return json({ reservation: r });
    }
    return await memberGate(kv, user, id, "owner");
  }
  if (action === "restore" && req.method === "POST") {
    const r = await restoreReservation(kv, token, id, ids, actor);
    if (r) {
      mutated(r.id);
      return json({ reservation: r });
    }
    return await memberGate(kv, user, id, "owner");
  }

  // Item: /api/reservations/:id
  if (action === undefined) {
    if (req.method === "PATCH") {
      const parsed = webPatchSchema.safeParse(await readJson(req));
      if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues }, 400);
      let r: WebReservation | null;
      // An editor member's edit is applied to the OWNER's ledger (no copy is
      // made in the member's) and reports the owner so the same post-write
      // calendar sync runs for THEIR Google/ICS.
      let ledgerOwner: WebUser | undefined;
      try {
        r = await patchReservation(kv, token, id, parsed.data, ids, actor);
        if (r === null) {
          const grant = await memberGate(kv, user, id, "edit");
          if (grant instanceof Response) return grant;
          ledgerOwner = grant.ownerUser;
          r = await patchReservation(kv, grant.ledger, id, parsed.data, ids, actor);
        }
      } catch (error) {
        if (error instanceof WebTransitionError) {
          return json({ error: "invalid_transition", message: error.message }, 409);
        }
        throw error;
      }
      if (r === null) return json({ error: "not found" }, 404);
      mutated(r.id, ledgerOwner);
      return json({ reservation: r });
    }
    if (req.method === "DELETE") {
      const ok = await deleteReservation(kv, token, id);
      if (ok) {
        // Owner deleting their reservation: sweep its shares too.
        if (owner !== null) await cleanupReservationShares(kv, owner.id, id);
        mutated(id);
        return json({ ok: true });
      }
      return await memberGate(kv, user, id, "owner");
    }
  }

  return json({ error: "not found" }, 404);
}

/**
 * `/api/policy-templates…` — the per-ledger library of facility base policies.
 *
 * Deliberately NOT folded into reservation create/patch as a
 * `saveAsTemplate` flag: the effective policy of a PATCH is only known after
 * merging with the stored record, so the flag could only be honoured after the
 * reservation write had already committed — a rejected template ("unknown")
 * would then have to either fail a request whose main effect already happened
 * or be dropped silently. Two explicit calls keep the failure modes honest.
 */
async function handlePolicyTemplates(
  kv: Deno.Kv,
  req: Request,
  ids: WebIds,
  token: string,
  segment: string | undefined,
  url: URL,
): Promise<Response> {
  if (segment === undefined) {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json({ templates: await listTemplates(kv, token) });
  }

  // Pre-fill lookup for the add/edit form. Exact normalized-key match ONLY —
  // no fuzzy/prefix matching in this slice, because a near miss quietly
  // pre-filling the wrong fee table is worse than no pre-fill at all.
  // "lookup" is therefore a reserved GET segment; a facility actually named
  // "lookup" stays reachable through PUT/DELETE, which never take this path.
  if (segment === "lookup") {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    const service = url.searchParams.get("service") ?? "";
    if (service.trim() === "") return json({ template: null });
    return json({ template: await getTemplate(kv, token, service) });
  }

  let facility: string;
  try {
    facility = decodeURIComponent(segment);
  } catch {
    return json({ error: "invalid facility name" }, 400);
  }

  if (req.method === "PUT") {
    const named = facilitySchema.safeParse(facility);
    if (!named.success) return json({ error: "invalid", issues: named.error.issues }, 400);
    const parsed = policyTemplateBodySchema.safeParse(await readJson(req));
    if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues }, 400);
    return json({ template: await saveTemplate(kv, token, named.data, parsed.data.policy, ids) });
  }
  if (req.method === "DELETE") {
    await deleteTemplate(kv, token, facility);
    return new Response(null, { status: 204 });
  }
  return json({ error: "method not allowed" }, 405);
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

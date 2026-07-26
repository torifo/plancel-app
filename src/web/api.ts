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
 *
 * Sharing (invite) routes — reservations stay in the owner's ledger, shares
 * are references (see sharing.ts). Available only when the acting ledger IS
 * the logged-in user's own ledger (opts.user); header-token / demo callers
 * get no sharing surface:
 *   GET    /api/reservations/:id/members          list (owner OR member)
 *   POST   /api/reservations/:id/members {q}       invite (owner only)
 *   DELETE /api/reservations/:id/members/me        leave (member)
 *   DELETE /api/reservations/:id/members/:userId   remove (owner only)
 * Plus the exact-match lookup used by the invite box:
 *   GET    /api/users/lookup?q=<email|uid>         (login required)
 */
import { z } from "zod";
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
  WebTransitionError,
} from "./store.ts";
import { getUser, type WebUser } from "./users.ts";
import {
  addMember,
  cleanupReservationShares,
  isMember,
  listMemberIds,
  listSharedIn,
  listSharedReservations,
  lookupUser,
  removeMember,
} from "./sharing.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** True if this request targets the web API (so the entrypoint can route it). */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api/reservations" || pathname.startsWith("/api/reservations/");
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
  /** Called with the reservation id after each successful mutation. */
  onMutate?: (resvId: string) => void;
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

const inviteSchema = z.object({ q: z.string().min(1) });

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
  const mutated = (id: string) => opts.onMutate?.(id);

  const user = opts.user ?? null;
  // Sharing is available only when the acting ledger IS this user's OWN
  // ledger. Demo (`ledgerId::demo`) and header/admin callers get `owner === null`.
  const owner = user !== null && token === user.ledgerId ? user : null;
  const isSharedMemberOf = async (resvId: string): Promise<boolean> =>
    user !== null && (await listSharedIn(kv, user.id)).some((r) => r.resvId === resvId);

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","reservations",id?,action?,sub?]
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
          shared: { ownerDisplayName: s.ownerDisplayName },
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
        r = await createReservation(kv, token, parsed.data, ids);
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
        const ref = (await listSharedIn(kv, user.id)).find((r) => r.resvId === id);
        if (ref !== undefined) ownerUserId = ref.ownerUserId;
      }
      if (ownerUserId === null) return json({ error: "not found" }, 404);
      const members = [];
      for (const memberUserId of await listMemberIds(kv, ownerUserId, id)) {
        const u = await getUser(kv, memberUserId);
        if (u !== null) members.push({ userId: u.id, displayName: u.displayName, uid: u.uid });
      }
      return json({ members });
    }
    // Invite — owner only. Self / duplicate are no-op successes.
    if (sub === undefined && req.method === "POST") {
      if (owner === null) return json({ error: "forbidden" }, 403);
      if ((await getReservation(kv, token, id)) === null) return json({ error: "not found" }, 404);
      const parsed = inviteSchema.safeParse(await readJson(req));
      if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues }, 400);
      const target = await lookupUser(kv, parsed.data.q);
      if (target === null) return json({ error: "user_not_found" }, 404);
      if (target.id === owner.id) return json({ ok: true });
      if (await isMember(kv, owner.id, id, target.id)) return json({ ok: true });
      await addMember(kv, owner.id, id, target.id, ids);
      return json({ ok: true });
    }
    // Leave — a member removes themselves.
    if (sub === "me" && req.method === "DELETE") {
      if (user === null) return json({ error: "not found" }, 404);
      const ref = (await listSharedIn(kv, user.id)).find((r) => r.resvId === id);
      if (ref === undefined) return json({ error: "not found" }, 404);
      await removeMember(kv, ref.ownerUserId, id, user.id);
      return json({ ok: true });
    }
    // Remove — owner drops a member by userId.
    if (sub !== undefined && sub !== "me" && req.method === "DELETE") {
      if (owner === null) return json({ error: "forbidden" }, 403);
      if ((await getReservation(kv, token, id)) === null) return json({ error: "not found" }, 404);
      await removeMember(kv, owner.id, id, sub);
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  }

  // Item action: /api/reservations/:id/(confirm|cancel|restore) — members of a
  // shared reservation may NOT mutate it (403 rather than a misleading 404).
  if (action === "confirm" && req.method === "POST") {
    let r;
    try {
      r = await confirmReservation(kv, token, id, ids);
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
    return (await isSharedMemberOf(id))
      ? json({ error: "forbidden" }, 403)
      : json({ error: "not found" }, 404);
  }
  if (action === "cancel" && req.method === "POST") {
    const r = await cancelReservation(kv, token, id, ids);
    if (r) {
      mutated(r.id);
      return json({ reservation: r });
    }
    return (await isSharedMemberOf(id))
      ? json({ error: "forbidden" }, 403)
      : json({ error: "not found" }, 404);
  }
  if (action === "restore" && req.method === "POST") {
    const r = await restoreReservation(kv, token, id, ids);
    if (r) {
      mutated(r.id);
      return json({ reservation: r });
    }
    return (await isSharedMemberOf(id))
      ? json({ error: "forbidden" }, 403)
      : json({ error: "not found" }, 404);
  }

  // Item: /api/reservations/:id
  if (action === undefined) {
    if (req.method === "PATCH") {
      const parsed = webPatchSchema.safeParse(await readJson(req));
      if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues }, 400);
      let r;
      try {
        r = await patchReservation(kv, token, id, parsed.data, ids);
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
      return (await isSharedMemberOf(id))
        ? json({ error: "forbidden" }, 403)
        : json({ error: "not found" }, 404);
    }
    if (req.method === "DELETE") {
      const ok = await deleteReservation(kv, token, id);
      if (ok) {
        // Owner deleting their reservation: sweep its shares too.
        if (owner !== null) await cleanupReservationShares(kv, owner.id, id);
        mutated(id);
        return json({ ok: true });
      }
      return (await isSharedMemberOf(id))
        ? json({ error: "forbidden" }, 403)
        : json({ error: "not found" }, 404);
    }
  }

  return json({ error: "not found" }, 404);
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

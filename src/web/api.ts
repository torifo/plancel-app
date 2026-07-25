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
 */
import {
  cancelReservation,
  confirmReservation,
  createReservation,
  deleteReservation,
  listReservations,
  patchReservation,
  restoreReservation,
  webCreateSchema,
  type WebIds,
  webPatchSchema,
} from "./store.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** True if this request targets the web API (so the entrypoint can route it). */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api/reservations" || pathname.startsWith("/api/reservations/");
}

export interface WebApiOptions {
  /** Ledger resolved by the entrypoint (session/dev/admin); overrides the header. */
  ledger?: string;
  /** Called with the reservation id after each successful mutation. */
  onMutate?: (resvId: string) => void;
}

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

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","reservations",id?,action?]
  const id = parts[2];
  const action = parts[3];

  // Collection: /api/reservations
  if (id === undefined) {
    if (req.method === "GET") {
      return json({ reservations: await listReservations(kv, token) });
    }
    if (req.method === "POST") {
      const parsed = webCreateSchema.safeParse(await readJson(req));
      if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues }, 400);
      const r = await createReservation(kv, token, parsed.data, ids);
      mutated(r.id);
      return json({ reservation: r }, 201);
    }
    return json({ error: "method not allowed" }, 405);
  }

  // Item action: /api/reservations/:id/(confirm|cancel)
  if (action === "confirm" && req.method === "POST") {
    const r = await confirmReservation(kv, token, id, ids);
    if (r) mutated(r.id);
    return r ? json({ reservation: r }) : json({ error: "not found" }, 404);
  }
  if (action === "cancel" && req.method === "POST") {
    const r = await cancelReservation(kv, token, id, ids);
    if (r) mutated(r.id);
    return r ? json({ reservation: r }) : json({ error: "not found" }, 404);
  }
  if (action === "restore" && req.method === "POST") {
    const r = await restoreReservation(kv, token, id, ids);
    if (r) mutated(r.id);
    return r ? json({ reservation: r }) : json({ error: "not found" }, 404);
  }

  // Item: /api/reservations/:id
  if (action === undefined) {
    if (req.method === "PATCH") {
      const parsed = webPatchSchema.safeParse(await readJson(req));
      if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues }, 400);
      const r = await patchReservation(kv, token, id, parsed.data, ids);
      if (r) mutated(r.id);
      return r ? json({ reservation: r }) : json({ error: "not found" }, 404);
    }
    if (req.method === "DELETE") {
      const ok = await deleteReservation(kv, token, id);
      if (ok) mutated(id);
      return ok ? json({ ok: true }) : json({ error: "not found" }, 404);
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

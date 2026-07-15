/**
 * Web HTTP API (`/api/*`) — per-user reservation CRUD backed by the shared
 * Deno KV, namespaced by the browser token (see store.ts).
 *
 * Every request carries the user's token in the `x-plancel-token` header
 * (the web UI generates one on first load and keeps it in localStorage).
 * No token → 400. This is intentionally simple auth for a 家族/身内 tool:
 * knowing the token = access to that token's ledger (browser-token model,
 * owner-chosen 2026-07-16).
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

/**
 * Handles one `/api/*` request. `kv` is the shared Deno KV; `ids` supplies id
 * + timestamp (injected for deterministic tests). Never throws on bad input —
 * returns 4xx JSON instead.
 */
export async function handleWebApi(kv: Deno.Kv, req: Request, ids: WebIds): Promise<Response> {
  const token = req.headers.get("x-plancel-token")?.trim();
  if (!token) return json({ error: "missing x-plancel-token" }, 400);

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
      return json({ reservation: await createReservation(kv, token, parsed.data, ids) }, 201);
    }
    return json({ error: "method not allowed" }, 405);
  }

  // Item action: /api/reservations/:id/(confirm|cancel)
  if (action === "confirm" && req.method === "POST") {
    const r = await confirmReservation(kv, token, id, ids);
    return r ? json({ reservation: r }) : json({ error: "not found" }, 404);
  }
  if (action === "cancel" && req.method === "POST") {
    const r = await cancelReservation(kv, token, id, ids);
    return r ? json({ reservation: r }) : json({ error: "not found" }, 404);
  }

  // Item: /api/reservations/:id
  if (action === undefined) {
    if (req.method === "PATCH") {
      const parsed = webPatchSchema.safeParse(await readJson(req));
      if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues }, 400);
      const r = await patchReservation(kv, token, id, parsed.data, ids);
      return r ? json({ reservation: r }) : json({ error: "not found" }, 404);
    }
    if (req.method === "DELETE") {
      const ok = await deleteReservation(kv, token, id);
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

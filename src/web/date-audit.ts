/**
 * GET /api/admin/date-audit — read-only list of stored dates the ledger cannot read (issue #2).
 * Admins only (PLANCEL_ADMIN_EMAILS); findings carry ids, never the text or a ledger id.
 */
import { toInstantOrNull } from "./instant.ts";
import { type WebUser, webUserSchema } from "./users.ts";

export interface DateAuditDeps {
  kv: Deno.Kv;
  /** Lower-cased emails allowed to run the audit (PLANCEL_ADMIN_EMAILS). */
  adminEmails: ReadonlySet<string>;
}

export interface UnreadableDate {
  userId: string;
  resvId: string;
  field: "startsAt" | "endsAt";
  status: string;
}

export interface DateAudit {
  users: number;
  reservations: number;
  unreadable: UnreadableDate[];
}

export function isAdminDateAuditPath(pathname: string): boolean {
  return pathname === "/api/admin/date-audit";
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Raw fields, not the record schema: a row the schema rejects must still be seen. */
interface StoredDates {
  id?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  status?: unknown;
}

/** Walks every user's own ledger (not `::demo`) and reads both stored dates. */
export async function auditStoredDates(kv: Deno.Kv): Promise<DateAudit> {
  const audit: DateAudit = { users: 0, reservations: 0, unreadable: [] };
  for await (const u of kv.list({ prefix: ["webuser"] })) {
    const user = webUserSchema.safeParse(u.value);
    if (!user.success) continue;
    audit.users++;
    for await (const e of kv.list<StoredDates>({ prefix: ["web", user.data.ledgerId, "resv"] })) {
      audit.reservations++;
      const r = e.value ?? {};
      const resvId = typeof r.id === "string" ? r.id : String(e.key.at(-1));
      const status = typeof r.status === "string" ? r.status : "unknown";
      const found = (field: UnreadableDate["field"]) =>
        audit.unreadable.push({ userId: user.data.id, resvId, field, status });
      if (toInstantOrNull(r.startsAt) === null) found("startsAt");
      if (r.endsAt !== null && r.endsAt !== undefined && toInstantOrNull(r.endsAt) === null) {
        found("endsAt");
      }
    }
  }
  return audit;
}

export async function handleAdminDateAudit(
  req: Request,
  deps: DateAuditDeps,
  who: { user: WebUser | null },
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const email = who.user?.email.toLowerCase();
  if (email === undefined || !deps.adminEmails.has(email)) {
    return json({ error: "forbidden" }, 403);
  }
  return json(await auditStoredDates(deps.kv));
}

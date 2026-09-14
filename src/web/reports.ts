/**
 * Reports — what a person (or the app itself) tells the developer (ADR-14).
 *
 * Three kinds land in one KV list, newest first by ULID:
 *   - "error"   the browser saw something fail and recorded it on the spot,
 *               with whatever the person cared to add;
 *   - "request" a wish typed into the help page — stored and shown, never
 *               acted on until the developer decides (owner 2026-08-20);
 *   - "system"  the app found a fault by itself, with no person involved.
 *               Written only through `recordSystemReport` — a browser that
 *               posts kind: "system" is refused.
 *
 * Why this exists: a retired Groq model took every pasted mail down for days
 * and the only detector was a family member complaining (ADR-13). Anything a
 * person sees fail is written here at the moment it fails, so the developer
 * does not depend on being told.
 *
 * Delivery is deliberately KV-only (no LINE/mail push, owner 2026-08-20): the
 * admin page under マイページ is where these are read.
 *
 * Privacy: `note` and `sample` pass through `maskPii` HERE, whatever the
 * browser already did — the client is not trusted to mask. `sample` is the
 * pasted text a parse failed on, capped, never the whole mail.
 */
import { z } from "zod";
import { logger } from "../lib/log.ts";
import { maskPii } from "../parse/mod.ts";
import type { WebUser } from "./users.ts";

const REPORT = "report";
const RATE = "report_rate";

/** Rolling window of the per-user cap (fixed window, like `mail_rate`). */
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Reports one person may file per window. A person clicks "send" a few
 * times a day at most; this only ever stops a browser stuck in a loop from
 * filling KV with the same failure.
 */
export const REPORT_DAILY_CAP = 50;
/** How long a report stays readable. Half a year outlives any follow-up. */
const KEEP_MS = 180 * 24 * 60 * 60 * 1000;
/** The admin page shows this many, newest first; older ones simply expire. */
const LIST_LIMIT = 200;

export const REPORT_KINDS = ["error", "request", "system"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** What a browser may submit. "system" is not here on purpose. */
const submitSchema = z.object({
  kind: z.enum(["error", "request"]),
  /** The sentence the app showed ("読み取りに進めませんでした。"). */
  action: z.string().max(200).optional(),
  /** Error identifier or parse reason ("login required", "unavailable"). */
  code: z.string().max(200).optional(),
  status: z.number().int().min(100).max(599).optional(),
  path: z.string().max(200).optional(),
  view: z.string().max(40).optional(),
  /** Build id from /healthz — which build the person was on. */
  build: z.string().max(64).optional(),
  ua: z.string().max(300).optional(),
  /** The person's own words. */
  note: z.string().max(2000).optional(),
  /** Input the failure was about (pasted text), masked again on arrival. */
  sample: z.string().max(4000).optional(),
  /**
   * The id of an earlier report this one adds to: the person's note, typed
   * after the failure was already recorded. The admin page shows it under
   * the report it refers to.
   */
  ref: z.string().max(64).optional(),
});
export type ReportSubmission = z.infer<typeof submitSchema>;

export interface Report {
  id: string;
  kind: ReportKind;
  /** ISO 8601, when it was recorded. */
  at: string;
  /** Who filed it; null for the app's own reports. */
  userId: string | null;
  action: string | null;
  code: string | null;
  status: number | null;
  path: string | null;
  view: string | null;
  build: string | null;
  ua: string | null;
  note: string | null;
  sample: string | null;
  ref: string | null;
}

export interface ReportsDeps {
  kv: Deno.Kv;
  ids: { ulid(): string; nowIso(): string };
  /** Lower-cased emails allowed to read the list (PLANCEL_ADMIN_EMAILS). */
  adminEmails: ReadonlySet<string>;
  /**
   * Where a structural fault is pushed the moment it is recorded (LINE to the
   * admin accounts in production). Only `kind: "system"` goes this way, and
   * one code at most once a day: a person's report or wish never pushes, and
   * a fault that repeats every tick costs one message, not a hundred.
   * Absent → KV only.
   */
  notify?: (report: Report) => Promise<void>;
  /** Injectable log sink for tests; defaults to stdout. */
  logWrite?: (line: string) => void;
}

/** A pushed code is not pushed again inside this window. */
const PUSH_WINDOW_MS = 24 * 60 * 60 * 1000;
const PUSHED = "report_pushed";

/**
 * What the boot beacon (web/index.html, the first <script>) may send. Tiny and
 * fixed on purpose: this endpoint takes no login, because the page it reports
 * on died before anyone could log in.
 */
const beaconSchema = z.object({
  message: z.string().min(1).max(300),
  where: z.string().max(200).optional(),
  stack: z.string().max(1500).optional(),
  ua: z.string().max(300).optional(),
  build: z.string().max(64).optional(),
});
/** One distinct failure is stored once per window, however many phones hit it. */
const BEACON_SEEN = "beacon_seen";
const BEACON_SEEN_MS = 24 * 60 * 60 * 1000;
/** Anonymous writers get a global ceiling per window, not a per-user one. */
const BEACON_DAILY_CAP = 200;
const BEACON_RATE = "beacon_rate";

/** The caller as resolved by the entrypoint; `ledger` is the rate key fallback. */
export interface ReportsCaller {
  user: WebUser | null;
  ledger: string | null;
}

export function isReportsPath(pathname: string): boolean {
  return pathname === "/api/reports";
}

export function isAdminReportsPath(pathname: string): boolean {
  return pathname === "/api/admin/reports";
}

export function isBeaconPath(pathname: string): boolean {
  return pathname === "/api/beacon";
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const reportKey = (id: string): Deno.KvKey => [REPORT, id];

const rateSchema = z.object({ count: z.number() });

/** True when this caller may file another report (counts the attempt). */
async function allowReport(kv: Deno.Kv, who: string): Promise<boolean> {
  const key = [RATE, who];
  const cur = rateSchema.safeParse((await kv.get(key)).value);
  const count = cur.success ? cur.data.count : 0;
  if (count >= REPORT_DAILY_CAP) return false;
  await kv.set(key, { count: count + 1 }, { expireIn: RATE_WINDOW_MS });
  return true;
}

const masked = (s: string | undefined): string | null =>
  s === undefined || s === "" ? null : maskPii(s).masked;

async function put(deps: ReportsDeps, report: Report): Promise<void> {
  await deps.kv.set(reportKey(report.id), report, { expireIn: KEEP_MS });
}

/**
 * POST /api/reports — a person's error report or wish. Login is required by
 * the entrypoint (an anonymous endpoint that writes KV is an abuse target),
 * which also means a failure on the login screen itself is not recorded.
 */
export async function handleReportsApi(
  req: Request,
  deps: ReportsDeps,
  who: ReportsCaller,
): Promise<Response> {
  const log = logger("web.reports", deps.logWrite !== undefined ? { write: deps.logWrite } : {});
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid" }, 400);
  }
  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid" }, 400);
  const sub = parsed.data;

  const rateKey = who.user?.id ?? who.ledger;
  if (rateKey === null || rateKey === undefined) return json({ error: "login required" }, 401);
  if (!(await allowReport(deps.kv, rateKey))) {
    log.warn("report cap reached; dropped", { who: rateKey, kind: sub.kind });
    return json({ error: "rate limited" }, 429);
  }

  const report: Report = {
    id: deps.ids.ulid(),
    kind: sub.kind,
    at: deps.ids.nowIso(),
    userId: who.user?.id ?? null,
    action: sub.action ?? null,
    code: sub.code ?? null,
    status: sub.status ?? null,
    path: sub.path ?? null,
    view: sub.view ?? null,
    build: sub.build ?? null,
    ua: sub.ua ?? null,
    note: masked(sub.note),
    sample: masked(sub.sample),
    ref: sub.ref ?? null,
  };
  await put(deps, report);
  // The log line carries no note/sample: the log is for "something failed
  // where", the KV record is for "what exactly".
  log.info("report received", {
    id: report.id,
    kind: report.kind,
    code: report.code,
    path: report.path,
    status: report.status,
    build: report.build,
  });
  return json({ ok: true, id: report.id }, 201);
}

/**
 * Something the app found out on its own — written without a person and
 * without the per-user cap, because the caller already decides how often to
 * look.
 */
export async function recordSystemReport(
  deps: ReportsDeps,
  fault: { code: string; detail?: string; path?: string; build?: string; ua?: string },
): Promise<Report> {
  const log = logger("web.reports", deps.logWrite !== undefined ? { write: deps.logWrite } : {});
  const report: Report = {
    id: deps.ids.ulid(),
    kind: "system",
    at: deps.ids.nowIso(),
    userId: null,
    action: null,
    code: fault.code,
    status: null,
    path: fault.path ?? null,
    view: null,
    build: fault.build ?? null,
    ua: fault.ua ?? null,
    note: masked(fault.detail),
    sample: null,
    ref: null,
  };
  await put(deps, report);
  log.error("system fault recorded", { id: report.id, code: report.code, path: report.path });

  if (deps.notify !== undefined) {
    // Claim the day for this code before pushing, so a push that throws is not
    // retried every tick against a channel that is already unhappy.
    const key = [PUSHED, report.code ?? ""];
    const claimed = await deps.kv.atomic()
      .check({ key, versionstamp: null })
      .set(key, { at: report.at }, { expireIn: PUSH_WINDOW_MS })
      .commit();
    if (claimed.ok) {
      try {
        await deps.notify(report);
        log.info("system fault pushed", { id: report.id, code: report.code });
      } catch (err) {
        log.warn("system fault push failed", { id: report.id, err: String(err) });
      }
    }
  }
  return report;
}

/**
 * POST /api/beacon — the page could not boot. Sent by a script that runs
 * before everything else and depends on nothing, because on 2026-09-02 the
 * app's own error reporter sat below the line that threw and never ran.
 *
 * No login (the page died before login), so: a fixed tiny shape, one stored
 * report per distinct failure per day, and a global daily ceiling. The
 * response says nothing a probe could use.
 */
export async function handleBeaconApi(req: Request, deps: ReportsDeps): Promise<Response> {
  const log = logger("web.reports", deps.logWrite !== undefined ? { write: deps.logWrite } : {});
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid" }, 400);
  }
  const parsed = beaconSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid" }, 400);
  const b = parsed.data;

  const rate = rateSchema.safeParse((await deps.kv.get([BEACON_RATE])).value);
  const count = rate.success ? rate.data.count : 0;
  if (count >= BEACON_DAILY_CAP) return json({ ok: true, stored: false }, 202);
  await deps.kv.set([BEACON_RATE], { count: count + 1 }, { expireIn: BEACON_SEEN_MS });

  // The same message at the same place is one fault, not one per phone.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${b.message}\n${b.where ?? ""}`),
  );
  const hash = [...new Uint8Array(digest)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const seen = await deps.kv.atomic()
    .check({ key: [BEACON_SEEN, hash], versionstamp: null })
    .set([BEACON_SEEN, hash], { at: deps.ids.nowIso() }, { expireIn: BEACON_SEEN_MS })
    .commit();
  if (!seen.ok) {
    log.warn("page failed to boot (already recorded today)", { hash, where: b.where ?? null });
    return json({ ok: true, stored: false }, 202);
  }

  await recordSystemReport(deps, {
    code: "boot",
    detail: `${b.message}${b.where ? ` @ ${b.where}` : ""}${b.stack ? `\n${b.stack}` : ""}`,
    path: "/",
    ...(b.build !== undefined ? { build: b.build } : {}),
    ...(b.ua !== undefined ? { ua: b.ua } : {}),
  });
  return json({ ok: true, stored: true }, 201);
}

/** Newest first. `kind` narrows to one kind. */
export async function listReports(
  kv: Deno.Kv,
  kind?: ReportKind,
): Promise<Report[]> {
  const out: Report[] = [];
  for await (
    const e of kv.list<Report>({ prefix: [REPORT] }, { reverse: true, limit: LIST_LIMIT })
  ) {
    if (kind !== undefined && e.value.kind !== kind) continue;
    out.push(e.value);
  }
  return out;
}

/**
 * GET /api/admin/reports[?kind=error|request|system] — the developer's view.
 * Admin is the same set of emails that /auth/me marks `admin: true` with.
 */
export async function handleAdminReportsApi(
  req: Request,
  deps: ReportsDeps,
  who: ReportsCaller,
): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const email = who.user?.email.toLowerCase();
  if (email === undefined || !deps.adminEmails.has(email)) {
    return json({ error: "forbidden" }, 403);
  }
  const kindParam = new URL(req.url).searchParams.get("kind");
  const kind = (REPORT_KINDS as readonly string[]).includes(kindParam ?? "")
    ? kindParam as ReportKind
    : undefined;
  return json({ reports: await listReports(deps.kv, kind) });
}

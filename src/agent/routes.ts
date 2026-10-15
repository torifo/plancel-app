/**
 * HTTP surface of the cancellation agent.
 *
 *   POST /agent/run                       Cloud Scheduler → every user (shared-secret header)
 *   POST /api/agent/run                   the signed-in user runs it for themselves
 *   GET  /api/agent/runs?limit=           latest runs (with their proposals) + pending proposals
 *   POST /api/agent/proposals/:id/approve cancel the reservation (owner only), then record it
 *   POST /api/agent/proposals/:id/reject  record the refusal; the ledger is untouched
 *   POST /api/demo/reset                  demo deployments only: refile the demo ledger
 */
import type { Clock } from "../core/clock/mod.ts";
import { cancelReservation, getReservation, type WebIds } from "../web/store.ts";
import type { WebUser } from "../web/users.ts";
import type { GeminiTransport } from "./gemini.ts";
import { runAgentForUser, runAgentSweep } from "./runner.ts";
import {
  decideProposal,
  getProposalEntry,
  listProposals,
  listRuns,
  takeManualRun,
} from "./store.ts";
import type { Proposal, Run } from "./types.ts";

export const AGENT_TOKEN_HEADER = "x-plancel-agent-token";

export interface AgentRouteDeps {
  kv: Deno.Kv;
  clock: Clock;
  ids: WebIds;
  /** null: no Gemini credentials in this deployment. */
  transport: GeminiTransport | null;
  /** PLANCEL_AGENT_TOKEN. Unset disables POST /agent/run. */
  agentToken: string | undefined;
  resolveUser(req: Request): Promise<WebUser | null>;
  /** After a cancellation, e.g. to kick the calendar sync. */
  onMutate?(user: WebUser, reservationId: string): void;
  /** Present only on a demo deployment; refiles the demo account's ledger. */
  resetDemo?(user: WebUser): Promise<boolean>;
  /** Whom the scheduler runs for. Unset: every user. Demo deployments narrow it. */
  sweepUsers?(): Promise<WebUser[]>;
  /** True for a demo sandbox user (the UI shows its banner). */
  isSandbox?(user: WebUser): Promise<boolean>;
}

export function isAgentPath(pathname: string): boolean {
  return pathname === "/agent/run" || pathname.startsWith("/api/agent/") ||
    pathname === "/api/demo/reset";
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Compares secrets by digest so neither content nor length shows in the timing. */
export async function tokenMatches(provided: string | null, expected: string): Promise<boolean> {
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(provided ?? ""), digest(expected)]);
  let diff = provided === null ? 1 : 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const URGENCY_RANK = { high: 0, normal: 1, low: 2 } as const;

/** Pending proposals, most urgent first, then newest. */
const pendingFirst = (proposals: Proposal[]) =>
  proposals.filter((p) => p.status === "pending").sort((a, b) =>
    URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]
  );

const withProposals = (run: Run, byId: Map<string, Proposal>) => ({
  ...run,
  proposals: run.proposalIds.map((id) => byId.get(id)).filter((p): p is Proposal =>
    p !== undefined
  ),
});

export async function handleAgentRoute(req: Request, deps: AgentRouteDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/agent/run") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (deps.agentToken === undefined || deps.agentToken === "") {
      return json({ error: "agent trigger disabled" }, 503);
    }
    if (!await tokenMatches(req.headers.get(AGENT_TOKEN_HEADER), deps.agentToken)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (deps.transport === null) return json({ error: "agent_not_configured" }, 503);
    const users = deps.sweepUsers === undefined ? undefined : await deps.sweepUsers();
    const results = await runAgentSweep(
      { ...deps, transport: deps.transport },
      users === undefined ? {} : { users },
    );
    return json({
      ran: results.filter((r) => r.status === "ran").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      results,
    });
  }

  const user = await deps.resolveUser(req);
  if (user === null) return json({ error: "login required" }, 401);

  if (path === "/api/agent/run") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (deps.transport === null) return json({ error: "agent_not_configured" }, 503);
    if (!await takeManualRun(deps.kv, user.id, deps.clock.now().epochMilliseconds)) {
      return json({ error: "rate limited" }, 429);
    }
    const outcome = await runAgentForUser({ ...deps, transport: deps.transport }, user, "manual");
    if (outcome.status === "busy") return json({ error: "agent_busy" }, 409);
    if (outcome.status === "skipped") {
      return json({ error: "skipped", reason: outcome.reason }, 409);
    }
    const byId = new Map((await listProposals(deps.kv, user.id)).map((p) => [p.id, p]));
    return json({ run: withProposals(outcome.run, byId) });
  }

  if (path === "/api/agent/runs") {
    if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
    const requested = Number(url.searchParams.get("limit") ?? "10");
    const limit = Number.isInteger(requested) ? Math.min(30, Math.max(1, requested)) : 10;
    const proposals = await listProposals(deps.kv, user.id);
    const byId = new Map(proposals.map((p) => [p.id, p]));
    const runs = await listRuns(deps.kv, user.id, limit);
    return json({
      configured: deps.transport !== null,
      model: deps.transport?.model ?? null,
      transport: deps.transport?.name ?? null,
      demo: deps.resetDemo !== undefined,
      sandbox: await deps.isSandbox?.(user) ?? false,
      runs: runs.map((r) => withProposals(r, byId)),
      pending: pendingFirst(proposals),
    });
  }

  const decision = path.match(/^\/api\/agent\/proposals\/([^/]+)\/(approve|reject)$/);
  if (decision !== null) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    return await decide(
      deps,
      user,
      decodeURIComponent(decision[1]!),
      decision[2] as "approve" | "reject",
    );
  }

  if (path === "/api/demo/reset") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (deps.resetDemo === undefined || !await deps.resetDemo(user)) {
      return json({ error: "forbidden" }, 403);
    }
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

/** Approve cancels through the ledger's own cancel (owner's ledger only); reject only records. */
async function decide(
  deps: AgentRouteDeps,
  user: WebUser,
  id: string,
  verb: "approve" | "reject",
): Promise<Response> {
  const read = await getProposalEntry(deps.kv, user.id, id);
  if (read === null) return json({ error: "not found" }, 404);
  const p = read.proposal;
  if (p.status !== "pending") return json({ error: "not_pending", proposal: p }, 409);
  const decidedAt = deps.ids.nowIso();
  const settle = async (status: Proposal["status"], outcome: string): Promise<Proposal | null> => {
    const next: Proposal = { ...p, status, decidedAt, outcome };
    return await decideProposal(deps.kv, user.id, read, next) ? next : null;
  };

  if (verb === "reject") {
    const next = await settle("rejected", "却下しました。台帳は変更していません。");
    return next === null ? json({ error: "not_pending" }, 409) : json({ proposal: next });
  }

  const r = await getReservation(deps.kv, user.ledgerId, p.reservationId);
  if (r === null || r.status === "confirmed") {
    const next = await settle(
      "stale",
      r === null
        ? "予約が台帳に見つからないため、実行しませんでした。"
        : "その後に確定済みになったため、キャンセルしませんでした。",
    );
    return json({ error: "stale", proposal: next ?? p }, 409);
  }
  if (r.status === "cancelled") {
    const next = await settle("approved", "すでにキャンセル済みでした。台帳は変更していません。");
    return next === null
      ? json({ error: "not_pending" }, 409)
      : json({ proposal: next, reservation: r });
  }
  const cancelled = await cancelReservation(deps.kv, user.ledgerId, r.id, deps.ids, user.id);
  if (cancelled === null) return json({ error: "not found" }, 404);
  deps.onMutate?.(user, cancelled.id);
  const next = await settle("approved", "承認され、予約をキャンセル済みにしました。");
  return json({ proposal: next ?? { ...p, status: "approved" }, reservation: cancelled });
}

/**
 * KV persistence for the agent. All keys lead with the userId, so one user's
 * runs and proposals are unreachable from another's id by construction.
 *
 *   ["agent_run", userId, runId]            → Run          (newest 50 kept, 30 days)
 *   ["agent_proposal", userId, proposalId]  → Proposal     (30 days)
 *   ["agent_lock", userId]                  → holder       (a run is in flight)
 *   ["agent_rate", userId, hour]            → count        (manual runs this hour)
 */
import { type Proposal, proposalSchema, type Run, runSchema } from "./types.ts";

export const AGENT_RUN = "agent_run";
export const AGENT_PROPOSAL = "agent_proposal";
const LOCK = "agent_lock";
const RATE = "agent_rate";

const RETENTION_MS = 30 * 24 * 3_600_000;
export const MAX_RUNS_KEPT = 50;
export const LOCK_TTL_MS = 3 * 60_000;
export const MANUAL_RUNS_PER_HOUR = 12;

export async function putRun(kv: Deno.Kv, run: Run): Promise<void> {
  await kv.set([AGENT_RUN, run.userId, run.id], run, { expireIn: RETENTION_MS });
  const all = await listRuns(kv, run.userId, Number.MAX_SAFE_INTEGER);
  for (const old of all.slice(MAX_RUNS_KEPT)) await kv.delete([AGENT_RUN, run.userId, old.id]);
}

/** Newest first. Rows that no longer parse are skipped, never fatal. */
export async function listRuns(kv: Deno.Kv, userId: string, limit: number): Promise<Run[]> {
  const runs: Run[] = [];
  for await (const e of kv.list({ prefix: [AGENT_RUN, userId] })) {
    const parsed = runSchema.safeParse(e.value);
    if (parsed.success) runs.push(parsed.data);
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  return runs.slice(0, limit);
}

export async function putProposal(kv: Deno.Kv, userId: string, p: Proposal): Promise<void> {
  await kv.set([AGENT_PROPOSAL, userId, p.id], p, { expireIn: RETENTION_MS });
}

export async function getProposalEntry(
  kv: Deno.Kv,
  userId: string,
  id: string,
): Promise<{ proposal: Proposal; entry: Deno.KvEntryMaybe<unknown> } | null> {
  const entry = await kv.get([AGENT_PROPOSAL, userId, id]);
  const parsed = proposalSchema.safeParse(entry.value);
  return parsed.success ? { proposal: parsed.data, entry } : null;
}

/** Newest first. */
export async function listProposals(kv: Deno.Kv, userId: string): Promise<Proposal[]> {
  const out: Proposal[] = [];
  for await (const e of kv.list({ prefix: [AGENT_PROPOSAL, userId] })) {
    const parsed = proposalSchema.safeParse(e.value);
    if (parsed.success) out.push(parsed.data);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/**
 * Moves a pending proposal to its decided state. The write is conditional on the
 * entry still being the one that was read, so two concurrent decisions cannot
 * both win. False when someone else decided first.
 */
export async function decideProposal(
  kv: Deno.Kv,
  userId: string,
  read: { proposal: Proposal; entry: Deno.KvEntryMaybe<unknown> },
  next: Proposal,
): Promise<boolean> {
  const res = await kv.atomic()
    .check(read.entry)
    .set([AGENT_PROPOSAL, userId, next.id], next, { expireIn: RETENTION_MS })
    .commit();
  return res.ok;
}

/** Takes the per-user run lock; false when a run is already in flight. */
export async function acquireRunLock(
  kv: Deno.Kv,
  userId: string,
  holder: string,
): Promise<boolean> {
  const key = [LOCK, userId];
  const res = await kv.atomic()
    .check({ key, versionstamp: null })
    .set(key, holder, { expireIn: LOCK_TTL_MS })
    .commit();
  return res.ok;
}

export async function releaseRunLock(kv: Deno.Kv, userId: string): Promise<void> {
  await kv.delete([LOCK, userId]);
}

/** Counts a manual run against the user's hourly budget; false once it is spent. */
export async function takeManualRun(kv: Deno.Kv, userId: string, nowMs: number): Promise<boolean> {
  const key = [RATE, userId, Math.floor(nowMs / 3_600_000)];
  const used = (await kv.get<number>(key)).value ?? 0;
  if (used >= MANUAL_RUNS_PER_HOUR) return false;
  await kv.set(key, used + 1, { expireIn: 2 * 3_600_000 });
  return true;
}

/** Deletes everything the agent holds for a user (demo reset, account deletion). */
export async function clearAgentState(kv: Deno.Kv, userId: string): Promise<void> {
  for (const prefix of [[AGENT_RUN, userId], [AGENT_PROPOSAL, userId], [LOCK, userId]]) {
    for await (const e of kv.list({ prefix })) await kv.delete(e.key);
  }
}

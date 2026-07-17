/**
 * `POST /api/parse` — the web UI's intake brain (owner 2026-07-16:
 * everything except LINE ships now).
 *
 * Runs the SAME parse pipeline as MCP/LINE (runParseChain: PII mask →
 * Groq → Gemini fallback → rule validation) on text pasted into the web
 * UI (確認メール貼り付け) or an image (スクショ読み取り, Gemini vision),
 * and returns fields pre-mapped to the web reservation shape so the UI
 * can open a prefilled confirmation form. The full ParseJob (raw LLM
 * responses included) is saved through `saveJob` for the replay corpus
 * (SDD §10.4) — observability only, a save failure never fails the
 * request.
 *
 * The web store models cancellation policies as presets
 * (unknown/none/free24/staged) while the parser emits arbitrary stage
 * arrays; `mapPolicyToPreset` folds one into the other.
 */
import { z } from "zod";
import type { Clock } from "../core/clock/mod.ts";
import type { ParseJob } from "../core/schema/mod.ts";
import { missingFieldQuestions, runParseChain } from "../parse/mod.ts";
import type { ParseInput, Parser, ParserChainConfig } from "../parse/mod.ts";
import type { WebPolicy } from "./store.ts";

export interface ParseApiDeps {
  parsers: Parser[];
  chainConfig: ParserChainConfig;
  clock: Clock;
  ids: { ulid(): string; nowIso(): string };
  /** Persists the ParseJob for the replay corpus (best-effort). */
  saveJob: (job: ParseJob) => Promise<void>;
}

const parseReqSchema = z.object({
  type: z.enum(["text", "image"]).default("text"),
  content: z.string().min(1),
});

interface PolicyStageLike {
  until_offset_hours?: number;
  fee_percent?: number;
  fee_fixed_jpy?: number | null;
}

/**
 * Folds a parsed CancellationPolicy (arbitrary stages) into the web UI's
 * preset enum: no/unknown policy -> "unknown"; all-free stages -> "none";
 * fees that only start within 24h of the booking -> "free24"; anything
 * with an earlier paid boundary -> "staged".
 */
export function mapPolicyToPreset(cp: unknown): WebPolicy {
  if (cp === null || cp === undefined || cp === "unknown") return "unknown";
  const stages = (cp as { stages?: PolicyStageLike[] }).stages;
  if (!Array.isArray(stages) || stages.length === 0) return "unknown";
  const paid = stages.filter((s) => (s.fee_percent ?? 0) > 0 || (s.fee_fixed_jpy ?? 0) > 0);
  if (paid.length === 0) return "none";
  const firstPaidOffset = Math.max(...paid.map((s) => s.until_offset_hours ?? 0));
  return firstPaidOffset <= 24 ? "free24" : "staged";
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export async function handleParseApi(req: Request, deps: ParseApiDeps): Promise<Response> {
  const token = req.headers.get("x-plancel-token")?.trim();
  if (!token) return json({ error: "missing x-plancel-token" }, 400);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const parsed = parseReqSchema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "invalid", issues: parsed.error.issues }, 400);

  const input: ParseInput = {
    type: parsed.data.type,
    content: parsed.data.content,
    correlation_id: `web-${deps.ids.ulid()}`,
  };
  const job = await runParseChain(input, deps.chainConfig, deps.parsers, deps.clock, {
    ulid: deps.ids.ulid,
    nowIso: deps.ids.nowIso,
  });
  try {
    await deps.saveJob(job);
  } catch (err) {
    console.error("parse-api: saveJob failed (ignored):", err);
  }

  // Merged output across attempts (later attempts override earlier), same
  // pragmatic shape the LINE webhook uses for prefill purposes.
  const merged: Record<string, unknown> = {};
  for (const a of job.attempts) {
    if (!a.output) continue;
    for (const [k, v] of Object.entries(a.output)) {
      if (v !== undefined && v !== null) merged[k] = v;
    }
  }

  const fields = {
    service: typeof merged.service_name === "string" ? merged.service_name : null,
    startsAt: typeof merged.starts_at === "string" ? merged.starts_at : null,
    amount: typeof merged.amount_jpy === "number" ? merged.amount_jpy : null,
    policy: mapPolicyToPreset(merged.cancellation_policy),
    location: typeof merged.location === "string" ? merged.location : null,
    notes: typeof merged.notes === "string" ? merged.notes : null,
  };

  return json({
    status: job.status,
    job_id: job.id,
    fields,
    missing: missingFieldQuestions(job),
    detail: job.status === "failed" ? job.attempts.at(-1)?.raw_response ?? null : null,
  });
}

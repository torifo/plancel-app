/**
 * `debug_replay_parse` (SDD §10.5, Task 5.2). DEBUG-only, flag-gated like the
 * rest of `debug.ts`: loads a stored `ParseJob` by id, records it as a
 * `ReplayFixture` (replay.ts), replays it through the CURRENT parser chain,
 * and returns the diff against the job's own recorded outcome — lets an
 * operator ask "would this job still parse the same way today?" without
 * touching the fixture corpus on disk.
 */
import { z } from "zod";
import { ulidSchema } from "../../core/schema/mod.ts";
import { loadParserChainConfig, recordFixture, replayJob } from "../../parse/mod.ts";
import { ulid } from "../../lib/ulid.ts";
import type { ToolContext } from "../context.ts";
import { notFound, nowIso, ok, type ToolDefinition } from "./shared.ts";

const debugReplayParseSchema = z.object({ job_id: ulidSchema });

export const debugReplayParseTool: ToolDefinition<typeof debugReplayParseSchema> = {
  name: "debug_replay_parse",
  description: "DEBUG: replay a stored ParseJob's recorded raw_responses through the current " +
    "parser chain/validation logic and diff the outcome against what was originally recorded.",
  inputSchema: debugReplayParseSchema,
  async run(ctx: ToolContext, input) {
    const job = await ctx.store.getParseJob(input.job_id);
    if (job === null) {
      return notFound("job_id", `ParseJob ${input.job_id} not found`);
    }

    const fixture = recordFixture(job);
    const config = await loadParserChainConfig();
    const ids = { ulid, nowIso: () => nowIso(ctx) };
    const { job: replayedJob, diff } = await replayJob(fixture, config, ctx.clock, ids);

    return ok({
      job_id: job.id,
      identical: diff.identical,
      changes: diff.changes,
      replayed_status: replayedJob.status,
    });
  },
};

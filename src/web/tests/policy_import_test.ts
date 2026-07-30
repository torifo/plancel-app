/**
 * What the recorded parse corpus turns into in the ledger.
 *
 * `deno task replay` stops at the ParseJob: it proves the pipeline still reads
 * a frozen LLM response the same way, but says nothing about the policy the
 * owner ends up looking at. This walks the same corpus one step further —
 * through `impliedFreeBoundaryHours` + `fromCoreStages`, exactly as the mail,
 * paste and LINE paths do — and pins the property that matters: a mail whose
 * text says when charging starts must produce a 無料キャンセル期限, whatever the
 * model answered.
 *
 * `real-hotel-checkinout.json` is the case in point. It was recorded before
 * the 2026-07-30 prompt fix, so its stages carry no 0% stage at all, and it
 * still reads that way (re-recording needs a live Gemini call). It is the
 * strongest possible input for this test rather than a gap in it: the worst
 * answer in the corpus still lands on a usable deadline.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { impliedFreeBoundaryHours } from "../../parse/mod.ts";
import { describePolicy, freeDeadlineMs, fromCoreStages } from "../policy.ts";

const FIXTURES = new URL("../../../fixtures/parse/", import.meta.url);
const START = "2026-08-20T19:00:00+09:00";
const startMs = Temporal.Instant.from(START).epochMilliseconds;
const H = 3_600_000;

interface Fixture {
  name?: string;
  raw_input: string;
  input_type: string;
  expected: { output?: { cancellation_policy?: unknown } };
}

async function loadFixtures(): Promise<[string, Fixture][]> {
  const out: [string, Fixture][] = [];
  for await (const entry of Deno.readDir(FIXTURES)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, FIXTURES));
    out.push([entry.name, JSON.parse(text) as Fixture]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

Deno.test("corpus: a text stating when charging starts always yields a 無料キャンセル期限", async () => {
  let checked = 0;
  for (const [file, fixture] of await loadFixtures()) {
    if (fixture.input_type !== "text") continue;
    const boundary = impliedFreeBoundaryHours(fixture.raw_input);
    if (boundary === null) continue; // states its own deadline, or states none
    const policy = fromCoreStages(fixture.expected.output?.cancellation_policy, boundary);
    assertEquals(
      freeDeadlineMs(policy, START),
      startMs - boundary * H,
      `${file}: the ledger deadline must be the boundary the text implies`,
    );
    checked++;
  }
  // A corpus with no 「から」 case would make this test vacuous.
  assert(checked > 0, "no fee-from-boundary fixture in the corpus");
});

Deno.test("corpus: the pre-fix 「3日前から20%」 recording still lands on 4日前まで無料", async () => {
  const text = await Deno.readTextFile(new URL("real-hotel-checkinout.json", FIXTURES));
  const fixture = JSON.parse(text) as Fixture;
  // Recorded 2026-07-27 from groq-llama, before the prompt stated the
  // convention: three paid stages, no free stage, so the ledger used to read it
  // as "20% from the moment you booked" and had no deadline to notify on.
  assertEquals(
    fixture.expected.output?.cancellation_policy,
    {
      stages: [
        { until_offset_hours: 72, fee_percent: 20, fee_fixed_jpy: null },
        { until_offset_hours: 24, fee_percent: 50, fee_fixed_jpy: null },
        { until_offset_hours: 0, fee_percent: 80, fee_fixed_jpy: null },
      ],
    },
  );
  assertEquals(impliedFreeBoundaryHours(fixture.raw_input), 96);

  const policy = fromCoreStages(fixture.expected.output?.cancellation_policy, 96);
  assertEquals(describePolicy(policy), "4日前まで無料 → 3日前まで20% → 前日まで50% → 当日80%");
  assertEquals(freeDeadlineMs(policy, START), startMs - 96 * H);
});

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

Deno.test("corpus: 「7日前から20%」 is recorded as 8日前まで無料", async () => {
  // real-lodge-fee-from-day, recorded 2026-07-31 from gemini-flash under the
  // corrected prompt — the owner's own case (「7日目から20%とるってなってると、
  // 8日目まで無料とは自動で入らないんだね」), now the corpus's answer to it.
  const text = await Deno.readTextFile(new URL("real-lodge-fee-from-day.json", FIXTURES));
  const fixture = JSON.parse(text) as Fixture;
  assertEquals(impliedFreeBoundaryHours(fixture.raw_input), 192);

  const policy = fromCoreStages(fixture.expected.output?.cancellation_policy, 192);
  assertEquals(describePolicy(policy), "8日前まで無料 → 当日20%");
  assertEquals(freeDeadlineMs(policy, START), startMs - 192 * H);
});

Deno.test("import: an answer with no free stage at all still lands on a deadline", () => {
  // What groq-llama returned for 「3日前から20%、前日50%、当日80%」 before the
  // 2026-07-30 prompt fix: three paid stages and no free stage, which the
  // ledger read as "20% from the moment you booked" — no deadline to show and
  // none for the 24時間前 sweep to fire on. Kept inline because the corpus now
  // records the corrected answer, and the guarantee has to hold for the worst
  // one too, whoever produces it next.
  const preFix = {
    stages: [
      { until_offset_hours: 72, fee_percent: 20, fee_fixed_jpy: null },
      { until_offset_hours: 24, fee_percent: 50, fee_fixed_jpy: null },
      { until_offset_hours: 0, fee_percent: 80, fee_fixed_jpy: null },
    ],
  };
  assertEquals(freeDeadlineMs(fromCoreStages(preFix), START), null); // 修正前の姿
  const policy = fromCoreStages(preFix, 96);
  // The free window is restored; the inner tiers stay where the model put them,
  // one tier pessimistic (2日前 reads 50% where the facility charges 20%).
  assertEquals(describePolicy(policy), "4日前まで無料 → 3日前まで20% → 前日まで50% → 当日80%");
  assertEquals(freeDeadlineMs(policy, START), startMs - 96 * H);
});

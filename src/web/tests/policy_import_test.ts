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
 * The corpus now records the corrected answers (re-recorded 2026-07-31), so the
 * worst case — a model answer with no free stage at all — is kept inline below
 * rather than relying on a fixture happening to contain one.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { impliedFreeBoundaryHours } from "../../parse/mod.ts";
import { boundaryMs, describePolicy, freeDeadlineMs, fromCoreStages } from "../policy.ts";

const FIXTURES = new URL("../../../fixtures/parse/", import.meta.url);
const START = "2026-08-20T19:00:00+09:00";
const startMs = Temporal.Instant.from(START).epochMilliseconds;
/** 無料キャンセル期限はその日の終わり（JST）— 予約の時刻ではない。 */
const eod = (day: string) => Temporal.Instant.from(`${day}T23:59:59.999+09:00`).epochMilliseconds;

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
      boundaryMs(startMs, boundary),
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
  assertEquals(freeDeadlineMs(policy, START), eod("2026-08-12")); // 8日前の終わり
});

Deno.test("import: a deadline stated as 「キャンセル料はかかりません」 is not moved inward", () => {
  // 規定が無料期限を否定形で書いた場合。ここで補正を掛けると、期限は必ず内側の
  // 「から」境界＝規定が課金を始める側へ動く（14日前 → 4日前）。無料期間が10日
  // 伸びて見えるので、利用者は課金が始まった後に「まだ無料」と読む。
  const text = "取消料：14日前まではキャンセル料はかかりません。3日前から50%、当日100%";
  assertEquals(impliedFreeBoundaryHours(text), null);

  const model = {
    stages: [
      { until_offset_hours: 336, fee_percent: 0, fee_fixed_jpy: null },
      { until_offset_hours: 72, fee_percent: 50, fee_fixed_jpy: null },
      { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
    ],
  };
  const policy = fromCoreStages(model, impliedFreeBoundaryHours(text));
  assertEquals(freeDeadlineMs(policy, START), eod("2026-08-06")); // 規定が書いた14日前
  // 「無料」だけを見ていた頃に入っていた値。期限が10日後ろへ動いていた。
  assertEquals(freeDeadlineMs(fromCoreStages(model, 96), START), eod("2026-08-16"));
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
  assertEquals(freeDeadlineMs(policy, START), eod("2026-08-16")); // 4日前の終わり
});

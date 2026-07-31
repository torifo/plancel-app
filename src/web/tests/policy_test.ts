import { assertEquals } from "jsr:@std/assert@^1.0.19";
import {
  describePolicy,
  freeDeadlineMs,
  fromCoreStages,
  isAlwaysFree,
  maxLossYen,
  normalizeStages,
  pctAt,
  stagesOf,
  type WebPolicy,
  webPolicySchema,
} from "../policy.ts";

const START = "2026-08-20T19:00:00+09:00";
const startMs = Temporal.Instant.from(START).epochMilliseconds;
/** 無料キャンセル期限はその日の終わり（JST）— 予約の時刻ではない。 */
const eod = (day: string) => Temporal.Instant.from(`${day}T23:59:59.999+09:00`).epochMilliseconds;

/** The policy the owner actually needed: 5日前まで無料 → 3日前まで30% → 当日100%. */
const FIVE_DAY: WebPolicy = {
  stages: [{ h: 120, pct: 0 }, { h: 72, pct: 30 }, { h: 0, pct: 100 }],
};

const core = (stages: [number, number][], fixed: number | null = null) => ({
  stages: stages.map(([h, pct]) => ({
    until_offset_hours: h,
    fee_percent: pct,
    fee_fixed_jpy: fixed,
  })),
});

Deno.test("policy: legacy preset strings still parse (production records hold them)", () => {
  for (const name of ["unknown", "none", "free24", "staged"] as const) {
    assertEquals(webPolicySchema.parse(name), name);
  }
  assertEquals(webPolicySchema.safeParse("free7").success, false);
});

Deno.test("policy: a custom stage table round-trips through the schema", () => {
  assertEquals(webPolicySchema.parse(FIVE_DAY), FIVE_DAY);
  // Order and duplicate boundaries are canonicalized on the way in.
  assertEquals(
    webPolicySchema.parse({
      stages: [{ h: 0, pct: 100 }, { h: 72, pct: 30 }, { h: 120, pct: 0 }],
    }),
    FIVE_DAY,
  );
});

Deno.test("policy: a table not ending at 当日 (h=0) is rejected, not completed", () => {
  const noZero = { stages: [{ h: 120, pct: 0 }, { h: 72, pct: 30 }] };
  assertEquals(webPolicySchema.safeParse(noZero).success, false);
  assertEquals(webPolicySchema.safeParse({ stages: [] }).success, false);
  assertEquals(webPolicySchema.safeParse({ stages: [{ h: 0, pct: 120 }] }).success, false);
  assertEquals(webPolicySchema.safeParse({ stages: [{ h: -24, pct: 0 }] }).success, false);
  assertEquals(webPolicySchema.safeParse({ stages: [{ h: 1.5, pct: 0 }] }).success, false);
  // Cap: 9 stages is more table than the model (and the form) allows.
  const many = Array.from({ length: 9 }, (_, i) => ({ h: (8 - i) * 24, pct: i * 10 }));
  assertEquals(webPolicySchema.safeParse({ stages: many }).success, false);
});

Deno.test("policy: normalizeStages orders, dedupes by boundary and drops redundant rates", () => {
  assertEquals(
    normalizeStages([{ h: 0, pct: 100 }, { h: 120, pct: 0 }, { h: 72, pct: 30 }]),
    FIVE_DAY.stages,
  );
  // Same boundary twice: the later entry wins (a later form row overrides).
  assertEquals(
    normalizeStages([{ h: 72, pct: 30 }, { h: 72, pct: 50 }, { h: 0, pct: 100 }]),
    [{ h: 72, pct: 50 }, { h: 0, pct: 100 }],
  );
  // A stage charging the same rate as the next inner one is redundant.
  assertEquals(
    normalizeStages([{ h: 168, pct: 0 }, { h: 120, pct: 0 }, { h: 0, pct: 100 }]),
    [{ h: 120, pct: 0 }, { h: 0, pct: 100 }],
  );
});

Deno.test("policy: a table equal to a preset collapses to the preset name", () => {
  assertEquals(webPolicySchema.parse({ stages: [{ h: 0, pct: 0 }] }), "none");
  assertEquals(
    webPolicySchema.parse({ stages: [{ h: 24, pct: 0 }, { h: 0, pct: 100 }] }),
    "free24",
  );
  assertEquals(
    webPolicySchema.parse({
      stages: [{ h: 168, pct: 0 }, { h: 72, pct: 30 }, { h: 24, pct: 50 }, { h: 0, pct: 100 }],
    }),
    "staged",
  );
});

Deno.test("policy: stagesOf is null only for unknown", () => {
  assertEquals(stagesOf("unknown"), null);
  assertEquals(stagesOf("free24"), [{ h: 24, pct: 0 }, { h: 0, pct: 100 }]);
  assertEquals(stagesOf(FIVE_DAY), FIVE_DAY.stages);
});

Deno.test("policy: freeDeadlineMs is the end of the last free DAY", () => {
  // START は 8/20(木) 19:00 JST。5日前=8/15、前日=8/19、7日前=8/13、いずれもその日の
  // 終わりまで無料（予約が19:00でも15:00でも同じ日付で切れる）。
  assertEquals(freeDeadlineMs(FIVE_DAY, START), eod("2026-08-15"));
  assertEquals(freeDeadlineMs("free24", START), eod("2026-08-19"));
  assertEquals(freeDeadlineMs("staged", START), eod("2026-08-13"));
  // No free window to lose: unknown / always free / paid from the outset.
  assertEquals(freeDeadlineMs("unknown", START), null);
  assertEquals(freeDeadlineMs("none", START), null);
  assertEquals(freeDeadlineMs({ stages: [{ h: 48, pct: 20 }, { h: 0, pct: 80 }] }, START), null);
});

Deno.test("policy: isAlwaysFree separates いつでも無料 from 無料期間なし", () => {
  assertEquals(isAlwaysFree("none"), true);
  assertEquals(isAlwaysFree(FIVE_DAY), false);
  assertEquals(isAlwaysFree("unknown"), false);
  assertEquals(isAlwaysFree({ stages: [{ h: 48, pct: 20 }, { h: 0, pct: 80 }] }), false);
});

Deno.test("policy: maxLossYen and pctAt read the custom stage table", () => {
  assertEquals(maxLossYen(FIVE_DAY, 40000), 40000);
  assertEquals(maxLossYen({ stages: [{ h: 120, pct: 0 }, { h: 0, pct: 30 }] }, 40000), 12000);
  assertEquals(maxLossYen(FIVE_DAY, null), 0);
  assertEquals(maxLossYen("unknown", 40000), 0);

  // 境界は日付の変わり目。START は 8/20(木) 19:00 JST なので 5日前=8/15 の終わり。
  const at = (iso: string) => Temporal.Instant.from(iso).epochMilliseconds;
  assertEquals(pctAt(FIVE_DAY, startMs, at("2026-08-10T00:00:00+09:00")), 0); // まだ無料
  assertEquals(pctAt(FIVE_DAY, startMs, at("2026-08-15T23:59:00+09:00")), 0); // 5日前の終わり際
  assertEquals(pctAt(FIVE_DAY, startMs, at("2026-08-16T00:30:00+09:00")), 30); // 日付が変わった
  assertEquals(pctAt(FIVE_DAY, startMs, at("2026-08-20T09:00:00+09:00")), 100); // 当日
  assertEquals(pctAt(FIVE_DAY, startMs, at("2026-08-20T20:00:00+09:00")), 100); // 開始後
  assertEquals(pctAt("unknown", startMs, at("2026-08-10T00:00:00+09:00")), null);
});

Deno.test("policy: describePolicy is human Japanese, never JSON", () => {
  assertEquals(describePolicy("unknown"), "不明");
  assertEquals(describePolicy("none"), "いつでも無料");
  assertEquals(describePolicy("free24"), "前日まで無料 → 当日100%");
  assertEquals(describePolicy("staged"), "7日前まで無料 → 3日前まで30% → 前日まで50% → 当日100%");
  assertEquals(describePolicy(FIVE_DAY), "5日前まで無料 → 3日前まで30% → 当日100%");
  assertEquals(
    describePolicy({ stages: [{ h: 36, pct: 0 }, { h: 0, pct: 50 }] }),
    "36時間前まで無料 → 当日50%",
  );
  assertEquals(
    describePolicy({ stages: [{ h: 48, pct: 20 }, { h: 0, pct: 80 }] }),
    "2日前まで20% → 当日80%",
  );
});

Deno.test("fromCoreStages: arbitrary parsed stages are preserved, not coerced", () => {
  assertEquals(fromCoreStages(core([[120, 0], [72, 30], [0, 100]])), FIVE_DAY);
  // Fractional offsets round to whole hours; the innermost rate is stated at h=0
  // (it already applied down to the start) instead of inventing a 100% stage.
  assertEquals(
    fromCoreStages(core([[48.4, 20], [12, 80]])),
    { stages: [{ h: 48, pct: 20 }, { h: 0, pct: 80 }] },
  );
});

Deno.test("fromCoreStages: a 「N日前から◯%」 policy keeps its free window", () => {
  // What the ledger must end up with for 「7日前から20%」 (owner, 2026-07-30:
  // 「7日目から20%とるってなってると、8日目まで無料とは自動で入らないんだね」).
  // 7日前 is a charged day, so the last free moment is 8日前 — the parse prompt
  // now states that convention, and this is the shape it has to produce: a
  // deadline the ledger can show and the 24時間前 sweep can notify on. A table
  // with no 0% stage yields freeDeadlineMs === null and silently notifies about
  // nothing at all.
  const fromBoundary = fromCoreStages(core([[192, 0], [0, 20]]));
  assertEquals(fromBoundary, { stages: [{ h: 192, pct: 0 }, { h: 0, pct: 20 }] });
  assertEquals(describePolicy(fromBoundary), "8日前まで無料 → 当日20%");
  assertEquals(freeDeadlineMs(fromBoundary, START), eod("2026-08-12"));

  // Staged version of the same phrasing: 「3日前から20%、前日50%、当日80%」.
  const staged = fromCoreStages(core([[96, 0], [48, 20], [24, 50], [0, 80]]));
  assertEquals(describePolicy(staged), "4日前まで無料 → 2日前まで20% → 前日まで50% → 当日80%");
  assertEquals(freeDeadlineMs(staged, START), eod("2026-08-16"));
});

Deno.test("fromCoreStages: the source text's free boundary wins over the model's", () => {
  // Both are real answers to 「3日前から20%、前日50%、当日80%」, measured 2026-07-30:
  // gemini-flash applies the one-day correction, llama-3.3-70b does not. The
  // ledger must not depend on which one answered, so the boundary the TEXT
  // implies (4日前 = 96h) is forced onto both.
  const want = {
    stages: [{ h: 96, pct: 0 }, { h: 48, pct: 20 }, { h: 24, pct: 50 }, { h: 0, pct: 80 }],
  };
  assertEquals(fromCoreStages(core([[72, 0], [48, 20], [24, 50], [0, 80]]), 96), want);
  assertEquals(fromCoreStages(core([[96, 0], [48, 20], [24, 50], [0, 80]]), 96), want);

  // 「7日前から20%」 — the owner's case (2026-07-30): 「8日目まで無料とは自動で
  // 入らないんだね」. 7日前 is a charged day, so the deadline is 8日前.
  const single = { stages: [{ h: 192, pct: 0 }, { h: 0, pct: 20 }] };
  assertEquals(fromCoreStages(core([[168, 0], [0, 20]]), 192), single);
  assertEquals(fromCoreStages(core([[192, 0], [0, 20]]), 192), single);
  assertEquals(
    describePolicy(fromCoreStages(core([[168, 0], [0, 20]]), 192)),
    "8日前まで無料 → 当日20%",
  );

  // No free stage at all (what the pre-2026-07-30 prompt produced): the window
  // is put back rather than left as "charged since you booked".
  assertEquals(
    fromCoreStages(core([[72, 20], [24, 50], [0, 80]]), 96),
    { stages: [{ h: 96, pct: 0 }, { h: 72, pct: 20 }, { h: 24, pct: 50 }, { h: 0, pct: 80 }] },
  );

  // 「当日から100%」 collapses to the preset it has always been.
  assertEquals(fromCoreStages(core([[0, 100]]), 24), "free24");
});

Deno.test("fromCoreStages: no boundary from the text leaves the table untouched", () => {
  // 「まで」-phrased and unrecognised text pass null — the model's own free
  // stage is the only claim available and is kept verbatim.
  assertEquals(fromCoreStages(core([[168, 0], [72, 30], [24, 50], [0, 100]]), null), "staged");
  assertEquals(fromCoreStages(core([[120, 0], [72, 30], [0, 100]]), undefined), FIVE_DAY);
  // An always-free table has nothing to charge for: no free boundary is forced.
  assertEquals(fromCoreStages(core([[0, 0]]), 96), "none");
});

Deno.test("fromCoreStages: a fixed-yen fee cannot be expressed as % -> unknown", () => {
  assertEquals(fromCoreStages(core([[24, 0], [0, 0]], 5000)), "unknown");
  assertEquals(fromCoreStages("unknown"), "unknown");
  assertEquals(fromCoreStages(undefined), "unknown");
  assertEquals(fromCoreStages(null), "unknown");
  assertEquals(fromCoreStages({ stages: [] }), "unknown");
  // A boundary a decade out is a parse error, not a policy.
  assertEquals(fromCoreStages(core([[100000, 0], [0, 100]])), "unknown");
});

Deno.test("fromCoreStages: an exact preset match collapses to the preset name", () => {
  assertEquals(fromCoreStages(core([[0, 0]])), "none");
  assertEquals(fromCoreStages(core([[24, 0], [0, 100]])), "free24");
  assertEquals(fromCoreStages(core([[168, 0], [72, 30], [24, 50], [0, 100]])), "staged");
});

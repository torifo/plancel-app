import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { compareToTruth, policyKey } from "../bench.ts";

Deno.test("policyKey: stages become a comparable line, anything else is unknown", () => {
  assertEquals(
    policyKey({
      stages: [
        { until_offset_hours: 168, fee_percent: 0, fee_fixed_jpy: null },
        { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
      ],
    }),
    "168/0,0/100",
  );
  assertEquals(policyKey("unknown"), "unknown");
  assertEquals(policyKey(null), "unknown");
  assertEquals(policyKey({ stages: [] }), "unknown");
});

Deno.test("compareToTruth: a field the text does not state is not compared", () => {
  // No `location` in truth: the fixture says nothing, so any answer passes.
  assertEquals(
    compareToTruth({ service_name: "鮨さいとう", location: "東京" }, {
      service_name: "鮨さいとう",
    }),
    [],
  );
  // Present and null means the text states nothing usable — an answer is wrong.
  assertEquals(
    compareToTruth({ location: "東京" }, { location: null }).map((m) => m.field),
    ["location"],
  );
});

Deno.test("compareToTruth: a year-less date is judged on month, day and time only", () => {
  const truth = { starts_at_md: "08-01T19:00" };
  // Read in a different year: still right.
  assertEquals(compareToTruth({ starts_at: "2027-08-01T19:00:00+09:00" }, truth), []);
  assertEquals(compareToTruth({ starts_at: "2026-08-01T19:00:00+09:00" }, truth), []);
  // Wrong day: wrong.
  assertEquals(
    compareToTruth({ starts_at: "2026-08-02T19:00:00+09:00" }, truth).map((m) => m.field),
    ["starts_at (月日と時刻)"],
  );
});

Deno.test("compareToTruth: a weekday fixes only the time", () => {
  const truth = { starts_at_time: "19:00" };
  assertEquals(compareToTruth({ starts_at: "2026-09-05T19:00:00+09:00" }, truth), []);
  assertEquals(
    compareToTruth({ starts_at: "2026-09-05T19:30:00+09:00" }, truth).map((m) => m.field),
    ["starts_at (時刻)"],
  );
});

Deno.test("compareToTruth: the stage table is compared as a whole", () => {
  const truth = { policy: "23/0,0/100" };
  assertEquals(
    compareToTruth({
      cancellation_policy: {
        stages: [
          { until_offset_hours: 23, fee_percent: 0, fee_fixed_jpy: null },
          { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
        ],
      },
    } as never, truth),
    [],
  );
  // The value the corpus recorded for this mail — and it is wrong.
  const off = compareToTruth({
    cancellation_policy: {
      stages: [
        { until_offset_hours: 29, fee_percent: 0, fee_fixed_jpy: null },
        { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
      ],
    },
  } as never, truth);
  assertEquals(off, [{ field: "policy", got: "29/0,0/100", want: "23/0,0/100" }]);
});

Deno.test("compareToTruth: no answer at all is one plain mismatch", () => {
  assertEquals(compareToTruth(null, { service_name: "x" }), [{
    field: "output",
    got: "null",
    want: "an answer",
  }]);
});

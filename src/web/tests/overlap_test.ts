import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { findOverlaps, nightsOf, type OverlapRow, rideSpanOf } from "../overlap.ts";

const row = (o: Partial<OverlapRow> & { id: string }): OverlapRow => ({
  service: o.id,
  plan: null,
  startsAt: "2026-12-19T15:00:00+09:00",
  endsAt: "2026-12-20T10:00:00+09:00",
  status: "candidate",
  ...o,
});

Deno.test("overlap: two different inns for the same night are one group", () => {
  const out = findOverlaps([
    row({
      id: "A",
      service: "おにやまホテル",
      status: "confirmed",
      startsAt: "2026-12-19T15:30:00+09:00",
    }),
    row({ id: "B", service: "別府温泉　ホテル白菊" }),
    row({
      id: "C",
      service: "白馬ハイランド",
      startsAt: "2027-01-23T15:00:00+09:00",
      endsAt: null,
    }),
  ]);
  assertEquals(out, [{ kind: "stay", from: "2026-12-19", to: "2026-12-20", ids: ["A", "B"] }]);
});

Deno.test("overlap: nights are counted in JST, and leaving on the day another arrives is no clash", () => {
  // 12/18 → 12/19 and 12/19 → 12/20 share no night.
  assertEquals(
    findOverlaps([
      row({ id: "A", startsAt: "2026-12-18T15:00:00+09:00", endsAt: "2026-12-19T10:00:00+09:00" }),
      row({ id: "B" }),
    ]),
    [],
  );
  // 00:30 JST on the 20th is still written as the 19th in UTC: it is the night of the 20th.
  assertEquals(
    nightsOf(row({ id: "A", startsAt: "2026-12-19T15:30:00Z", endsAt: "2026-12-21T01:00:00Z" })),
    nightsOf(
      row({ id: "B", startsAt: "2026-12-20T00:30:00+09:00", endsAt: "2026-12-21T10:00:00+09:00" }),
    ),
  );
  // A three-night stay clashes with a one-night stay in its middle, and the span covers both.
  assertEquals(
    findOverlaps([
      row({ id: "A", startsAt: "2026-12-18T15:00:00+09:00", endsAt: "2026-12-21T10:00:00+09:00" }),
      row({ id: "B" }),
    ]),
    [{ kind: "stay", from: "2026-12-18", to: "2026-12-21", ids: ["A", "B"] }],
  );
});

Deno.test("overlap: only stays that are still in play are weighed", () => {
  const base = row({ id: "A" });
  const none = (other: OverlapRow) => assertEquals(findOverlaps([base, other]), []);
  none(row({ id: "B", status: "to_cancel" }));
  none(row({ id: "B", status: "cancelled" }));
  // A flight or a dinner on the same day is not a second inn.
  none(row({ id: "B", kind: "flight" }));
  none(row({ id: "B", kind: "meal" }));
  // No kind and no later end: a dinner entered before kinds existed.
  none(row({ id: "B", endsAt: null }));
  none(row({ id: "B", startsAt: "こわれた日時" }));
  // Said to be a stay: one night even with no end.
  assertEquals(findOverlaps([base, row({ id: "B", kind: "stay", endsAt: null })]).length, 1);
});

Deno.test("overlap: one plan's candidates and the same booking entered twice are someone else's job", () => {
  // Same plan → the plan card already says 「どれか1つに」.
  assertEquals(
    findOverlaps([row({ id: "A", plan: "別府の宿" }), row({ id: "B", plan: "別府の宿" })]),
    [],
  );
  // Same name, same day → the merge note.
  assertEquals(
    findOverlaps([
      row({ id: "A", service: "ホテル 白菊" }),
      row({ id: "B", service: "ホテル白菊" }),
    ]),
    [],
  );
  // Different plans still clash.
  assertEquals(
    findOverlaps([row({ id: "A", plan: "別府の宿" }), row({ id: "B", plan: "母の案" })]).length,
    1,
  );
});

const ride = (o: Partial<OverlapRow> & { id: string }): OverlapRow =>
  row({
    kind: "flight",
    startsAt: "2026-12-19T08:00:00+09:00",
    endsAt: "2026-12-19T09:45:00+09:00",
    ...o,
  });

Deno.test("overlap: a flight and a train for the same hours are one group, apart from the inns", () => {
  const out = findOverlaps([
    ride({ id: "JAL", service: "JAL661" }),
    ride({
      id: "SONIC",
      service: "特急ソニック",
      kind: "train",
      startsAt: "2026-12-19T09:00:00+09:00",
      endsAt: "2026-12-19T11:00:00+09:00",
    }),
    // The inn that night is not an alternative to either.
    row({ id: "INN" }),
    // The return leg is another day.
    ride({
      id: "BACK",
      startsAt: "2026-12-20T17:00:00+09:00",
      endsAt: "2026-12-20T18:40:00+09:00",
    }),
  ]);
  assertEquals(out, [{
    kind: "transport",
    from: "2026-12-19",
    to: "2026-12-19",
    ids: ["JAL", "SONIC"],
  }]);
});

Deno.test("overlap: rides that follow one another, a hired car, and a ride with no time are not weighed", () => {
  const first = ride({ id: "A" });
  const none = (other: OverlapRow) => assertEquals(findOverlaps([first, other]), []);
  // A connection leaving as the first arrives.
  none(
    ride({
      id: "B",
      kind: "bus",
      startsAt: "2026-12-19T09:45:00+09:00",
      endsAt: "2026-12-19T10:30:00+09:00",
    }),
  );
  // A car is hired alongside the flight, not instead of it.
  none(
    ride({
      id: "B",
      kind: "car",
      startsAt: "2026-12-19T08:30:00+09:00",
      endsAt: "2026-12-20T18:00:00+09:00",
    }),
  );
  // Only the day is known: nothing to set against the hours.
  none(ride({ id: "B", startsAt: "2026-12-19T00:00:00+09:00", endsAt: null, timeTentative: true }));
  none(ride({ id: "B", status: "to_cancel" }));
  // Same flight entered twice is the merge note's job.
  none(ride({ id: "B", service: "ａ", startsAt: "2026-12-19T08:30:00+09:00" }));
});

Deno.test("overlap: a ride with no arrival time is taken to last an hour", () => {
  const start = Date.parse("2026-12-19T08:00:00+09:00");
  assertEquals(rideSpanOf(ride({ id: "A", endsAt: null })), [start, start + 3_600_000]);
  // A date alone for the arrival says nothing about the hour either.
  assertEquals(rideSpanOf(ride({ id: "A", endsAt: "2026-12-18T15:00:00Z" })), [
    start,
    start + 3_600_000,
  ]);
  assertEquals(
    findOverlaps([
      ride({ id: "A", endsAt: null }),
      ride({ id: "B", kind: "train", startsAt: "2026-12-19T08:59:00+09:00", endsAt: null }),
    ]).length,
    1,
  );
  assertEquals(
    findOverlaps([
      ride({ id: "A", endsAt: null }),
      ride({ id: "B", kind: "train", startsAt: "2026-12-19T09:00:00+09:00", endsAt: null }),
    ]),
    [],
  );
});

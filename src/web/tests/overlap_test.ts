import { assertEquals } from "jsr:@std/assert@^1.0.19";
import {
  classifyAlternatives,
  classifyRide,
  findOverlaps,
  nightsOf,
  type OverlapRow,
  parkingDaysOf,
  partySize,
  rideSpanOf,
} from "../overlap.ts";

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

const park = (o: Partial<OverlapRow> & { id: string }): OverlapRow =>
  row({
    kind: "parking",
    startsAt: "2026-12-19T08:00:00+09:00",
    endsAt: "2026-12-20T20:00:00+09:00",
    ...o,
  });

Deno.test("overlap: two parking bookings sharing a day are one group, ends counted", () => {
  // 12/19-12/20 and 12/20-12/21 meet on the 20th; `to` is the last exit day itself.
  assertEquals(
    findOverlaps([
      park({ id: "HND", service: "羽田空港 P2" }),
      park({
        id: "NEAR",
        service: "近くの民間駐車場",
        startsAt: "2026-12-20T07:00:00+09:00",
        endsAt: "2026-12-21T21:00:00+09:00",
      }),
    ]),
    [{ kind: "parking", from: "2026-12-19", to: "2026-12-21", ids: ["HND", "NEAR"] }],
  );
});

Deno.test("overlap: parking on days apart is not a group", () => {
  assertEquals(
    findOverlaps([
      park({ id: "A" }),
      park({
        id: "B",
        startsAt: "2026-12-21T08:00:00+09:00",
        endsAt: "2026-12-22T20:00:00+09:00",
      }),
    ]),
    [],
  );
});

Deno.test("overlap: parking is never grouped with an inn or a flight", () => {
  assertEquals(
    findOverlaps([
      park({ id: "P" }),
      row({ id: "INN", kind: "stay" }),
      ride({
        id: "FLY",
        startsAt: "2026-12-19T08:00:00+09:00",
        endsAt: "2026-12-19T09:45:00+09:00",
      }),
    ]),
    [],
  );
});

Deno.test("overlap: parking with no exit, or one before the entry, is the entry day alone", () => {
  assertEquals(parkingDaysOf(park({ id: "A", endsAt: null })), [
    Math.floor((Date.parse("2026-12-19T08:00:00+09:00") + 9 * 3_600_000) / 86_400_000),
    Math.floor((Date.parse("2026-12-19T08:00:00+09:00") + 9 * 3_600_000) / 86_400_000) + 1,
  ]);
  const one = findOverlaps([
    park({ id: "A", endsAt: null }),
    park({ id: "B", endsAt: "2026-12-18T20:00:00+09:00" }),
  ]);
  assertEquals(one, [{ kind: "parking", from: "2026-12-19", to: "2026-12-19", ids: ["A", "B"] }]);
  // The 20th is not covered by a no-exit booking on the 19th.
  assertEquals(
    findOverlaps([
      park({ id: "A", endsAt: null }),
      park({ id: "B", startsAt: "2026-12-20T08:00:00+09:00", endsAt: null }),
    ]),
    [],
  );
});

Deno.test("overlap: parking of one plan, or the same name on the same day, is left out", () => {
  const none = (a: Partial<OverlapRow>, b: Partial<OverlapRow>) =>
    assertEquals(findOverlaps([park({ id: "A", ...a }), park({ id: "B", ...b })]), []);
  none({ plan: "駐車場" }, { plan: "駐車場" });
  none({ service: "羽田 P2" }, { service: "羽田　p2" });
  none({}, { status: "to_cancel" });
});

Deno.test("party: the trip's count wins, else the largest booking in the trip, else unknown", () => {
  const live = (id: string, people: number | null, status = "confirmed") => ({
    id,
    status,
    people,
  });
  assertEquals(partySize(4, [live("A", 2)]), { party: 4, inferred: false });
  assertEquals(partySize(null, [live("INN", 4), live("F1", 2), live("X", 6, "to_cancel")]), {
    party: 4,
    inferred: true,
  });
  assertEquals(partySize(undefined, [live("A", null)]), { party: null, inferred: false });
});

Deno.test("party: two halves of a party are both used, more seats than people are over, unknown is choose", () => {
  const r = (id: string, people: number | null) => ({ id, status: "candidate", people });
  // Four people, two 2-seat bookings of the same hours: split, both used.
  assertEquals(classifyAlternatives([r("JAL", 2), r("ANA", 2)], 4), { mode: "split", total: 4 });
  // Four people, two 4-seat bookings: one is extra.
  assertEquals(classifyAlternatives([r("JAL", 4), r("ANA", 4)], 4), { mode: "over", total: 8 });
  // A booking that does not say how many it is for: one of them, as before.
  assertEquals(classifyAlternatives([r("JAL", 2), r("ANA", null)], 4), {
    mode: "choose",
    total: null,
  });
  assertEquals(classifyAlternatives([r("JAL", 2), r("ANA", 2)], null), {
    mode: "choose",
    total: null,
  });
});

Deno.test("party: the same flight bought twice on one day counts as one party when working it out", () => {
  const seat = (id: string, service: string, people: number, at = "2026-12-19T12:05:00+09:00") => ({
    id,
    status: "confirmed",
    people,
    service,
    startsAt: at,
  });
  // JAL665 as 2 + 2 seats: four people, not two.
  assertEquals(partySize(null, [seat("A", "JAL665", 2), seat("B", "JAL 665", 2)]), {
    party: 4,
    inferred: true,
  });
  // Two different flights of two seats each say only that two travel on each.
  assertEquals(partySize(null, [seat("A", "JAL665", 2), seat("B", "ANA795", 2)]), {
    party: 2,
    inferred: true,
  });
  // The same flight on different days is two trips' worth, not one party.
  assertEquals(
    partySize(null, [seat("A", "JAL665", 2), seat("B", "JAL665", 2, "2026-12-20T12:05:00+09:00")]),
    { party: 2, inferred: true },
  );
});

Deno.test("ride: bookings of one flight that each say their seats are one ride, unless one is entered twice", () => {
  const b = (id: string, people: number | null, ref: string | null = null) => ({
    id,
    status: "confirmed",
    people,
    ref,
  });
  // No trip count: 2 + 2 seats on JAL665 are halves of one party.
  assertEquals(classifyRide([b("A", 2, "ABC"), b("B", 2, "DEF")], null), {
    mode: "split",
    total: 4,
  });
  // A trip of four with 2 + 1: still one ride, one seat short (read as before).
  assertEquals(classifyRide([b("A", 2), b("B", 1)], 4), { mode: "split", total: 3 });
  // A booking without its seats cannot be read: one of them, as before.
  assertEquals(classifyRide([b("A", 2), b("B", null)], null), { mode: "choose", total: null });
  // The same booking number twice (spacing and case aside) is one booking entered twice.
  assertEquals(classifyRide([b("A", 2, "ABC"), b("B", 2, " a b c")], null), {
    mode: "over",
    total: 4,
  });
  assertEquals(classifyRide([b("A", 2, "ABC"), b("B", 2, "ABC")], 4), { mode: "over", total: 4 });
  // More seats than the trip holds stays over.
  assertEquals(classifyRide([b("A", 4), b("B", 4)], 4), { mode: "over", total: 8 });
});

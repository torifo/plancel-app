/**
 * How the remote MCP shows the ledger to the model (issues #5, #6): JST
 * timestamps, the computed free-cancel deadline, a filtered list, and the
 * duplicate check that keeps a retried create from making a second row.
 */
import { assertEquals } from "jsr:@std/assert@^1.0.19";
import {
  findDuplicate,
  findSameDay,
  jst,
  listFilterSchema,
  presentList,
  presentReservation,
} from "../web_api_view.ts";
import type { WebReservation } from "../../web/store.ts";

const NOW = Date.parse("2026-10-13T03:00:00Z"); // 12:00 JST

function row(over: Partial<WebReservation> = {}): WebReservation {
  return {
    id: "R1",
    plan: null,
    service: "鮨 さいとう",
    startsAt: "2026-12-20T10:00:00.000Z", // 19:00 JST
    endsAt: null,
    amount: 30000,
    location: null,
    notes: null,
    timeTentative: false,
    trip: null,
    booked: true,
    kind: null,
    from: null,
    to: null,
    bookedBy: null,
    rank: null,
    people: null,
    suggestion: null,
    policy: "staged",
    status: "candidate",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    updated_by: "01USER",
    ...over,
  };
}

Deno.test("view: timestamps go out as +09:00, never Z", () => {
  assertEquals(jst("2026-12-20T10:00:00.000Z"), "2026-12-20T19:00:00+09:00");
  assertEquals(jst("来週の金曜"), "来週の金曜"); // a legacy row keeps its text
});

Deno.test("view: a reservation carries its deadline and policy in words, not internals", () => {
  const v = presentReservation(row(), NOW);
  assertEquals(v.startsAt, "2026-12-20T19:00:00+09:00");
  // staged: free until the end of the day 7 days before (12/13), then 30%.
  assertEquals(v.freeUntil, "2026-12-13T23:59:59+09:00");
  assertEquals(v.nextCharge, { from: "2026-12-14T00:00:00+09:00", pct: 30 });
  assertEquals(v.policyText, "7日前まで無料 → 3日前まで30% → 前日まで50% → 当日100%");
  assertEquals(v.finished, false);
  assertEquals("updated_by" in v, false);
  assertEquals("created_at" in v, false);

  const unknown = presentReservation(row({ policy: "unknown" }), NOW);
  assertEquals(unknown.freeUntil, null);
  assertEquals(unknown.nextCharge, null);
  assertEquals(unknown.policyText, "不明");

  const done = presentReservation(row({ startsAt: "2026-10-01T10:00:00.000Z" }), NOW);
  assertEquals(done.finished, true);
});

Deno.test("view: the list hides finished and cancelled rows by default, filters, sorts, limits", () => {
  const rows = [
    row({ id: "A", startsAt: "2026-12-20T10:00:00.000Z" }),
    row({ id: "B", startsAt: "2026-11-01T10:00:00.000Z", policy: "free24", status: "confirmed" }),
    row({ id: "C", startsAt: "2026-10-01T10:00:00.000Z" }), // finished
    row({ id: "D", startsAt: "2026-11-15T10:00:00.000Z", status: "cancelled" }),
    row({ id: "E", startsAt: "2026-11-20T10:00:00.000Z", policy: "unknown", service: "宿 蛍" }),
  ];
  const ids = (out: { reservations: { id: string }[] }) => out.reservations.map((r) => r.id);

  const def = presentList(rows, listFilterSchema.parse({}), NOW);
  assertEquals(ids(def), ["B", "E", "A"]);
  assertEquals(def.total, 5);
  assertEquals(def.count, 3);

  assertEquals(ids(presentList(rows, listFilterSchema.parse({ includeFinished: true }), NOW)), [
    "C",
    "B",
    "E",
    "A",
  ]);
  assertEquals(
    ids(presentList(rows, listFilterSchema.parse({ status: ["cancelled"] }), NOW)),
    ["D"],
  );
  assertEquals(ids(presentList(rows, listFilterSchema.parse({ q: "さいとう" }), NOW)), ["B", "A"]);
  assertEquals(ids(presentList(rows, listFilterSchema.parse({ q: "宿蛍" }), NOW)), ["E"]);
  assertEquals(
    ids(presentList(rows, listFilterSchema.parse({ from: "2026-11-10", to: "2026-12-31" }), NOW)),
    ["E", "A"],
  );
  // Soonest deadline first; no deadline last.
  assertEquals(ids(presentList(rows, listFilterSchema.parse({ sort: "deadline" }), NOW)), [
    "B",
    "A",
    "E",
  ]);
  const limited = presentList(rows, listFilterSchema.parse({ limit: 1 }), NOW);
  assertEquals(ids(limited), ["B"]);
  assertEquals(limited.truncated, true);
});

Deno.test("view: a duplicate is the same place at the same instant, still live", () => {
  const rows = [row({ id: "A" }), row({ id: "X", status: "cancelled" })];
  assertEquals(findDuplicate(rows, "鮨さいとう", "2026-12-20T19:00:00+09:00")?.id, "A");
  assertEquals(findDuplicate(rows, "鮨 さいとう", "2026-12-20T19:30:00+09:00"), null);
  assertEquals(findDuplicate([rows[1]!], "鮨さいとう", "2026-12-20T19:00:00+09:00"), null);
});

// ---- found by driving the December family scenario through the tools (2026-11-11) ----

Deno.test("view: feeNow is what cancelling right now would cost", () => {
  // 12/20 19:00 JST, staged, ¥30,000. On 10/13 it is still free.
  assertEquals(presentReservation(row(), NOW).feeNow, { pct: 0, yen: 0 });
  // 12/15 (5 days before): past the 7-day free window, inside the 30% band.
  const later = Date.parse("2026-12-15T03:00:00Z");
  assertEquals(presentReservation(row(), later).feeNow, { pct: 30, yen: 9000 });
  // No amount: the rate is known, the yen figure is not.
  assertEquals(presentReservation(row({ amount: null }), later).feeNow, { pct: 30, yen: null });
  // Unknown policy: nothing to say.
  assertEquals(presentReservation(row({ policy: "unknown" }), NOW).feeNow, null);
});

Deno.test("view: a status filter does not bring finished rows back, and the list says what it hid", () => {
  const rows = [
    row({ id: "A" }),
    row({ id: "C", startsAt: "2026-10-01T10:00:00.000Z" }), // finished
    row({ id: "D", startsAt: "2026-11-15T10:00:00.000Z", status: "cancelled" }),
    row({ id: "E", startsAt: "2026-11-20T10:00:00.000Z", policy: "unknown" }),
  ];
  const out = presentList(
    rows,
    listFilterSchema.parse({ status: ["candidate", "confirmed"] }),
    NOW,
  );
  assertEquals(out.reservations.map((r) => r.id), ["E", "A"]);
  // 「total 4 なのに 2 件」の理由が応答から読める。
  const def = presentList(rows, listFilterSchema.parse({}), NOW);
  assertEquals(def.hidden, { finished: 1, cancelled: 1 });
  // 規定不明は期限順で末尾に回るので、件数を別に出して埋もれさせない。
  assertEquals(def.policyUnknown, 1);
  const all = presentList(
    rows,
    listFilterSchema.parse({ includeFinished: true, status: ["candidate", "cancelled"] }),
    NOW,
  );
  assertEquals(all.reservations.length, 4);
  assertEquals(all.hidden, { finished: 0, cancelled: 0 });
});

Deno.test("view: someone else's shared reservation is not my duplicate", () => {
  const shared = row({ id: "S" }) as WebReservation & {
    shared: { ownerDisplayName: string; role: string };
  };
  shared.shared = { ownerDisplayName: "母", role: "viewer" };
  assertEquals(findDuplicate([shared], "鮨さいとう", "2026-12-20T19:00:00+09:00"), null);
});

Deno.test("view: a row stored before endsAt existed still answers endsAt: null", () => {
  const legacy = row() as Partial<WebReservation>;
  delete legacy.endsAt;
  const v = presentReservation(legacy as WebReservation, NOW);
  assertEquals("endsAt" in v && v.endsAt, null);
  assertEquals(JSON.parse(JSON.stringify(v)).endsAt, null);
});

// ---- found by the test-account rehearsal (2026-11-11) ----

Deno.test("view: the fee schedule gives dates, so a gap in the wording cannot mislead", () => {
  // 「2日前まで無料、それ以降は全額」 for 12/12 14:00: the day before is already
  // 100%. The wording says 以降 for that, and the schedule gives the dates.
  const v = presentReservation(
    row({
      startsAt: "2026-12-12T05:00:00.000Z",
      policy: { stages: [{ h: 48, pct: 0 }, { h: 0, pct: 100 }] },
    }),
    NOW,
  );
  assertEquals(v.policyText, "2日前まで無料 → 以降100%");
  assertEquals(v.feeSchedule, [
    { until: "2026-12-10T23:59:59+09:00", pct: 0, yen: 0 },
    { until: "2026-12-12T14:00:00+09:00", pct: 100, yen: 30000 },
  ]);
  // When the fee STARTS — the instant after the free deadline, not the deadline.
  assertEquals(v.freeUntil, "2026-12-10T23:59:59+09:00");
  assertEquals(v.nextCharge, { from: "2026-12-11T00:00:00+09:00", pct: 100 });
  assertEquals(presentReservation(row({ policy: "unknown" }), NOW).feeSchedule, null);
});

Deno.test("view: policyUnknown counts rows still to be watched, not cancelled ones", () => {
  const rows = [
    row({ id: "A", policy: "unknown", status: "cancelled" }),
    row({ id: "B", policy: "unknown", status: "to_cancel" }),
  ];
  const out = presentList(
    rows,
    listFilterSchema.parse({ status: ["cancelled", "to_cancel"] }),
    NOW,
  );
  assertEquals(out.count, 2);
  assertEquals(out.policyUnknown, 1);
});

// ---- from the first real Codex run against the production ledger (2026-11-12) ----

Deno.test("view: the same place on the same day is a possible duplicate even at another time", () => {
  // A stay filed with a tentative 15:30 check-in, then again with 15:00: the
  // exact-instant check let the second one through.
  const rows = [row({ id: "A", startsAt: "2026-12-19T06:30:00.000Z" })];
  assertEquals(findDuplicate(rows, "鮨さいとう", "2026-12-19T15:00:00+09:00"), null);
  assertEquals(findSameDay(rows, "鮨さいとう", "2026-12-19T15:00:00+09:00")?.id, "A");
  // Late evening JST is still that JST day, not the next UTC one.
  assertEquals(findSameDay(rows, "鮨 さいとう", "2026-12-19T23:30:00+09:00")?.id, "A");
  assertEquals(findSameDay(rows, "鮨さいとう", "2026-12-20T15:00:00+09:00"), null);
  assertEquals(findSameDay(rows, "別の店", "2026-12-19T15:00:00+09:00"), null);
});

Deno.test("view: notes, trip and the tentative-time flag reach the model, and trips can be listed", () => {
  const rows = [
    row({ id: "A", trip: "別府旅行", notes: "夕朝食付き", timeTentative: true }),
    row({ id: "B", startsAt: "2026-12-21T10:00:00.000Z", trip: "別府 旅行" }),
    row({ id: "C", startsAt: "2026-12-22T10:00:00.000Z" }),
  ];
  const a = presentReservation(rows[0]!, NOW);
  assertEquals([a.trip, a.notes, a.timeTentative], ["別府旅行", "夕朝食付き", true]);
  const c = presentReservation(rows[2]!, NOW);
  assertEquals([c.trip, c.notes, c.timeTentative], [null, null, false]);
  // Spacing aside, like every other name in the ledger.
  const trip = presentList(rows, listFilterSchema.parse({ trip: "別府旅行" }), NOW);
  assertEquals(trip.reservations.map((r) => r.id), ["A", "B"]);
  // The free-text search reads the note and the trip name too.
  assertEquals(
    presentList(rows, listFilterSchema.parse({ q: "夕朝食" }), NOW).reservations.map((r) => r.id),
    ["A"],
  );
});

Deno.test("view: an end given as a date comes back as a date, and still holds the stay open that day", () => {
  // Stored as midnight JST of the checkout day. Shown as "…T00:00:00+09:00" it
  // read as "ends at midnight" — the end of the FIRST day (rehearsal, 2026-11-12).
  const stay = row({ startsAt: "2026-12-19T06:30:00.000Z", endsAt: "2026-12-19T15:00:00.000Z" });
  assertEquals(presentReservation(stay, NOW).endsAt, "2026-12-20");
  // A real checkout time is shown as a time.
  assertEquals(
    presentReservation(row({ endsAt: "2026-12-20T01:00:00.000Z" }), NOW).endsAt,
    "2026-12-20T10:00:00+09:00",
  );
  // The stay is not over on the morning of the checkout day…
  assertEquals(presentReservation(stay, Date.parse("2026-12-20T00:30:00+09:00")).finished, false);
  assertEquals(presentReservation(stay, Date.parse("2026-12-20T20:00:00+09:00")).finished, false);
  // …and is once that day has ended.
  assertEquals(presentReservation(stay, Date.parse("2026-12-21T00:30:00+09:00")).finished, true);
});

Deno.test("view: an unbooked reservation has nothing to cancel, and a chosen one still needs booking", () => {
  const idea = presentReservation(row({ booked: false }), NOW);
  assertEquals([idea.booked, idea.needsBooking], [false, false]);
  assertEquals([idea.freeUntil, idea.nextCharge, idea.feeNow], [null, null, { pct: 0, yen: 0 }]);
  const chosen = presentReservation(row({ booked: false, status: "confirmed" }), NOW);
  assertEquals(chosen.needsBooking, true);
  const held = presentReservation(row(), NOW);
  assertEquals([held.booked, held.needsBooking], [true, false]);
  // Unknown policy on something not booked is not "unwatched": there is nothing to watch.
  const list = presentList(
    [row({ id: "A", booked: false, policy: "unknown" }), row({ id: "B", policy: "unknown" })],
    listFilterSchema.parse({}),
    NOW,
  );
  assertEquals(list.policyUnknown, 1);
});

Deno.test("view: a trip is summed up, and each row says what is still to be checked", () => {
  const rows = [
    row({
      id: "INN",
      trip: "別府旅行",
      kind: "stay",
      status: "confirmed",
      amount: 48000,
      endsAt: null,
    }),
    row({
      id: "T1",
      trip: "別府旅行",
      kind: "train",
      from: "博多",
      to: "別府",
      booked: false,
      policy: "unknown",
      amount: 22000,
      timeTentative: true,
      startsAt: "2026-12-19T00:00:00.000Z",
    }),
    row({
      id: "L1",
      trip: "別府旅行",
      plan: "昼",
      amount: 6000,
      startsAt: "2026-12-19T03:00:00.000Z",
    }),
    row({
      id: "L2",
      trip: "別府旅行",
      plan: "昼",
      amount: 8000,
      startsAt: "2026-12-19T03:00:00.000Z",
    }),
    row({ id: "X", amount: null, policy: "unknown" }),
  ];
  const out = presentList(rows, listFilterSchema.parse({}), NOW);
  const by = Object.fromEntries(out.reservations.map((r) => [r.id, r]));
  assertEquals([by.T1!.kind, by.T1!.from, by.T1!.to], ["train", "博多", "別府"]);
  assertEquals(by.T1!.needsCheck, ["まだ予約していない", "時刻が仮"]);
  assertEquals(by.INN!.needsCheck, ["終了日（チェックアウト日）が未入力"]);
  assertEquals(by.X!.needsCheck, ["キャンセル規定が不明", "金額が未入力"]);
  assertEquals(by.L1!.needsCheck, []);
  // Confirmed money, and the most the undecided rest could add (one per plan).
  assertEquals(out.trips, [{
    trip: "別府旅行",
    people: null,
    peopleInferred: false,
    count: 4,
    from: "2026-12-19",
    to: "2026-12-20",
    confirmedYen: 48000,
    expectedYen: 48000 + 22000 + 8000,
  }]);
});

Deno.test("view: a day with no time is shown as a date, sorted last in its day, and listed as open", () => {
  const rows = [
    row({ id: "BUS", startsAt: "2026-12-18T15:00:00.000Z", timeTentative: true, booked: false }),
    row({ id: "JAL", startsAt: "2026-12-18T23:05:00.000Z" }), // 12/19 08:05 JST
    row({ id: "NEXT", startsAt: "2026-12-19T23:00:00.000Z" }), // 12/20 08:00 JST
  ];
  const out = presentList(rows, listFilterSchema.parse({}), NOW);
  assertEquals(out.reservations.map((r) => r.id), ["JAL", "BUS", "NEXT"]);
  const bus = out.reservations[1]!;
  assertEquals(bus.startsAt, "2026-12-19");
  assertEquals(bus.needsCheck, ["まだ予約していない", "時刻が未定"]);
  // A real guess keeps its time and says so.
  const guess = presentReservation(row({ timeTentative: true }), NOW);
  assertEquals([guess.startsAt, guess.needsCheck], ["2026-12-20T19:00:00+09:00", ["時刻が仮"]]);
});

Deno.test("view: a reservation waiting to be cancelled says so in needsCheck", () => {
  const v = presentReservation(row({ status: "to_cancel", policy: "free24" }), NOW);
  assertEquals(v.needsCheck, ["取り消しの連絡が要る（2026-12-19 まで無料）"]);
  const noPolicy = presentReservation(row({ status: "to_cancel", policy: "unknown" }), NOW);
  assertEquals(noPolicy.needsCheck, ["取り消しの連絡が要る", "キャンセル規定が不明"]);
});

Deno.test("view: the list points out entries that may be the same booking, mine or shared", () => {
  const shared = row({ id: "HERS", service: "白 菊", startsAt: "2026-12-19T06:00:00.000Z" }) as
    & WebReservation
    & { shared: { ownerDisplayName: string; role: string } };
  shared.shared = { ownerDisplayName: "母", role: "editor" };
  const rows = [
    row({ id: "MINE", service: "白菊", startsAt: "2026-12-18T15:00:00.000Z", timeTentative: true }),
    shared,
    row({ id: "OTHER", service: "別の宿", startsAt: "2026-12-19T06:00:00.000Z" }),
    row({ id: "GONE", service: "白菊", startsAt: "2026-12-19T06:00:00.000Z", status: "cancelled" }),
  ];
  const out = presentList(
    rows,
    listFilterSchema.parse({ status: ["candidate", "confirmed", "to_cancel", "cancelled"] }),
    NOW,
  );
  assertEquals(out.possibleDuplicates, [{
    service: "白菊",
    day: "2026-12-19",
    ids: ["MINE", "HERS"],
    sharedBy: ["母"],
  }]);
  // Nothing alike → the key is absent.
  assertEquals(
    presentList([rows[0]!, rows[2]!], listFilterSchema.parse({}), NOW).possibleDuplicates,
    undefined,
  );
});

Deno.test("view: the list lines up different stays held for the same night, with the day to decide by", () => {
  const hers = row({
    id: "HERS",
    service: "ホテル白菊",
    startsAt: "2026-12-19T06:00:00.000Z",
    endsAt: "2026-12-20T01:00:00.000Z",
    amount: 75768,
    policy: { stages: [{ h: 192, pct: 0 }, { h: 0, pct: 100 }] },
  }) as WebReservation & { shared: { ownerDisplayName: string; role: string } };
  hers.shared = { ownerDisplayName: "母", role: "editor" };
  const mine = row({
    id: "MINE",
    service: "おにやまホテル",
    status: "confirmed",
    startsAt: "2026-12-19T06:30:00.000Z",
    endsAt: "2026-12-20T01:00:00.000Z",
    amount: 65472,
    policy: { stages: [{ h: 96, pct: 0 }, { h: 0, pct: 100 }] },
  });
  const out = presentList([mine, hers, row({ id: "DINNER" })], listFilterSchema.parse({}), NOW);
  assertEquals(out.overlaps, [{
    kind: "stay",
    // Neither says how many it is for, and no trip says how many go: one of them.
    mode: "choose",
    party: null,
    partyInferred: false,
    peopleTotal: null,
    shortBy: 0,
    from: "2026-12-19",
    to: "2026-12-20",
    // Hers closes first (8 days before): by then, dropping either is free.
    decideBy: "2026-12-11T23:59:59+09:00",
    reservations: [
      {
        id: "HERS",
        service: "ホテル白菊",
        status: "candidate",
        rank: null,
        people: null,
        amount: 75768,
        freeUntil: "2026-12-11T23:59:59+09:00",
        owner: "母",
      },
      {
        id: "MINE",
        service: "おにやまホテル",
        status: "confirmed",
        rank: null,
        people: null,
        amount: 65472,
        freeUntil: "2026-12-15T23:59:59+09:00",
        owner: null,
      },
    ],
  }]);
  // One stay and a dinner: nothing to weigh, so the key is absent.
  assertEquals(
    presentList([mine, row({ id: "DINNER" })], listFilterSchema.parse({}), NOW).overlaps,
    undefined,
  );
});

Deno.test("view: parking held for overlapping days is listed in overlaps as parking", () => {
  const haneda = row({
    id: "HND",
    service: "羽田空港 P2",
    kind: "parking",
    startsAt: "2026-12-19T00:00:00.000Z",
    endsAt: "2026-12-20T11:00:00.000Z",
    amount: 9000,
  });
  const near = row({
    id: "NEAR",
    service: "近くの民間駐車場",
    kind: "parking",
    startsAt: "2026-12-20T01:00:00.000Z",
    endsAt: "2026-12-21T11:00:00.000Z",
    amount: 6000,
  });
  const out = presentList([haneda, near], listFilterSchema.parse({}), NOW);
  assertEquals(out.overlaps?.map((o) => [o.kind, o.from, o.to, o.reservations.map((r) => r.id)]), [
    ["parking", "2026-12-19", "2026-12-21", ["HND", "NEAR"]],
  ]);
});

Deno.test("view: parking with no exit day says so in needsCheck", () => {
  const out = presentList(
    [
      row({
        id: "P",
        kind: "parking",
        startsAt: "2026-12-19T00:00:00.000Z",
        endsAt: null,
        amount: 9000,
      }),
      row({
        id: "Q",
        kind: "parking",
        startsAt: "2026-12-19T00:00:00.000Z",
        endsAt: "2026-12-20T11:00:00.000Z",
        amount: 9000,
      }),
    ],
    listFilterSchema.parse({}),
    NOW,
  );
  const by = Object.fromEntries(out.reservations.map((r) => [r.id, r]));
  assertEquals(by.P!.needsCheck.includes("出庫日が未入力"), true);
  assertEquals(by.Q!.needsCheck.includes("出庫日が未入力"), false);
});

Deno.test("view: the order of preference and an open proposal go out with the row", () => {
  const owner = presentReservation(
    row({
      rank: 1,
      suggestion: {
        action: "cancel",
        byUserId: "U2",
        byName: "@toriforiumu",
        at: "2026-11-13T01:00:00.000Z",
        notifiedAt: null,
      },
    }),
    NOW,
  );
  assertEquals(owner.rank, 1);
  assertEquals(owner.suggestion, {
    action: "cancel",
    by: "@toriforiumu",
    at: "2026-11-13T10:00:00+09:00",
  });
  assertEquals(owner.needsCheck.includes("@toriforiumu さんから取り消しの提案がある"), true);
  const plain = presentReservation(row(), NOW);
  assertEquals([plain.rank, plain.suggestion], [null, null]);
});

Deno.test("view: overlaps are read against the party — split, over, or choose", () => {
  const flight = (id: string, people: number | null, at = "2026-12-18T23:00:00.000Z") =>
    row({
      id,
      service: id,
      kind: "flight",
      trip: "別府",
      startsAt: at,
      endsAt: "2026-12-19T00:45:00.000Z",
      people,
    });
  const modeOf = (
    rows: WebReservation[],
    trips = [] as { name: string; people: number | null }[],
  ) => {
    const out = presentList(rows, listFilterSchema.parse({}), NOW, trips);
    return (out.overlaps ?? []).map((o) => [o.mode, o.party, o.partyInferred, o.peopleTotal]);
  };
  // Four go, two 2-seat flights at the same hours: both used.
  assertEquals(modeOf([flight("JAL", 2), flight("ANA", 2)], [{ name: "別府", people: 4 }]), [
    ["split", 4, false, 4],
  ]);
  // Two 4-seat flights for four: one is extra.
  assertEquals(modeOf([flight("JAL", 4), flight("ANA", 4)], [{ name: "別府", people: 4 }]), [
    ["over", 4, false, 8],
  ]);
  // The party worked out from the inn when the trip has no count.
  const inn = row({
    id: "INN",
    service: "宿",
    kind: "stay",
    trip: "別府",
    startsAt: "2026-12-19T06:00:00.000Z",
    endsAt: "2026-12-20T01:00:00.000Z",
    people: 4,
  });
  assertEquals(modeOf([flight("JAL", 2), flight("ANA", 2), inn]), [["split", 4, true, 4]]);
  // A booking that does not say how many: one of them, as before.
  assertEquals(modeOf([flight("JAL", 2), flight("ANA", null)]), [["choose", 2, true, null]]);
  // The same flight bought twice for two halves is not a duplicate.
  const same = [flight("JAL", 2), { ...flight("JAL", 2), id: "JAL2" }];
  assertEquals(
    presentList(same, listFilterSchema.parse({}), NOW, [{ name: "別府", people: 4 }])
      .possibleDuplicates,
    undefined,
  );
  assertEquals(
    presentList(same, listFilterSchema.parse({}), NOW, [{ name: "別府", people: 2 }])
      .possibleDuplicates?.length,
    1,
  );
  // Trips say how many go.
  const t = presentList([inn], listFilterSchema.parse({}), NOW).trips![0]!;
  assertEquals([t.people, t.peopleInferred], [4, true]);
});

Deno.test("view: a split that leaves people without seats says how many, and the same flight bought twice is one set", () => {
  const flight = (id: string, service: string, people: number, at = "2026-12-18T23:00:00.000Z") =>
    row({
      id,
      service,
      kind: "flight",
      trip: "別府",
      startsAt: at,
      endsAt: "2026-12-19T00:45:00.000Z",
      people,
    });
  const four = [{ name: "別府", people: 4 }];
  // 2 + 1 for four: split, one short.
  const short = presentList(
    [flight("A", "JAL661", 2), flight("B", "ANA795", 1, "2026-12-18T23:10:00.000Z")],
    listFilterSchema.parse({}),
    NOW,
    four,
  ).overlaps!;
  assertEquals(short.map((o) => [o.mode, o.peopleTotal, o.shortBy]), [["split", 3, 1]]);
  // The same flight bought twice, 2 + 2: one used set, not a duplicate.
  const same = presentList(
    [flight("A", "JAL661", 2), flight("B", "JAL661", 2)],
    listFilterSchema.parse({}),
    NOW,
    four,
  );
  assertEquals(same.possibleDuplicates, undefined);
  assertEquals(
    same.overlaps!.map((o) => [o.kind, o.mode, o.shortBy, o.reservations.map((r) => r.id)]),
    [["transport", "split", 0, ["A", "B"]]],
  );
});

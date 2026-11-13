/**
 * Pins the client copy of the 「同じ夜に重なる宿」 rule in web/index.html
 * (`function findOverlaps`) to src/web/overlap.ts. The page and the MCP list
 * must name the same groups: a clash the model reports and the screen does not
 * show (or the reverse) reads as a lost reservation. Same method as
 * policy_mirror_test.ts — the block is pure, so it is cut out of the HTML as
 * text and run with `new Function`.
 */
import { assertEquals } from "jsr:@std/assert@^1.0.19";
import {
  classifyAlternatives,
  classifyRide,
  findOverlaps,
  type OverlapRow,
  partySize,
} from "../overlap.ts";

const HTML_URL = new URL("../../../web/index.html", import.meta.url);
const DRIFT = "重なる宿の判定の二重実装がズレています: src/web/overlap.ts（サーバ・正）と " +
  "web/index.html の `function findOverlaps`。サーバ側を正として写しを合わせてください。";

/** Cuts the `function <anchor>…}` block out of the page and returns it as source. */
function block(html: string, anchor: string): string {
  const start = html.indexOf(anchor);
  if (start < 0) throw new Error(`${DRIFT}\nweb/index.html に \`${anchor}\` が見つかりません。`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${DRIFT}\n\`${anchor}\` の終わりが見つかりません。`);
}

function clientFindOverlaps(html: string): (rows: OverlapRow[]) => unknown {
  const anchor = "function findOverlaps(rows)";
  const start = html.indexOf(anchor);
  if (start < 0) throw new Error(`${DRIFT}\nweb/index.html に \`${anchor}\` が見つかりません。`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) {
      return new Function(`${html.slice(start, i + 1)}; return findOverlaps;`)();
    }
  }
  throw new Error(`${DRIFT}\n\`${anchor}\` の終わりが見つかりません。`);
}

const row = (o: Partial<OverlapRow> & { id: string }): OverlapRow => ({
  service: o.id,
  plan: null,
  startsAt: "2026-12-19T06:00:00.000Z",
  endsAt: "2026-12-20T01:00:00.000Z",
  status: "candidate",
  ...o,
});

const CASES: Record<string, OverlapRow[]> = {
  "two inns, one night": [row({ id: "B" }), row({ id: "A", status: "confirmed" })],
  "back to back": [
    row({ id: "A", startsAt: "2026-12-18T06:00:00.000Z", endsAt: "2026-12-19T01:00:00.000Z" }),
    row({ id: "B" }),
  ],
  "after midnight JST": [
    row({ id: "A", startsAt: "2026-12-19T15:30:00.000Z", endsAt: "2026-12-21T01:00:00.000Z" }),
    row({ id: "B", startsAt: "2026-12-20T06:00:00.000Z", endsAt: "2026-12-21T01:00:00.000Z" }),
  ],
  "chain of three": [
    row({ id: "A", startsAt: "2026-12-18T06:00:00.000Z", endsAt: "2026-12-20T01:00:00.000Z" }),
    row({ id: "B", startsAt: "2026-12-19T06:00:00.000Z", endsAt: "2026-12-21T01:00:00.000Z" }),
    row({ id: "C", startsAt: "2026-12-20T06:00:00.000Z", endsAt: "2026-12-22T01:00:00.000Z" }),
    row({ id: "D", startsAt: "2027-01-23T06:00:00.000Z", endsAt: "2027-01-24T01:00:00.000Z" }),
  ],
  "out of play": [
    row({ id: "A" }),
    row({ id: "B", status: "to_cancel" }),
    row({ id: "C", status: "cancelled" }),
    row({ id: "D", kind: "flight" }),
    row({ id: "E", endsAt: null }),
    row({ id: "F", startsAt: "こわれた日時" }),
  ],
  "kind says stay": [row({ id: "A" }), row({ id: "B", kind: "stay", endsAt: null })],
  "same plan": [row({ id: "A", plan: "別府の宿" }), row({ id: "B", plan: "別府の宿" })],
  "different plans": [row({ id: "A", plan: "別府の宿" }), row({ id: "B", plan: "母の案" })],
  "flight against train": [
    row({
      id: "A",
      kind: "flight",
      startsAt: "2026-12-18T23:00:00.000Z",
      endsAt: "2026-12-19T00:45:00.000Z",
    }),
    row({
      id: "B",
      kind: "train",
      startsAt: "2026-12-19T00:00:00.000Z",
      endsAt: "2026-12-19T02:00:00.000Z",
    }),
    row({ id: "C", kind: "bus", startsAt: "2026-12-19T02:00:00.000Z", endsAt: null }),
    row({
      id: "D",
      kind: "car",
      startsAt: "2026-12-18T23:30:00.000Z",
      endsAt: "2026-12-20T09:00:00.000Z",
    }),
    row({ id: "E" }),
  ],
  "rides without an arrival time": [
    row({ id: "A", kind: "flight", startsAt: "2026-12-18T23:00:00.000Z", endsAt: null }),
    row({
      id: "B",
      kind: "train",
      startsAt: "2026-12-18T23:59:00.000Z",
      endsAt: "2026-12-18T15:00:00.000Z",
    }),
    row({ id: "C", kind: "bus", startsAt: "2026-12-19T01:00:00.000Z", endsAt: null }),
    row({
      id: "D",
      kind: "bus",
      startsAt: "2026-12-18T15:00:00.000Z",
      endsAt: null,
      timeTentative: true,
    }),
  ],
  "same name": [row({ id: "A", service: "ホテル　白菊" }), row({ id: "B", service: "ホテル白菊" })],
  "parking overlapping on one day": [
    row({
      id: "A",
      kind: "parking",
      startsAt: "2026-12-18T23:00:00.000Z",
      endsAt: "2026-12-20T11:00:00.000Z",
    }),
    row({
      id: "B",
      kind: "parking",
      startsAt: "2026-12-19T22:00:00.000Z",
      endsAt: "2026-12-21T12:00:00.000Z",
    }),
    row({ id: "C", kind: "stay" }),
    row({ id: "D", kind: "flight", startsAt: "2026-12-19T01:00:00.000Z", endsAt: null }),
  ],
  "parking days apart, no exit, and one plan": [
    row({ id: "A", kind: "parking", startsAt: "2026-12-18T23:00:00.000Z", endsAt: null }),
    row({ id: "B", kind: "parking", startsAt: "2026-12-20T23:00:00.000Z", endsAt: null }),
    row({
      id: "C",
      kind: "parking",
      plan: "P",
      startsAt: "2026-12-22T01:00:00.000Z",
      endsAt: "2026-12-23T01:00:00.000Z",
    }),
    row({
      id: "D",
      kind: "parking",
      plan: "P",
      startsAt: "2026-12-22T02:00:00.000Z",
      endsAt: "2026-12-23T02:00:00.000Z",
    }),
    row({
      id: "E",
      kind: "parking",
      startsAt: "2026-12-26T01:00:00.000Z",
      endsAt: "2026-12-25T01:00:00.000Z",
    }),
    row({ id: "F", kind: "parking", startsAt: "2026-12-26T02:00:00.000Z", endsAt: null }),
  ],
};

Deno.test("mirror: the page names the same overlapping stays as the server", async () => {
  const client = clientFindOverlaps(await Deno.readTextFile(HTML_URL));
  for (const [name, rows] of Object.entries(CASES)) {
    assertEquals(client(rows), findOverlaps(rows), `${DRIFT}\nケース: ${name}`);
  }
  // Not vacuous: the table does contain clashes, and of more than one shape.
  assertEquals(findOverlaps(CASES["two inns, one night"]!).length, 1);
  assertEquals(findOverlaps(CASES["chain of three"]!)[0]?.ids, ["A", "B", "C"]);
  assertEquals(findOverlaps(CASES["back to back"]!), []);
  assertEquals(findOverlaps(CASES["flight against train"]!).map((g) => [g.kind, g.ids]), [
    ["transport", ["A", "B"]],
  ]);
  assertEquals(findOverlaps(CASES["rides without an arrival time"]!)[0]?.ids, ["A", "B"]);
  assertEquals(findOverlaps(CASES["parking overlapping on one day"]!), [
    { kind: "parking", from: "2026-12-19", to: "2026-12-21", ids: ["A", "B"] },
  ]);
  assertEquals(
    findOverlaps(CASES["parking days apart, no exit, and one plan"]!).map((g) => g.ids),
    [["E", "F"]],
  );
});

Deno.test("mirror: the page reads a party the way the server does", async () => {
  const html = await Deno.readTextFile(HTML_URL);
  const client = new Function(
    `${block(html, "function partySize(explicit, tripRows)")}
     ${block(html, "function classifyAlternatives(live, party)")}
     ${block(html, "function classifyRide(live, party)")}
     return { partySize, classifyAlternatives, classifyRide };`,
  )() as {
    partySize: typeof partySize;
    classifyAlternatives: typeof classifyAlternatives;
    classifyRide: typeof classifyRide;
  };
  const live = (id: string, people: number | null, status = "confirmed") => ({
    id,
    status,
    people,
  });
  const seat = (id: string, service: string, people: number, startsAt: string) => ({
    id,
    status: "confirmed",
    people,
    service,
    startsAt,
  });
  const trips = [
    [null, [
      seat("A", "JAL665", 2, "2026-12-19T03:05:00.000Z"),
      seat("B", "JAL 665", 2, "2026-12-19T03:05:00.000Z"),
    ]],
    [null, [
      seat("A", "JAL665", 2, "2026-12-19T15:30:00.000Z"),
      seat("B", "JAL665", 2, "2026-12-19T03:05:00.000Z"),
    ]],
    [4, [live("A", 2)]],
    [null, [live("INN", 4), live("F1", 2), live("X", 6, "to_cancel")]],
    [undefined, [live("A", null)]],
    [null, []],
  ] as const;
  for (const [explicit, rows] of trips) {
    assertEquals(client.partySize(explicit, [...rows]), partySize(explicit, [...rows]), DRIFT);
  }
  const groups: [ReturnType<typeof live>[], number | null][] = [
    [[live("JAL", 2), live("ANA", 2)], 4],
    [[live("JAL", 4), live("ANA", 4)], 4],
    [[live("JAL", 2), live("ANA", null)], 4],
    [[live("JAL", 2), live("ANA", 2)], null],
    [[live("JAL", 3), live("ANA", 1)], 4],
    [[], 4],
  ];
  for (const [g, party] of groups) {
    assertEquals(client.classifyAlternatives(g, party), classifyAlternatives(g, party), DRIFT);
    assertEquals(client.classifyRide(g, party), classifyRide(g, party), DRIFT);
  }
  const booked = (id: string, people: number | null, ref: string | null) => ({
    id,
    status: "confirmed",
    people,
    ref,
  });
  const rides: [ReturnType<typeof booked>[], number | null][] = [
    [[booked("A", 2, "ABC"), booked("B", 2, "DEF")], null],
    [[booked("A", 2, "ABC"), booked("B", 2, "abc")], null],
    [[booked("A", 2, "ABC"), booked("B", 2, " A B C ")], 4],
    [[booked("A", 2, null), booked("B", null, null)], null],
    [[booked("A", 4, ""), booked("B", 4, "")], 4],
  ];
  for (const [g, party] of rides) {
    assertEquals(client.classifyRide(g, party), classifyRide(g, party), DRIFT);
  }
});

/**
 * Pins the client copy of the 「同じ夜に重なる宿」 rule in web/index.html
 * (`function findOverlaps`) to src/web/overlap.ts. The page and the MCP list
 * must name the same groups: a clash the model reports and the screen does not
 * show (or the reverse) reads as a lost reservation. Same method as
 * policy_mirror_test.ts — the block is pure, so it is cut out of the HTML as
 * text and run with `new Function`.
 */
import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { findOverlaps, type OverlapRow } from "../overlap.ts";

const HTML_URL = new URL("../../../web/index.html", import.meta.url);
const DRIFT = "重なる宿の判定の二重実装がズレています: src/web/overlap.ts（サーバ・正）と " +
  "web/index.html の `function findOverlaps`。サーバ側を正として写しを合わせてください。";

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
});

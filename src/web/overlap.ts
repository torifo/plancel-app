/**
 * Stays that cover the same night: two different inns held for one evening,
 * where the family will take one of them (owner 2026-11-12: 「おにやまホテルと
 * 白菊が日付ブッキングしててどっちかを取るって比較をするのが理想」 — one was
 * the owner's, the other his mother's, shared with him).
 *
 * Nothing is stored. The groups are worked out from the rows each time, the
 * caller's own and those shared with them alike, and they only inform: a
 * family may hold two inns on purpose, so nothing here blocks a write.
 *
 * Mirrored as plain JS in web/index.html (`findOverlaps`); the pair is pinned
 * by src/web/tests/overlap_mirror_test.ts.
 */
import { toInstantOrNull } from "./instant.ts";

export interface OverlapRow {
  id: string;
  service: string;
  plan: string | null;
  startsAt: string;
  endsAt: string | null;
  status: string;
  kind?: string | null;
}

export interface OverlapGroup {
  /** First night, as a JST date (YYYY-MM-DD). */
  from: string;
  /** The morning the last one ends, as a JST date. */
  to: string;
  /** The stays in it, earliest first night first (then by id). */
  ids: string[];
}

const DAY_MS = 86_400_000;
const JST_MS = 9 * 3_600_000;
const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const dayOf = (ms: number): number => Math.floor((ms + JST_MS) / DAY_MS);
const dateOf = (day: number): string =>
  Temporal.Instant.fromEpochMilliseconds(day * DAY_MS).toString().slice(0, 10);

/**
 * The nights a row covers, as JST day numbers [first, end) — or null when it
 * is not a stay. A row with no kind counts as a stay when it ends on a later
 * day (how every inn was entered before kinds existed).
 */
export function nightsOf(r: OverlapRow): [number, number] | null {
  const start = toInstantOrNull(r.startsAt)?.epochMilliseconds;
  if (start === undefined) return null;
  const end = r.endsAt === null ? undefined : toInstantOrNull(r.endsAt)?.epochMilliseconds;
  const first = dayOf(start);
  const last = end === undefined ? first : dayOf(end);
  const kind = r.kind ?? null;
  if (kind !== null && kind !== "stay") return null;
  if (kind === null && last <= first) return null;
  return [first, Math.max(last, first + 1)];
}

export function findOverlaps(rows: OverlapRow[]): OverlapGroup[] {
  const stays = rows.flatMap((r) => {
    if (r.status !== "candidate" && r.status !== "confirmed") return [];
    const n = nightsOf(r);
    return n === null ? [] : [{ r, a: n[0], b: n[1] }];
  }).sort((x, y) => x.a - y.a || x.r.id.localeCompare(y.r.id));
  // Union-find over the pairs that share a night. Two rows of one plan are
  // already a 「どれか1つに」 card, and the same name on the same day is the
  // same booking entered twice (the merge note) — neither is a clash to weigh.
  const parent = stays.map((_, i) => i);
  const root = (i: number): number => parent[i] === i ? i : (parent[i] = root(parent[i]!));
  for (let i = 0; i < stays.length; i++) {
    for (let j = i + 1; j < stays.length; j++) {
      const x = stays[i]!, y = stays[j]!;
      if (y.a >= x.b || x.a >= y.b) continue;
      if (x.r.plan !== null && x.r.plan === y.r.plan) continue;
      if (x.a === y.a && fold(x.r.service) === fold(y.r.service)) continue;
      parent[root(j)] = root(i);
    }
  }
  const groups = new Map<number, typeof stays>();
  stays.forEach((s, i) => {
    const k = root(i);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  });
  return [...groups.values()].filter((g) => g.length > 1).map((g) => ({
    from: dateOf(Math.min(...g.map((s) => s.a))),
    to: dateOf(Math.max(...g.map((s) => s.b))),
    ids: g.map((s) => s.r.id),
  }));
}

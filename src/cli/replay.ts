/**
 * `deno task replay` — CI-able regression gate over the parse replay
 * fixture corpus (SDD §10.4, Task 5.2). Loads every `*.json` fixture in
 * `fixtures/parse/`, replays each through the CURRENT parser chain
 * (`parsers.config.json`) via `replayAll`, prints a per-fixture
 * identical/changed report, and exits non-zero when any fixture diverged
 * from its recorded expectation — so a prompt/chain/validation change that
 * silently alters real-data outcomes fails CI instead of shipping quietly.
 */
import { loadParserChainConfig, replayAll } from "../parse/mod.ts";
import type { ReplayFixture } from "../parse/mod.ts";
import { SystemClock } from "../core/clock/mod.ts";
import { ulid } from "../lib/ulid.ts";

const DEFAULT_FIXTURES_DIR = new URL("../../fixtures/parse/", import.meta.url);

/** Reads and parses every `*.json` file in `dir` as a `ReplayFixture`. */
export async function loadFixtures(
  dir: string | URL = DEFAULT_FIXTURES_DIR,
): Promise<ReplayFixture[]> {
  const fixtures: ReplayFixture[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const path = new URL(entry.name, dir);
    const text = await Deno.readTextFile(path);
    fixtures.push(JSON.parse(text) as ReplayFixture);
  }
  fixtures.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return fixtures;
}

/** Runs the fixture regression corpus and returns `replayAll`'s summary. */
export async function runReplayCli(dir: string | URL = DEFAULT_FIXTURES_DIR) {
  const fixtures = await loadFixtures(dir);
  const config = await loadParserChainConfig();
  const clock = new SystemClock();
  const ids = { ulid, nowIso: () => clock.now().toString({ smallestUnit: "millisecond" }) };
  return await replayAll(fixtures, config, clock, ids);
}

if (import.meta.main) {
  const result = await runReplayCli();
  console.log(result.report);
  Deno.exit(result.changed > 0 ? 1 : 0);
}

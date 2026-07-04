/**
 * seed — `deno task seed [--db <path>] [--base <iso-instant>] [--force] [--dry-run]`
 * (Task 4.2, SDD §10.5: "初期状態を1コマンドで再現").
 *
 * Loads `fixtures/seed.json` (a typical Event/Plan/Reservation scenario:
 * staged cancellation policies, an unknown-policy mix, and a standalone
 * confirmed reservation — see that file's own doc comment), shifts every
 * datetime relative to `--base`, and persists the result through the domain
 * layer (`src/cli/seed_lib.ts`).
 *
 *   --db <path>   KvStore path, passed straight to `Deno.openKv` (default:
 *                 Deno's own default KV database).
 *   --base <iso>  Anchor instant the fixture is shifted onto. Default:
 *                 `DEFAULT_SEED_BASE` (fixtures/seed.json's own documented
 *                 base — no shift). Deliberately NOT "now": a fixed instant
 *                 keeps `deno task seed` reproducible (FR-008).
 *   --force       Seed even if the store already holds data (not a merge:
 *                 fixture ids are freshly minted, so this adds a second
 *                 copy of the scenario rather than overwriting anything).
 *   --dry-run     Materialize + validate only, print a summary, write
 *                 nothing (uses an ephemeral InMemoryStore, never opens the
 *                 real KV database).
 */
import { InMemoryStore, KvStore } from "../core/store/mod.ts";
import { VirtualClock } from "../core/clock/mod.ts";
import type { Store } from "../core/store/mod.ts";
import { ulid } from "../lib/ulid.ts";
import {
  DEFAULT_SEED_BASE,
  materializeFixtures,
  persistEntities,
  readFixtureFile,
  storeIsEmpty,
} from "./seed_lib.ts";

interface CliOptions {
  db?: string;
  base: string;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = { base: DEFAULT_SEED_BASE, force: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--db": {
        const value = args[++i];
        if (value !== undefined) opts.db = value;
        break;
      }
      case "--base":
        opts.base = args[++i] ?? opts.base;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        throw new Error(
          `seed: unknown argument "${arg}" (expected --db, --base, --force, --dry-run)`,
        );
    }
  }
  return opts;
}

/** Runs the seed against an already-open store (exported for scenario.ts / tests). */
export async function seedStore(
  store: Store,
  base: string,
  opts: { force?: boolean } = {},
): Promise<{ events: number; plans: number; reservations: number }> {
  if (!opts.force && !(await storeIsEmpty(store))) {
    throw new Error(
      "seed: store already has data; pass --force to seed anyway " +
        "(this adds a second copy rather than merging).",
    );
  }
  const fixture = await readFixtureFile();
  const clock = new VirtualClock(base);
  const ids = { newUlid: () => ulid() };
  const entities = materializeFixtures(fixture, base, ids);
  await persistEntities(store, clock, ids, entities);
  return {
    events: entities.events.length,
    plans: entities.plans.length,
    reservations: entities.reservations.length,
  };
}

async function main(opts: CliOptions): Promise<void> {
  if (opts.dryRun) {
    const store = new InMemoryStore();
    const fixture = await readFixtureFile();
    const ids = { newUlid: () => ulid() };
    const entities = materializeFixtures(fixture, opts.base, ids);
    console.log(
      `seed --dry-run: base=${opts.base} events=${entities.events.length} ` +
        `plans=${entities.plans.length} reservations=${entities.reservations.length}`,
    );
    for (const r of entities.reservations) {
      const policy = r.cancellation_policy === "unknown" ? "unknown" : "staged";
      console.log(
        `  - [${r.status}] ${r.service_name} starts_at=${r.starts_at} ` +
          `amount=${r.amount_jpy ?? "?"} policy=${policy}`,
      );
    }
    await store.close();
    return;
  }

  const store = await KvStore.open(opts.db);
  try {
    const summary = await seedStore(store, opts.base, { force: opts.force });
    console.log(
      `seed: base=${opts.base} events=${summary.events} plans=${summary.plans} ` +
        `reservations=${summary.reservations} — done.`,
    );
  } finally {
    await store.close();
  }
}

if (import.meta.main) {
  try {
    await main(parseArgs(Deno.args));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}

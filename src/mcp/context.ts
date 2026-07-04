/**
 * ToolContext — the injected dependencies every MCP tool handler needs
 * (Task 3.3, L2b).
 *
 * All non-determinism is injected so handlers stay deterministic and testable:
 *   - `store`: persistence port (InMemoryStore in tests, KvStore in prod).
 *   - `clock`: current instant (VirtualClock in tests, SystemClock in prod).
 *   - `ids.newUlid`: fresh ULID source (sequential ids in tests).
 *
 * Tool handlers accept a `ToolContext` explicitly (never reach for globals), so
 * tests pass an InMemoryStore + a fixed VirtualClock without a live transport.
 */
import type { Clock } from "../core/clock/mod.ts";
import { SystemClock } from "../core/clock/mod.ts";
import type { Store } from "../core/store/mod.ts";
import { KvStore } from "../core/store/mod.ts";
import { ulid } from "../lib/ulid.ts";

/** Injected id source. `newUlid()` returns a fresh ULID string per call. */
export interface IdSource {
  newUlid(): string;
}

/** Everything a tool handler needs, all injectable for deterministic tests. */
export interface ToolContext {
  store: Store;
  clock: Clock;
  ids: IdSource;
}

/**
 * Builds the production context: a real KvStore + SystemClock + ULID generator.
 * Used by `main.ts` (the `deno run` entrypoint). Tests build their own context
 * from an InMemoryStore + VirtualClock instead of calling this.
 */
export async function createDefaultContext(kvPath?: string): Promise<ToolContext> {
  const store = await KvStore.open(kvPath);
  return {
    store,
    clock: new SystemClock(),
    ids: { newUlid: () => ulid() },
  };
}

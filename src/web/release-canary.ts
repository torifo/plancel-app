/**
 * The release canary (owner 2026-11-13: 「本番と全く同じデータで公開一歩手前の
 * 検証」). A push to the `canary` branch deploys to its own timeline and
 * database; the workflow copies production's data into that database so the
 * new code can be looked at, and smoke-tested, on real records before it goes
 * to production. It is an extra road, not a gate: a push to `main` still goes
 * straight to production (owner: 「必ず canary を通る設計にはしない」).
 *
 * The copied data holds real people: their LINE ids, addresses and Google
 * tokens. A canary must therefore never reach anyone. The copy writes a marker
 * into the canary database BEFORE any data, and while the marker is present
 * the app sends nothing out — no cron (deadline / proposal notices, calendar
 * sweeps, provider checks), no calendar sync on write, no login mail, no
 * fault push. Production's database never holds the marker: the copy refuses
 * to run if its source does.
 */

/** Present only in a canary database. */
export const RELEASE_CANARY_KEY: Deno.KvKey = ["meta", "release_canary"];

export interface ReleaseCanaryMark {
  copiedAt: string;
  /** Where the data came from, for whoever reads the canary database. */
  source: string;
}

/**
 * Whether this deployment's database is a canary copy. Read at most every
 * `ttlMs` (default 30s): a sweep or a write asks on every call, and the
 * answer only changes when a copy runs.
 */
export function releaseCanaryGate(
  kv: Deno.Kv,
  nowMs: () => number,
  ttlMs = 30_000,
): () => Promise<boolean> {
  let cached: { at: number; on: boolean } | null = null;
  return async () => {
    const now = nowMs();
    if (cached !== null && now - cached.at < ttlMs) return cached.on;
    // A failed read counts as "canary": sending nothing is the safe side.
    let on = true;
    try {
      on = (await kv.get(RELEASE_CANARY_KEY)).value !== null;
    } catch {
      on = true;
    }
    cached = { at: now, on };
    return on;
  };
}

const sameKey = (a: Deno.KvKey, b: Deno.KvKey) =>
  a.length === b.length && a.every((part, i) => part === b[i]);

/**
 * Copies every key of `source` into `target`, replacing what `target` held.
 * The marker goes into `target` first, so a canary that ticks mid-copy
 * already sends nothing. `source` is only listed, never written. Returns the
 * number of entries copied.
 */
export async function copyIntoCanary(
  source: Deno.Kv,
  target: Deno.Kv,
  mark: ReleaseCanaryMark,
  batch = 100,
): Promise<number> {
  if ((await source.get(RELEASE_CANARY_KEY)).value !== null) {
    throw new Error(
      "the source database is itself a canary copy — refusing (are the ids swapped?)",
    );
  }
  await target.set(RELEASE_CANARY_KEY, mark);

  const flush = async (ops: ((tx: Deno.AtomicOperation) => Deno.AtomicOperation)[]) => {
    if (ops.length === 0) return;
    let tx = target.atomic();
    for (const op of ops) tx = op(tx);
    const done = await tx.commit();
    if (!done.ok) throw new Error("canary write was rejected");
  };

  let ops: ((tx: Deno.AtomicOperation) => Deno.AtomicOperation)[] = [];
  for await (const e of target.list({ prefix: [] })) {
    if (sameKey(e.key, RELEASE_CANARY_KEY)) continue;
    const k = e.key;
    ops.push((tx) => tx.delete(k));
    if (ops.length >= batch) {
      await flush(ops);
      ops = [];
    }
  }
  await flush(ops);
  ops = [];

  let copied = 0;
  for await (const e of source.list({ prefix: [] })) {
    if (sameKey(e.key, RELEASE_CANARY_KEY)) continue;
    const k = e.key;
    const v = e.value;
    ops.push((tx) => tx.set(k, v));
    copied++;
    if (ops.length >= batch) {
      await flush(ops);
      ops = [];
    }
  }
  await flush(ops);
  return copied;
}

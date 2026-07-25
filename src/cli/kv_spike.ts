/**
 * `deno task kv:spike` — ADR-2 connectivity spike: can a LOCAL process reach
 * the Deno Deploy managed KV (KV Connect) the deployed app uses?
 *
 * ADR-2 names this "the first task of deploy": if a local MCP/CLI can write to
 * the same KV that Deploy reads, the local Claude-MCP entry point stays usable
 * post-deploy. If it CANNOT, the fallback is a thin write-only HTTP layer on
 * Deploy, or the VPS + SQLite escape route — decided by this measurement.
 *
 * Usage:
 *   export DENO_KV_ACCESS_TOKEN=<Deno Deploy access token>
 *   deno task kv:spike "https://api.deno.com/databases/<database-id>/connect"
 *
 * Does a harmless round-trip on a dedicated `__kv_spike__` key (set → get →
 * delete) so it never touches real plancel data, and reports latency. Exits
 * non-zero on any failure so it is CI/checklist-usable.
 */
function usage(): never {
  console.error('usage: deno task kv:spike "<kv-connect-url>"  (needs DENO_KV_ACCESS_TOKEN)');
  Deno.exit(2);
}

if (import.meta.main) {
  const url = Deno.args[0] ?? Deno.env.get("KV_CONNECT_URL");
  if (url === undefined || url === "") usage();
  if ((Deno.env.get("DENO_KV_ACCESS_TOKEN") ?? "") === "") {
    console.error("error: DENO_KV_ACCESS_TOKEN is not set — KV Connect requires it.");
    Deno.exit(2);
  }

  const marker = ["__kv_spike__", "probe"] as const;
  const started = performance.now();
  let kv: Deno.Kv;
  try {
    kv = await Deno.openKv(url);
  } catch (err) {
    console.error(
      `FAIL: could not open KV at ${url}\n  ${err instanceof Error ? err.message : err}`,
    );
    Deno.exit(1);
  }

  try {
    const token = `probe-${performance.now()}`;
    await kv.set(marker, token);
    const read = await kv.get<string>(marker);
    await kv.delete(marker);
    const ms = Math.round(performance.now() - started);

    if (read.value !== token) {
      console.error(`FAIL: round-trip mismatch (wrote "${token}", read "${read.value}")`);
      Deno.exit(1);
    }
    console.log(`OK: KV Connect round-trip succeeded in ${ms}ms`);
    console.log(
      `  → local writes reach the Deploy KV; the local MCP entry point stays usable post-deploy.`,
    );
  } catch (err) {
    console.error(`FAIL: round-trip errored\n  ${err instanceof Error ? err.message : err}`);
    console.error("  → fallback (ADR-2): a write-only HTTP layer on Deploy, or VPS + SQLite.");
    Deno.exit(1);
  } finally {
    kv.close();
  }
}

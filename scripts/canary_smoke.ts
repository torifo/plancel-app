/**
 * Runs the checked-out code over the canary database (after canary_copy.ts):
 * every user's ledger list, the MCP view and both notification sweeps, with
 * nothing sent. Exits 1 on any failure. Prints counts and user ids only.
 *
 *   DENO_KV_ACCESS_TOKEN, PLANCEL_CANARY_DB_ID   as for canary_copy.ts
 */
import { smokeCanary } from "../src/web/release-canary-smoke.ts";

const token = Deno.env.get("DENO_KV_ACCESS_TOKEN")?.trim();
const canaryId = Deno.env.get("PLANCEL_CANARY_DB_ID")?.trim();
if (!token || !canaryId) {
  console.error("DENO_KV_ACCESS_TOKEN and PLANCEL_CANARY_DB_ID must be set");
  Deno.exit(2);
}
const kv = await Deno.openKv(`https://api.deno.com/v2/databases/${canaryId}/connect`);
try {
  const r = await smokeCanary(kv, Temporal.Now.instant().epochMilliseconds);
  console.log(`smoke: ${r.users} users, ${r.rows} rows, ${r.failures.length} failures`);
  for (const f of r.failures) console.log(`  FAIL ${f.step} user=${f.userId}: ${f.error}`);
  if (r.failures.length > 0) Deno.exit(1);
} finally {
  kv.close();
}

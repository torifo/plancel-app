/**
 * Copies production's KV database into the canary database
 * (src/web/release-canary.ts). Run by .github/workflows/canary.yml.
 *
 *   DENO_KV_ACCESS_TOKEN   organization access token (Deno Deploy org settings)
 *   PLANCEL_PROD_DB_ID     the Production timeline's database id
 *   PLANCEL_CANARY_DB_ID   the `canary` branch timeline's database id
 *
 * Production is only listed, never written; the canary marker is written into
 * the canary database before anything else. Prints counts, never values.
 */
import { copyIntoCanary } from "../src/web/release-canary.ts";

const need = (name: string): string => {
  const v = Deno.env.get(name)?.trim();
  if (!v) {
    console.error(`${name} is not set`);
    Deno.exit(2);
  }
  return v;
};
need("DENO_KV_ACCESS_TOKEN");
const prodId = need("PLANCEL_PROD_DB_ID");
const canaryId = need("PLANCEL_CANARY_DB_ID");
if (prodId === canaryId) {
  console.error("PLANCEL_PROD_DB_ID and PLANCEL_CANARY_DB_ID are the same — refusing");
  Deno.exit(2);
}
const connect = (id: string) => Deno.openKv(`https://api.deno.com/v2/databases/${id}/connect`);
const prod = await connect(prodId);
const canary = await connect(canaryId);
try {
  const copiedAt = Temporal.Now.instant().toString();
  const n = await copyIntoCanary(prod, canary, { copiedAt, source: "production" });
  console.log(`copied ${n} entries from production into the canary database at ${copiedAt}`);
} finally {
  prod.close();
  canary.close();
}

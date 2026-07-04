import { KvStore } from "../kv-store.ts";
import type { Store } from "../store.ts";
import { runStoreContractTests } from "./contract.ts";

/**
 * Each contract test call gets its own temp-file-backed Deno KV database, so
 * tests never see each other's data regardless of execution order. The
 * temp file (and its `-wal`/`-shm` siblings, if any) is removed once the
 * store closes.
 */
async function kvStoreFactory(): Promise<Store> {
  const path = await Deno.makeTempFile({ prefix: "plancel-store-test-", suffix: ".kv" });
  const kv = await KvStore.open(path);
  return {
    getEvent: kv.getEvent.bind(kv),
    putEvent: kv.putEvent.bind(kv),
    listEventEntities: kv.listEventEntities.bind(kv),
    getPlan: kv.getPlan.bind(kv),
    putPlan: kv.putPlan.bind(kv),
    listPlans: kv.listPlans.bind(kv),
    getReservation: kv.getReservation.bind(kv),
    putReservation: kv.putReservation.bind(kv),
    listReservations: kv.listReservations.bind(kv),
    listReservationsByPlan: kv.listReservationsByPlan.bind(kv),
    listPendingCancellations: kv.listPendingCancellations.bind(kv),
    getPolicyTemplate: kv.getPolicyTemplate.bind(kv),
    putPolicyTemplate: kv.putPolicyTemplate.bind(kv),
    listPolicyTemplates: kv.listPolicyTemplates.bind(kv),
    getParseJob: kv.getParseJob.bind(kv),
    putParseJob: kv.putParseJob.bind(kv),
    listParseJobs: kv.listParseJobs.bind(kv),
    appendEvent: kv.appendEvent.bind(kv),
    listEvents: kv.listEvents.bind(kv),
    getOutboxEntry: kv.getOutboxEntry.bind(kv),
    putOutboxEntry: kv.putOutboxEntry.bind(kv),
    listOutboxEntries: kv.listOutboxEntries.bind(kv),
    close: async () => {
      await kv.close();
      try {
        await Deno.remove(path);
      } catch {
        // best-effort cleanup; ignore if already gone.
      }
    },
  };
}

runStoreContractTests("KvStore", kvStoreFactory);

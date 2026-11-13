/**
 * What the ledger knows about a trip beyond its reservations: how many people
 * go (owner 2026-11-13: 「4人でいって２人ずつしか買えないこともある」). A trip
 * is only a name on reservations (store.ts `trip`), so this lives beside them,
 * keyed by the name folded the way the rest of the app matches names. Each
 * ledger keeps its own; a member sees the trip as their own ledger sets it.
 */
import { z } from "zod";

const NS = "web";
const TRIP = "trip";
export const foldTrip = (name: string): string =>
  name.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
const key = (ledger: string, name: string): Deno.KvKey => [NS, ledger, TRIP, foldTrip(name)];

export const tripMetaSchema = z.object({
  name: z.string(),
  /** How many people go; null = not set. */
  people: z.number().int().min(1).max(99).nullable(),
  updated_at: z.string(),
});
export type TripMeta = z.infer<typeof tripMetaSchema>;

export async function listTrips(kv: Deno.Kv, ledger: string): Promise<TripMeta[]> {
  const out: TripMeta[] = [];
  for await (const e of kv.list({ prefix: [NS, ledger, TRIP] })) {
    const parsed = tripMetaSchema.safeParse(e.value);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Sets (or, with null, clears) how many people go on `name`. */
export async function setTripPeople(
  kv: Deno.Kv,
  ledger: string,
  name: string,
  people: number | null,
  nowIso: string,
): Promise<TripMeta | null> {
  if (people === null) {
    await kv.delete(key(ledger, name));
    return null;
  }
  const meta: TripMeta = { name, people, updated_at: nowIso };
  await kv.set(key(ledger, name), meta);
  return meta;
}

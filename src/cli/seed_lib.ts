/**
 * Shared fixture-loading + persistence logic for `src/cli/seed.ts` and
 * `src/cli/scenario.ts` (Task 4.2, SDD §10.5).
 *
 * `fixtures/seed.json` fixes a documented "base" instant and stores every
 * datetime literally relative to it (JSON has no notion of relative time).
 * `materializeFixtures` shifts every datetime in the fixture by the delta
 * between the fixture's documented `base` and the caller's requested target
 * base, so the same static file replays anchored to any instant while
 * preserving the relative gaps the scenario depends on (e.g. "3 days after
 * base crosses a fee boundary" — see fixtures/seed.json's own comment).
 *
 * Reservation creation always goes through the domain `createReservation`
 * transition (SDD §10.2: never hand-rolled outside the domain layer) so the
 * event log carries a `reservation.created` event for every seeded
 * reservation, matching how the MCP tools create reservations
 * (`src/mcp/tools/shared.ts` `persistNewReservation`). Events/Plans have no
 * domain lifecycle of their own (see `create_event.ts`/`create_plan.ts`) so
 * they are simple `store.put*` upserts.
 */
import { z } from "zod";
import type { Clock } from "../core/clock/mod.ts";
import type { Store } from "../core/store/mod.ts";
import {
  cancellationPolicyOrUnknownSchema,
  dateRangeSchema,
  type Event,
  eventSchema,
  isoDateTimeSchema,
  type Plan,
  planSchema,
  type Reservation,
  reservationSchema,
  reservationStatusSchema,
} from "../core/schema/mod.ts";
import { createReservation } from "../core/domain/mod.ts";
import { append } from "../core/eventlog/mod.ts";

/** Default scenario anchor: a fixed instant, never system "now" (FR-008). */
export const DEFAULT_SEED_BASE = "2026-07-10T00:00:00Z";

/** Injected ULID source, matching `src/mcp/context.ts`'s `IdSource` shape. */
export interface IdSource {
  newUlid(): string;
}

const fixtureEventSchema = z.object({
  key: z.string(),
  title: z.string(),
  date_range: dateRangeSchema.default(null),
  notes: z.string().nullable().default(null),
});

const fixturePlanSchema = z.object({
  key: z.string(),
  event_key: z.string().nullable().default(null),
  title: z.string(),
  date_range: dateRangeSchema.default(null),
  confirm_quota: z.number().int().min(1).default(1),
});

const fixtureReservationSchema = z.object({
  key: z.string(),
  plan_key: z.string().nullable().default(null),
  event_key: z.string().nullable().default(null),
  service_name: z.string(),
  provider: z.string().nullable().default(null),
  starts_at: isoDateTimeSchema,
  ends_at: isoDateTimeSchema.nullable().default(null),
  location: z.string().nullable().default(null),
  amount_jpy: z.number().nullable().default(null),
  status: reservationStatusSchema.default("candidate"),
  cancellation_policy: cancellationPolicyOrUnknownSchema.default("unknown"),
  source: z.enum(["mcp", "line", "manual"]).default("manual"),
  notes: z.string().nullable().default(null),
});

const fixtureFileSchema = z.object({
  base: isoDateTimeSchema,
  events: z.array(fixtureEventSchema).default([]),
  plans: z.array(fixturePlanSchema).default([]),
  reservations: z.array(fixtureReservationSchema).default([]),
});

export type FixtureFile = z.infer<typeof fixtureFileSchema>;

/** Resolves fixtures/seed.json relative to this module, independent of cwd. */
const DEFAULT_FIXTURE_URL = new URL("../../fixtures/seed.json", import.meta.url);

/** Loads + schema-validates a fixture file (default: fixtures/seed.json). */
export async function readFixtureFile(path?: string): Promise<FixtureFile> {
  const text = path === undefined
    ? await Deno.readTextFile(DEFAULT_FIXTURE_URL)
    : await Deno.readTextFile(path);
  return fixtureFileSchema.parse(JSON.parse(text));
}

/** Whole-day shift for date-only (YYYY-MM-DD) fields, derived from the instant delta. */
function shiftDateRange(
  range: { start: string; end: string } | null,
  deltaMs: number,
): { start: string; end: string } | null {
  if (range === null) return null;
  const days = Math.round(deltaMs / 86_400_000);
  const shift = (d: string) => Temporal.PlainDate.from(d).add({ days }).toString();
  return { start: shift(range.start), end: shift(range.end) };
}

function shiftInstant(iso: string, deltaMs: number): string {
  return Temporal.Instant.from(iso)
    .add({ milliseconds: deltaMs })
    .toString({ smallestUnit: "millisecond" });
}

export interface SeededEntities {
  events: Event[];
  plans: Plan[];
  reservations: Reservation[];
  /** Fixture-local `key` -> minted ULID, for callers that need to look one up. */
  idsByKey: Map<string, string>;
}

/**
 * Builds fully-validated Event/Plan/Reservation entities from a fixture
 * file, with every datetime shifted so `fixture.base` lands on `targetBase`.
 * Pure/no I/O — does not write anything (see `persistEntities`).
 */
export function materializeFixtures(
  fixture: FixtureFile,
  targetBase: string,
  ids: IdSource,
): SeededEntities {
  const fixtureBase = Temporal.Instant.from(fixture.base);
  const target = Temporal.Instant.from(targetBase);
  const deltaMs = target.epochMilliseconds - fixtureBase.epochMilliseconds;
  const createdAt = target.toString({ smallestUnit: "millisecond" });

  const idsByKey = new Map<string, string>();
  const keyId = (key: string): string => {
    const existing = idsByKey.get(key);
    if (existing !== undefined) return existing;
    const id = ids.newUlid();
    idsByKey.set(key, id);
    return id;
  };

  const events: Event[] = fixture.events.map((e) =>
    eventSchema.parse({
      id: keyId(e.key),
      title: e.title,
      date_range: shiftDateRange(e.date_range, deltaMs),
      notes: e.notes,
      created_at: createdAt,
      updated_at: createdAt,
    })
  );

  const plans: Plan[] = fixture.plans.map((p) =>
    planSchema.parse({
      id: keyId(p.key),
      event_id: p.event_key === null ? null : keyId(p.event_key),
      title: p.title,
      date_range: shiftDateRange(p.date_range, deltaMs),
      confirm_quota: p.confirm_quota,
      status: "open",
      reservation_ids: [],
      created_at: createdAt,
      updated_at: createdAt,
    })
  );

  const reservations: Reservation[] = fixture.reservations.map((r) =>
    reservationSchema.parse({
      id: keyId(r.key),
      plan_id: r.plan_key === null ? null : keyId(r.plan_key),
      event_id: r.event_key === null ? null : keyId(r.event_key),
      service_name: r.service_name,
      provider: r.provider,
      starts_at: shiftInstant(r.starts_at, deltaMs),
      ends_at: r.ends_at === null ? null : shiftInstant(r.ends_at, deltaMs),
      location: r.location,
      amount_jpy: r.amount_jpy,
      status: r.status,
      cancellation_policy: r.cancellation_policy,
      policy_template_id: null,
      source: r.source,
      raw_input_ref: null,
      notes: r.notes,
      created_at: createdAt,
      updated_at: createdAt,
    })
  );

  return { events, plans, reservations, idsByKey };
}

/** True when the store holds no Event/Plan/Reservation yet. */
export async function storeIsEmpty(store: Store): Promise<boolean> {
  const [events, plans, reservations] = await Promise.all([
    store.listEventEntities(),
    store.listPlans(),
    store.listReservations(),
  ]);
  return events.length === 0 && plans.length === 0 && reservations.length === 0;
}

/**
 * Persists materialized entities. Reservations are created via the domain
 * `createReservation` transition (see module docstring); Events/Plans are
 * direct upserts (no lifecycle/events of their own).
 */
export async function persistEntities(
  store: Store,
  clock: Clock,
  ids: IdSource,
  entities: SeededEntities,
): Promise<void> {
  for (const event of entities.events) {
    await store.putEvent(event);
  }
  for (const plan of entities.plans) {
    await store.putPlan(plan);
  }
  for (const reservation of entities.reservations) {
    const outcome = createReservation(reservation, clock, {
      newId: () => ids.newUlid(),
      correlationId: `seed:${reservation.id}`,
    });
    if (!outcome.ok) {
      // createReservation never rejects; this guard is defensive only.
      throw new Error(`seed: createReservation unexpectedly rejected for ${reservation.id}`);
    }
    await append(store, outcome.events);
    await store.putReservation(reservation);
  }
}

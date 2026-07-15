/**
 * KvStore — Deno KV backed `Store` implementation (Task 1.3, FR-012).
 *
 * Key layout follows design.md's KV key design exactly:
 *   event/<ulid>              plan/<ulid>              reservation/<ulid>
 *   domain_event/<ulid>       policy_template/<service_key>  parse_job/<ulid>
 *   idx/plan_reservations/<plan_id>/<res_id>
 *   idx/pending_cancel/<starts_at>/<res_id>
 *
 * Deno KV's `Deno.Kv.set` does not support Zod validation, so every read and
 * write goes through the entity's Zod schema explicitly (FR-001: schemas are
 * the single validation source, at all Store boundaries).
 *
 * The two secondary indexes are non-authoritative derived data: they store
 * the reservation id as the key tail and `true` as a marker value, so they
 * can be listed via `kv.list()` with a prefix without re-reading the
 * reservation. `putReservation` keeps them in sync using a
 * read-then-atomic-write (a KV transaction with `check()`), retrying once on
 * conflict, since Deno KV has no cross-key transactions otherwise.
 */
import { domainEventSchema } from "../schema/domain-event.ts";
import { eventSchema } from "../schema/event.ts";
import { outboxEntrySchema } from "../schema/outbox-entry.ts";
import { parseJobSchema } from "../schema/parse-job.ts";
import { planSchema } from "../schema/plan.ts";
import { policyTemplateSchema } from "../schema/policy-template.ts";
import { reservationSchema } from "../schema/reservation.ts";
import type { DomainEvent } from "../schema/domain-event.ts";
import type { Event } from "../schema/event.ts";
import type { OutboxEntry } from "../schema/outbox-entry.ts";
import type { ParseJob } from "../schema/parse-job.ts";
import type { Plan } from "../schema/plan.ts";
import type { PolicyTemplate } from "../schema/policy-template.ts";
import type { Reservation } from "../schema/reservation.ts";
import type { ListEventsFilter, ListOutboxFilter, Store } from "./store.ts";

function parseOrThrow<T>(schema: { parse: (v: unknown) => T }, value: unknown, what: string): T {
  try {
    return schema.parse(value);
  } catch (err) {
    throw new Error(`KvStore: invalid ${what}: ${String(err)}`);
  }
}

const EVENT = "event";
const PLAN = "plan";
const RESERVATION = "reservation";
const POLICY_TEMPLATE = "policy_template";
const PARSE_JOB = "parse_job";
const DOMAIN_EVENT = "domain_event";
const IDX_PLAN_RESERVATIONS = "idx/plan_reservations";
const IDX_PENDING_CANCEL = "idx/pending_cancel";
const OUTBOX = "outbox";

export class KvStore implements Store {
  #kv: Deno.Kv;

  private constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }

  /** Opens (or creates) a Deno KV database. `path` matches `Deno.openKv`'s. */
  static async open(path?: string): Promise<KvStore> {
    const kv = await Deno.openKv(path);
    return new KvStore(kv);
  }

  /** The underlying Deno KV handle — for adjacent per-user stores (web API)
   * that share the same database but use their own key namespace. */
  get kv(): Deno.Kv {
    return this.#kv;
  }

  async getEvent(id: string): Promise<Event | null> {
    const entry = await this.#kv.get<Event>([EVENT, id]);
    if (entry.value === null) return null;
    return parseOrThrow(eventSchema, entry.value, "Event");
  }

  async putEvent(event: Event): Promise<void> {
    const validated = parseOrThrow(eventSchema, event, "Event");
    await this.#kv.set([EVENT, validated.id], validated);
  }

  async listEventEntities(): Promise<Event[]> {
    const out: Event[] = [];
    for await (const entry of this.#kv.list<Event>({ prefix: [EVENT] })) {
      out.push(parseOrThrow(eventSchema, entry.value, "Event"));
    }
    return out;
  }

  async getPlan(id: string): Promise<Plan | null> {
    const entry = await this.#kv.get<Plan>([PLAN, id]);
    if (entry.value === null) return null;
    return parseOrThrow(planSchema, entry.value, "Plan");
  }

  async putPlan(plan: Plan): Promise<void> {
    const validated = parseOrThrow(planSchema, plan, "Plan");
    await this.#kv.set([PLAN, validated.id], validated);
  }

  async listPlans(): Promise<Plan[]> {
    const out: Plan[] = [];
    for await (const entry of this.#kv.list<Plan>({ prefix: [PLAN] })) {
      out.push(parseOrThrow(planSchema, entry.value, "Plan"));
    }
    return out;
  }

  async getReservation(id: string): Promise<Reservation | null> {
    const entry = await this.#kv.get<Reservation>([RESERVATION, id]);
    if (entry.value === null) return null;
    return parseOrThrow(reservationSchema, entry.value, "Reservation");
  }

  async putReservation(reservation: Reservation): Promise<void> {
    const validated = parseOrThrow(reservationSchema, reservation, "Reservation");

    // Retry the read-modify-write loop on optimistic-concurrency conflicts;
    // KV transactions have no cross-key locking otherwise.
    for (let attempt = 0; attempt < 10; attempt++) {
      const resKey = [RESERVATION, validated.id];
      const currentEntry = await this.#kv.get<Reservation>(resKey);
      const previous = currentEntry.value;

      const tx = this.#kv.atomic().check(currentEntry).set(resKey, validated);

      if (previous?.plan_id && previous.plan_id !== validated.plan_id) {
        tx.delete([IDX_PLAN_RESERVATIONS, previous.plan_id, validated.id]);
      }
      if (validated.plan_id) {
        tx.set([IDX_PLAN_RESERVATIONS, validated.plan_id, validated.id], true);
      }

      if (
        previous && previous.status === "to_cancel" && previous.starts_at !== validated.starts_at
      ) {
        tx.delete([IDX_PENDING_CANCEL, previous.starts_at, validated.id]);
      }
      if (validated.status === "to_cancel") {
        tx.set([IDX_PENDING_CANCEL, validated.starts_at, validated.id], true);
      } else if (previous && previous.status === "to_cancel") {
        tx.delete([IDX_PENDING_CANCEL, previous.starts_at, validated.id]);
      }

      const result = await tx.commit();
      if (result.ok) return;
      // conflict: someone else wrote this reservation concurrently; retry.
    }
    throw new Error(`KvStore: putReservation(${validated.id}) failed after repeated conflicts`);
  }

  async listReservations(): Promise<Reservation[]> {
    const out: Reservation[] = [];
    for await (const entry of this.#kv.list<Reservation>({ prefix: [RESERVATION] })) {
      out.push(parseOrThrow(reservationSchema, entry.value, "Reservation"));
    }
    return out;
  }

  async listReservationsByPlan(plan_id: string): Promise<Reservation[]> {
    const ids: string[] = [];
    for await (const entry of this.#kv.list({ prefix: [IDX_PLAN_RESERVATIONS, plan_id] })) {
      const key = entry.key;
      const id = key[key.length - 1];
      if (typeof id === "string") ids.push(id);
    }
    const out: Reservation[] = [];
    for (const id of ids) {
      const r = await this.getReservation(id);
      if (r) out.push(r);
    }
    return out;
  }

  async listPendingCancellations(): Promise<Reservation[]> {
    const ids: string[] = [];
    // Keys are [IDX_PENDING_CANCEL, starts_at, res_id]; Deno KV lists in key
    // order, so this is already ascending by starts_at.
    for await (const entry of this.#kv.list({ prefix: [IDX_PENDING_CANCEL] })) {
      const key = entry.key;
      const id = key[key.length - 1];
      if (typeof id === "string") ids.push(id);
    }
    const out: Reservation[] = [];
    for (const id of ids) {
      const r = await this.getReservation(id);
      if (r) out.push(r);
    }
    return out;
  }

  async getPolicyTemplate(id: string): Promise<PolicyTemplate | null> {
    const entry = await this.#kv.get<PolicyTemplate>([POLICY_TEMPLATE, id]);
    if (entry.value === null) return null;
    return parseOrThrow(policyTemplateSchema, entry.value, "PolicyTemplate");
  }

  async putPolicyTemplate(template: PolicyTemplate): Promise<void> {
    const validated = parseOrThrow(policyTemplateSchema, template, "PolicyTemplate");
    await this.#kv.set([POLICY_TEMPLATE, validated.id], validated);
  }

  async listPolicyTemplates(): Promise<PolicyTemplate[]> {
    const out: PolicyTemplate[] = [];
    for await (const entry of this.#kv.list<PolicyTemplate>({ prefix: [POLICY_TEMPLATE] })) {
      out.push(parseOrThrow(policyTemplateSchema, entry.value, "PolicyTemplate"));
    }
    return out;
  }

  async getParseJob(id: string): Promise<ParseJob | null> {
    const entry = await this.#kv.get<ParseJob>([PARSE_JOB, id]);
    if (entry.value === null) return null;
    return parseOrThrow(parseJobSchema, entry.value, "ParseJob");
  }

  async putParseJob(job: ParseJob): Promise<void> {
    const validated = parseOrThrow(parseJobSchema, job, "ParseJob");
    await this.#kv.set([PARSE_JOB, validated.id], validated);
  }

  async listParseJobs(): Promise<ParseJob[]> {
    const out: ParseJob[] = [];
    for await (const entry of this.#kv.list<ParseJob>({ prefix: [PARSE_JOB] })) {
      out.push(parseOrThrow(parseJobSchema, entry.value, "ParseJob"));
    }
    return out;
  }

  async appendEvent(event: DomainEvent): Promise<void> {
    const validated = parseOrThrow(domainEventSchema, event, "DomainEvent");
    const key = [DOMAIN_EVENT, validated.id];
    const result = await this.#kv.atomic()
      .check({ key, versionstamp: null })
      .set(key, validated)
      .commit();
    if (!result.ok) {
      throw new Error(`KvStore: DomainEvent ${validated.id} already exists (append-only)`);
    }
  }

  async listEvents(filter?: ListEventsFilter): Promise<DomainEvent[]> {
    // Keys are ordered lexicographically by id (ULID = chronological order),
    // so a plain prefix scan already yields chronological order; filtering
    // is done in-process to keep id-comparison semantics identical to
    // InMemoryStore's.
    const out: DomainEvent[] = [];
    for await (const entry of this.#kv.list<DomainEvent>({ prefix: [DOMAIN_EVENT] })) {
      const value = parseOrThrow(domainEventSchema, entry.value, "DomainEvent");
      if (filter?.entity_id !== undefined && value.entity_id !== filter.entity_id) continue;
      if (filter?.after_id !== undefined && !(value.id > filter.after_id)) continue;
      out.push(value);
    }
    return out;
  }

  async getOutboxEntry(idempotency_key: string): Promise<OutboxEntry | null> {
    const entry = await this.#kv.get<OutboxEntry>([OUTBOX, idempotency_key]);
    if (entry.value === null) return null;
    return parseOrThrow(outboxEntrySchema, entry.value, "OutboxEntry");
  }

  async putOutboxEntry(entry: OutboxEntry): Promise<void> {
    const validated = parseOrThrow(outboxEntrySchema, entry, "OutboxEntry");
    await this.#kv.set([OUTBOX, validated.idempotency_key], validated);
  }

  async listOutboxEntries(filter?: ListOutboxFilter): Promise<OutboxEntry[]> {
    const out: OutboxEntry[] = [];
    for await (const entry of this.#kv.list<OutboxEntry>({ prefix: [OUTBOX] })) {
      const value = parseOrThrow(outboxEntrySchema, entry.value, "OutboxEntry");
      if (filter?.status !== undefined && value.status !== filter.status) continue;
      out.push(value);
    }
    return out;
  }

  close(): Promise<void> {
    this.#kv.close();
    return Promise.resolve();
  }
}

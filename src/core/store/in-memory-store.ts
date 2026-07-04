/**
 * InMemoryStore — Map-based `Store` implementation for tests (Task 1.3).
 *
 * Deliberately mirrors `KvStore`'s semantics (validation at both
 * read/write boundaries, same index maintenance, append-only event log) so
 * the shared contract test suite exercises the same behavior in both.
 */
import { domainEventSchema } from "../schema/domain-event.ts";
import { eventSchema } from "../schema/event.ts";
import { parseJobSchema } from "../schema/parse-job.ts";
import { planSchema } from "../schema/plan.ts";
import { policyTemplateSchema } from "../schema/policy-template.ts";
import { reservationSchema } from "../schema/reservation.ts";
import type { DomainEvent } from "../schema/domain-event.ts";
import type { Event } from "../schema/event.ts";
import type { ParseJob } from "../schema/parse-job.ts";
import type { Plan } from "../schema/plan.ts";
import type { PolicyTemplate } from "../schema/policy-template.ts";
import type { Reservation } from "../schema/reservation.ts";
import type { ListEventsFilter, Store } from "./store.ts";

function parseOrThrow<T>(schema: { parse: (v: unknown) => T }, value: unknown, what: string): T {
  try {
    return schema.parse(value);
  } catch (err) {
    throw new Error(`InMemoryStore: invalid ${what}: ${String(err)}`);
  }
}

/**
 * Runs a synchronous write and wraps its outcome as a Promise, so a
 * synchronous validation throw (via `parseOrThrow`) surfaces as a rejected
 * Promise (matching `KvStore`'s async behavior) instead of throwing
 * synchronously out of a nominally `Promise<void>`-returning method.
 */
function asAsync<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err);
  }
}

export class InMemoryStore implements Store {
  #events = new Map<string, Event>();
  #plans = new Map<string, Plan>();
  #reservations = new Map<string, Reservation>();
  #policyTemplates = new Map<string, PolicyTemplate>();
  #parseJobs = new Map<string, ParseJob>();
  #domainEvents = new Map<string, DomainEvent>();

  // idx/plan_reservations/<plan_id>/<res_id>
  #planReservationIdx = new Map<string, Set<string>>();
  // idx/pending_cancel/<starts_at>/<res_id> — reservation_id -> starts_at, to
  // allow removal/relocation without a linear scan.
  #pendingCancelIdx = new Map<string, string>();

  getEvent(id: string): Promise<Event | null> {
    return Promise.resolve(this.#events.get(id) ?? null);
  }

  putEvent(event: Event): Promise<void> {
    return asAsync(() => {
      const validated = parseOrThrow(eventSchema, event, "Event");
      this.#events.set(validated.id, validated);
    });
  }

  listEventEntities(): Promise<Event[]> {
    return Promise.resolve([...this.#events.values()]);
  }

  getPlan(id: string): Promise<Plan | null> {
    return Promise.resolve(this.#plans.get(id) ?? null);
  }

  putPlan(plan: Plan): Promise<void> {
    return asAsync(() => {
      const validated = parseOrThrow(planSchema, plan, "Plan");
      this.#plans.set(validated.id, validated);
    });
  }

  listPlans(): Promise<Plan[]> {
    return Promise.resolve([...this.#plans.values()]);
  }

  getReservation(id: string): Promise<Reservation | null> {
    return Promise.resolve(this.#reservations.get(id) ?? null);
  }

  putReservation(reservation: Reservation): Promise<void> {
    return asAsync(() => {
      const validated = parseOrThrow(reservationSchema, reservation, "Reservation");

      const previous = this.#reservations.get(validated.id);
      if (previous?.plan_id && previous.plan_id !== validated.plan_id) {
        this.#planReservationIdx.get(previous.plan_id)?.delete(validated.id);
      }
      if (validated.plan_id) {
        let set = this.#planReservationIdx.get(validated.plan_id);
        if (!set) {
          set = new Set();
          this.#planReservationIdx.set(validated.plan_id, set);
        }
        set.add(validated.id);
      }

      if (validated.status === "to_cancel") {
        this.#pendingCancelIdx.set(validated.id, validated.starts_at);
      } else {
        this.#pendingCancelIdx.delete(validated.id);
      }

      this.#reservations.set(validated.id, validated);
    });
  }

  listReservations(): Promise<Reservation[]> {
    return Promise.resolve([...this.#reservations.values()]);
  }

  listReservationsByPlan(plan_id: string): Promise<Reservation[]> {
    const ids = this.#planReservationIdx.get(plan_id) ?? new Set<string>();
    const out: Reservation[] = [];
    for (const id of ids) {
      const r = this.#reservations.get(id);
      if (r) out.push(r);
    }
    return Promise.resolve(out);
  }

  listPendingCancellations(): Promise<Reservation[]> {
    const out: Reservation[] = [];
    for (const id of this.#pendingCancelIdx.keys()) {
      const r = this.#reservations.get(id);
      if (r) out.push(r);
    }
    out.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id));
    return Promise.resolve(out);
  }

  getPolicyTemplate(id: string): Promise<PolicyTemplate | null> {
    return Promise.resolve(this.#policyTemplates.get(id) ?? null);
  }

  putPolicyTemplate(template: PolicyTemplate): Promise<void> {
    return asAsync(() => {
      const validated = parseOrThrow(policyTemplateSchema, template, "PolicyTemplate");
      this.#policyTemplates.set(validated.id, validated);
    });
  }

  listPolicyTemplates(): Promise<PolicyTemplate[]> {
    return Promise.resolve([...this.#policyTemplates.values()]);
  }

  getParseJob(id: string): Promise<ParseJob | null> {
    return Promise.resolve(this.#parseJobs.get(id) ?? null);
  }

  putParseJob(job: ParseJob): Promise<void> {
    return asAsync(() => {
      const validated = parseOrThrow(parseJobSchema, job, "ParseJob");
      this.#parseJobs.set(validated.id, validated);
    });
  }

  listParseJobs(): Promise<ParseJob[]> {
    return Promise.resolve([...this.#parseJobs.values()]);
  }

  appendEvent(event: DomainEvent): Promise<void> {
    return asAsync(() => {
      const validated = parseOrThrow(domainEventSchema, event, "DomainEvent");
      if (this.#domainEvents.has(validated.id)) {
        throw new Error(`InMemoryStore: DomainEvent ${validated.id} already exists (append-only)`);
      }
      this.#domainEvents.set(validated.id, validated);
    });
  }

  listEvents(filter?: ListEventsFilter): Promise<DomainEvent[]> {
    let out = [...this.#domainEvents.values()];
    if (filter?.entity_id !== undefined) {
      out = out.filter((e) => e.entity_id === filter.entity_id);
    }
    if (filter?.after_id !== undefined) {
      out = out.filter((e) => e.id > filter.after_id!);
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return Promise.resolve(out);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Store interface (Task 1.3, FR-012, SDD §2/§10.2, design.md KV key design).
 *
 * Storage-agnostic: implementations swap between Deno KV (`KvStore`) and, if
 * a VPS deployment is chosen later, a SQLite-backed implementation, without
 * changing any calling code. `InMemoryStore` exists purely for tests.
 *
 * The Store deals only in already-validated entities: implementations must
 * validate against the Zod schemas at both the read and write boundary (so a
 * corrupted/foreign-written record is caught on read, not just on write).
 *
 * No domain logic (state transitions) lives here. This layer is pure
 * storage + the two secondary indexes called out in design.md:
 *   - plan -> reservations (`idx/plan_reservations/<plan_id>/<res_id>`)
 *   - pending-cancel by starts_at (`idx/pending_cancel/<starts_at>/<res_id>`)
 *
 * The Outbox (Task 3.2) is also stored here, keyed by idempotency_key
 * (`outbox/<idempotency_key>`, design.md KV key design) — `notify/outbox.ts`
 * owns the enqueue/deliver/retry *logic*, but the entry itself is just
 * another Store-persisted, Zod-validated record like every other entity.
 */
import type { DomainEvent } from "../schema/domain-event.ts";
import type { Event } from "../schema/event.ts";
import type { OutboxEntry, OutboxStatus } from "../schema/outbox-entry.ts";
import type { ParseJob } from "../schema/parse-job.ts";
import type { Plan } from "../schema/plan.ts";
import type { PolicyTemplate } from "../schema/policy-template.ts";
import type { Reservation } from "../schema/reservation.ts";

export type { OutboxEntry, OutboxStatus } from "../schema/outbox-entry.ts";

/** Filter for `listOutboxEntries()`. */
export interface ListOutboxFilter {
  status?: OutboxStatus;
}

/** Filter for `listEvents()`. Both fields are optional and combine with AND. */
export interface ListEventsFilter {
  /** Restrict to events about a single entity. */
  entity_id?: string;
  /** Only events with `id > after_id` (exclusive), by ULID/lexicographic order. */
  after_id?: string;
}

/**
 * Storage-agnostic persistence port. All entity CRUD is get-by-id / put
 * (upsert) / list-all; the domain event log is append-only and ordered by
 * ULID id (= chronological). See design.md for the KV key layout that
 * `KvStore` follows; other implementations are free to use a different
 * physical layout as long as the semantics below hold.
 */
export interface Store {
  getEvent(id: string): Promise<Event | null>;
  putEvent(event: Event): Promise<void>;
  /** Lists all `Event` entities. Named `listEventEntities` to avoid clashing
   * with `listEvents`, which lists the DomainEvent log. */
  listEventEntities(): Promise<Event[]>;

  getPlan(id: string): Promise<Plan | null>;
  putPlan(plan: Plan): Promise<void>;
  listPlans(): Promise<Plan[]>;

  getReservation(id: string): Promise<Reservation | null>;
  /**
   * Upserts a Reservation. Also maintains the plan->reservations index and
   * the pending-cancel-by-starts_at index (adding/removing the reservation
   * from the pending-cancel index depending on whether its status is
   * `to_cancel`, and moving it if `starts_at` changed).
   */
  putReservation(reservation: Reservation): Promise<void>;
  listReservations(): Promise<Reservation[]>;
  /** Reservations belonging to a Plan, via the plan->reservations index. */
  listReservationsByPlan(plan_id: string): Promise<Reservation[]>;
  /**
   * Reservations with status `to_cancel`, ordered by `starts_at` ascending
   * (soonest deadline first), via the pending-cancel index.
   */
  listPendingCancellations(): Promise<Reservation[]>;

  getPolicyTemplate(id: string): Promise<PolicyTemplate | null>;
  putPolicyTemplate(template: PolicyTemplate): Promise<void>;
  listPolicyTemplates(): Promise<PolicyTemplate[]>;

  getParseJob(id: string): Promise<ParseJob | null>;
  putParseJob(job: ParseJob): Promise<void>;
  listParseJobs(): Promise<ParseJob[]>;

  /** Appends a DomainEvent. Append-only: overwriting an existing id is rejected. */
  appendEvent(event: DomainEvent): Promise<void>;
  /** Lists DomainEvents in ULID (chronological) order, optionally filtered. */
  listEvents(filter?: ListEventsFilter): Promise<DomainEvent[]>;

  /** Fetches a single OutboxEntry by its idempotency_key, or null if absent. */
  getOutboxEntry(idempotency_key: string): Promise<OutboxEntry | null>;
  /** Upserts an OutboxEntry, keyed by `idempotency_key`. */
  putOutboxEntry(entry: OutboxEntry): Promise<void>;
  /** Lists OutboxEntries, optionally filtered by status. */
  listOutboxEntries(filter?: ListOutboxFilter): Promise<OutboxEntry[]>;

  /** Releases any underlying resources (e.g. closes the KV connection). */
  close(): Promise<void>;
}

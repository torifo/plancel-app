/**
 * Shared valid fixtures for schema tests. Kept in one place so each entity
 * test can build minimal deviations off a known-good base.
 */
import type { CancellationPolicy } from "../cancellation-policy.ts";
import type { Event } from "../event.ts";
import type { Plan } from "../plan.ts";
import type { Reservation } from "../reservation.ts";
import type { PolicyTemplate } from "../policy-template.ts";
import type { ParseJob } from "../parse-job.ts";
import type { DomainEvent } from "../domain-event.ts";

// 26-char Crockford Base32 ULID-shaped strings for fixtures.
export const ULID_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const ULID_B = "01BRZ3NDEKTSV4RRFFQ69G5FAV";
export const ULID_C = "01CRZ3NDEKTSV4RRFFQ69G5FAV";

export const validEvent: Event = {
  id: ULID_A,
  title: "夏の北陸旅行",
  date_range: { start: "2026-08-01", end: "2026-08-03" },
  notes: null,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

export const validPlan: Plan = {
  id: ULID_A,
  event_id: null,
  title: "7/12 ディナー候補",
  date_range: null,
  confirm_quota: 1,
  status: "open",
  reservation_ids: [],
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

export const validPolicy: CancellationPolicy = {
  stages: [
    { until_offset_hours: 168, fee_percent: 0, fee_fixed_jpy: null },
    { until_offset_hours: 24, fee_percent: 50, fee_fixed_jpy: null },
    { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
  ],
};

export const validReservation: Reservation = {
  id: ULID_A,
  plan_id: null,
  event_id: null,
  service_name: "○○旅館",
  provider: "じゃらん",
  starts_at: "2026-08-01T15:00:00.000Z",
  ends_at: "2026-08-02T10:00:00.000Z",
  location: "石川県",
  amount_jpy: 12000,
  status: "candidate",
  cancellation_policy: validPolicy,
  policy_template_id: null,
  source: "manual",
  raw_input_ref: null,
  notes: null,
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

export const validPolicyTemplate: PolicyTemplate = {
  id: ULID_A,
  service_key: "jalan:○○旅館",
  policy: validPolicy,
  hit_count: 3,
  last_used_at: "2026-07-01T00:00:00.000Z",
};

export const validParseJob: ParseJob = {
  id: ULID_A,
  input_type: "text",
  raw_input: "土曜19時に○○を仮予約、前日まで無料",
  attempts: [
    {
      parser: "groq-llama",
      raw_response: '{"service_name":"○○"}',
      output: { service_name: "○○" },
      validation_errors: [],
      correlation_id: "corr-1",
    },
  ],
  status: "parsed",
  conflicts: [],
  created_at: "2026-07-01T00:00:00.000Z",
};

export const validDomainEvent: DomainEvent = {
  id: ULID_A,
  type: "reservation.created",
  entity_id: ULID_B,
  payload: { foo: "bar" },
  caused_by: null,
  correlation_id: "corr-1",
  occurred_at: "2026-07-01T00:00:00.000Z",
};

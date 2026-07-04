import { assertEquals } from "jsr:@std/assert@1";
import { reservationSchema } from "../reservation.ts";
import { validReservation } from "./fixtures.ts";

Deno.test("reservationSchema accepts a valid Reservation", () => {
  const result = reservationSchema.safeParse(validReservation);
  assertEquals(result.success, true);
});

Deno.test("reservationSchema accepts cancellation_policy: 'unknown'", () => {
  const result = reservationSchema.safeParse({
    ...validReservation,
    cancellation_policy: "unknown",
  });
  assertEquals(result.success, true);
});

Deno.test("reservationSchema accepts nullable optional fields as null", () => {
  const result = reservationSchema.safeParse({
    ...validReservation,
    plan_id: null,
    event_id: null,
    provider: null,
    ends_at: null,
    location: null,
    amount_jpy: null,
    policy_template_id: null,
    raw_input_ref: null,
    notes: null,
  });
  assertEquals(result.success, true);
});

Deno.test("reservationSchema rejects bad status", () => {
  const result = reservationSchema.safeParse({ ...validReservation, status: "archived" });
  assertEquals(result.success, false);
});

Deno.test("reservationSchema rejects missing required field (service_name)", () => {
  const { service_name: _s, ...rest } = validReservation;
  const result = reservationSchema.safeParse(rest);
  assertEquals(result.success, false);
});

Deno.test("reservationSchema rejects an invalid nested cancellation_policy", () => {
  const result = reservationSchema.safeParse({
    ...validReservation,
    cancellation_policy: {
      stages: [
        { until_offset_hours: 24, fee_percent: 50, fee_fixed_jpy: null },
        { until_offset_hours: 48, fee_percent: 10, fee_fixed_jpy: null },
      ],
    },
  });
  assertEquals(result.success, false);
});

Deno.test("reservationSchema rejects negative amount_jpy", () => {
  const result = reservationSchema.safeParse({ ...validReservation, amount_jpy: -100 });
  assertEquals(result.success, false);
});

Deno.test("reservationSchema rejects bad source enum value", () => {
  const result = reservationSchema.safeParse({ ...validReservation, source: "email" });
  assertEquals(result.success, false);
});

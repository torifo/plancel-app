import { assertEquals } from "jsr:@std/assert@1";
import type { DomainEvent } from "../domain-event.ts";
import { domainEventSchema, domainEventTypes } from "../domain-event.ts";
import { validDomainEvent } from "./fixtures.ts";

Deno.test("DomainEvent.payload is a required property (type-level)", () => {
  const { payload: _payload, ...withoutPayload } = validDomainEvent;
  // @ts-expect-error payload is required; omitting it must be a type error.
  const missingPayload: DomainEvent = { ...withoutPayload };
  void missingPayload;
});

Deno.test("domainEventSchema accepts a valid DomainEvent", () => {
  const result = domainEventSchema.safeParse(validDomainEvent);
  assertEquals(result.success, true);
});

Deno.test("domainEventSchema accepts all 8 named SDD §10.2 types", () => {
  assertEquals(domainEventTypes.length, 8);
  for (const type of domainEventTypes) {
    const result = domainEventSchema.safeParse({ ...validDomainEvent, type });
    assertEquals(result.success, true, `expected type "${type}" to be accepted`);
  }
});

Deno.test("domainEventSchema accepts a null caused_by", () => {
  const result = domainEventSchema.safeParse({ ...validDomainEvent, caused_by: null });
  assertEquals(result.success, true);
});

Deno.test("domainEventSchema rejects an unrecognized type", () => {
  const result = domainEventSchema.safeParse({ ...validDomainEvent, type: "reservation.made_up" });
  assertEquals(result.success, false);
});

Deno.test("domainEventSchema rejects missing required field (correlation_id)", () => {
  const { correlation_id: _c, ...rest } = validDomainEvent;
  const result = domainEventSchema.safeParse(rest);
  assertEquals(result.success, false);
});

Deno.test("domainEventSchema rejects a non-ULID caused_by", () => {
  const result = domainEventSchema.safeParse({ ...validDomainEvent, caused_by: "not-a-ulid" });
  assertEquals(result.success, false);
});

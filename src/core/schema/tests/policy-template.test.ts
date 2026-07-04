import { assertEquals } from "jsr:@std/assert@1";
import { policyTemplateSchema } from "../policy-template.ts";
import { validPolicyTemplate } from "./fixtures.ts";

Deno.test("policyTemplateSchema accepts a valid PolicyTemplate", () => {
  const result = policyTemplateSchema.safeParse(validPolicyTemplate);
  assertEquals(result.success, true);
});

Deno.test("policyTemplateSchema rejects an invalid nested policy", () => {
  const result = policyTemplateSchema.safeParse({
    ...validPolicyTemplate,
    policy: {
      stages: [
        { until_offset_hours: 24, fee_percent: 0, fee_fixed_jpy: null },
        { until_offset_hours: 48, fee_percent: 0, fee_fixed_jpy: null },
      ],
    },
  });
  assertEquals(result.success, false);
});

Deno.test("policyTemplateSchema rejects missing required field (service_key)", () => {
  const { service_key: _s, ...rest } = validPolicyTemplate;
  const result = policyTemplateSchema.safeParse(rest);
  assertEquals(result.success, false);
});

Deno.test("policyTemplateSchema rejects negative hit_count", () => {
  const result = policyTemplateSchema.safeParse({ ...validPolicyTemplate, hit_count: -1 });
  assertEquals(result.success, false);
});

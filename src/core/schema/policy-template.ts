/**
 * PolicyTemplate — cached default CancellationPolicy per service (SDD §3.4).
 */
import { z } from "zod";
import { cancellationPolicySchema } from "./cancellation-policy.ts";
import { isoDateTimeSchema, ulidSchema } from "./common.ts";

export const policyTemplateSchema = z.object({
  id: ulidSchema,
  service_key: z.string().min(1),
  policy: cancellationPolicySchema,
  hit_count: z.number().int().min(0),
  last_used_at: isoDateTimeSchema,
});

export type PolicyTemplate = z.infer<typeof policyTemplateSchema>;

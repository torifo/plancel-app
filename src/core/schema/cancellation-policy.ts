/**
 * CancellationPolicy — staged cancellation fees (SDD §3.3, FR-003).
 *
 * Validation rules (FR-003 / SDD §3.3):
 *   - stages sorted by until_offset_hours strictly descending (farthest first)
 *   - fee is monotonically non-decreasing as the offset decreases (i.e. as the
 *     reservation start approaches), considering both fee_percent and
 *     fee_fixed_jpy independently: a stage's fee must never be lower than
 *     that of a farther (earlier-in-array) stage.
 *   - fee_percent is within [0, 100]
 *   - the literal "unknown" is accepted wherever a CancellationPolicy is used
 *     (see cancellationPolicyOrUnknownSchema, used by Reservation).
 */
import { z } from "zod";

export const policyStageSchema = z.object({
  until_offset_hours: z.number().finite(),
  fee_percent: z.number().min(0).max(100),
  fee_fixed_jpy: z.number().nullable(),
});

export type PolicyStage = z.infer<typeof policyStageSchema>;

export const cancellationPolicySchema = z
  .object({
    stages: z.array(policyStageSchema),
  })
  .superRefine((policy, ctx) => {
    const { stages } = policy;
    for (let i = 1; i < stages.length; i++) {
      const prev = stages[i - 1];
      const curr = stages[i];
      if (!prev || !curr) continue;

      if (curr.until_offset_hours >= prev.until_offset_hours) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `stages must be sorted by until_offset_hours strictly descending ` +
            `(stage ${i} offset ${curr.until_offset_hours} is not less than stage ${
              i - 1
            } offset ${prev.until_offset_hours})`,
          path: ["stages", i, "until_offset_hours"],
        });
      }

      if (curr.fee_percent < prev.fee_percent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `fee_percent must be monotonically non-decreasing as offset decreases ` +
            `(stage ${i} fee_percent ${curr.fee_percent} is lower than stage ${
              i - 1
            } fee_percent ${prev.fee_percent})`,
          path: ["stages", i, "fee_percent"],
        });
      }

      if (
        prev.fee_fixed_jpy !== null &&
        curr.fee_fixed_jpy !== null &&
        curr.fee_fixed_jpy < prev.fee_fixed_jpy
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `fee_fixed_jpy must be monotonically non-decreasing as offset decreases ` +
            `(stage ${i} fee_fixed_jpy ${curr.fee_fixed_jpy} is lower than stage ${
              i - 1
            } fee_fixed_jpy ${prev.fee_fixed_jpy})`,
          path: ["stages", i, "fee_fixed_jpy"],
        });
      }
    }
  });

export type CancellationPolicy = z.infer<typeof cancellationPolicySchema>;

/** CancellationPolicy, or the literal "unknown" (SDD §3.3 — never rejected). */
export const cancellationPolicyOrUnknownSchema = z.union([
  cancellationPolicySchema,
  z.literal("unknown"),
]);

export type CancellationPolicyOrUnknown = z.infer<typeof cancellationPolicyOrUnknownSchema>;

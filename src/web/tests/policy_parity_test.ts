/**
 * The core ledger and the web ledger must read one stage table the same way.
 *
 * They did not until 2026-07-30: `src/core/domain/policy.ts` read a stage's
 * fee as applying from its boundary INWARD with an implicit free window
 * beyond the farthest stage, while `src/web/policy.ts` reads it OUTWARD with
 * the free window spelled out as a 0% stage. The same array meant 30% in one
 * and 50% in the other, and `free24` meant "free until the start" to core and
 * "free until 前日" to the ledger. Nothing caught it because no test compared
 * them and nothing in the deployed process writes core Reservations — but
 * `deno task line` standalone and the local-core MCP do, off the same parser
 * output the web ledger uses.
 *
 * This file is that comparison. Both modules keep their own implementation
 * (different types, different call shapes); what is pinned is that they agree.
 */
import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { freeDeadlineMs, pctAt, type WebPolicy } from "../policy.ts";
import { freeCancellationDeadline, resolvePolicyAt } from "../../core/domain/policy.ts";
import type { CancellationPolicy } from "../../core/schema/mod.ts";

const START = "2026-08-20T19:00:00+09:00";
const startInstant = Temporal.Instant.from(START);

/** The same policy in both shapes, from one list of (boundary, fee) pairs. */
function both(pairs: [number, number][]): { web: WebPolicy; core: CancellationPolicy } {
  return {
    web: { stages: pairs.map(([h, pct]) => ({ h, pct })) },
    core: {
      stages: pairs.map(([h, pct]) => ({
        until_offset_hours: h,
        fee_percent: pct,
        fee_fixed_jpy: null,
      })),
    },
  };
}

const POLICIES: [string, [number, number][]][] = [
  ["staged（7日前まで無料）", [[168, 0], [72, 30], [24, 50], [0, 100]]],
  ["free24（前日まで無料）", [[24, 0], [0, 100]]],
  ["5日前まで無料", [[120, 0], [72, 30], [0, 100]]],
  ["8日前まで無料（から表記の取り込み結果）", [[192, 0], [0, 20]]],
  ["最初から有料（無料期間なし）", [[48, 20], [0, 80]]],
  ["いつでも無料", [[0, 0]]],
  ["時間単位の境界", [[36, 0], [0, 50]]],
];

/** Every boundary used above, one hour either side of it, and past the start. */
const BOUNDARIES = [192, 168, 120, 72, 48, 36, 24, 0];
const PROBES = [1000, 200, -5, ...BOUNDARIES.flatMap((h) => [h + 1, h, h - 1])];

for (const [name, pairs] of POLICIES) {
  Deno.test(`policy parity: ${name} resolves to the same fee in core and web`, () => {
    const { web, core } = both(pairs);
    for (const hoursLeft of PROBES) {
      const at = startInstant.subtract({ hours: hoursLeft });
      const resolved = resolvePolicyAt(core, startInstant, at);
      const corePct = resolved.policyKnown ? resolved.feePercent : null;
      assertEquals(corePct, pctAt(web, hoursLeft), `${name} at ${hoursLeft}h before start`);
    }
  });

  Deno.test(`policy parity: ${name} has the same 無料キャンセル期限`, () => {
    const { web, core } = both(pairs);
    const coreDeadline = freeCancellationDeadline(core, startInstant);
    const webMs = freeDeadlineMs(web, START);
    assertEquals(
      coreDeadline === null ? null : coreDeadline.epochMilliseconds,
      webMs,
      `${name}: core ${coreDeadline?.toString() ?? "null"} vs web ${webMs}`,
    );
  });
}

Deno.test("policy parity: 「unknown」 is unknown on both sides", () => {
  assertEquals(resolvePolicyAt("unknown", startInstant, startInstant).policyKnown, false);
  assertEquals(pctAt("unknown", 100), null);
  assertEquals(freeCancellationDeadline("unknown", startInstant), null);
  assertEquals(freeDeadlineMs("unknown", START), null);
});

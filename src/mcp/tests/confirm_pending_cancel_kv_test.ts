/**
 * Regression guard: confirming a candidate in a quota-1 plan must, when it
 * settles the plan and auto-moves the sibling to `to_cancel`, also maintain the
 * `idx/pending_cancel` secondary index against a *real* KvStore (temp-file KV) —
 * not just InMemoryStore. This exercises the full MCP persistence path
 * (`persistTransition` → `KvStore.putReservation` for every side-effect sibling)
 * and asserts both the high-level query (`listPendingCancellations`) and the raw
 * KV index prefix are populated, so a future regression in KvStore's index
 * maintenance for side-effect transitions is caught here.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { KvStore } from "../../core/store/mod.ts";
import { VirtualClock } from "../../core/clock/mod.ts";
import type { Reservation } from "../../core/schema/mod.ts";
import { ulid } from "../../lib/ulid.ts";
import type { ToolContext } from "../context.ts";
import { invokeTool } from "../tools/shared.ts";
import { confirmReservationTool } from "../tools/confirm_reservation.ts";
import { createPlanTool } from "../tools/create_plan.ts";
import { addToPlanTool } from "../tools/add_to_plan.ts";

const NOW = "2026-07-01T00:00:00.000Z";

Deno.test(
  "confirm_reservation (KvStore): side-effect to_cancel sibling is added to the pending_cancel index",
  async () => {
    const path = await Deno.makeTempFile({ prefix: "plancel-pending-cancel-", suffix: ".kv" });
    const store = await KvStore.open(path);
    const c: ToolContext = {
      store,
      clock: new VirtualClock(NOW),
      ids: { newUlid: () => ulid() },
    };

    try {
      // Seed a quota-1 plan with two candidates through the same MCP tool path
      // the live stdio server uses (create_plan + add_to_plan inline).
      const planRes = await invokeTool(createPlanTool, c, { title: "t", confirm_quota: 1 });
      assert(planRes.ok);
      const planId = (planRes.data.plan as { id: string }).id;

      const aRes = await invokeTool(addToPlanTool, c, {
        plan_id: planId,
        reservation: { service_name: "A", starts_at: "2026-08-01T12:00:00.000Z" },
      });
      assert(aRes.ok);
      const aId = (aRes.data.reservation as Reservation).id;

      const bRes = await invokeTool(addToPlanTool, c, {
        plan_id: planId,
        reservation: { service_name: "B", starts_at: "2026-08-02T12:00:00.000Z" },
      });
      assert(bRes.ok);
      const bId = (bRes.data.reservation as Reservation).id;

      // Confirm A → plan settles, B auto-moves to to_cancel (a side-effect).
      const res = await invokeTool(confirmReservationTool, c, { reservation_id: aId });
      assert(res.ok);

      // The sibling is persisted as to_cancel...
      assertEquals((await store.getReservation(bId))?.status, "to_cancel");

      // ...and the high-level query returns it (index-backed).
      const pending = await store.listPendingCancellations();
      assertEquals(pending.map((r) => r.id), [bId]);

      // ...and the raw idx/pending_cancel KV prefix is non-empty and points at B.
      const raw = await Deno.openKv(path);
      const idxKeys: Deno.KvKey[] = [];
      for await (const entry of raw.list({ prefix: ["idx/pending_cancel"] })) {
        idxKeys.push(entry.key);
      }
      raw.close();
      assertEquals(idxKeys.length, 1);
      assertEquals(idxKeys[0]?.[idxKeys[0].length - 1], bId);
    } finally {
      await store.close();
      await Deno.remove(path).catch(() => {});
    }
  },
);

import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import { makeIds, withKv } from "../../agent/tests/helpers.ts";
import { cancelReservation, listReservations } from "../../web/store.ts";
import { listProposals, putProposal } from "../../agent/store.ts";
import { freeDeadlineMs } from "../../web/policy.ts";
import { isFinished } from "../../web/lifecycle.ts";
import { findUserByEmail, getOrCreateUserByEmail } from "../../web/users.ts";
import { verifyPassword } from "../../lib/password.ts";
import { DEMO_EMAIL, demoEnv, resetDemoLedger, seedDemoIfEmpty } from "../demo.ts";

const HOUR = 3_600_000;

Deno.test("demo seed: account, password hash, and a ledger the agent can act on", async () => {
  await withKv(async (kv) => {
    const clock = new VirtualClock("2026-10-15T11:00:00Z"); // 20:00 JST
    const ids = makeIds(clock);
    const r = await seedDemoIfEmpty({ kv, clock, ids, password: "demo-pass-1234" });
    assertEquals(r.status, "seeded");
    if (r.status !== "seeded") return;

    const user = await findUserByEmail(kv, DEMO_EMAIL);
    assert(user !== null && user.passwordHash !== null);
    assert(await verifyPassword("demo-pass-1234", user.passwordHash));
    assertEquals(user.emailVerified, true);

    const rows = await listReservations(kv, user.ledgerId);
    assertEquals(rows.length, 6);
    const by = (service: string) => rows.find((x) => x.service === service)!;
    assertEquals(by("鮨 さいとう").status, "confirmed");
    // Turned to_cancel by the real confirm transition, not written that way.
    assertEquals(by("トラットリア アルバ").status, "to_cancel");
    assertEquals(by("ビストロ ル・ポワン").status, "candidate");
    assertEquals(by("ホテル鴨川リバーサイド").status, "candidate");
    assertEquals(by("旅館 花ごろも").status, "candidate");
    assert(isFinished(by("炭火焼き とり吉"), clock.now().epochMilliseconds));
  });
});

Deno.test("demo seed: the fee boundaries land inside the windows the demo is about", async () => {
  // Whatever time of day the container boots, アルバ's free window closes within
  // 24h and the 鴨川 hotel's within 24-48h.
  for (const iso of ["2026-10-14T15:05:00Z", "2026-10-15T03:00:00Z", "2026-10-15T14:50:00Z"]) {
    await withKv(async (kv) => {
      const clock = new VirtualClock(iso);
      const r = await seedDemoIfEmpty({
        kv,
        clock,
        ids: makeIds(clock),
        password: "demo-pass-1234",
      });
      assertEquals(r.status, "seeded");
      if (r.status !== "seeded") return;
      const rows = await listReservations(kv, r.user.ledgerId);
      const now = clock.now().epochMilliseconds;
      const left = (service: string) => {
        const row = rows.find((x) => x.service === service)!;
        return freeDeadlineMs(row.policy, row.startsAt)! - now;
      };
      assert(left("トラットリア アルバ") > 0 && left("トラットリア アルバ") <= 24 * HOUR, iso);
      assert(
        left("ホテル鴨川リバーサイド") > 24 * HOUR && left("ホテル鴨川リバーサイド") <= 48 * HOUR,
        iso,
      );
    });
  }
});

Deno.test("demo seed: idempotent, and refuses to invent a password", async () => {
  await withKv(async (kv) => {
    const clock = new VirtualClock("2026-10-15T11:00:00Z");
    const ids = makeIds(clock);

    assertEquals(
      (await seedDemoIfEmpty({ kv, clock, ids, password: undefined })).status,
      "no_password",
    );
    assertEquals(
      (await seedDemoIfEmpty({ kv, clock, ids, password: "short" })).status,
      "weak_password",
    );
    assertEquals(await findUserByEmail(kv, DEMO_EMAIL), null);

    const first = await seedDemoIfEmpty({ kv, clock, ids, password: "demo-pass-1234" });
    assertEquals(first.status, "seeded");
    const again = await seedDemoIfEmpty({ kv, clock, ids, password: "another-pass-99" });
    assertEquals(again.status, "exists");
    if (first.status !== "seeded" || again.status !== "exists") return;
    assertEquals((await listReservations(kv, first.user.ledgerId)).length, 6);
    // The existing account keeps its original password.
    assert(await verifyPassword("demo-pass-1234", again.user.passwordHash!));
  });
});

Deno.test("demoEnv hides every outbound integration but leaves the rest readable", () => {
  const env = new Map([
    ["LINE_CHANNEL_ACCESS_TOKEN", "x"],
    ["RESEND_API_KEY", "x"],
    ["GOOGLE_CLIENT_ID", "x"],
    ["PLANCEL_DEV_USER", "dev@local"],
    ["GEMINI_API_KEY", "keep"],
    ["PORT", "8080"],
  ]);
  const masked = demoEnv({ get: (k) => env.get(k) });
  for (
    const k of [
      "LINE_CHANNEL_ACCESS_TOKEN",
      "RESEND_API_KEY",
      "GOOGLE_CLIENT_ID",
      "PLANCEL_DEV_USER",
    ]
  ) {
    assertEquals(masked.get(k), undefined, k);
  }
  assertEquals(masked.get("GEMINI_API_KEY"), "keep");
  assertEquals(masked.get("PORT"), "8080");
});

Deno.test("demo reset refiles the ledger and forgets the agent's history, for the demo user only", async () => {
  await withKv(async (kv) => {
    const clock = new VirtualClock("2026-10-15T11:00:00Z");
    const ids = makeIds(clock);
    const deps = { kv, clock, ids, password: "demo-pass-1234" };
    const seeded = await seedDemoIfEmpty(deps);
    if (seeded.status !== "seeded") throw new Error("seed failed");
    const user = seeded.user;

    // Make a mess: cancel a row and leave agent records behind.
    const rows = await listReservations(kv, user.ledgerId);
    await cancelReservation(kv, user.ledgerId, rows[0]!.id, ids);
    await putProposal(kv, user.id, {
      id: "P1",
      runId: "R1",
      reservationId: rows[0]!.id,
      service: "x",
      startsAt: "x",
      reason: "x",
      draftMessage: "x",
      urgency: "normal",
      estimate: {
        pctNow: null,
        lossNowYen: null,
        lossAfterNextBoundaryYen: null,
        nextBoundaryAt: null,
        freeUntil: null,
      },
      status: "pending",
      createdAt: "2026-10-15T11:00:00Z",
      decidedAt: null,
      outcome: null,
    });

    clock.advance("P5D");
    assertEquals(await resetDemoLedger(deps, user), true);
    const after = await listReservations(kv, user.ledgerId);
    assertEquals(after.length, 6);
    assertEquals(after.filter((r) => r.status === "cancelled").length, 0);
    assertEquals((await listProposals(kv, user.id)).length, 0);
    // Dates follow the clock, so the demo is "this week" again, not five days stale.
    const alba = after.find((r) => r.service === "トラットリア アルバ")!;
    assert(Temporal.Instant.from(alba.startsAt).epochMilliseconds > clock.now().epochMilliseconds);

    const other = await getOrCreateUserByEmail(kv, "someone@example.com", ids);
    assertEquals(await resetDemoLedger(deps, other), false);
  });
});

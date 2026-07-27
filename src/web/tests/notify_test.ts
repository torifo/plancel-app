import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { type NotifyDeps, sweepDeadlineNotifications } from "../notify.ts";
import { freeDeadlineMs } from "../policy.ts";
import { getOrCreateUserByEmail } from "../users.ts";
import type { WebPolicy, WebReservation, WebStatus } from "../store.ts";
import { makeAuthIds } from "./users_test.ts";

const H = 3_600_000;
const NOW = Temporal.Instant.from("2026-08-01T00:00:00Z").epochMilliseconds;
const iso = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms).toString();

interface Sent {
  email: string;
  subject: string;
  text: string;
}

function makeDeps(kv: Deno.Kv, sent: Sent[], nowMs = NOW): NotifyDeps {
  return {
    kv,
    nowMs,
    baseUrl: "https://plancel.test",
    send: (email, subject, text) => {
      sent.push({ email, subject, text });
      return Promise.resolve();
    },
  };
}

/** Adds the owner LINE push route to a deps object (LINE v2 #1). */
function withLine(
  deps: NotifyDeps,
  ownerEmail: string,
  pushed: string[],
  fail = false,
): NotifyDeps {
  return {
    ...deps,
    line: {
      ownerEmail,
      push: (text) => {
        if (fail) return Promise.reject(new Error("line push failed"));
        pushed.push(text);
        return Promise.resolve();
      },
    },
  };
}

/** Writes a reservation record straight into a ledger's KV namespace. */
async function putResv(
  kv: Deno.Kv,
  ledger: string,
  id: string,
  policy: WebPolicy,
  status: WebStatus,
  startMs: number,
): Promise<void> {
  const r: WebReservation = {
    id,
    plan: null,
    service: `svc-${id}`,
    startsAt: iso(startMs),
    amount: 10000,
    location: null,
    policy,
    status,
    created_at: iso(NOW),
    updated_at: iso(NOW),
  };
  await kv.set(["web", ledger, "resv", id], r);
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

// ① a free24 reservation whose free deadline is inside the next 24h → 1 mail.
// free24 (「前日まで無料」) の無料期限は start − 24h（最後の pct==0 ステージ、
// 2026-07-25 の期限バグ修正後の正）。start = now+36h → deadline = now+12h。
Deno.test("notifies once for a free24 deadline within 24h", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    const count = await sweepDeadlineNotifications(makeDeps(kv, sent));
    assertEquals(count, 1);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.email, "a@b.jp");
    assertEquals(sent[0]?.subject, "[plancel] キャンセル無料期限が近づいています");
    assertEquals(sent[0]?.text.includes("svc-R1"), true);
    assertEquals(sent[0]?.text.includes("plancel で確認: https://plancel.test"), true);
  });
});

// ② re-running the sweep sends nothing more (idempotent marker).
Deno.test("does not re-notify on a second sweep", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    await putResv(kv, u.ledgerId, "R1", "free24", "confirmed", NOW + 36 * H);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 1);
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 0);
    assertEquals(sent.length, 1);

    // The marker also survives the reservation being deleted → still no re-notify.
    await kv.delete(["web", u.ledgerId, "resv", "R1"]);
    await putResv(kv, u.ledgerId, "R1", "free24", "confirmed", NOW + 36 * H);
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 0);
    assertEquals(sent.length, 1);
  });
});

// ③ far-future / past / cancelled / unknown are all out of scope.
Deno.test("skips far-future, past, cancelled and unknown-policy reservations", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    // free24 deadline = start−24h; start = now+100h → deadline = now+76h → too far.
    await putResv(kv, u.ledgerId, "FAR", "free24", "candidate", NOW + 100 * H);
    // deadline = now−1h → past (not future).
    await putResv(kv, u.ledgerId, "PAST", "free24", "candidate", NOW + 1 * H); // deadline は過去
    // in-window shape but cancelled.
    await putResv(kv, u.ledgerId, "CANC", "free24", "cancelled", NOW + 36 * H);
    // in-window shape but policy unknown → no deadline.
    await putResv(kv, u.ledgerId, "UNK", "unknown", "candidate", NOW + 12 * H);
    // in-window shape but policy none → no paid stage.
    await putResv(kv, u.ledgerId, "NONE", "none", "candidate", NOW + 12 * H);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 0);
    assertEquals(sent.length, 0);
  });
});

// ④ staged deadline math matches the canonical client `freeDeadline`: the
// staged (「7日前まで無料」) の無料期限は start − 168h（最後の pct==0 ステージ）。
Deno.test("staged free deadline is start − 168h (last free stage) and notifies in-window", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    const start = NOW + 180 * H; // deadline = start − 168h = now+12h (in window)
    assertEquals(freeDeadlineMs("staged", iso(start)), start - 168 * H);
    await putResv(kv, u.ledgerId, "S1", "staged", "to_cancel", start);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 1);
    assertEquals(sent.length, 1);
  });
});

// ⑤ an arbitrary (non-preset) policy is swept on ITS own boundary — the whole
// point of the 2026-07-27 model change: 「5日前まで無料」 = start − 120h.
Deno.test("notifies on a custom 5日前 policy boundary", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    const policy = { stages: [{ h: 120, pct: 0 }, { h: 72, pct: 30 }, { h: 0, pct: 100 }] };
    const start = NOW + 132 * H; // deadline = start − 120h = now+12h (in window)
    assertEquals(freeDeadlineMs(policy, iso(start)), start - 120 * H);
    await putResv(kv, u.ledgerId, "C1", policy, "candidate", start);
    // A second reservation with the same policy but a deadline 6 days out.
    await putResv(kv, u.ledgerId, "C2", policy, "candidate", NOW + 264 * H);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 1);
    assertEquals(sent[0]?.text.includes("svc-C1"), true);
  });
});

// ⑥ the ::demo ledger namespace is never swept.
Deno.test("ignores the ::demo ledger", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    await putResv(kv, `${u.ledgerId}::demo`, "D1", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 0);
    assertEquals(sent.length, 0);
  });
});

// ⑦ the owner's own ledger is delivered by LINE push — never by mail.
Deno.test("routes the owner's deadline notification to LINE push", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "owner@b.jp", makeAuthIds());
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    const pushed: string[] = [];
    const deps = withLine(makeDeps(kv, sent), "owner@b.jp", pushed);
    assertEquals(await sweepDeadlineNotifications(deps), 1);
    assertEquals(sent.length, 0);
    assertEquals(pushed.length, 1);
    assertEquals(pushed[0]?.includes("svc-R1"), true);
    assertEquals(pushed[0]?.includes("plancel で確認: https://plancel.test"), true);
    // Same marker regardless of channel → no second push.
    assertEquals(await sweepDeadlineNotifications(deps), 0);
    assertEquals(pushed.length, 1);
  });
});

// ⑧ owner matching ignores case and surrounding whitespace.
Deno.test("matches the owner email case-insensitively", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "Owner@B.jp", makeAuthIds());
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    const pushed: string[] = [];
    const deps = withLine(makeDeps(kv, sent), "  OWNER@b.JP ", pushed);
    assertEquals(await sweepDeadlineNotifications(deps), 1);
    assertEquals(pushed.length, 1);
    assertEquals(sent.length, 0);
  });
});

// ⑨ a non-owner ledger keeps the email/console route even when LINE is wired.
Deno.test("keeps the email route for non-owner users", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "other@b.jp", makeAuthIds());
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    const pushed: string[] = [];
    assertEquals(
      await sweepDeadlineNotifications(withLine(makeDeps(kv, sent), "owner@b.jp", pushed)),
      1,
    );
    assertEquals(pushed.length, 0);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.email, "other@b.jp");
  });
});

// ⑩ a failing push leaves the marker unset, so the next sweep retries.
Deno.test("retries on the next sweep when the LINE push fails", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "owner@b.jp", makeAuthIds());
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    const pushed: string[] = [];
    const base = makeDeps(kv, sent);
    assertEquals(await sweepDeadlineNotifications(withLine(base, "owner@b.jp", pushed, true)), 0);
    assertEquals(sent.length, 0);
    assertEquals(pushed.length, 0);
    // Marker never written → the recovered push goes through next sweep.
    assertEquals(await sweepDeadlineNotifications(withLine(base, "owner@b.jp", pushed)), 1);
    assertEquals(pushed.length, 1);
  });
});

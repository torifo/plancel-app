import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { freeDeadlineMs, type NotifyDeps, sweepDeadlineNotifications } from "../notify.ts";
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
// Per the canonical client `freeDeadline` (first pct>0 stage), free24's
// deadline is start − 0h = start, so start itself must be within 24h.
Deno.test("notifies once for a free24 deadline within 24h", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 12 * H);
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
    await putResv(kv, u.ledgerId, "R1", "free24", "confirmed", NOW + 12 * H);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 1);
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 0);
    assertEquals(sent.length, 1);

    // The marker also survives the reservation being deleted → still no re-notify.
    await kv.delete(["web", u.ledgerId, "resv", "R1"]);
    await putResv(kv, u.ledgerId, "R1", "free24", "confirmed", NOW + 12 * H);
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 0);
    assertEquals(sent.length, 1);
  });
});

// ③ far-future / past / cancelled / unknown are all out of scope.
Deno.test("skips far-future, past, cancelled and unknown-policy reservations", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    // free24 deadline = start; start = now+100h → deadline >24h away → too far.
    await putResv(kv, u.ledgerId, "FAR", "free24", "candidate", NOW + 100 * H);
    // deadline = now−1h → past (not future).
    await putResv(kv, u.ledgerId, "PAST", "free24", "candidate", NOW - 1 * H);
    // in-window shape but cancelled.
    await putResv(kv, u.ledgerId, "CANC", "free24", "cancelled", NOW + 12 * H);
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
// first pct>0 stage of the staged table is {h:72,pct:30}, so the free
// deadline is start − 72h (see report: spec prose says 168h, but the client
// implementation — declared authoritative — resolves to 72h).
Deno.test("staged free deadline is start − 72h (first paid stage) and notifies in-window", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    const start = NOW + 84 * H; // deadline = start − 72h = now+12h (in window)
    assertEquals(freeDeadlineMs("staged", iso(start)), start - 72 * H);
    await putResv(kv, u.ledgerId, "S1", "staged", "to_cancel", start);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 1);
    assertEquals(sent.length, 1);
  });
});

// ⑤ the ::demo ledger namespace is never swept.
Deno.test("ignores the ::demo ledger", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    await putResv(kv, `${u.ledgerId}::demo`, "D1", "free24", "candidate", NOW + 12 * H);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 0);
    assertEquals(sent.length, 0);
  });
});

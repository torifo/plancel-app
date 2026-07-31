import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { type NotifyDeps, sweepDeadlineNotifications } from "../notify.ts";
import { boundaryMs, freeDeadlineMs } from "../policy.ts";
import { getOrCreateUserByEmail, linkLineUser } from "../users.ts";
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

/** Quota / priority knobs — injected, never read from env by notify.ts. */
interface QuotaOpts {
  emailDailyCap?: number;
  allowedEmails?: ReadonlySet<string>;
  logWrite?: (line: string) => void;
}

function makeDeps(
  kv: Deno.Kv,
  sent: Sent[],
  nowMs = NOW,
  opts: QuotaOpts = {},
): NotifyDeps {
  return {
    kv,
    nowMs,
    baseUrl: "https://plancel.test",
    send: (email, subject, text) => {
      sent.push({ email, subject, text });
      return Promise.resolve();
    },
    ...(opts.emailDailyCap !== undefined ? { emailDailyCap: opts.emailDailyCap } : {}),
    ...(opts.allowedEmails !== undefined ? { allowedEmails: opts.allowedEmails } : {}),
    ...(opts.logWrite !== undefined ? { logWrite: opts.logWrite } : {}),
  };
}

/** True when the `boundary24` idempotency marker exists for this reservation. */
async function notified(kv: Deno.Kv, userId: string, resvId: string): Promise<boolean> {
  return (await kv.get(["web_notified", userId, resvId, "boundary24"])).value !== null;
}

const quotaAt = (kv: Deno.Kv, date: string) => kv.get(["email_quota", date]);

/** Adds the per-user LINE push route to a deps object (LINE v2 #1). */
function withLine(
  deps: NotifyDeps,
  pushed: { to: string; text: string }[],
  fail = false,
): NotifyDeps {
  return {
    ...deps,
    line: {
      push: (to, text) => {
        if (fail) return Promise.reject(new Error("line push failed"));
        pushed.push({ to, text });
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
    updated_by: null,
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
    assertEquals(sent[0]?.subject, "[plancel] 無料キャンセル期限が近づいています");
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
    assertEquals(freeDeadlineMs("staged", iso(start)), boundaryMs(start, 168));
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
    assertEquals(freeDeadlineMs(policy, iso(start)), boundaryMs(start, 120));
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

// ⑦ a user with their OWN linked LINE account is pushed to — never mailed.
Deno.test("pushes to the ledger owner's own linked LINE account", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "owner@b.jp", ids);
    await linkLineUser(kv, u.id, "U-owner", ids);
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    const pushed: { to: string; text: string }[] = [];
    const deps = withLine(makeDeps(kv, sent), pushed);
    assertEquals(await sweepDeadlineNotifications(deps), 1);
    assertEquals(sent.length, 0);
    assertEquals(pushed.length, 1);
    assertEquals(pushed[0]?.to, "U-owner");
    assertEquals(pushed[0]?.text.includes("svc-R1"), true);
    assertEquals(pushed[0]?.text.includes("plancel で確認: https://plancel.test"), true);
    // Same marker regardless of channel → no second push.
    assertEquals(await sweepDeadlineNotifications(deps), 0);
    assertEquals(pushed.length, 1);
  });
});

// ⑧ two users, one linked: each reminder goes to its own owner's channel.
Deno.test("routes per user: linked → LINE, unlinked → email, in one sweep", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const a = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    const b = await getOrCreateUserByEmail(kv, "b@b.jp", ids);
    await linkLineUser(kv, b.id, "U-b", ids);
    await putResv(kv, a.ledgerId, "RA", "free24", "candidate", NOW + 36 * H);
    await putResv(kv, b.ledgerId, "RB", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    const pushed: { to: string; text: string }[] = [];
    assertEquals(await sweepDeadlineNotifications(withLine(makeDeps(kv, sent), pushed)), 2);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.email, "a@b.jp");
    assertEquals(sent[0]?.text.includes("svc-RA"), true);
    assertEquals(pushed.length, 1);
    assertEquals(pushed[0]?.to, "U-b");
    assertEquals(pushed[0]?.text.includes("svc-RB"), true);
  });
});

// ⑨ no LINE channel configured at all → everyone keeps the email route.
Deno.test("keeps the email route when no LINE channel is wired", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "other@b.jp", ids);
    await linkLineUser(kv, u.id, "U-other", ids);
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 1);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.email, "other@b.jp");
  });
});

// ⑩ a failing push leaves the marker unset, so the next sweep retries.
Deno.test("retries on the next sweep when the LINE push fails", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const u = await getOrCreateUserByEmail(kv, "owner@b.jp", ids);
    await linkLineUser(kv, u.id, "U-owner", ids);
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    const pushed: { to: string; text: string }[] = [];
    const base = makeDeps(kv, sent);
    assertEquals(await sweepDeadlineNotifications(withLine(base, pushed, true)), 0);
    assertEquals(sent.length, 0);
    assertEquals(pushed.length, 0);
    // Marker never written → the recovered push goes through next sweep.
    assertEquals(await sweepDeadlineNotifications(withLine(base, pushed)), 1);
    assertEquals(pushed.length, 1);
    assertEquals(pushed[0]?.to, "U-owner");
  });
});

// ---- bundling + daily email cap (owner 2026-07-27, 「知人優先で枠を使いたい」) ----

// ⑪ three reservations crossing in ONE sweep cost ONE Resend send, and every
// one of them gets its marker.
Deno.test("bundles every reservation crossing in one sweep into a single message", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    // free24 の無料期限は「前日の終わり」。3件とも開始が 8/2(JST) なので期限は
    // 8/1 23:59 に揃い、まとめて次の24時間に入る。
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 36 * H);
    await putResv(kv, u.ledgerId, "R2", "free24", "confirmed", NOW + 30 * H);
    await putResv(kv, u.ledgerId, "R3", "free24", "to_cancel", NOW + 24 * H);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 1);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.subject, "[plancel] 無料キャンセル期限が近い予約が3件あります");
    for (const id of ["R1", "R2", "R3"]) {
      assertEquals(sent[0]?.text.includes(`svc-${id}`), true);
      assertEquals(await notified(kv, u.id, id), true);
    }
    // One bundle, not three concatenated mails: the link appears exactly once.
    assertEquals(sent[0]?.text.split("plancel で確認").length, 2);
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 0);
    assertEquals(sent.length, 1);
  });
});

// ⑫ one reservation still reads as a sentence — never 「1件あります」.
Deno.test("a single crossing reservation keeps the singular phrasing", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 1);
    assertEquals(sent[0]?.subject, "[plancel] 無料キャンセル期限が近づいています");
    assertEquals(sent[0]?.text.includes("無料キャンセル期限が近い予約があります。"), true);
    assertEquals(sent[0]?.text.includes("1件"), false);
    // free24 の最大料率は 100% → amount 10000 の期限後は ¥10,000。
    assertEquals(sent[0]?.text.includes("期限後の最大キャンセル料 ¥10,000"), true);
    assertEquals(await notified(kv, u.id, "R1"), true);
  });
});

// ⑬ a failed bundle leaves NO marker behind — a partial success must never
// drop a member of the bundle silently.
Deno.test("a failed bundled send writes no markers and retries the whole bundle", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", NOW + 36 * H);
    await putResv(kv, u.ledgerId, "R2", "free24", "candidate", NOW + 30 * H);
    const sent: Sent[] = [];
    const lines: string[] = [];
    const failing: NotifyDeps = {
      ...makeDeps(kv, sent, NOW, { logWrite: (l) => lines.push(l) }),
      send: () => Promise.reject(new Error("resend 429")),
    };
    assertEquals(await sweepDeadlineNotifications(failing), 0);
    assertEquals(await notified(kv, u.id, "R1"), false);
    assertEquals(await notified(kv, u.id, "R2"), false);
    assertEquals(lines.some((l) => l.includes("will retry")), true);
    // A failed send also spends none of the day's quota.
    assertEquals((await quotaAt(kv, "2026-08-01")).value, null);
    // The recovered send takes both in one message next sweep.
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent)), 1);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.text.includes("svc-R1"), true);
    assertEquals(sent[0]?.text.includes("svc-R2"), true);
    assertEquals(await notified(kv, u.id, "R1"), true);
    assertEquals(await notified(kv, u.id, "R2"), true);
  });
});

// ⑭ cap=1, two email users → only the first is served; the second keeps no
// marker and goes out on the first sweep of the next JST day.
// 23:00 JST → 01:00 JST の2時間だけ進める（24h 進めると期限が窓の外に出る）。
const CAP_NOW = Temporal.Instant.from("2026-08-01T14:00:00Z").epochMilliseconds;
const CAP_NEXT_JST_DAY = Temporal.Instant.from("2026-08-01T16:00:00Z").epochMilliseconds;

Deno.test("the daily email cap serves the first user and defers the rest a day", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const a = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    const b = await getOrCreateUserByEmail(kv, "b@b.jp", ids);
    // CAP_NOW は 8/1 23:00(JST)。開始を 8/2 にすると無料期限は 8/1 23:59 で、
    // ちょうど次の24時間に入る（期限は日付の変わり目に揃う）。
    await putResv(kv, a.ledgerId, "RA", "free24", "candidate", CAP_NOW + 12 * H);
    await putResv(kv, b.ledgerId, "RB", "free24", "candidate", CAP_NOW + 12 * H);
    const sent: Sent[] = [];
    const lines: string[] = [];
    const opts: QuotaOpts = { emailDailyCap: 1, logWrite: (l) => lines.push(l) };
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent, CAP_NOW, opts)), 1);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.email, "a@b.jp");
    assertEquals(await notified(kv, a.id, "RA"), true);
    assertEquals(await notified(kv, b.id, "RB"), false);
    assertEquals(lines.some((l) => l.includes("daily email cap reached")), true);
    assertEquals((await quotaAt(kv, "2026-08-01")).value, 1);
    // Same JST day → still capped.
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent, CAP_NOW, opts)), 0);
    assertEquals(sent.length, 1);
    // Next JST day → fresh bucket. RB2 の期限は 8/2 の終わりなのでこの窓に入る。
    await putResv(kv, b.ledgerId, "RB2", "free24", "candidate", CAP_NOW + 36 * H);
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent, CAP_NEXT_JST_DAY, opts)), 1);
    assertEquals(sent.length, 2);
    assertEquals(sent[1]?.email, "b@b.jp");
    assertEquals(await notified(kv, b.id, "RB2"), true);
    // RB は上限で送れないまま日付をまたぎ、期限（8/1 の終わり）が過ぎたので二度と
    // 送られない。期限が日付の変わり目に揃う以上、上限に当たった当日分は翌日には
    // 救えない — 上限は 100通/日 なので実際に起きるのは利用者が100人を超えてから。
    assertEquals(await notified(kv, b.id, "RB"), false);
    assertEquals((await quotaAt(kv, "2026-08-02")).value, 1);
  });
});

// ⑮ 知人優先: the 保証リスト user sorts AFTER the stranger by id, and still
// takes the single available send.
Deno.test("保証リスト users are served first when the daily cap binds", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const stranger = await getOrCreateUserByEmail(kv, "stranger@b.jp", ids);
    const known = await getOrCreateUserByEmail(kv, "friend@b.jp", ids);
    assertEquals(stranger.id < known.id, true); // id order would serve the stranger
    await putResv(kv, stranger.ledgerId, "RS", "free24", "candidate", NOW + 36 * H);
    await putResv(kv, known.ledgerId, "RK", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    const lines: string[] = [];
    const deps = makeDeps(kv, sent, NOW, {
      emailDailyCap: 1,
      allowedEmails: new Set(["friend@b.jp"]),
      logWrite: (l) => lines.push(l),
    });
    assertEquals(await sweepDeadlineNotifications(deps), 1);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.email, "friend@b.jp");
    assertEquals(await notified(kv, known.id, "RK"), true);
    assertEquals(await notified(kv, stranger.id, "RS"), false);
  });
});

// ⑯ LINE push has its own quota: it neither consumes the email cap nor is
// blocked by an exhausted one.
Deno.test("LINE-linked users bypass the email daily cap", async () => {
  await withKv(async (kv) => {
    const ids = makeAuthIds();
    const a = await getOrCreateUserByEmail(kv, "a@b.jp", ids);
    const b = await getOrCreateUserByEmail(kv, "b@b.jp", ids);
    await linkLineUser(kv, b.id, "U-b", ids);
    await putResv(kv, a.ledgerId, "RA", "free24", "candidate", NOW + 36 * H);
    await putResv(kv, b.ledgerId, "RB", "free24", "candidate", NOW + 36 * H);
    const sent: Sent[] = [];
    const pushed: { to: string; text: string }[] = [];
    // cap=1 is spent by a (id-first); b is pushed to anyway.
    const deps = withLine(makeDeps(kv, sent, NOW, { emailDailyCap: 1 }), pushed);
    assertEquals(await sweepDeadlineNotifications(deps), 2);
    assertEquals(sent.length, 1);
    assertEquals(pushed.length, 1);
    assertEquals(pushed[0]?.to, "U-b");
    assertEquals(await notified(kv, b.id, "RB"), true);
    // Only the mail was counted.
    assertEquals((await quotaAt(kv, "2026-08-01")).value, 1);
  });
});

// ⑰ 15:30Z is already 00:30 the NEXT day in JST — the counter must follow the
// Asia/Tokyo date, or a late-evening burst would keep spending yesterday's quota.
Deno.test("the email quota bucket is the Asia/Tokyo date, not the UTC date", async () => {
  await withKv(async (kv) => {
    const u = await getOrCreateUserByEmail(kv, "a@b.jp", makeAuthIds());
    const at = Temporal.Instant.from("2026-08-01T15:30:00Z").epochMilliseconds;
    await putResv(kv, u.ledgerId, "R1", "free24", "candidate", at + 36 * H);
    const sent: Sent[] = [];
    assertEquals(await sweepDeadlineNotifications(makeDeps(kv, sent, at)), 1);
    assertEquals((await quotaAt(kv, "2026-08-02")).value, 1);
    assertEquals((await quotaAt(kv, "2026-08-01")).value, null);
  });
});

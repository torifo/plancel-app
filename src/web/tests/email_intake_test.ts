import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { VirtualClock } from "../../core/clock/mod.ts";
import { MockParser } from "../../parse/mod.ts";
import type { Parser } from "../../parse/mod.ts";
import type { ParseJob } from "../../core/schema/mod.ts";
import {
  type EmailIntakeDeps,
  handleEmailWebhook,
  isEmailWebhookPath,
  MAIL_DAILY_CAP_DEFAULT,
} from "../email-intake.ts";
import { signSvix } from "../email-signature.ts";
import { saveTemplate } from "../policy-template.ts";
import { listReservations } from "../store.ts";
import { getOrCreateUserByEmail, linkLineUser, mailAddressFor, type WebUser } from "../users.ts";
import { makeAuthIds } from "./users_test.ts";

const NOW = "2026-08-01T00:00:00Z";
const NOW_MS = Temporal.Instant.from(NOW).epochMilliseconds;
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const API_KEY = "re_test";
const DOMAIN = "ferouhelee.resend.app";

/** A forwarded confirmation mail the mock parser knows how to read. */
const MAIL = "【予約確認】翠嶺館 8/20 15:00 42,000円 7日前まで無料/3日前30%/前日50%/当日100%";
const MAIL_OUTPUT = {
  raw_response: "{}",
  output: {
    service_name: "翠嶺館",
    starts_at: "2026-08-20T15:00:00+09:00",
    amount_jpy: 42000,
    location: "長野県",
    // Exactly the `staged` preset table — the assertion then reads as a name.
    cancellation_policy: {
      stages: [
        { until_offset_hours: 168, fee_percent: 0, fee_fixed_jpy: null },
        { until_offset_hours: 72, fee_percent: 30, fee_fixed_jpy: null },
        { until_offset_hours: 24, fee_percent: 50, fee_fixed_jpy: null },
        { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
      ],
    },
  },
};
/** Same mail with no fee table at all → policy "unknown" (template rescue). */
const MAIL_NO_POLICY = "【予約確認】翠嶺館 8/20 15:00 42,000円";
const MAIL_NO_POLICY_OUTPUT = {
  raw_response: "{}",
  output: {
    service_name: "翠嶺館",
    starts_at: "2026-08-20T15:00:00+09:00",
    amount_jpy: 42000,
  },
};

interface Pushed {
  to: string;
  text: string;
}

interface Fixture {
  deps: EmailIntakeDeps;
  pushed: Pushed[];
  lines: string[];
  jobs: ParseJob[];
  fetched: string[];
  /** Body the fake Received-Emails API answers with (null = HTTP 500). */
  received: { text?: string | null; html?: string | null; subject?: string | null } | null;
}

interface Opts {
  parsers?: Parser[];
  dailyCap?: number;
  webhookSecret?: string | null;
  apiKey?: string | null;
  line?: boolean;
  nowMs?: number;
}

function makeFixture(kv: Deno.Kv, opts: Opts = {}): Fixture {
  const pushed: Pushed[] = [];
  const lines: string[] = [];
  const jobs: ParseJob[] = [];
  const fetched: string[] = [];
  const clock = new VirtualClock(
    Temporal.Instant.fromEpochMilliseconds(opts.nowMs ?? NOW_MS),
  );
  const fixture: Fixture = {
    pushed,
    lines,
    jobs,
    fetched,
    received: { text: MAIL },
    deps: undefined as unknown as EmailIntakeDeps,
  };
  let n = 0;
  fixture.deps = {
    kv,
    ids: {
      newId: () => `R${String(++n).padStart(4, "0")}`,
      nowIso: () => `${NOW.slice(0, -1)}.000Z`,
    },
    clock,
    parsers: opts.parsers ?? [MockParser("p1", new Map([[MAIL, MAIL_OUTPUT]]))],
    chainConfig: { text: ["p1"], image: ["v1"] },
    ...(opts.webhookSecret === null ? {} : { webhookSecret: opts.webhookSecret ?? SECRET }),
    ...(opts.apiKey === null ? {} : { apiKey: opts.apiKey ?? API_KEY }),
    fetchFn: (input) => {
      fetched.push(String(input));
      if (fixture.received === null) return Promise.resolve(new Response("nope", { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify(fixture.received)));
    },
    saveJob: (job) => {
      jobs.push(job);
      return Promise.resolve();
    },
    ...(opts.line === true
      ? {
        line: {
          push: (to, text) => {
            pushed.push({ to, text });
            return Promise.resolve();
          },
        },
      }
      : {}),
    baseUrl: "https://plancel.test",
    ...(opts.dailyCap !== undefined ? { dailyCap: opts.dailyCap } : {}),
    logWrite: (l) => lines.push(l),
  };
  return fixture;
}

interface EventOpts {
  to?: string[];
  receivedFor?: string[];
  from?: string;
  emailId?: string;
  type?: string;
}

function eventBody(opts: EventOpts = {}): string {
  return JSON.stringify({
    type: opts.type ?? "email.received",
    created_at: NOW,
    data: {
      email_id: opts.emailId ?? "eml_1",
      created_at: NOW,
      from: opts.from ?? "reservations@example.com",
      to: opts.to ?? [],
      cc: [],
      bcc: [],
      received_for: opts.receivedFor ?? [],
      message_id: "<abc@example.com>",
      subject: "ご予約ありがとうございます",
      attachments: [],
    },
  });
}

/** A signed POST, exactly as Resend sends it. */
async function signedRequest(
  rawBody: string,
  opts: { secret?: string; id?: string; timestampMs?: number } = {},
): Promise<Request> {
  const id = opts.id ?? "msg_1";
  const timestamp = String(Math.floor((opts.timestampMs ?? NOW_MS) / 1000));
  const signature = await signSvix(opts.secret ?? SECRET, id, timestamp, rawBody);
  return new Request("https://app.test/webhook/email", {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
      "content-type": "application/json",
    },
    body: rawBody,
  });
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

// One id/token generator per KV: two users created from two fresh generators
// would collide on `ID1`/`ID2` and share a ledger.
const idsByKv = new WeakMap<Deno.Kv, ReturnType<typeof makeAuthIds>>();

function idsFor(kv: Deno.Kv): ReturnType<typeof makeAuthIds> {
  const cached = idsByKv.get(kv);
  if (cached !== undefined) return cached;
  const ids = makeAuthIds();
  idsByKv.set(kv, ids);
  return ids;
}

/** A user whose forward-to address is `p-<mailSecret>@DOMAIN`. */
async function makeUser(kv: Deno.Kv, email = "owner@b.jp"): Promise<WebUser> {
  return await getOrCreateUserByEmail(kv, email, idsFor(kv));
}

const addressOf = (user: WebUser) => mailAddressFor(user.mailSecret ?? "", DOMAIN);

const logged = (lines: string[], msg: string) =>
  lines.some((l) => (JSON.parse(l) as { msg: string }).msg === msg);

Deno.test("email intake: only /webhook/email is the intake path", () => {
  assertEquals(isEmailWebhookPath("/webhook/email"), true);
  assertEquals(isEmailWebhookPath("/webhook"), false);
  assertEquals(isEmailWebhookPath("/webhook/email/x"), false);
});

// ---- signature verification (layer 2: the POST really came from Resend) ----

Deno.test("email intake: a valid signature is accepted", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv);
    const res = await handleEmailWebhook(
      await signedRequest(eventBody({ to: [addressOf(user)] })),
      f.deps,
    );
    assertEquals(res.status, 200);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 1);
  });
});

Deno.test("email intake: a signature from another secret is 401", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv);
    const req = await signedRequest(eventBody({ to: [addressOf(user)] }), {
      secret: "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 401);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 0);
    assertEquals(logged(f.lines, "signature verification failed"), true);
  });
});

Deno.test("email intake: a signature with no headers at all is 401", async () => {
  await withKv(async (kv) => {
    const f = makeFixture(kv);
    const req = new Request("https://app.test/webhook/email", {
      method: "POST",
      body: eventBody(),
    });
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 401);
  });
});

// A captured delivery replayed hours later must not be accepted even though its
// signature is still mathematically correct.
Deno.test("email intake: a stale svix-timestamp is 401", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv);
    const req = await signedRequest(eventBody({ to: [addressOf(user)] }), {
      timestampMs: NOW_MS - 6 * 60 * 1000,
    });
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 401);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 0);
  });
});

Deno.test("email intake: no RESEND_WEBHOOK_SECRET / RESEND_API_KEY -> 503", async () => {
  await withKv(async (kv) => {
    const noSecret = makeFixture(kv, { webhookSecret: null });
    const req1 = await signedRequest(eventBody());
    assertEquals((await handleEmailWebhook(req1, noSecret.deps)).status, 503);

    const noKey = makeFixture(kv, { apiKey: null });
    const req2 = await signedRequest(eventBody());
    assertEquals((await handleEmailWebhook(req2, noKey.deps)).status, 503);
    assertEquals(logged(noKey.lines, "email intake not configured"), true);
  });
});

Deno.test("email intake: a signed body that is not JSON is 400", async () => {
  await withKv(async (kv) => {
    const f = makeFixture(kv);
    assertEquals((await handleEmailWebhook(await signedRequest("not json"), f.deps)).status, 400);
  });
});

// ---- event type filtering (Resend must not retry what we ignore) ----

Deno.test("email intake: a non-email.received type is a 200 no-op", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv);
    const req = await signedRequest(
      eventBody({ type: "email.delivered", to: [addressOf(user)] }),
    );
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 0);
    assertEquals(f.fetched.length, 0); // never even read the body
    assertEquals(logged(f.lines, "event ignored"), true);
  });
});

// ---- recipient resolution (layer 1: the secret is the identity) ----

Deno.test("email intake: the secret in `to` resolves the ledger", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv);
    // Display-name form is what forwarding clients actually send.
    const req = await signedRequest(
      eventBody({ to: [`plancel <${addressOf(user)}>`] }),
    );
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 1);
  });
});

Deno.test("email intake: the secret in `received_for` resolves the ledger", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv);
    const req = await signedRequest(eventBody({
      to: ["someone-else@example.com"],
      receivedFor: [addressOf(user)],
    }));
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 1);
  });
});

Deno.test("email intake: an unknown secret is a 200 drop that writes nothing", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv);
    const req = await signedRequest(
      eventBody({ to: [mailAddressFor("nobodys-secret", DOMAIN)] }),
    );
    const res = await handleEmailWebhook(req, f.deps);
    assertEquals(res.status, 200);
    // The response must not reveal whether a secret matched.
    assertEquals(await res.text(), "");
    assertEquals((await listReservations(kv, user.ledgerId)).length, 0);
    assertEquals(f.fetched.length, 0);
    assertEquals(logged(f.lines, "no ledger for this recipient; dropped"), true);
  });
});

// `from` is forgeable, so a sender that matches a real account resolves nothing.
Deno.test("email intake: a forged `from` matching a real user resolves nothing", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv, "victim@b.jp");
    const f = makeFixture(kv);
    const req = await signedRequest(eventBody({
      from: "victim@b.jp",
      to: ["plancel@example.com"],
      receivedFor: ["plancel@example.com"],
    }));
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 0);
  });
});

// ---- happy path ----

Deno.test("email intake: the fetched body is parsed into a candidate reservation", async () => {
  await withKv(async (kv) => {
    const owner = await makeUser(kv, "owner@b.jp");
    const other = await makeUser(kv, "other@b.jp");
    const f = makeFixture(kv);
    const req = await signedRequest(eventBody({ to: [addressOf(owner)] }));
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);

    assertEquals(f.fetched, ["https://api.resend.com/emails/receiving/eml_1"]);
    const list = await listReservations(kv, owner.ledgerId);
    assertEquals(list.length, 1);
    assertEquals(list[0]?.service, "翠嶺館");
    // モデルが返した "+09:00" は保存時に正規形へそろう（同じ瞬間・src/web/instant.ts）。
    assertEquals(list[0]?.startsAt, "2026-08-20T06:00:00.000Z");
    assertEquals(list[0]?.amount, 42000);
    assertEquals(list[0]?.location, "長野県");
    assertEquals(list[0]?.policy, "staged");
    assertEquals(list[0]?.status, "candidate");
    assertEquals(list[0]?.updated_by, owner.id);
    assertEquals(f.jobs.length, 1); // ParseJob kept for the replay corpus
    // Only the addressed ledger is touched.
    assertEquals((await listReservations(kv, other.ledgerId)).length, 0);
  });
});

Deno.test("email intake: an HTML-only mail is stripped to text and parsed", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv);
    f.received = { text: null, html: `<div><p>${MAIL}</p></div>` };
    const req = await signedRequest(eventBody({ to: [addressOf(user)] }));
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 1);
  });
});

/** 「N日前から◯%」 mail: the boundary the TEXT implies must beat the model's. */
const MAIL_FROM_BOUNDARY =
  "【予約確認】翠嶺館 8/20 15:00 42,000円 キャンセルは7日前から20%頂戴します";
/** What llama-3.3-70b actually answers for it (measured 2026-07-30): 168, not 192. */
const MAIL_FROM_BOUNDARY_OUTPUT = {
  raw_response: "{}",
  output: {
    service_name: "翠嶺館",
    starts_at: "2026-08-20T15:00:00+09:00",
    amount_jpy: 42000,
    cancellation_policy: {
      stages: [
        { until_offset_hours: 168, fee_percent: 0, fee_fixed_jpy: null },
        { until_offset_hours: 0, fee_percent: 20, fee_fixed_jpy: null },
      ],
    },
  },
};

Deno.test("email intake: 「7日前から20%」 lands as 8日前まで無料, whichever model answered", async () => {
  // Forwarded mail has no confirmation screen — whatever this path stores is
  // what the owner sees, so the one-day correction cannot wait for a review.
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv, {
      parsers: [MockParser("p1", new Map([[MAIL_FROM_BOUNDARY, MAIL_FROM_BOUNDARY_OUTPUT]]))],
    });
    f.received = { text: MAIL_FROM_BOUNDARY };
    const req = await signedRequest(eventBody({ to: [addressOf(user)] }));
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);
    const list = await listReservations(kv, user.ledgerId);
    assertEquals(list[0]?.policy, { stages: [{ h: 192, pct: 0 }, { h: 0, pct: 20 }] });
  });
});

// ---- facility policy template ----

Deno.test("email intake: the facility template fills a policy the mail never stated", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    await saveTemplate(kv, user.ledgerId, "翠嶺館", "free24", {
      newId: () => "T1",
      nowIso: () => `${NOW.slice(0, -1)}.000Z`,
    });
    const f = makeFixture(kv, {
      parsers: [MockParser("p1", new Map([[MAIL_NO_POLICY, MAIL_NO_POLICY_OUTPUT]]))],
    });
    f.received = { text: MAIL_NO_POLICY };
    const req = await signedRequest(eventBody({ to: [addressOf(user)] }));
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);
    const list = await listReservations(kv, user.ledgerId);
    assertEquals(list[0]?.policy, "free24");
    assertEquals(logged(f.lines, "forwarded mail registered as a candidate"), true);
  });
});

Deno.test("email intake: a parsed policy is not overwritten by the template", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    // The template says 「前日まで無料」; the mail itself says 「7日前まで無料」.
    await saveTemplate(kv, user.ledgerId, "翠嶺館", "free24", {
      newId: () => "T1",
      nowIso: () => `${NOW.slice(0, -1)}.000Z`,
    });
    const f = makeFixture(kv);
    const req = await signedRequest(eventBody({ to: [addressOf(user)] }));
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);
    assertEquals((await listReservations(kv, user.ledgerId))[0]?.policy, "staged");
  });
});

// ---- parse failure: nothing written, the forwarder is not left hanging ----

Deno.test("email intake: an unparseable forward writes nothing and pushes to LINE", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    await linkLineUser(kv, user.id, "U-owner", idsFor(kv));
    const f = makeFixture(kv, { parsers: [MockParser("p1", new Map())], line: true });
    f.received = { text: "？？？", subject: "何かの通知" };
    const req = await signedRequest(eventBody({ to: [addressOf(user)] }));
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 0);
    assertEquals(f.pushed.length, 1);
    assertEquals(f.pushed[0]?.to, "U-owner");
    assertEquals(f.pushed[0]?.text.includes("読み取れませんでした"), true);
    assertEquals(f.pushed[0]?.text.includes("何かの通知"), true);
    assertEquals(f.pushed[0]?.text.includes("https://plancel.test"), true);
    assertEquals(logged(f.lines, "forwarded mail could not be parsed; nothing written"), true);
  });
});

Deno.test("email intake: an unlinked user gets no push on an unparseable forward", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv, { parsers: [MockParser("p1", new Map())], line: true });
    f.received = { text: "？？？" };
    const req = await signedRequest(eventBody({ to: [addressOf(user)] }));
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 0);
    assertEquals(f.pushed.length, 0);
    assertEquals(logged(f.lines, "no LINE link; unreadable forward not notified"), true);
  });
});

// A Received-Emails read that fails is the ONE case worth a Resend retry.
Deno.test("email intake: a failed body read asks for a retry and stays retryable", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv);
    f.received = null;
    const body = eventBody({ to: [addressOf(user)] });
    assertEquals((await handleEmailWebhook(await signedRequest(body), f.deps)).status, 502);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 0);
    // The idempotency claim was released, so the retry actually re-runs.
    f.received = { text: MAIL };
    assertEquals((await handleEmailWebhook(await signedRequest(body), f.deps)).status, 200);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 1);
  });
});

// ---- idempotency ----

Deno.test("email intake: the same email_id twice creates one reservation", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv);
    const body = eventBody({ to: [addressOf(user)] });
    assertEquals((await handleEmailWebhook(await signedRequest(body), f.deps)).status, 200);
    // Resend's retry: same email_id, a fresh svix-id and signature.
    const retry = await signedRequest(body, { id: "msg_2" });
    assertEquals((await handleEmailWebhook(retry, f.deps)).status, 200);
    assertEquals((await listReservations(kv, user.ledgerId)).length, 1);
    assertEquals(f.jobs.length, 1); // the parsers ran once
    assertEquals(logged(f.lines, "duplicate delivery; already handled"), true);
  });
});

// ---- anti-abuse: the per-user daily cap ----

Deno.test("email intake: the daily cap blocks the forward past it and writes nothing", async () => {
  await withKv(async (kv) => {
    const user = await makeUser(kv);
    const f = makeFixture(kv, { dailyCap: 2 });
    for (const emailId of ["eml_1", "eml_2", "eml_3"]) {
      const req = await signedRequest(eventBody({ to: [addressOf(user)], emailId }));
      assertEquals((await handleEmailWebhook(req, f.deps)).status, 200);
    }
    assertEquals((await listReservations(kv, user.ledgerId)).length, 2);
    assertEquals(f.jobs.length, 2); // the blocked forward burned no LLM quota
    assertEquals(logged(f.lines, "daily forward cap reached; dropped"), true);
    // Default is the 50 documented in docs/DEPLOY.md.
    assertEquals(MAIL_DAILY_CAP_DEFAULT, 50);
  });
});

Deno.test("email intake: the cap is per user, not global", async () => {
  await withKv(async (kv) => {
    const a = await makeUser(kv, "a@b.jp");
    const b = await makeUser(kv, "b@b.jp");
    const f = makeFixture(kv, { dailyCap: 1 });
    const first = await signedRequest(eventBody({ to: [addressOf(a)], emailId: "eml_1" }));
    assertEquals((await handleEmailWebhook(first, f.deps)).status, 200);
    const second = await signedRequest(eventBody({ to: [addressOf(b)], emailId: "eml_2" }));
    assertEquals((await handleEmailWebhook(second, f.deps)).status, 200);
    assertEquals((await listReservations(kv, a.ledgerId)).length, 1);
    assertEquals((await listReservations(kv, b.ledgerId)).length, 1);
  });
});

// ---- raw-body ceiling ----

Deno.test("email intake: an oversized body is refused before it is parsed", async () => {
  await withKv(async (kv) => {
    const f = makeFixture(kv);
    const req = await signedRequest(`{"type":"email.received","pad":"${"x".repeat(70_000)}"}`);
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 413);
    assertEquals(logged(f.lines, "webhook body over the size ceiling"), true);
  });
});

Deno.test("email intake: a non-POST is 405", async () => {
  await withKv(async (kv) => {
    const f = makeFixture(kv);
    const req = new Request("https://app.test/webhook/email", { method: "GET" });
    assertEquals((await handleEmailWebhook(req, f.deps)).status, 405);
  });
});

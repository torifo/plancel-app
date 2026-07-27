import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { InMemoryStore } from "../../core/store/mod.ts";
import { VirtualClock } from "../../core/clock/mod.ts";
import { MockParser } from "../../parse/mod.ts";
import type { ParserChainConfig } from "../../parse/mod.ts";
import type { ToolContext } from "../../mcp/context.ts";
import { signLineBody } from "../signature.ts";
import { handleLineWebhook, type LineWebhookDeps } from "../webhook.ts";
import type { LineMessagingClient, LineTextMessage } from "../types.ts";
import type { LineWebDeps } from "../web-commands.ts";
import type { CancellationPolicyOrUnknown } from "../../core/schema/mod.ts";
import {
  cancelReservation,
  createReservation,
  getReservation,
  listReservations,
} from "../../web/store.ts";
import {
  type AuthIds,
  findUserByLineUserId,
  getOrCreateUserByEmail,
  getUser,
  issueLineLinkCode,
  linkLineUser,
  setUid,
} from "../../web/users.ts";
import { makeAuthIds } from "../../web/tests/users_test.ts";

const SECRET = "channel-secret";
const OWNER = "U-owner";
const CONFIG: ParserChainConfig = { text: ["p1", "p2"], image: ["vision"] };

function makeCtx(): ToolContext {
  let counter = 0;
  return {
    store: new InMemoryStore(),
    clock: new VirtualClock("2026-07-04T00:00:00Z"),
    ids: { newUlid: () => `JAB${String(++counter).padStart(23, "0")}` },
  };
}

function fakeClient() {
  const replies: { token: string; messages: LineTextMessage[] }[] = [];
  const contentRequests: string[] = [];
  const client: LineMessagingClient = {
    reply(token, messages) {
      replies.push({ token, messages });
      return Promise.resolve();
    },
    push: () => Promise.resolve(),
    getMessageContent(messageId) {
      contentRequests.push(messageId);
      return Promise.resolve({ mimeType: "image/png", base64: "AAAA" });
    },
  };
  return { client, replies, contentRequests };
}

function makeDeps(overrides: Partial<LineWebhookDeps> = {}) {
  const ctx = makeCtx();
  const { client, replies, contentRequests } = fakeClient();
  const deps: LineWebhookDeps = {
    channelSecret: SECRET,
    allowedUserIds: new Set([OWNER]),
    ctx,
    parsers: [],
    chainConfig: CONFIG,
    client,
    logWrite: () => {},
    ...overrides,
  };
  return { deps, ctx, replies, contentRequests };
}

function textEvent(text: string, userId = OWNER) {
  return {
    type: "message",
    replyToken: "reply-1",
    source: { type: "user", userId },
    message: { id: "m1", type: "text", text },
  };
}

async function post(deps: LineWebhookDeps, events: unknown[]) {
  const rawBody = JSON.stringify({ events });
  const signature = await signLineBody(SECRET, rawBody);
  return await handleLineWebhook(rawBody, signature, deps);
}

Deno.test("webhook: invalid signature -> 401, nothing processed", async () => {
  const { deps, replies } = makeDeps();
  const result = await handleLineWebhook(JSON.stringify({ events: [textEvent("x")] }), "bad", deps);
  assertEquals(result.status, 401);
  assertEquals(replies.length, 0);
});

Deno.test("webhook: sender outside the allowlist is ignored", async () => {
  const { deps, ctx, replies } = makeDeps();
  const result = await post(deps, [textEvent("土曜19時に〇〇を予約", "U-stranger")]);
  assertEquals(result.status, 200);
  assertEquals(result.handled, ["ignored:not-allowed"]);
  assertEquals(replies.length, 0);
  assertEquals(await ctx.store.listParseJobs(), []);
});

Deno.test("webhook: clean text parse -> reservation registered + summary reply", async () => {
  const text = "8/1 19時に〇〇を予約";
  const parser = MockParser(
    "p1",
    new Map([[text, {
      raw_response: '{"service_name":"〇〇","starts_at":"2026-08-01T19:00:00+09:00"}',
      output: { service_name: "〇〇", starts_at: "2026-08-01T19:00:00+09:00" },
    }]]),
  );
  const { deps, ctx, replies } = makeDeps();
  deps.parsers = [parser];

  const result = await post(deps, [textEvent(text)]);

  assertEquals(result.handled, ["registered"]);
  const reservations = await ctx.store.listReservations();
  assertEquals(reservations.length, 1);
  assertEquals(reservations[0]?.service_name, "〇〇");
  assertEquals(reservations[0]?.source, "line");
  assertEquals(reservations[0]?.status, "candidate");
  const jobs = await ctx.store.listParseJobs();
  assertEquals(jobs[0]?.status, "parsed");
  assertEquals(reservations[0]?.raw_input_ref, jobs[0]?.id);
  assertStringIncludes(replies[0]?.messages[0]?.text ?? "", "登録しました: 〇〇");
});

Deno.test("webhook: field conflict -> Quick Reply; postback one-tap -> registered + resolved", async () => {
  const text = "土曜19時に〇〇を仮予約";
  const p1 = MockParser(
    "p1",
    // p1 misses service_name (fails rule validation, schema-storable) so the
    // chain falls through to p2 while still producing a starts_at conflict.
    new Map([[text, {
      raw_response: '{"starts_at":"2026-08-01T19:00:00+09:00"}',
      output: { starts_at: "2026-08-01T19:00:00+09:00" },
    }]]),
  );
  const p2 = MockParser(
    "p2",
    new Map([[text, {
      raw_response: '{"service_name":"〇〇","starts_at":"2026-08-01T19:30:00+09:00"}',
      output: { service_name: "〇〇", starts_at: "2026-08-01T19:30:00+09:00" },
    }]]),
  );
  const { deps, ctx, replies } = makeDeps();
  deps.parsers = [p1, p2];

  const first = await post(deps, [textEvent(text)]);
  assertEquals(first.handled, ["needs_review"]);

  // Quick Reply asks about the conflicting field, one button per option.
  const quick = replies[0]?.messages[0];
  assertStringIncludes(quick?.text ?? "", "starts_at");
  const items = quick?.quickReply?.items ?? [];
  assertEquals(items.length, 2);
  const data = items[1]?.action.data ?? "";
  assertStringIncludes(data, "resolve|");
  assertStringIncludes(data, "|starts_at|1");

  // One tap on the second option (19:30) resolves and registers.
  const second = await post(deps, [{
    type: "postback",
    replyToken: "reply-2",
    source: { type: "user", userId: OWNER },
    postback: { data },
  }]);
  assertEquals(second.handled, ["postback:registered"]);

  const reservations = await ctx.store.listReservations();
  assertEquals(reservations.length, 1);
  // The chosen 19:30+09:00 option, UTC-canonicalized by isoDateTimeSchema.
  assertEquals(reservations[0]?.starts_at, "2026-08-01T10:30:00.000Z");
  const jobs = await ctx.store.listParseJobs();
  assertEquals(jobs[0]?.status, "resolved");
  assertStringIncludes(replies[1]?.messages[0]?.text ?? "", "登録しました");
});

Deno.test("webhook: missing required field -> asks ONLY for what is missing", async () => {
  const text = "〇〇を予約したい";
  const parser = MockParser(
    "p1",
    new Map([[text, {
      raw_response: '{"service_name":"〇〇"}',
      output: { service_name: "〇〇" },
    }]]),
  );
  const { deps, ctx, replies } = makeDeps();
  deps.parsers = [parser];

  const result = await post(deps, [textEvent(text)]);

  assertEquals(result.handled, ["needs_review"]);
  assertStringIncludes(replies[0]?.messages[0]?.text ?? "", "starts_at");
  assertEquals(await ctx.store.listReservations(), []);
});

Deno.test("webhook: all parsers fail -> failure reply, job recorded as failed", async () => {
  const parser = MockParser("p1", new Map());
  const { deps, ctx, replies } = makeDeps();
  deps.parsers = [parser];

  const result = await post(deps, [textEvent("？？？")]);

  assertEquals(result.handled, ["failed"]);
  assertStringIncludes(replies[0]?.messages[0]?.text ?? "", "読み取れませんでした");
  assertEquals((await ctx.store.listParseJobs())[0]?.status, "failed");
});

Deno.test("webhook: image message -> content downloaded and parsed via image chain", async () => {
  const vision = MockParser("vision", (input) =>
    input.type === "image"
      ? {
        raw_response: '{"service_name":"宿","starts_at":"2026-08-10T15:00:00+09:00"}',
        output: { service_name: "宿", starts_at: "2026-08-10T15:00:00+09:00" },
      }
      : undefined);
  const { deps, ctx, replies, contentRequests } = makeDeps();
  deps.parsers = [vision];

  const result = await post(deps, [{
    type: "message",
    replyToken: "reply-1",
    source: { type: "user", userId: OWNER },
    message: { id: "img-123", type: "image" },
  }]);

  assertEquals(result.handled, ["registered"]);
  assertEquals(contentRequests, ["img-123"]);
  const jobs = await ctx.store.listParseJobs();
  assertEquals(jobs[0]?.input_type, "image");
  assertStringIncludes(jobs[0]?.raw_input ?? "", "data:image/png;base64,AAAA");
  assertStringIncludes(replies[0]?.messages[0]?.text ?? "", "登録しました: 宿");
});

// ---- WEB-ledger check / narrow update (LINE v2 #2 + #3) ----

const OWNER_EMAIL = "owner@example.com";
const OTHER = "U-other";
const OTHER_EMAIL = "other@example.com";
const NOW_MS = Temporal.Instant.from("2026-08-01T00:00:00+09:00").epochMilliseconds;

/**
 * Web-ledger surface + a seeded, LINE-LINKED owner. The sender's link is what
 * resolves a ledger now, so `seed` lets a test add a second account (linked or
 * not) and prove the two never see each other's reservations.
 */
async function makeWebDeps(kv: Deno.Kv) {
  const authIds = makeAuthIds();
  const webIds: AuthIds = {
    ...authIds,
    newId: () => `R${++seq}`,
    nowIso: () => "2026-08-01T00:00:00.000Z",
  };
  const mutated: string[] = [];
  const web: LineWebDeps = {
    kv,
    ids: webIds,
    nowMs: () => NOW_MS,
    onMutate: (_user, resvId) => mutated.push(resvId),
  };
  /** Creates (or re-reads) a user with a uid — the label replies name it by. */
  const seed = async (email: string, lineUserId: string | null) => {
    const user = await getOrCreateUserByEmail(kv, email, authIds);
    await setUid(kv, user.id, email.split("@")[0] ?? "", authIds);
    if (lineUserId !== null) await linkLineUser(kv, user.id, lineUserId, authIds);
    return (await getUser(kv, user.id)) ?? user;
  };
  const owner = await seed(OWNER_EMAIL, OWNER);
  return { web, owner, webIds, mutated, seed, authIds };
}
let seq = 0;

/** Ids whose `nowIso` matches NOW_MS, so an issued link code is not expired. */
function makeCodeIds(): AuthIds {
  return {
    ...makeAuthIds(),
    nowIso: () => Temporal.Instant.fromEpochMilliseconds(NOW_MS).toString(),
  };
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

Deno.test("webhook: 「確認」 -> web-ledger summary + action Quick Reply", async () => {
  await withKv(async (kv) => {
    const { web, owner, webIds } = await makeWebDeps(kv);
    const a = await createReservation(kv, owner.ledgerId, {
      plan: "夏旅",
      service: "湖畔の湯宿 蛍",
      startsAt: "2026-08-22T15:00:00+09:00",
      amount: 40000,
      location: null,
      policy: "staged",
      confirmed: false,
    }, webIds);
    const b = await createReservation(kv, owner.ledgerId, {
      plan: "夏旅",
      service: "翠嶺館",
      startsAt: "2026-08-23T15:00:00+09:00",
      amount: null,
      location: null,
      policy: "unknown",
      confirmed: false,
    }, webIds);
    await cancelReservation(kv, owner.ledgerId, b.id, webIds);

    const { deps, replies } = makeDeps({ web });
    const result = await post(deps, [textEvent("確認")]);

    assertEquals(result.handled, ["web:check"]);
    const msg = replies[0]?.messages[0];
    const body = msg?.text ?? "";
    // Every reply names the account it read — one person may own several.
    assertStringIncludes(body, "@owner のWeb台帳の予約 1件");
    // 8/22 start, staged policy -> free until 168h before = 8/15.
    assertStringIncludes(body, "8/22(土) 湖畔の湯宿 蛍 [候補] ◆8/15(土)まで¥0");
    assertStringIncludes(body, "◆次の締切 8/15(土)");
    assertStringIncludes(body, "放置損失 ¥40,000");
    // Cancelled reservations are out of the summary entirely.
    assertEquals(body.includes("翠嶺館"), false);
    const items = msg?.quickReply?.items ?? [];
    assertEquals(items.length, 1);
    assertEquals(items[0]?.action.data, `webact|confirm|${a.id}`);
    assertStringIncludes(items[0]?.action.label ?? "", "確定:");
  });
});

Deno.test("webhook: empty web ledger -> friendly one-liner, no Quick Reply", async () => {
  await withKv(async (kv) => {
    const { web } = await makeWebDeps(kv);
    const { deps, replies } = makeDeps({ web });
    const result = await post(deps, [textEvent("一覧")]);
    assertEquals(result.handled, ["web:check"]);
    assertStringIncludes(
      replies[0]?.messages[0]?.text ?? "",
      "@owner のWeb台帳に予約はまだありません",
    );
    assertEquals(replies[0]?.messages[0]?.quickReply, undefined);
  });
});

Deno.test("webhook: webact confirm -> siblings to_cancel + calendar sync requested", async () => {
  await withKv(async (kv) => {
    const { web, owner, webIds, mutated } = await makeWebDeps(kv);
    const base = {
      plan: "夏旅",
      startsAt: "2026-08-22T15:00:00+09:00",
      amount: null,
      location: null,
      policy: "free24" as const,
      confirmed: false,
    };
    const a = await createReservation(kv, owner.ledgerId, { ...base, service: "宿A" }, webIds);
    const b = await createReservation(kv, owner.ledgerId, { ...base, service: "宿B" }, webIds);
    const c = await createReservation(kv, owner.ledgerId, { ...base, service: "宿C" }, webIds);

    const { deps, replies } = makeDeps({ web });
    const result = await post(deps, [{
      type: "postback",
      replyToken: "reply-2",
      source: { type: "user", userId: OWNER },
      postback: { data: `webact|confirm|${a.id}` },
    }]);

    assertEquals(result.handled, ["web:confirm"]);
    assertEquals((await getReservation(kv, owner.ledgerId, a.id))?.status, "confirmed");
    assertEquals((await getReservation(kv, owner.ledgerId, b.id))?.status, "to_cancel");
    assertEquals((await getReservation(kv, owner.ledgerId, c.id))?.status, "to_cancel");
    // Same as the web API: the acted reservation is the one handed to the sync.
    assertEquals(mutated, [a.id]);
    const text = replies[0]?.messages[0]?.text ?? "";
    assertStringIncludes(text, "確定しました: 宿A（@owner）");
    assertStringIncludes(text, "同プランの残り2件を要キャンセルにしました。");
  });
});

Deno.test("webhook: webact cancel -> reservation cancelled; stale id -> polite reply", async () => {
  await withKv(async (kv) => {
    const { web, owner, webIds, mutated } = await makeWebDeps(kv);
    const r = await createReservation(kv, owner.ledgerId, {
      plan: null,
      service: "翠嶺館",
      startsAt: "2026-08-22T15:00:00+09:00",
      amount: null,
      location: null,
      policy: "free24",
      confirmed: true,
    }, webIds);

    const { deps, replies } = makeDeps({ web });
    const postback = (data: string, token: string) => ({
      type: "postback",
      replyToken: token,
      source: { type: "user", userId: OWNER },
      postback: { data },
    });

    const ok = await post(deps, [postback(`webact|cancel|${r.id}`, "reply-2")]);
    assertEquals(ok.handled, ["web:cancel"]);
    assertEquals((await getReservation(kv, owner.ledgerId, r.id))?.status, "cancelled");
    assertEquals(mutated, [r.id]);
    assertStringIncludes(
      replies[0]?.messages[0]?.text ?? "",
      "キャンセル済みにしました: 翠嶺館（@owner）",
    );

    const stale = await post(deps, [postback("webact|cancel|R-gone", "reply-3")]);
    assertEquals(stale.handled, ["web:cancel"]);
    assertStringIncludes(replies[1]?.messages[0]?.text ?? "", "すでに処理済み");
  });
});

// ---- Registration into the web ledger (LINE v2 #4) ----

/** The three web policy presets expressed as core `cancellation_policy` values. */
const CORE_POLICY = {
  none: { stages: [{ until_offset_hours: 0, fee_percent: 0, fee_fixed_jpy: null }] },
  free24: {
    stages: [
      { until_offset_hours: 24, fee_percent: 0, fee_fixed_jpy: null },
      { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
    ],
  },
  staged: {
    stages: [
      { until_offset_hours: 168, fee_percent: 0, fee_fixed_jpy: null },
      { until_offset_hours: 72, fee_percent: 30, fee_fixed_jpy: null },
      { until_offset_hours: 24, fee_percent: 50, fee_fixed_jpy: null },
      { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
    ],
  },
  /** Nonstandard: real stages, no preset match -> preserved as a stage table. */
  weird: {
    stages: [
      { until_offset_hours: 48, fee_percent: 20, fee_fixed_jpy: null },
      { until_offset_hours: 12, fee_percent: 80, fee_fixed_jpy: null },
    ],
  },
  /** 「5日前まで無料」 — the shape the owner needed and presets could not hold. */
  fiveDay: {
    stages: [
      { until_offset_hours: 120, fee_percent: 0, fee_fixed_jpy: null },
      { until_offset_hours: 72, fee_percent: 30, fee_fixed_jpy: null },
      { until_offset_hours: 0, fee_percent: 100, fee_fixed_jpy: null },
    ],
  },
  /** A fixed-yen fee has no % expression -> the honest answer is "unknown". */
  fixedFee: {
    stages: [
      { until_offset_hours: 72, fee_percent: 0, fee_fixed_jpy: 0 },
      { until_offset_hours: 0, fee_percent: 0, fee_fixed_jpy: 5000 },
    ],
  },
} satisfies Record<string, CancellationPolicyOrUnknown>;

Deno.test("webhook: parsed text with web wired -> web-ledger candidate, NOT the core ledger", async () => {
  await withKv(async (kv) => {
    const { web, owner, mutated } = await makeWebDeps(kv);
    const text = "8/1 19時に〇〇を予約";
    const parser = MockParser(
      "p1",
      new Map([[text, {
        raw_response: '{"service_name":"〇〇","starts_at":"2026-08-01T19:00:00+09:00"}',
        output: {
          service_name: "〇〇",
          starts_at: "2026-08-01T19:00:00+09:00",
          amount_jpy: 12000,
          location: "港区",
          cancellation_policy: CORE_POLICY.staged,
        },
      }]]),
    );
    const { deps, ctx, replies } = makeDeps({ web });
    deps.parsers = [parser];

    const result = await post(deps, [textEvent(text)]);
    assertEquals(result.handled, ["registered"]);

    // The core event-sourced ledger stays untouched when web is the sink.
    assertEquals(await ctx.store.listReservations(), []);
    const own = await listReservations(kv, owner.ledgerId);
    assertEquals(own.length, 1);
    const r = own[0];
    assertEquals(r?.service, "〇〇");
    assertEquals(r?.startsAt, "2026-08-01T10:00:00.000Z");
    assertEquals(r?.amount, 12000);
    assertEquals(r?.location, "港区");
    assertEquals(r?.policy, "staged");
    assertEquals(r?.plan, null);
    assertEquals(r?.status, "candidate");
    // Same post-write hook the HTTP API fires on create.
    assertEquals(mutated, [r?.id]);
    // ParseJob lifecycle is unchanged.
    assertEquals((await ctx.store.listParseJobs())[0]?.status, "parsed");
    const body = replies[0]?.messages[0]?.text ?? "";
    assertStringIncludes(body, "登録しました: 〇〇 / 8/1(土) 19:00");
    assertStringIncludes(body, "@owner のWeb台帳に候補として入りました");
    assertEquals(body.includes("規定は不明"), false);
  });
});

/** Registers one parsed reservation and returns the stored record + reply text. */
async function registerParsed(
  kv: Deno.Kv,
  label: string,
  policy: CancellationPolicyOrUnknown | undefined,
) {
  const { web, owner } = await makeWebDeps(kv);
  const text = `${label} 8/1 19時に〇〇を予約`;
  const parser = MockParser(
    "p1",
    new Map([[text, {
      raw_response: "{}",
      output: {
        service_name: `宿-${label}`,
        starts_at: "2026-08-01T19:00:00+09:00",
        ...(policy === undefined ? {} : { cancellation_policy: policy }),
      },
    }]]),
  );
  const { deps, replies } = makeDeps({ web });
  deps.parsers = [parser];
  assertEquals((await post(deps, [textEvent(text)])).handled, ["registered"]);
  const r = (await listReservations(kv, owner.ledgerId)).find((x) => x.service === `宿-${label}`);
  return { r, text: replies[0]?.messages[0]?.text ?? "" };
}

// 2026-07-27: arbitrary parsed stages are PRESERVED (the web model now holds
// them) instead of being flattened onto a preset or dropped as "unknown".
Deno.test("webhook: nonstandard parsed policy -> stored as its own stage table", async () => {
  await withKv(async (kv) => {
    const weird = await registerParsed(kv, "weird", CORE_POLICY.weird);
    // 12h の段は「開始まで80%」と同義なので、正規形では h=0 に畳まれる。
    assertEquals(weird.r?.policy, { stages: [{ h: 48, pct: 20 }, { h: 0, pct: 80 }] });
    assertEquals(weird.text.includes("キャンセル規定は不明"), false);

    const five = await registerParsed(kv, "five", CORE_POLICY.fiveDay);
    assertEquals(five.r?.policy, {
      stages: [{ h: 120, pct: 0 }, { h: 72, pct: 30 }, { h: 0, pct: 100 }],
    });
  });
});

// A policy with no % expression at all still becomes "unknown" — reported, so
// the owner completes it in the web UI rather than being told a wrong number.
Deno.test("webhook: fixed-yen fee / absent parsed policy -> unknown, and says so", async () => {
  await withKv(async (kv) => {
    for (
      const [label, policy] of [["fixed", CORE_POLICY.fixedFee], ["absent", undefined]] as const
    ) {
      const { r, text } = await registerParsed(kv, label, policy);
      assertEquals(r?.policy, "unknown", label);
      assertStringIncludes(text, "キャンセル規定は不明");
    }
  });
});

Deno.test("webhook: preset policies map exactly (none/free24)", async () => {
  await withKv(async (kv) => {
    for (const name of ["none", "free24"] as const) {
      const { web, owner } = await makeWebDeps(kv);
      const text = `${name} を予約`;
      const parser = MockParser(
        "p1",
        new Map([[text, {
          raw_response: "{}",
          output: {
            service_name: `宿-${name}`,
            starts_at: "2026-08-01T19:00:00+09:00",
            cancellation_policy: CORE_POLICY[name],
          },
        }]]),
      );
      const { deps } = makeDeps({ web });
      deps.parsers = [parser];
      assertEquals((await post(deps, [textEvent(text)])).handled, ["registered"]);
      const r = (await listReservations(kv, owner.ledgerId)).find(
        (x) => x.service === `宿-${name}`,
      );
      assertEquals(r?.policy, name);
    }
  });
});

Deno.test("webhook: postback-resolved registration lands in the web ledger too", async () => {
  await withKv(async (kv) => {
    const { web, owner } = await makeWebDeps(kv);
    const text = "土曜19時に〇〇を仮予約";
    const p1 = MockParser(
      "p1",
      new Map([[text, {
        raw_response: '{"starts_at":"2026-08-01T19:00:00+09:00"}',
        output: { starts_at: "2026-08-01T19:00:00+09:00" },
      }]]),
    );
    const p2 = MockParser(
      "p2",
      new Map([[text, {
        raw_response: '{"service_name":"〇〇","starts_at":"2026-08-01T19:30:00+09:00"}',
        output: { service_name: "〇〇", starts_at: "2026-08-01T19:30:00+09:00" },
      }]]),
    );
    const { deps, ctx, replies } = makeDeps({ web });
    deps.parsers = [p1, p2];

    await post(deps, [textEvent(text)]);
    const data = replies[0]?.messages[0]?.quickReply?.items[1]?.action.data ?? "";
    const second = await post(deps, [{
      type: "postback",
      replyToken: "reply-2",
      source: { type: "user", userId: OWNER },
      postback: { data },
    }]);

    assertEquals(second.handled, ["postback:registered"]);
    assertEquals(await ctx.store.listReservations(), []);
    const own = await listReservations(kv, owner.ledgerId);
    assertEquals(own.length, 1);
    assertEquals(own[0]?.startsAt, "2026-08-01T10:30:00.000Z");
    // ParseJob lifecycle is identical to the core-ledger path.
    assertEquals((await ctx.store.listParseJobs())[0]?.status, "resolved");
    assertStringIncludes(replies[1]?.messages[0]?.text ?? "", "Web台帳に候補として入りました");
  });
});

// ---- Per-user linking (owner 2026-07-27) ----

Deno.test("webhook: unlinked sender gets link guidance; nothing is parsed or written", async () => {
  await withKv(async (kv) => {
    const { web } = await makeWebDeps(kv);
    const text = "8/1 19時に〇〇を予約";
    const parser = MockParser(
      "p1",
      new Map([[text, {
        raw_response: "{}",
        output: { service_name: "〇〇", starts_at: "2026-08-01T19:00:00+09:00" },
      }]]),
    );
    // U-nolink is in the legacy allowlist but has no plancel link.
    const { deps, ctx, replies } = makeDeps({
      web,
      allowedUserIds: new Set([OWNER, "U-nolink"]),
    });
    deps.parsers = [parser];

    const result = await post(deps, [textEvent(text, "U-nolink")]);
    assertEquals(result.handled, ["line:guide"]);
    const reply = replies[0]?.messages[0]?.text ?? "";
    assertStringIncludes(reply, "まだ plancel のアカウントと連携されていません");
    assertStringIncludes(reply, "https://plancel-app.torifo.deno.net");
    assertStringIncludes(reply, "連携コード");
    // No parse job, no reservation anywhere.
    assertEquals(await ctx.store.listParseJobs(), []);
    assertEquals(await ctx.store.listReservations(), []);
    assertEquals(await findUserByLineUserId(kv, "U-nolink"), null);
  });
});

Deno.test("webhook: an unlinked sender's link code links the account and names it", async () => {
  await withKv(async (kv) => {
    const { web, seed } = await makeWebDeps(kv);
    const target = await seed(OTHER_EMAIL, null); // logged in on the web, no LINE yet
    const code = await issueLineLinkCode(kv, target.id, makeCodeIds()) ?? "";
    const { deps, ctx, replies } = makeDeps({ web, allowedUserIds: new Set<string>() });

    // A wrong code links nothing.
    const wrong = await post(deps, [textEvent("ABCDEFGH", OTHER)]);
    assertEquals(wrong.handled, ["line:bad-code"]);
    assertStringIncludes(replies[0]?.messages[0]?.text ?? "", "連携コードが確認できませんでした");
    assertEquals(await findUserByLineUserId(kv, OTHER), null);

    // The real code links, and the reply says WHICH account was linked.
    const ok = await post(deps, [textEvent(` ${code.toLowerCase()} `, OTHER)]);
    assertEquals(ok.handled, ["line:linked"]);
    assertStringIncludes(replies[1]?.messages[0]?.text ?? "", "LINE連携が完了しました: @other");
    assertEquals((await findUserByLineUserId(kv, OTHER))?.id, target.id);
    assertEquals(await ctx.store.listParseJobs(), []);

    // Single-use: the same code cannot link a second LINE account.
    const reuse = await post(deps, [textEvent(code, "U-third")]);
    assertEquals(reuse.handled, ["line:bad-code"]);
    assertEquals(await findUserByLineUserId(kv, "U-third"), null);

    // Once linked, the same sender is served their own ledger.
    const check = await post(deps, [textEvent("確認", OTHER)]);
    assertEquals(check.handled, ["web:check"]);
    assertStringIncludes(replies[3]?.messages[0]?.text ?? "", "@other のWeb台帳");
  });
});

Deno.test("webhook: 確認 shows ONLY the sender's own ledger (isolation)", async () => {
  await withKv(async (kv) => {
    const { web, owner, webIds, seed } = await makeWebDeps(kv);
    const other = await seed(OTHER_EMAIL, OTHER);
    const base = {
      plan: null,
      startsAt: "2026-08-22T15:00:00+09:00",
      amount: null,
      location: null,
      policy: "free24" as const,
      confirmed: false,
    };
    await createReservation(kv, owner.ledgerId, { ...base, service: "オーナーの宿" }, webIds);
    await createReservation(kv, other.ledgerId, { ...base, service: "他人の宿" }, webIds);

    // A linked sender is served even though the legacy allowlist lists only OWNER.
    const { deps, replies } = makeDeps({ web, allowedUserIds: new Set([OWNER]) });
    assertEquals((await post(deps, [textEvent("確認", OTHER)])).handled, ["web:check"]);
    const otherBody = replies[0]?.messages[0]?.text ?? "";
    assertStringIncludes(otherBody, "@other のWeb台帳の予約 1件");
    assertStringIncludes(otherBody, "他人の宿");
    assertEquals(otherBody.includes("オーナーの宿"), false);

    assertEquals((await post(deps, [textEvent("確認", OWNER)])).handled, ["web:check"]);
    const ownerBody = replies[1]?.messages[0]?.text ?? "";
    assertStringIncludes(ownerBody, "オーナーの宿");
    assertEquals(ownerBody.includes("他人の宿"), false);
  });
});

Deno.test("webhook: parse-and-add lands in the SENDER's ledger, not the other user's", async () => {
  await withKv(async (kv) => {
    const { web, owner, seed } = await makeWebDeps(kv);
    const other = await seed(OTHER_EMAIL, OTHER);
    const text = "8/1 19時に〇〇を予約";
    const parser = MockParser(
      "p1",
      new Map([[text, {
        raw_response: "{}",
        output: { service_name: "〇〇", starts_at: "2026-08-01T19:00:00+09:00" },
      }]]),
    );
    const { deps, replies } = makeDeps({ web });
    deps.parsers = [parser];

    assertEquals((await post(deps, [textEvent(text, OTHER)])).handled, ["registered"]);
    assertEquals((await listReservations(kv, other.ledgerId)).length, 1);
    assertEquals(await listReservations(kv, owner.ledgerId), []);
    assertStringIncludes(replies[0]?.messages[0]?.text ?? "", "@other のWeb台帳に候補として");
  });
});

Deno.test("webhook: a webact postback for another user's reservation id does nothing", async () => {
  await withKv(async (kv) => {
    const { web, owner, webIds, mutated, seed } = await makeWebDeps(kv);
    await seed(OTHER_EMAIL, OTHER);
    const mine = await createReservation(kv, owner.ledgerId, {
      plan: null,
      service: "オーナーの宿",
      startsAt: "2026-08-22T15:00:00+09:00",
      amount: null,
      location: null,
      policy: "free24",
      confirmed: false,
    }, webIds);

    // OTHER taps a Quick Reply carrying the OWNER's reservation id.
    const { deps, replies } = makeDeps({ web });
    const result = await post(deps, [{
      type: "postback",
      replyToken: "reply-2",
      source: { type: "user", userId: OTHER },
      postback: { data: `webact|confirm|${mine.id}` },
    }]);

    assertEquals(result.handled, ["web:confirm"]);
    assertStringIncludes(replies[0]?.messages[0]?.text ?? "", "見つかりませんでした");
    assertEquals((await getReservation(kv, owner.ledgerId, mine.id))?.status, "candidate");
    assertEquals(mutated, []);
  });
});

Deno.test("webhook: without deps.web, 「確認」 is parsed as before (no crash)", async () => {
  const { deps, replies } = makeDeps();
  deps.parsers = [MockParser("p1", new Map())];
  const result = await post(deps, [textEvent("確認")]);
  assertEquals(result.handled, ["failed"]);
  assertStringIncludes(replies[0]?.messages[0]?.text ?? "", "読み取れませんでした");
});

Deno.test("webhook: standalone mode keeps the legacy allowlist as the only gate", async () => {
  // No `web` dep → no link index, so an empty allowlist admits nobody.
  const { deps, ctx, replies } = makeDeps({ allowedUserIds: new Set<string>() });
  deps.parsers = [MockParser("p1", new Map())];
  const result = await post(deps, [textEvent("8/1 19時に〇〇を予約")]);
  assertEquals(result.handled, ["ignored:not-allowed"]);
  assertEquals(replies.length, 0);
  assertEquals(await ctx.store.listParseJobs(), []);
});

Deno.test("webhook: legacy allowlist still gates an UNLINKED sender's postback", async () => {
  await withKv(async (kv) => {
    const { web, mutated } = await makeWebDeps(kv);
    const { deps, replies } = makeDeps({ web });
    const result = await post(deps, [{
      type: "postback",
      replyToken: "reply-2",
      source: { type: "user", userId: "U-stranger" },
      postback: { data: "webact|confirm|R1" },
    }]);
    assertEquals(result.handled, ["ignored:not-allowed"]);
    assertEquals(replies.length, 0);
    assertEquals(mutated, []);
  });
});

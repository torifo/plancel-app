import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { InMemoryStore } from "../../core/store/mod.ts";
import { VirtualClock } from "../../core/clock/mod.ts";
import { MockParser } from "../../parse/mod.ts";
import type { ParserChainConfig } from "../../parse/mod.ts";
import type { ToolContext } from "../../mcp/context.ts";
import { signLineBody } from "../signature.ts";
import { handleLineWebhook, type LineWebhookDeps } from "../webhook.ts";
import type { LineMessagingClient, LineQuickReplyItem, LineTextMessage } from "../types.ts";
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
import { saveTemplate } from "../../web/policy-template.ts";
import type { WebPolicy } from "../../web/policy.ts";

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

/** Postback payload of a Quick Reply item ("" for the command menu's message actions). */
function postbackData(item: LineQuickReplyItem | undefined): string {
  return item?.action.type === "postback" ? item.action.data : "";
}

/** The texts the command Quick Reply items would send — i.e. the offered menu. */
function menuTexts(message: LineTextMessage | undefined): string[] {
  return (message?.quickReply?.items ?? []).flatMap((i) =>
    i.action.type === "message" ? [i.action.text] : []
  );
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
  const data = postbackData(items[1]);
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
    assertStringIncludes(body, "@owner の台帳の予約 1件");
    // 8/22 start, staged policy -> free until 168h before = 8/15.
    assertStringIncludes(body, "8/22(土) 湖畔の湯宿 蛍 [候補] ◆8/15(土)まで無料");
    assertStringIncludes(body, "◆次の無料キャンセル期限 8/15(土)");
    assertStringIncludes(body, "最大キャンセル料 ¥40,000");
    // Cancelled reservations are out of the summary entirely.
    assertEquals(body.includes("翠嶺館"), false);
    const items = msg?.quickReply?.items ?? [];
    assertEquals(postbackData(items[0]), `webact|confirm|${a.id}`);
    assertStringIncludes(items[0]?.action.label ?? "", "確定:");
    // The per-reservation action comes first, then the rest of the command menu.
    assertEquals(menuTexts(msg), ["締切", "今日", "今週", "使い方"]);
  });
});

Deno.test("webhook: empty web ledger -> friendly one-liner, still navigable", async () => {
  await withKv(async (kv) => {
    const { web } = await makeWebDeps(kv);
    const { deps, replies } = makeDeps({ web });
    const result = await post(deps, [textEvent("一覧")]);
    assertEquals(result.handled, ["web:check"]);
    const msg = replies[0]?.messages[0];
    assertStringIncludes(msg?.text ?? "", "@owner の台帳に予約はまだありません");
    // No reservation to act on, but the menu is still there.
    assertEquals(menuTexts(msg), ["締切", "今日", "今週", "使い方"]);
    assertEquals((msg?.quickReply?.items ?? []).filter((i) => postbackData(i) !== ""), []);
  });
});

// ---- Rich-menu commands (owner 2026-07-28) ----
//
// A rich-menu button can only send a fixed text, so every menu word must get
// its own reply here — falling through to the parse pipeline is a dead end.

/** The full command menu, in order — what a reply offers when it excludes none. */
const FULL_MENU = ["確認", "締切", "今日", "今週", "使い方"];

Deno.test("webhook: 使い方 -> compact how-to + command Quick Reply", async () => {
  await withKv(async (kv) => {
    const { web } = await makeWebDeps(kv);
    const { deps, replies } = makeDeps({ web });
    const result = await post(deps, [textEvent("使い方")]);

    assertEquals(result.handled, ["web:help"]);
    const msg = replies[0]?.messages[0];
    const body = msg?.text ?? "";
    assertStringIncludes(body, "plancel は予約のキャンセル期限を見張って");
    assertStringIncludes(body, "・確認：予約の一覧と次の無料キャンセル期限");
    assertStringIncludes(body, "予約確認メールの本文かスクショ");
    assertStringIncludes(body, "https://plancel-app.torifo.deno.net/#help");
    // A chat bubble, not a manual.
    assertEquals(body.split("\n").length <= 10, true, body);
    assertEquals(menuTexts(msg), ["確認", "締切", "今日", "今週"]);
  });
});

Deno.test("webhook: 連携 -> names the bound account and how to unlink", async () => {
  await withKv(async (kv) => {
    const { web } = await makeWebDeps(kv);
    const { deps, replies } = makeDeps({ web });
    const result = await post(deps, [textEvent("設定")]);

    assertEquals(result.handled, ["web:link"]);
    const msg = replies[0]?.messages[0];
    assertStringIncludes(msg?.text ?? "", "このトークは @owner の台帳につながっています");
    assertStringIncludes(msg?.text ?? "", "https://plancel-app.torifo.deno.net/#link");
    assertEquals(menuTexts(msg), FULL_MENU);
  });
});

/** Seeds one reservation in the owner's ledger with the fields a test cares about. */
function seedResv(
  kv: Deno.Kv,
  ledgerId: string,
  webIds: AuthIds,
  fields: { service: string; startsAt: string; amount?: number; policy?: "free24" | "staged" },
) {
  return createReservation(kv, ledgerId, {
    plan: null,
    service: fields.service,
    startsAt: fields.startsAt,
    amount: fields.amount ?? null,
    location: null,
    policy: fields.policy ?? "free24",
    confirmed: false,
  }, webIds);
}

Deno.test("webhook: 締切 lists only the deadlines inside 7 days, soonest first", async () => {
  await withKv(async (kv) => {
    const { web, owner, webIds } = await makeWebDeps(kv);
    // now = 2026-08-01T00:00 JST, so the window closes 2026-08-08T00:00 JST.
    // staged = free until 168h before start; free24 = until 24h before.
    await seedResv(kv, owner.ledgerId, webIds, {
      service: "宿A",
      startsAt: "2026-08-08T15:00:00+09:00",
      policy: "free24", // deadline 8/7
    });
    await seedResv(kv, owner.ledgerId, webIds, {
      service: "宿B",
      startsAt: "2026-08-10T15:00:00+09:00",
      amount: 30000,
      policy: "staged", // deadline 8/3
    });
    await seedResv(kv, owner.ledgerId, webIds, {
      service: "宿C",
      startsAt: "2026-09-01T15:00:00+09:00",
      policy: "staged", // deadline 8/25 — outside the window
    });

    const { deps, replies } = makeDeps({ web });
    assertEquals((await post(deps, [textEvent("締切")])).handled, ["web:deadline"]);

    const msg = replies[0]?.messages[0];
    const body = msg?.text ?? "";
    assertStringIncludes(body, "@owner の無料キャンセル期限（7日以内）2件");
    assertStringIncludes(body, "8/3(月) 宿B — 過ぎると最大¥30,000");
    assertStringIncludes(body, "8/7(金) 宿A — 金額未登録");
    assertEquals(body.indexOf("宿B") < body.indexOf("宿A"), true, body);
    assertEquals(body.includes("宿C"), false);
    assertEquals(menuTexts(msg), ["確認", "今日", "今週", "使い方"]);
  });
});

Deno.test("webhook: 締切 with nothing inside 7 days says so and names the next one", async () => {
  await withKv(async (kv) => {
    const { web, owner, webIds } = await makeWebDeps(kv);
    await seedResv(kv, owner.ledgerId, webIds, {
      service: "宿C",
      startsAt: "2026-09-01T15:00:00+09:00",
      policy: "staged", // deadline 8/25
    });

    const { deps, replies } = makeDeps({ web });
    assertEquals((await post(deps, [textEvent("期限")])).handled, ["web:deadline"]);
    const body = replies[0]?.messages[0]?.text ?? "";
    assertStringIncludes(body, "@owner に7日以内の無料キャンセル期限はありません。");
    assertStringIncludes(body, "次の無料キャンセル期限は 8/25(火)「宿C」です。");
  });
});

Deno.test("webhook: 今日/今週 windows are JST calendar days, not UTC ones", async () => {
  await withKv(async (kv) => {
    const { web, owner, webIds } = await makeWebDeps(kv);
    // now = 2026-07-31T15:00Z = 2026-08-01T00:00 JST. Both reservations below
    // fall on the SAME UTC day (2026-08-01) but on DIFFERENT JST days, so a
    // UTC-day window would put both in 「今日」.
    await seedResv(kv, owner.ledgerId, webIds, {
      service: "宵の宿",
      startsAt: "2026-08-01T23:00:00+09:00", // 2026-08-01T14:00Z — JST 8/1
    });
    await seedResv(kv, owner.ledgerId, webIds, {
      service: "翌朝の宿",
      startsAt: "2026-08-02T01:00:00+09:00", // 2026-08-01T16:00Z — JST 8/2
    });
    await seedResv(kv, owner.ledgerId, webIds, {
      service: "先の宿",
      startsAt: "2026-08-20T15:00:00+09:00", // beyond the 7-day window
    });

    const { deps, replies } = makeDeps({ web });
    assertEquals((await post(deps, [textEvent("今日")])).handled, ["web:today"]);
    const today = replies[0]?.messages[0];
    assertStringIncludes(today?.text ?? "", "@owner の今日の予定 1件");
    assertStringIncludes(today?.text ?? "", "8/1(土) 23:00 宵の宿 [候補]");
    assertEquals((today?.text ?? "").includes("翌朝の宿"), false);
    assertEquals(menuTexts(today), ["確認", "締切", "今週", "使い方"]);

    assertEquals((await post(deps, [textEvent("今週")])).handled, ["web:week"]);
    const week = replies[1]?.messages[0]?.text ?? "";
    assertStringIncludes(week, "@owner のこれから7日間の予定 2件");
    assertStringIncludes(week, "8/2(日) 01:00 翌朝の宿");
    assertEquals(week.includes("先の宿"), false);
  });
});

Deno.test("webhook: unrecognised SHORT text -> command list, no ParseJob", async () => {
  await withKv(async (kv) => {
    const { web } = await makeWebDeps(kv);
    const { deps, ctx, replies } = makeDeps({ web });
    deps.parsers = [MockParser("p1", new Map())]; // would fail if it ran

    const result = await post(deps, [textEvent("よてい表")]);

    assertEquals(result.handled, ["web:unknown-command"]);
    const msg = replies[0]?.messages[0];
    const body = msg?.text ?? "";
    assertStringIncludes(body, "コマンドとして読み取れませんでした");
    assertStringIncludes(body, "確認／締切／今日／今週／連携／使い方");
    assertStringIncludes(body, "https://plancel-app.torifo.deno.net/#import");
    // NOT the parse-failure dead end, and the parsers were never reached.
    assertEquals(body.includes("店名と日時がわかる形で"), false);
    assertEquals(await ctx.store.listParseJobs(), []);
    assertEquals(menuTexts(msg), FULL_MENU);
  });
});

Deno.test("webhook: text past the command threshold still parses and registers", async () => {
  await withKv(async (kv) => {
    const { web, owner } = await makeWebDeps(kv);
    // 13 chars — one past MAX_COMMAND_GUESS_CHARS, so the pipeline still runs.
    const text = "8/1 19時に〇〇を予約";
    assertEquals(text.length, 13);
    const { deps, ctx, replies } = makeDeps({ web });
    deps.parsers = [MockParser(
      "p1",
      new Map([[text, {
        raw_response: "{}",
        output: { service_name: "〇〇", starts_at: "2026-08-01T19:00:00+09:00" },
      }]]),
    )];

    assertEquals((await post(deps, [textEvent(text)])).handled, ["registered"]);
    assertEquals((await ctx.store.listParseJobs())[0]?.status, "parsed");
    assertEquals((await listReservations(kv, owner.ledgerId)).length, 1);
    assertStringIncludes(replies[0]?.messages[0]?.text ?? "", "登録しました: 〇〇");
  });
});

Deno.test("webhook: an unlinked sender's 使い方/締切 gets link guidance only", async () => {
  await withKv(async (kv) => {
    const { web } = await makeWebDeps(kv);
    const { deps, ctx, replies } = makeDeps({
      web,
      allowedUserIds: new Set([OWNER, "U-nolink"]),
    });

    const result = await post(deps, [textEvent("使い方", "U-nolink"), {
      ...textEvent("締切", "U-nolink"),
      replyToken: "reply-2",
    }]);

    assertEquals(result.handled, ["line:guide", "line:guide"]);
    for (const reply of replies) {
      const body = reply.messages[0]?.text ?? "";
      assertStringIncludes(body, "まだ plancel のアカウントと連携されていません");
      // No command list and no ledger figures leak to an unknown sender.
      assertEquals(body.includes("使えるコマンド"), false);
      assertEquals(body.includes("無料キャンセル期限"), false);
      assertEquals(reply.messages[0]?.quickReply, undefined);
    }
    assertEquals(await ctx.store.listParseJobs(), []);
  });
});

Deno.test("webhook: commands match after normalisation (full-width, spaces, case)", async () => {
  await withKv(async (kv) => {
    const { web } = await makeWebDeps(kv);
    const { deps, replies } = makeDeps({ web });
    deps.parsers = [MockParser("p1", new Map())];

    const cases: [string, string][] = [
      ["　確認　", "web:check"], // ideographic spaces around the word
      ["ＨＥＬＰ", "web:help"], // full-width ASCII
      ["Help", "web:help"], // mixed case
      [" help ", "web:help"],
      ["ﾍﾙﾌﾟ", "web:help"], // half-width katakana
    ];
    for (const [sent, expected] of cases) {
      const result = await post(deps, [textEvent(sent)]);
      assertEquals(result.handled, [expected], sent);
    }
    assertEquals(replies.length, cases.length);
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
    assertStringIncludes(body, "@owner の台帳に候補として入りました");
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
    assertEquals(weird.text.includes("キャンセル規定が不明です"), false);

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
      assertStringIncludes(text, "キャンセル規定が不明です");
    }
  });
});

// ---- 規定不明で登録したあとの続き（LINE で始めた作業を LINE で終える） ----

/**
 * 規定を読み取れない予約メールを1通送り、候補として登録させる。返り値には
 * 登録直後の返信と、その続きの postback を撃つための deps がそろっている。
 */
async function registerWithUnknownPolicy(
  kv: Deno.Kv,
  fields: { amount?: number; startsAt?: string; template?: WebPolicy } = {},
) {
  const { web, owner, webIds, mutated, seed } = await makeWebDeps(kv);
  if (fields.template !== undefined) {
    await saveTemplate(kv, owner.ledgerId, "翠嶺館", fields.template, webIds);
  }
  const body = "宿からの予約確認メールです（キャンセル規定の記載なし）";
  const parser = MockParser(
    "p1",
    new Map([[body, {
      raw_response: "{}",
      output: {
        service_name: "翠嶺館",
        starts_at: fields.startsAt ?? "2026-08-22T15:00:00+09:00",
        ...(fields.amount === undefined ? {} : { amount_jpy: fields.amount }),
      },
    }]]),
  );
  const { deps, replies } = makeDeps({ web });
  deps.parsers = [parser];
  assertEquals((await post(deps, [textEvent(body)])).handled, ["registered"]);
  const resv = (await listReservations(kv, owner.ledgerId))[0];
  return { deps, replies, owner, mutated, seed, resv, message: replies[0]?.messages[0] };
}

/** 規定 Quick Reply のタップ。既定は本人（OWNER）が押した場合。 */
function policyPostback(
  id: string | undefined,
  choice: string,
  opts: { by?: string; token?: string } = {},
) {
  return {
    type: "postback",
    replyToken: opts.token ?? "reply-2",
    source: { type: "user", userId: opts.by ?? OWNER },
    postback: { data: `webact|policy|${id}|${choice}` },
  };
}

Deno.test("webhook: 規定不明で登録 -> その場で規定を選べる Quick Reply が付く", async () => {
  await withKv(async (kv) => {
    const { resv, message } = await registerWithUnknownPolicy(kv);
    assertEquals(resv?.policy, "unknown");

    const body = message?.text ?? "";
    assertStringIncludes(body, "キャンセル規定が不明です");
    assertStringIncludes(body, "当てはまるものを選んでください");
    // プリセットで表せない規定の逃げ道は台帳そのもの（取り込み画面ではない）。
    assertStringIncludes(body, "その他はWebで: https://plancel-app.torifo.deno.net");
    assertEquals(body.includes("#import"), false);

    // 選択肢は PRESET_STAGES のプリセット名だけ = 新しい段階表を発明しない。
    const items = message?.quickReply?.items ?? [];
    assertEquals(items.map((i) => i.action.label), [
      "前日まで無料",
      "7日前まで無料",
      "いつでも無料",
    ]);
    assertEquals(
      items.map(postbackData),
      ["free24", "staged", "none"].map((p) => `webact|policy|${resv?.id}|${p}`),
    );
    // LINE の Quick Reply 上限（MAX_QUICK_REPLY = 13）の内側。
    assertEquals(items.length <= 13, true);
  });
});

Deno.test("webhook: 施設の既定規定があるときは、聞かずにそれを当てる", async () => {
  await withKv(async (kv) => {
    // web の取り込み（フォームの /api/policy-templates/lookup とメール転送の
    // email-intake.ts）は、規定を読み取れなかったとき施設の既定規定に落ちる。
    // LINE だけがこれを引いていなかったので、同じ宿でも web から入れると規定が
    // 入り、LINE から入れると unknown のままだった（2026-07-28 修正）。
    const { resv, message } = await registerWithUnknownPolicy(kv, { template: "staged" });
    assertEquals(resv?.policy, "staged");

    // 規定が決まっている以上、聞く必要がない = Quick Reply を出さない。
    const body = message?.text ?? "";
    assertEquals(body.includes("キャンセル規定が不明です"), false);
    assertEquals(message?.quickReply, undefined);
  });
});

Deno.test("webhook: 読み取れた規定は施設の既定で塗り替えない", async () => {
  await withKv(async (kv) => {
    // その予約に固有の料率表のほうが、施設の既定より強い（6068e12 と同じ規則）。
    const { web, owner, webIds } = await makeWebDeps(kv);
    await saveTemplate(kv, owner.ledgerId, "翠嶺館", "none", webIds);
    const body = "翠嶺館 予約確認（3日前から50%）";
    const parser = MockParser(
      "p1",
      new Map([[body, {
        raw_response: "{}",
        output: {
          service_name: "翠嶺館",
          starts_at: "2026-08-22T15:00:00+09:00",
          cancellation_policy: CORE_POLICY.staged,
        },
      }]]),
    );
    const { deps } = makeDeps({ web });
    deps.parsers = [parser];
    assertEquals((await post(deps, [textEvent(body)])).handled, ["registered"]);
    const resv = (await listReservations(kv, owner.ledgerId))[0];
    assertEquals(resv?.policy, "staged");
  });
});

Deno.test("webhook: 規定を選ぶと台帳に入り、無料キャンセル期限が返信に出る", async () => {
  await withKv(async (kv) => {
    const { deps, replies, owner, mutated, resv } = await registerWithUnknownPolicy(kv, {
      amount: 40000,
    });
    const id = resv?.id ?? "";

    const result = await post(deps, [policyPostback(id, "staged")]);

    assertEquals(result.handled, ["web:policy"]);
    assertEquals((await getReservation(kv, owner.ledgerId, id))?.policy, "staged");
    // 規定はカレンダーの説明文に出るので、登録時と同じく貼り直しを頼む。
    assertEquals(mutated, [id, id]);

    const body = replies[1]?.messages[0]?.text ?? "";
    assertStringIncludes(body, "キャンセル規定を「7日前まで無料」にしました: 翠嶺館（@owner）");
    assertStringIncludes(body, "7日前まで無料 → 3日前まで30% → 前日まで50% → 当日100%");
    // 8/22 開始・staged = 168時間前まで無料 -> 8/15。
    assertStringIncludes(body, "◆8/15(土)まで無料");
    assertStringIncludes(body, "最大キャンセル料 ¥40,000");
  });
});

Deno.test("webhook: 「いつでも無料」の返信は同じ文を二度言わない", async () => {
  await withKv(async (kv) => {
    // describePolicy と無料キャンセル期限の一行が、この規定だけ同じ文になる。
    const { deps, replies, resv } = await registerWithUnknownPolicy(kv, { amount: 8000 });
    await post(deps, [policyPostback(resv?.id, "none")]);
    assertEquals((replies[1]?.messages[0]?.text ?? "").split("\n"), [
      "キャンセル規定を「いつでも無料」にしました: 翠嶺館（@owner）",
      "いつでも無料 / 最大キャンセル料 ¥0",
      "「確認」で一覧",
    ]);
  });
});

Deno.test("webhook: 他人の予約IDを載せた policy postback は何も書き換えない", async () => {
  await withKv(async (kv) => {
    const { deps, replies, owner, mutated, seed, resv } = await registerWithUnknownPolicy(kv);
    const id = resv?.id ?? "";
    await seed(OTHER_EMAIL, OTHER);

    // OTHER が OWNER の予約IDを載せて押す。
    const foreign = await post(deps, [policyPostback(id, "none", { by: OTHER })]);
    assertEquals(foreign.handled, ["web:policy"]);
    assertStringIncludes(replies[1]?.messages[0]?.text ?? "", "見つかりませんでした");
    assertEquals((await getReservation(kv, owner.ledgerId, id))?.policy, "unknown");

    // 本人が押しても、プリセット名でない値は受け付けない（段階表は postback から
    // 入ってこない）。パースの時点で落ちるので返信もしない。
    const bogus = await post(deps, [policyPostback(id, "free48", { token: "reply-3" })]);
    assertEquals(bogus.handled, ["ignored:postback"]);
    assertEquals((await getReservation(kv, owner.ledgerId, id))?.policy, "unknown");

    // 登録時の1回だけ。弾かれた2回はカレンダー同期も走っていない。
    assertEquals(mutated, [id]);
    assertEquals(replies.length, 2);
  });
});

Deno.test("webhook: 選んだ時点で無料キャンセル期限が過ぎていたら、過ぎたと言う", async () => {
  await withKv(async (kv) => {
    // now = 8/1。開始 8/3 の予約に「7日前まで無料」を選ぶと期限は 7/27 = 過去。
    // 「◆7/27まで無料」だけ返すと、まだ間に合うように読めてしまう。
    const { deps, replies, resv } = await registerWithUnknownPolicy(kv, {
      startsAt: "2026-08-03T15:00:00+09:00",
    });
    await post(deps, [policyPostback(resv?.id, "staged")]);
    assertStringIncludes(
      replies[1]?.messages[0]?.text ?? "",
      "◆7/27(月)まで無料（この無料キャンセル期限は過ぎています）",
    );
  });
});

Deno.test("webhook: preset policies map exactly (none/free24)", async () => {
  await withKv(async (kv) => {
    for (const name of ["none", "free24"] as const) {
      const { web, owner } = await makeWebDeps(kv);
      // Longer than MAX_COMMAND_GUESS_CHARS, so it reaches the parse pipeline.
      const text = `${name} 8/1 19時に〇〇を予約`;
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
    // Longer than MAX_COMMAND_GUESS_CHARS, so it reaches the parse pipeline.
    const text = "土曜19時に〇〇を仮予約しました";
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
    const data = postbackData(replies[0]?.messages[0]?.quickReply?.items[1]);
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
    assertStringIncludes(replies[1]?.messages[0]?.text ?? "", "の台帳に候補として入りました");
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
    assertStringIncludes(replies[3]?.messages[0]?.text ?? "", "@other の台帳");
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
    assertStringIncludes(otherBody, "@other の台帳の予約 1件");
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
    assertStringIncludes(replies[0]?.messages[0]?.text ?? "", "@other の台帳に候補として");
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

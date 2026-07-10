import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { InMemoryStore } from "../../core/store/mod.ts";
import { VirtualClock } from "../../core/clock/mod.ts";
import { MockParser } from "../../parse/mod.ts";
import type { ParserChainConfig } from "../../parse/mod.ts";
import type { ToolContext } from "../../mcp/context.ts";
import { signLineBody } from "../signature.ts";
import { handleLineWebhook, type LineWebhookDeps } from "../webhook.ts";
import type { LineMessagingClient, LineTextMessage } from "../types.ts";

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

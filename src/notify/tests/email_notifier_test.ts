import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { EmailNotifier } from "../email-notifier.ts";
import type { PendingNotification } from "../types.ts";

const NOTIFICATION: PendingNotification = {
  idempotency_key: "r1|day_of_reminder|2026-08-01",
  trigger: "day_of_reminder",
  reservation_id: "r1",
  fire_at: "2026-08-01T07:00:00.000Z",
  message: "本日 19:00 に 〇〇 の予約があります",
};

function stubFetch(status = 200) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetchStub = ((input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
      auth: headers.get("Authorization"),
    });
    return Promise.resolve(new Response(status === 200 ? "{}" : "quota exceeded", { status }));
  }) as typeof fetch;
  return { fetchStub, calls };
}

Deno.test("EmailNotifier: posts the notification to Resend with trigger subject", async () => {
  const { fetchStub, calls } = stubFetch();
  const notifier = new EmailNotifier({
    apiKey: "re_test",
    from: "plancel <notify@example.com>",
    to: "owner@example.com",
    fetch: fetchStub,
    write: () => {},
  });

  await notifier.deliver(NOTIFICATION);

  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.url, "https://api.resend.com/emails");
  assertEquals(calls[0]?.auth, "Bearer re_test");
  assertEquals(calls[0]?.body.to, ["owner@example.com"]);
  assertEquals(calls[0]?.body.text, NOTIFICATION.message);
  assertStringIncludes(String(calls[0]?.body.subject), "[plancel]");
  assertStringIncludes(String(calls[0]?.body.subject), "リマインド");
});

Deno.test("EmailNotifier: rejects on HTTP failure so the Outbox can retry", async () => {
  const { fetchStub } = stubFetch(429);
  const notifier = new EmailNotifier({
    apiKey: "re_test",
    from: "plancel <notify@example.com>",
    to: "owner@example.com",
    fetch: fetchStub,
    write: () => {},
  });
  await assertRejects(() => notifier.deliver(NOTIFICATION), Error, "http 429");
});

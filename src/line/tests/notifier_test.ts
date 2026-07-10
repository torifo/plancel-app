import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.19";
import { LineNotifier } from "../notifier.ts";
import type { LineMessagingClient, LineTextMessage } from "../types.ts";
import type { PendingNotification } from "../../notify/types.ts";

const NOTIFICATION: PendingNotification = {
  idempotency_key: "r1|fee_boundary_24h|2026-08-01T10:00:00.000Z",
  trigger: "fee_boundary_24h",
  reservation_id: "r1",
  fire_at: "2026-07-31T10:00:00.000Z",
  message: "明日からキャンセル料が発生します",
};

function fakeClient(failPush = false) {
  const pushes: { to: string; messages: LineTextMessage[] }[] = [];
  const client: LineMessagingClient = {
    reply: () => Promise.resolve(),
    push(to, messages) {
      if (failPush) return Promise.reject(new Error("line api down"));
      pushes.push({ to, messages });
      return Promise.resolve();
    },
    getMessageContent: () => Promise.reject(new Error("unused")),
  };
  return { client, pushes };
}

Deno.test("LineNotifier: pushes the notification message to the configured user", async () => {
  const { client, pushes } = fakeClient();
  const notifier = new LineNotifier({ client, to: "U-owner", write: () => {} });

  await notifier.deliver(NOTIFICATION);

  assertEquals(pushes.length, 1);
  assertEquals(pushes[0]?.to, "U-owner");
  assertEquals(pushes[0]?.messages[0]?.text, NOTIFICATION.message);
});

Deno.test("LineNotifier: rejects on push failure so the Outbox can retry", async () => {
  const { client } = fakeClient(true);
  const notifier = new LineNotifier({ client, to: "U-owner", write: () => {} });
  await assertRejects(() => notifier.deliver(NOTIFICATION), Error, "line api down");
});

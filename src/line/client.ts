/**
 * LINE Messaging API client (Task 6.2).
 *
 * Thin fetch wrapper implementing `LineMessagingClient` (types.ts). Reply
 * messages are free; push messages count against the free-tier quota
 * (月200通, ADR/tasks 6.2) — quota discipline lives in the notification
 * design (few, high-value pushes), not here. Failures throw so the Outbox
 * can retry deliveries (notifier contract, src/notify/notifier.ts).
 */
import { encodeBase64 } from "jsr:@std/encoding@^1.0.5/base64";
import type { LineMessagingClient, LineTextMessage } from "./types.ts";

const API_BASE = "https://api.line.me/v2/bot";
const DATA_API_BASE = "https://api-data.line.me/v2/bot";

export interface LineClientOptions {
  channelAccessToken: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  apiBase?: string;
  dataApiBase?: string;
}

export function createLineClient(options: LineClientOptions): LineMessagingClient {
  const doFetch = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? API_BASE;
  const dataApiBase = options.dataApiBase ?? DATA_API_BASE;
  const headers = {
    "Authorization": `Bearer ${options.channelAccessToken}`,
    "Content-Type": "application/json",
  };

  async function post(path: string, body: unknown): Promise<void> {
    const res = await doFetch(`${apiBase}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`line api ${path} failed: http ${res.status}: ${await res.text()}`);
    }
    await res.body?.cancel();
  }

  return {
    reply(replyToken: string, messages: LineTextMessage[]): Promise<void> {
      return post("/message/reply", { replyToken, messages });
    },
    push(to: string, messages: LineTextMessage[]): Promise<void> {
      return post("/message/push", { to, messages });
    },
    async getMessageContent(messageId: string): Promise<{ mimeType: string; base64: string }> {
      const res = await doFetch(`${dataApiBase}/message/${messageId}/content`, {
        headers: { "Authorization": `Bearer ${options.channelAccessToken}` },
      });
      if (!res.ok) {
        throw new Error(
          `line content ${messageId} failed: http ${res.status}: ${await res.text()}`,
        );
      }
      const mimeType = res.headers.get("content-type") ?? "image/jpeg";
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { mimeType, base64: encodeBase64(bytes) };
    },
  };
}

/**
 * Minimal LINE Messaging API shapes (Task 6.2).
 *
 * Only the subset plancel touches: text/image message events, postback
 * events (Quick Reply one-tap resolution), and outgoing text messages with
 * optional Quick Reply buttons. Webhook bodies are typed loosely and
 * validated defensively in webhook.ts — LINE adds event kinds over time and
 * unknown events must be ignored, not crash the endpoint.
 */

export interface LineWebhookBody {
  destination?: string;
  events?: LineWebhookEvent[];
}

export interface LineWebhookEvent {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { id?: string; type?: string; text?: string };
  postback?: { data?: string };
}

/**
 * The two Quick Reply actions plancel sends. `postback` drives one-tap ledger
 * updates; `message` makes the tap send a plain text, i.e. exactly what a rich
 * menu button sends — so both surfaces land on the one command table
 * (src/line/web-commands.ts) instead of two parallel dispatchers.
 */
export type LineQuickReplyAction =
  | { type: "postback"; label: string; data: string; displayText?: string }
  | { type: "message"; label: string; text: string };

export interface LineQuickReplyItem {
  type: "action";
  action: LineQuickReplyAction;
}

export interface LineTextMessage {
  type: "text";
  text: string;
  quickReply?: { items: LineQuickReplyItem[] };
}

/** The messaging surface webhook.ts / notifier.ts depend on (injectable in tests). */
export interface LineMessagingClient {
  reply(replyToken: string, messages: LineTextMessage[]): Promise<void>;
  push(to: string, messages: LineTextMessage[]): Promise<void>;
  /** Downloads user-sent media (images) for the parse pipeline. */
  getMessageContent(messageId: string): Promise<{ mimeType: string; base64: string }>;
}

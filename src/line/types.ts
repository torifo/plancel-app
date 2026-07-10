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

export interface LineQuickReplyItem {
  type: "action";
  action: {
    type: "postback";
    label: string;
    data: string;
    displayText?: string;
  };
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

/**
 * notify — fire-decision (Task 3.1) + Outbox / delivery / event-subscription
 * glue (Task 3.2).
 */
export * from "./types.ts";
export {
  computePendingNotifications,
  type NotificationInput,
  notificationsForEvents,
  previewNotifications,
} from "./trigger.ts";
export { ConsoleNotifier, type ConsoleNotifierOptions } from "./console-notifier.ts";
export { EmailNotifier, type EmailNotifierOptions } from "./email-notifier.ts";
export type { Notifier } from "./notifier.ts";
export {
  type DeliverPendingOptions,
  type DeliverPendingResult,
  type EnqueueResult,
  Outbox,
} from "./outbox.ts";
export { onEventsAppended } from "./subscribe.ts";

/**
 * notify — pure notification fire-decision (Task 3.1). Delivery / Outbox
 * (Task 3.2) live in sibling modules and are not exported here.
 */
export * from "./types.ts";
export {
  computePendingNotifications,
  type NotificationInput,
  notificationsForEvents,
  previewNotifications,
} from "./trigger.ts";

/**
 * Notifier interface (Task 3.2, SDD §6 / §10, design.md Data Models).
 *
 * Implementation order (SDD §6): ① `ConsoleNotifier` (this task) → ②
 * `LineNotifier` → ③ `EmailNotifier` (Resend). Idempotency is owned
 * entirely by the Outbox (`outbox.ts`) — a `Notifier` just tries to deliver
 * whatever `PendingNotification` it is given and either resolves (success →
 * the Outbox marks it delivered) or rejects (failure → the Outbox retries
 * up to `maxAttempts`). Implementations must not track which notifications
 * they have already sent.
 */
import type { PendingNotification } from "./types.ts";

export interface Notifier {
  /** Delivers one notification. Reject to signal a retriable failure. */
  deliver(n: PendingNotification): Promise<void>;
}

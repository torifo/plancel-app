/**
 * Production Notifier selection from environment (deploy wiring).
 *
 * The cron tick (src/cron/tick.ts) is handed one `Notifier`. In tests and
 * local runs that is `ConsoleNotifier`; on Deno Deploy it must become a real
 * channel. This factory picks one from env so the same entrypoint works
 * across "no channel configured" (Console), email-only, and LINE setups
 * without code changes.
 *
 * Priority — LINE push to the owner first (the primary personal channel,
 * SDD §6 実装順 ②), then Email (Resend, ③), else Console (①, always-safe
 * fallback so a misconfigured deploy still runs and logs rather than
 * crashing). Idempotency stays owned by the Outbox regardless of channel.
 */
import { ConsoleNotifier, EmailNotifier, type Notifier } from "../notify/mod.ts";
import { createLineClient } from "../line/client.ts";
import { LineNotifier } from "../line/notifier.ts";

/** Minimal env port so the selector is testable without touching `Deno.env`. */
export interface EnvReader {
  get(key: string): string | undefined;
}

/** Wraps `Deno.env` in the `EnvReader` port (tolerates missing --allow-env). */
export function denoEnvReader(): EnvReader {
  return {
    get(key) {
      try {
        return Deno.env.get(key);
      } catch {
        return undefined;
      }
    },
  };
}

/** The channel `selectNotifier` chose, for startup logging. */
export type NotifierKind = "line" | "email" | "console";

export interface SelectedNotifier {
  notifier: Notifier;
  kind: NotifierKind;
}

/**
 * Selects the production Notifier from env (see module doc for priority).
 * `write` (optional) is threaded into every notifier as its log sink.
 *
 * LINE push target: `PLANCEL_OWNER_USER_ID`, else the first entry of
 * `LINE_ALLOWED_USER_IDS` (personal service — usually one allowed user).
 * Email requires all of RESEND_API_KEY / PLANCEL_EMAIL_FROM / PLANCEL_EMAIL_TO.
 */
export function selectNotifier(env: EnvReader, write?: (line: string) => void): SelectedNotifier {
  const writeOpt = write !== undefined ? { write } : {};

  const lineToken = env.get("LINE_CHANNEL_ACCESS_TOKEN");
  const ownerId = env.get("PLANCEL_OWNER_USER_ID") ??
    env.get("LINE_ALLOWED_USER_IDS")?.split(",").map((s) => s.trim()).filter(Boolean)[0];
  if (lineToken !== undefined && lineToken !== "" && ownerId !== undefined && ownerId !== "") {
    const client = createLineClient({ channelAccessToken: lineToken });
    return { notifier: new LineNotifier({ client, to: ownerId, ...writeOpt }), kind: "line" };
  }

  const resendKey = env.get("RESEND_API_KEY");
  const from = env.get("PLANCEL_EMAIL_FROM");
  const to = env.get("PLANCEL_EMAIL_TO");
  if (resendKey && from && to) {
    return {
      notifier: new EmailNotifier({ apiKey: resendKey, from, to, ...writeOpt }),
      kind: "email",
    };
  }

  return { notifier: new ConsoleNotifier(writeOpt), kind: "console" };
}

import { assertEquals, assertInstanceOf } from "jsr:@std/assert@^1.0.19";
import { ConsoleNotifier, EmailNotifier } from "../../notify/mod.ts";
import { LineNotifier } from "../../line/notifier.ts";
import { type EnvReader, selectNotifier } from "../notifier.ts";

/** In-memory EnvReader from a plain record. */
function env(vars: Record<string, string>): EnvReader {
  return { get: (k) => vars[k] };
}

Deno.test("selectNotifier: LINE token + owner id -> LineNotifier (highest priority)", () => {
  const { notifier, kind } = selectNotifier(
    env({
      LINE_CHANNEL_ACCESS_TOKEN: "tok",
      PLANCEL_OWNER_USER_ID: "U-owner",
      // even with email also configured, LINE wins
      RESEND_API_KEY: "re_x",
      PLANCEL_EMAIL_FROM: "a@x.com",
      PLANCEL_EMAIL_TO: "b@x.com",
    }),
    () => {},
  );
  assertEquals(kind, "line");
  assertInstanceOf(notifier, LineNotifier);
});

Deno.test("selectNotifier: owner id falls back to first of LINE_ALLOWED_USER_IDS", () => {
  const { notifier, kind } = selectNotifier(
    env({ LINE_CHANNEL_ACCESS_TOKEN: "tok", LINE_ALLOWED_USER_IDS: " U-a , U-b " }),
    () => {},
  );
  assertEquals(kind, "line");
  assertInstanceOf(notifier, LineNotifier);
});

Deno.test("selectNotifier: LINE token but no owner id -> not LINE (falls through)", () => {
  const { kind } = selectNotifier(env({ LINE_CHANNEL_ACCESS_TOKEN: "tok" }), () => {});
  assertEquals(kind, "console");
});

Deno.test("selectNotifier: no LINE, full Resend config -> EmailNotifier", () => {
  const { notifier, kind } = selectNotifier(
    env({ RESEND_API_KEY: "re_x", PLANCEL_EMAIL_FROM: "a@x.com", PLANCEL_EMAIL_TO: "b@x.com" }),
    () => {},
  );
  assertEquals(kind, "email");
  assertInstanceOf(notifier, EmailNotifier);
});

Deno.test("selectNotifier: partial Resend config -> Console fallback (not Email)", () => {
  const { kind } = selectNotifier(
    env({ RESEND_API_KEY: "re_x", PLANCEL_EMAIL_FROM: "a@x.com" }), // missing _TO
    () => {},
  );
  assertEquals(kind, "console");
});

Deno.test("selectNotifier: nothing configured -> ConsoleNotifier", () => {
  const { notifier, kind } = selectNotifier(env({}), () => {});
  assertEquals(kind, "console");
  assertInstanceOf(notifier, ConsoleNotifier);
});

/**
 * Demo mode (`PLANCEL_DEMO=1`): a test account with a ledger the cancellation agent can act on.
 * Rows go through the same store functions as the HTTP API, dated from the injected clock.
 */
import type { Clock } from "../core/clock/mod.ts";
import { clearAgentState } from "../agent/store.ts";
import { hashPassword } from "../lib/password.ts";
import { createReservationWithEffects, type WebIds } from "../web/store.ts";
import type { webCreateSchema } from "../web/store.ts";
import {
  type AuthIds,
  findUserByEmail,
  getOrCreateUserByEmail,
  updateUser,
  type WebUser,
} from "../web/users.ts";
import type { z } from "zod";

export const DEMO_EMAIL = "demo@plancel.example";
export const DEMO_DISPLAY_NAME = "デモユーザー";
export const MIN_DEMO_PASSWORD_LENGTH = 8;

/** Integrations demo mode switches off even if their env happens to be set. */
export const DEMO_DISABLED_ENV = [
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
  "LINE_ALLOWED_USER_IDS",
  "PLANCEL_OWNER_USER_ID",
  "RESEND_API_KEY",
  "PLANCEL_EMAIL_FROM",
  "PLANCEL_EMAIL_TO",
  "RESEND_WEBHOOK_SECRET",
  "PLANCEL_INBOUND_DOMAIN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  // Auto-login as one account would make the test account's password moot.
  "PLANCEL_DEV_USER",
] as const;

/** An env reader with the demo-disabled keys hidden. */
export function demoEnv(
  env: { get(key: string): string | undefined },
): { get(key: string): string | undefined } {
  const hidden = new Set<string>(DEMO_DISABLED_ENV);
  return { get: (key) => (hidden.has(key) ? undefined : env.get(key)) };
}

const JST = "Asia/Tokyo";

/** `hh:mm` on the JST calendar day `days` from the clock's today, as +09:00 ISO. */
function jstAt(clock: Clock, days: number, hhmm: string): string {
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  return clock.now().toZonedDateTimeISO(JST).toPlainDate().add({ days })
    .toPlainDateTime({ hour, minute }).toZonedDateTime(JST)
    .toString({ smallestUnit: "second", timeZoneName: "never" });
}

type Seed = z.input<typeof webCreateSchema>;

/** Candidates are filed before the winner so confirming it turns アルバ to_cancel the real way. */
export function demoReservations(clock: Clock): Seed[] {
  return [
    // --- An evening that is already over (history; the agent must leave it) ---
    {
      service: "炭火焼き とり吉",
      plan: null,
      startsAt: jstAt(clock, -6, "19:00"),
      endsAt: null,
      amount: 6800,
      location: "新宿区歌舞伎町",
      policy: "free24",
      confirmed: true,
    },
    // --- Plan 「記念日ディナー」: one winner, one loser, one stray ---
    {
      service: "トラットリア アルバ",
      plan: "記念日ディナー",
      startsAt: jstAt(clock, 3, "19:30"),
      endsAt: null,
      amount: 16000,
      location: "渋谷区恵比寿",
      // 3日前まで無料 → 前日50% → 当日100%: the free window closes tonight.
      policy: { stages: [{ h: 72, pct: 0 }, { h: 24, pct: 50 }, { h: 0, pct: 100 }] },
      confirmed: false,
    },
    {
      // Same evening, but nobody gave it the plan's name.
      service: "ビストロ ル・ポワン",
      plan: null,
      startsAt: jstAt(clock, 3, "20:00"),
      endsAt: null,
      amount: 12000,
      location: "港区麻布十番",
      policy: "free24",
      confirmed: false,
    },
    {
      service: "鮨 さいとう",
      plan: "記念日ディナー",
      startsAt: jstAt(clock, 3, "19:00"),
      endsAt: null,
      amount: 28000,
      location: "中央区銀座",
      policy: "free24",
      confirmed: true,
    },
    // --- Plan 「京都旅行（宿）」: two held, none chosen ---
    {
      service: "ホテル鴨川リバーサイド",
      plan: "京都旅行（宿）",
      startsAt: jstAt(clock, 9, "15:00"),
      endsAt: jstAt(clock, 10, "11:00"),
      amount: 46000,
      location: "京都市下京区",
      // 7日前から20% → 前日50% → 当日100%: free through the end of day D+1.
      policy: {
        stages: [{ h: 192, pct: 0 }, { h: 48, pct: 20 }, { h: 24, pct: 50 }, { h: 0, pct: 100 }],
      },
      confirmed: false,
    },
    {
      service: "旅館 花ごろも",
      plan: "京都旅行（宿）",
      startsAt: jstAt(clock, 9, "15:00"),
      endsAt: jstAt(clock, 10, "10:00"),
      amount: 52000,
      location: "京都市東山区",
      // 7日前まで無料 → 3日前まで30% → 前日50% → 当日100% (the "staged" preset).
      policy: "staged",
      confirmed: false,
    },
  ];
}

/** Files the demo reservations into `ledger`; returns how many were written. */
export async function seedDemoLedger(
  kv: Deno.Kv,
  ledger: string,
  clock: Clock,
  ids: WebIds,
): Promise<number> {
  const seeds = demoReservations(clock);
  for (const seed of seeds) {
    await createReservationWithEffects(
      kv,
      ledger,
      {
        plan: seed.plan ?? null,
        service: seed.service,
        startsAt: seed.startsAt,
        endsAt: seed.endsAt ?? null,
        amount: seed.amount ?? null,
        location: seed.location ?? null,
        policy: seed.policy ?? "unknown",
        confirmed: seed.confirmed ?? false,
      },
      ids,
      null,
    );
  }
  return seeds.length;
}

export interface DemoDeps {
  kv: Deno.Kv;
  clock: Clock;
  ids: AuthIds;
  /** From PLANCEL_DEMO_PASSWORD. Never defaulted. */
  password: string | undefined;
}

export type DemoSeedResult =
  | { status: "seeded"; user: WebUser; reservations: number }
  | { status: "exists"; user: WebUser }
  | { status: "no_password" }
  | { status: "weak_password" };

/** Creates the demo account and ledger when the account is absent; otherwise leaves the store as is. */
export async function seedDemoIfEmpty(deps: DemoDeps): Promise<DemoSeedResult> {
  const existing = await findUserByEmail(deps.kv, DEMO_EMAIL);
  if (existing !== null) return { status: "exists", user: existing };
  if (deps.password === undefined || deps.password === "") return { status: "no_password" };
  if (deps.password.length < MIN_DEMO_PASSWORD_LENGTH) return { status: "weak_password" };

  const created = await getOrCreateUserByEmail(deps.kv, DEMO_EMAIL, deps.ids, {
    emailVerified: true,
    passwordHash: await hashPassword(deps.password),
  });
  const user = await updateUser(
    deps.kv,
    created.id,
    (u) => ({ ...u, displayName: DEMO_DISPLAY_NAME }),
    deps.ids,
  ) ?? created;
  const reservations = await seedDemoLedger(deps.kv, user.ledgerId, deps.clock, deps.ids);
  return { status: "seeded", user, reservations };
}

/** Wipes a demo ledger and its agent history and files the sample again (demo account or sandbox only). */
export async function resetDemoLedger(
  deps: DemoDeps,
  user: WebUser,
  opts: { sandbox?: boolean } = {},
): Promise<boolean> {
  if (user.email !== DEMO_EMAIL && opts.sandbox !== true) return false;
  for await (const e of deps.kv.list({ prefix: ["web", user.ledgerId] })) {
    await deps.kv.delete(e.key);
  }
  await clearAgentState(deps.kv, user.id);
  await seedDemoLedger(deps.kv, user.ledgerId, deps.clock, deps.ids);
  return true;
}

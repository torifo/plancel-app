/**
 * Runs the new code over a canary copy of production's data (see
 * ./release-canary.ts): every user's ledger list as the screen asks for it,
 * the MCP view of it, and both notification sweeps with senders that send
 * nothing. Any non-200 or throw is a failure. Reports counts and user ids
 * only — the data is real people's, and this runs in CI logs.
 *
 * It refuses to run on a database without the canary marker: the sweeps write
 * their idempotency stamps, and those must never land in production.
 */
import { handleWebApi } from "./api.ts";
import { webUserSchema } from "./users.ts";
import { sweepDeadlineNotifications, sweepSuggestionNotifications } from "./notify.ts";
import { listFilterSchema, presentList } from "../mcp/web_api_view.ts";
import { RELEASE_CANARY_KEY } from "./release-canary.ts";

export interface SmokeFailure {
  userId: string;
  step: string;
  error: string;
}

export interface SmokeResult {
  users: number;
  rows: number;
  failures: SmokeFailure[];
}

export async function smokeCanary(kv: Deno.Kv, nowMs: number): Promise<SmokeResult> {
  if ((await kv.get(RELEASE_CANARY_KEY)).value === null) {
    throw new Error("not a canary database (no marker) — refusing to run the smoke test");
  }
  const ids = {
    newId: () => crypto.randomUUID(),
    nowIso: () => Temporal.Instant.fromEpochMilliseconds(nowMs).toString(),
    nowMs: () => nowMs,
  };
  const failures: SmokeFailure[] = [];
  let users = 0;
  let rows = 0;
  for await (const e of kv.list({ prefix: ["webuser"] })) {
    const parsed = webUserSchema.safeParse(e.value);
    if (!parsed.success) continue;
    const user = parsed.data;
    users++;
    try {
      const res = await handleWebApi(
        kv,
        new Request("http://canary.local/api/reservations"),
        ids,
        { user, ledger: user.ledgerId },
      );
      if (res.status !== 200) {
        failures.push({ userId: user.id, step: "list", error: `http ${res.status}` });
        continue;
      }
      const list = (await res.json()).reservations;
      rows += list.length;
      presentList(list, listFilterSchema.parse({}), nowMs);
      presentList(
        list,
        listFilterSchema.parse({
          status: ["candidate", "confirmed", "to_cancel", "cancelled"],
          includeFinished: true,
          limit: 200,
        }),
        nowMs,
      );
    } catch (err) {
      failures.push({ userId: user.id, step: "list", error: String(err) });
    }
  }
  const quiet = {
    kv,
    nowMs,
    baseUrl: "https://canary.invalid",
    send: () => Promise.resolve(),
    line: { push: () => Promise.resolve() },
  };
  for (
    const [step, sweep] of [
      ["deadline sweep", sweepDeadlineNotifications],
      ["proposal sweep", sweepSuggestionNotifications],
    ] as const
  ) {
    try {
      await sweep(quiet);
    } catch (err) {
      failures.push({ userId: "-", step, error: String(err) });
    }
  }
  return { users, rows, failures };
}

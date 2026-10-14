/** Shared setup for the agent tests: a seeded demo world, a second user, and a scripted model. */
import { VirtualClock } from "../../core/clock/mod.ts";
import { seedDemoIfEmpty } from "../../deploy/demo.ts";
import {
  confirmReservationWithEffects,
  createReservationWithEffects,
  listReservations,
  type WebReservation,
} from "../../web/store.ts";
import { getOrCreateUserByEmail, getUser, type WebUser } from "../../web/users.ts";
import type { GeminiContent, GeminiRequest, GeminiResponse, GeminiTransport } from "../gemini.ts";
import { type AgentRouteDeps, handleAgentRoute } from "../routes.ts";
import { makeIds, withKv } from "./helpers.ts";

export const TOKEN = "scheduler-secret-for-tests";

/** 2026-10-15 20:00 JST. */
export const NOW = "2026-10-15T11:00:00Z";

export const fcResponse = (
  ...calls: { name: string; args: Record<string, unknown> }[]
): GeminiResponse => ({
  candidates: [{
    content: { role: "model", parts: calls.map((c) => ({ functionCall: c })) },
    finishReason: "STOP",
  }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
});

export const say = (text: string): GeminiResponse => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
});

/** The functionResponse payload the model was last handed, by tool name. */
export function lastToolResult(req: GeminiRequest, name: string): Record<string, unknown> | null {
  for (const c of [...req.contents].reverse()) {
    for (const p of c.parts) {
      if (p.functionResponse?.name === name) return p.functionResponse.response;
    }
  }
  return null;
}

export const lastContent = (req: GeminiRequest): GeminiContent => req.contents.at(-1)!;

/** A model whose behaviour is a function of the request, so one script can serve many users. */
export class ScriptedModel implements GeminiTransport {
  readonly name = "fake-vertex";
  readonly model = "fake-model";
  readonly requests: GeminiRequest[] = [];
  constructor(private readonly script: (req: GeminiRequest, n: number) => GeminiResponse) {}
  generate(req: GeminiRequest): Promise<GeminiResponse> {
    this.requests.push(structuredClone(req));
    return Promise.resolve(this.script(req, this.requests.length - 1));
  }
}

interface ListedRow {
  id: string;
  service: string;
  status: string;
}

/**
 * The behaviour of a sensible model: read the ledger, propose cancelling every
 * to_cancel row, then report. Reads ids only from what the tools returned.
 */
export const sensibleModel = () =>
  new ScriptedModel((req) => {
    const proposed = lastToolResult(req, "propose_cancellation");
    if (proposed !== null) return say("到着した提案を作成しました。承認をお待ちください。");
    const listed = lastToolResult(req, "list_reservations");
    if (listed === null) return fcResponse({ name: "list_reservations", args: {} });
    const rows = listed.reservations as ListedRow[];
    const losers = rows.filter((r) => r.status === "to_cancel");
    return losers.length === 0 ? say("対応が必要な予約はありません。") : fcResponse(
      ...losers.map((r) => ({
        name: "propose_cancellation",
        args: {
          reservation_id: r.id,
          reason: `${r.service}は確定済みの予約と重なっています。`,
          draft_message: `${r.service} ご担当者様 キャンセルをお願いいたします。`,
          urgency: "high",
        },
      })),
    );
  });

export interface World {
  kv: Deno.Kv;
  clock: VirtualClock;
  ids: ReturnType<typeof makeIds>;
  demo: WebUser;
  other: WebUser;
  /** The other user's reservations: one confirmed, one to_cancel loser. */
  otherRows: WebReservation[];
  deps: (model: GeminiTransport | null, over?: Partial<AgentRouteDeps>) => AgentRouteDeps;
}

export async function withWorld(fn: (w: World) => Promise<void>): Promise<void> {
  await withKv(async (kv) => {
    const clock = new VirtualClock(NOW);
    const ids = makeIds(clock);
    const seeded = await seedDemoIfEmpty({ kv, clock, ids, password: "demo-pass-1234" });
    if (seeded.status !== "seeded") throw new Error("demo seed failed");
    const other = await getOrCreateUserByEmail(kv, "other@example.com", ids);
    const when = "2026-10-20T19:00:00+09:00";
    const mk = (service: string, confirmed: boolean) =>
      createReservationWithEffects(kv, other.ledgerId, {
        plan: "他人の会食",
        service,
        startsAt: when,
        endsAt: null,
        amount: 10000,
        location: null,
        policy: "staged",
        confirmed,
      }, ids);
    await mk("別人の和食店", false);
    const winner = await mk("別人の鉄板焼き", false);
    await confirmReservationWithEffects(kv, other.ledgerId, winner.reservation.id, ids);
    await fn({
      kv,
      clock,
      ids,
      demo: seeded.user,
      other,
      otherRows: await listReservations(kv, other.ledgerId),
      deps: (model, over = {}) => ({
        kv,
        clock,
        ids,
        transport: model,
        agentToken: TOKEN,
        resolveUser: (req) => {
          const id = req.headers.get("x-test-user");
          return id === null ? Promise.resolve(null) : getUser(kv, id);
        },
        ...over,
      }),
    });
  });
}

/** Calls the agent routes as a user (or anonymously). */
export function call(
  deps: AgentRouteDeps,
  method: string,
  path: string,
  as?: WebUser,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handleAgentRoute(
    new Request(`http://localhost${path}`, {
      method,
      headers: { ...(as ? { "x-test-user": as.id } : {}), ...headers },
    }),
    deps,
  );
}

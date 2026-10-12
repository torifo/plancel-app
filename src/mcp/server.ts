/**
 * MCP server wiring (Task 3.3 + 3.4, L2b). Registers the registration/read
 * tools, the state-transition tools, and — only when the debug flag is on
 * (env `PLANCEL_DEBUG=1`, or `options.debug` for tests) — the SDD §10.5
 * debug tools onto an `McpServer` instance.
 *
 * Every tool routes through {@link invokeTool} so validation and error shaping
 * are uniform: a Zod failure becomes an MCP error result whose JSON content
 * lists the offending field paths + messages (US-004). The SDK is handed a
 * permissive passthrough input schema so it forwards the raw arguments; the
 * authoritative per-field validation is done by each tool's own Zod schema
 * inside `invokeTool`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { invokeTool, type ToolDefinition } from "./tools/shared.ts";
import { createEventTool } from "./tools/create_event.ts";
import { createReservationTool } from "./tools/create_reservation.ts";
import { createPlanTool } from "./tools/create_plan.ts";
import { addToPlanTool } from "./tools/add_to_plan.ts";
import { getPlanTool } from "./tools/get_plan.ts";
import { getEventTool } from "./tools/get_event.ts";
import { listPendingCancellationsTool } from "./tools/list_pending_cancellations.ts";
import { confirmReservationTool } from "./tools/confirm_reservation.ts";
import { reportCancelledTool } from "./tools/report_cancelled.ts";
import { voidReservationTool } from "./tools/void_reservation.ts";
import { setPolicyTool } from "./tools/set_policy.ts";
import {
  debugAdvanceClockTool,
  debugCausalChainTool,
  debugDumpStateTool,
  debugPreviewNotificationsTool,
} from "./tools/debug.ts";
import { debugReplayParseTool } from "./tools/debug_replay_parse.ts";

// deno-lint-ignore no-explicit-any
export const registrationTools: ToolDefinition<any>[] = [
  createEventTool,
  createReservationTool,
  createPlanTool,
  addToPlanTool,
  getPlanTool,
  getEventTool,
  listPendingCancellationsTool,
];

/** State-transition tools (Task 3.4). Always registered. */
// deno-lint-ignore no-explicit-any
export const transitionTools: ToolDefinition<any>[] = [
  confirmReservationTool,
  reportCancelledTool,
  voidReservationTool,
  setPolicyTool,
];

/** Debug tools (SDD §10.5). Registered only behind the debug flag. */
// deno-lint-ignore no-explicit-any
export const debugTools: ToolDefinition<any>[] = [
  debugDumpStateTool,
  debugAdvanceClockTool,
  debugPreviewNotificationsTool,
  debugCausalChainTool,
  debugReplayParseTool,
];

/** Whether the `PLANCEL_DEBUG=1` env flag enables the debug tools. */
export function debugFlagFromEnv(): boolean {
  return Deno.env.get("PLANCEL_DEBUG") === "1";
}

/** The full tool set for a server: registration + transition (+ debug if on). */
// deno-lint-ignore no-explicit-any
export function serverTools(debug: boolean): ToolDefinition<any>[] {
  return [...registrationTools, ...transitionTools, ...(debug ? debugTools : [])];
}

const passthroughSchema = z.object({}).passthrough();

interface McpTextResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Runs a tool definition and maps its `ToolRunResult` to an MCP tool result:
 * success → JSON text content (+ structuredContent, + any warnings); failure →
 * `isError` with the structured error (code, message, field issues).
 */
export async function runToolForMcp(
  // deno-lint-ignore no-explicit-any
  def: ToolDefinition<any>,
  ctx: ToolContext,
  rawInput: unknown,
): Promise<McpTextResult> {
  const result = await invokeTool(def, ctx, rawInput);
  if (result.ok) {
    const payload = result.warning === undefined
      ? result.data
      : { ...result.data, warning: result.warning };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }],
    isError: true,
  };
}

/**
 * Builds an `McpServer` with every registration/read + transition tool wired
 * to `ctx`. Debug tools (SDD §10.5) are included only when `options.debug`
 * is true — defaulting to the `PLANCEL_DEBUG=1` env flag.
 */
/** Prefix on every local-core tool description. */
const LOCAL_LEDGER_TAG = "[ローカル台帳]";

/** What pairing_status answers in local-core mode (issue #3). */
export const LOCAL_LEDGER_NOTICE =
  "接続先: この PC のローカル KV にあるコア台帳です。本番の台帳ではないので、ここで作った予約は" +
  "スマホの plancel には出ません。スマホと同じ台帳を使うには、PLANCEL_API_URL を付けて MCP を登録し直して" +
  "ください（README「使い方」の最初のコマンド）。";

export function buildServer(ctx: ToolContext, options: { debug?: boolean } = {}): McpServer {
  const server = new McpServer({ name: "plancel", version: "0.1.0" });
  const debug = options.debug ?? debugFlagFromEnv();

  // Several names here (create_reservation, confirm_reservation) also exist on
  // the remote server with different arguments and meaning (issue #3). The
  // prefix tells the model which ledger a tool writes to; pairing_status below
  // answers the question outright, under the same name as remote mode.
  for (const def of serverTools(debug)) {
    server.registerTool(
      def.name,
      { description: `${LOCAL_LEDGER_TAG} ${def.description}`, inputSchema: passthroughSchema },
      // deno-lint-ignore no-explicit-any
      (args: any) => runToolForMcp(def, ctx, args ?? {}),
    );
  }
  server.registerTool("pairing_status", {
    description: "どの台帳に接続しているかを返す（このサーバーはローカルのコア台帳）",
    inputSchema: passthroughSchema,
  }, () => ({ content: [{ type: "text" as const, text: LOCAL_LEDGER_NOTICE }] }));

  return server;
}

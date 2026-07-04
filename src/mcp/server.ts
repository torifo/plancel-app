/**
 * MCP server wiring (Task 3.3, L2b). Registers the 7 registration/read tools
 * onto an `McpServer` instance. State-transition and debug tools are Task 3.4.
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

/** Builds an `McpServer` with all 7 registration/read tools wired to `ctx`. */
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "plancel", version: "0.1.0" });

  for (const def of registrationTools) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: passthroughSchema },
      // deno-lint-ignore no-explicit-any
      (args: any) => runToolForMcp(def, ctx, args ?? {}),
    );
  }

  return server;
}

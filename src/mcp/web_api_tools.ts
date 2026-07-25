/**
 * MCP → Web-ledger tools (owner 2026-07-23, 検証トラック3).
 *
 * When `PLANCEL_API_URL` + `PLANCEL_API_TOKEN` are set, src/mcp/main.ts
 * serves THESE tools instead of the local core-store tools: they call the
 * production `/api/reservations` HTTP API with the user's personal API
 * token (issued from the Web UI's カレンダー連携 modal), so reservations
 * created from Claude land in the same ledger the family sees — and flow
 * to their calendars through the existing sync.
 *
 * fetch is injected for tests; every tool returns the API's JSON verbatim.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface WebApiConfig {
  /** e.g. https://plancel-app.torifo.deno.net */
  baseUrl: string;
  /** Personal API token (x-plancel-token). */
  token: string;
  fetchFn?: typeof fetch;
}

const createInput = z.object({
  service: z.string().min(1).describe("お店・宿・サービス名"),
  startsAt: z.string().min(1).describe("開始日時 (ISO8601, 例 2026-08-01T19:00:00+09:00)"),
  plan: z.string().nullable().default(null).describe("プラン名（候補を束ねる場合）"),
  amount: z.number().nullable().default(null).describe("金額（円）"),
  location: z.string().nullable().default(null).describe("場所（店名・住所、任意）"),
  policy: z.enum(["unknown", "none", "free24", "staged"]).default("unknown"),
  confirmed: z.boolean().default(false).describe("true で確定済みとして登録"),
});

const idInput = z.object({ id: z.string().min(1).describe("予約ID") });

const patchInput = z.object({
  id: z.string().min(1),
  service: z.string().min(1).optional(),
  startsAt: z.string().min(1).optional(),
  plan: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  location: z.string().nullable().optional(),
  policy: z.enum(["unknown", "none", "free24", "staged"]).optional(),
});

interface McpTextResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

async function callApi(
  cfg: WebApiConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<McpTextResult> {
  const fetchFn = cfg.fetchFn ?? fetch;
  const res = await fetchFn(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      "x-plancel-token": cfg.token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { content: [{ type: "text", text }], ...(res.ok ? {} : { isError: true }) };
}

/** Builds the remote-mode MCP server (web-ledger tools only). */
export function buildWebApiServer(cfg: WebApiConfig): McpServer {
  const server = new McpServer({ name: "plancel-web", version: "0.1.0" });

  server.registerTool("list_reservations", {
    description: "Web台帳の予約一覧（候補/確定/要キャンセル/キャンセル済み）を取得する",
    inputSchema: z.object({}).passthrough(),
  }, () => callApi(cfg, "GET", "/api/reservations"));

  server.registerTool(
    "create_reservation",
    {
      description:
        "Web台帳に予約を登録する（confirmed=true で確定として登録。確定は家族のカレンダーにも反映される）",
      inputSchema: createInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = createInput.safeParse(args ?? {});
      if (!parsed.success) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: JSON.stringify(parsed.error.issues) }],
          isError: true,
        });
      }
      return callApi(cfg, "POST", "/api/reservations", parsed.data);
    },
  );

  const transitions: [string, string, string][] = [
    ["confirm_reservation", "confirm", "候補を確定する（同プランの他候補は自動で要キャンセルに）"],
    ["cancel_reservation", "cancel", "予約をキャンセル済みにする"],
    ["restore_reservation", "restore", "キャンセル済み/要キャンセルの予約を候補に復元する"],
  ];
  for (const [name, action, description] of transitions) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: idInput.passthrough(),
      }, // deno-lint-ignore no-explicit-any
      (args: any) => {
        const parsed = idInput.safeParse(args ?? {});
        if (!parsed.success) {
          return Promise.resolve({
            content: [{ type: "text" as const, text: JSON.stringify(parsed.error.issues) }],
            isError: true,
          });
        }
        return callApi(cfg, "POST", `/api/reservations/${parsed.data.id}/${action}`);
      },
    );
  }

  server.registerTool(
    "update_reservation",
    {
      description: "予約の内容（日時・金額・場所・プラン等）を編集する",
      inputSchema: patchInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = patchInput.safeParse(args ?? {});
      if (!parsed.success) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: JSON.stringify(parsed.error.issues) }],
          isError: true,
        });
      }
      const { id, ...patch } = parsed.data;
      return callApi(cfg, "PATCH", `/api/reservations/${id}`, patch);
    },
  );

  server.registerTool(
    "delete_reservation",
    {
      description: "予約を完全に削除する（復元不可）",
      inputSchema: idInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = idInput.safeParse(args ?? {});
      if (!parsed.success) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: JSON.stringify(parsed.error.issues) }],
          isError: true,
        });
      }
      return callApi(cfg, "DELETE", `/api/reservations/${parsed.data.id}`);
    },
  );

  return server;
}

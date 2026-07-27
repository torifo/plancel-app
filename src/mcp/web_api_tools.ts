/**
 * MCP → Web-ledger tools (owner 2026-07-23, 検証トラック3).
 *
 * When `PLANCEL_API_URL` + `PLANCEL_API_TOKEN` are set, src/mcp/main.ts
 * serves THESE tools instead of the local core-store tools: they call the
 * production `/api/reservations` + `/api/policy-templates` HTTP API with the user's personal API
 * token (issued from the Web UI's カレンダー連携 modal), so reservations
 * created from Claude land in the same ledger the family sees — and flow
 * to their calendars through the existing sync.
 *
 * fetch is injected for tests; every tool returns the API's JSON verbatim.
 *
 * Scope principle (owner 2026-07-23): 「GUI でできることは MCP でもできる」
 * が理念 — future tools may cover profile edits (display name etc.). The
 * EXCEPTIONS are identity-critical, deliberately human/GUI-only flows:
 * unique-uid claiming and account linking/merging are NEVER exposed here.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { webPolicyInputSchema } from "../web/policy.ts";
import { templatePolicyInputSchema } from "../web/policy-template.ts";

export interface WebApiConfig {
  /** e.g. https://plancel-app.torifo.deno.net */
  baseUrl: string;
  /** Personal API token (x-plancel-token). */
  token: string;
  fetchFn?: typeof fetch;
}

/** Presets stay one word; any other policy goes through the stage table. */
const POLICY_DESC =
  'キャンセル規定: "unknown"/"none"(いつでも無料)/"free24"(前日まで無料)/"staged"(7日前まで無料→30%→50%→100%) ' +
  'または任意の段階 {"stages":[{"h":120,"pct":0},{"h":0,"pct":100}]}（h=開始までの残り時間, pct=料率%、最後は h=0）';

const createInput = z.object({
  service: z.string().min(1).describe("お店・宿・サービス名"),
  startsAt: z.string().min(1).describe("開始日時 (ISO8601, 例 2026-08-01T19:00:00+09:00)"),
  plan: z.string().nullable().default(null).describe("プラン名（候補を束ねる場合）"),
  amount: z.number().nullable().default(null).describe("金額（円）"),
  location: z.string().nullable().default(null).describe("場所（店名・住所、任意）"),
  policy: webPolicyInputSchema.default("unknown").describe(POLICY_DESC),
  confirmed: z.boolean().default(false).describe("true で確定済みとして登録"),
});

const idInput = z.object({ id: z.string().min(1).describe("予約ID") });

const facilityInput = z.object({
  facility: z.string().min(1).max(100).describe(
    "お店・宿・サービス名（全角/半角・空白・大小は同一視）",
  ),
});

const templateInput = facilityInput.extend({
  // "unknown" is not offered: a template that states no rate would pre-fill the
  // form with 不明 and hide that the fee table was never entered.
  policy: templatePolicyInputSchema.describe(
    POLICY_DESC.replace('"unknown"/', "") + "（テンプレに unknown は保存できない）",
  ),
});

const patchInput = z.object({
  id: z.string().min(1),
  service: z.string().min(1).optional(),
  startsAt: z.string().min(1).optional(),
  plan: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  location: z.string().nullable().optional(),
  policy: webPolicyInputSchema.optional().describe(POLICY_DESC),
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
  // 204 (template delete) carries no body, and MCP text content must not be empty.
  const reply = text === "" ? JSON.stringify({ ok: res.ok, status: res.status }) : text;
  return { content: [{ type: "text", text: reply }], ...(res.ok ? {} : { isError: true }) };
}

/** Bad tool arguments: reported to the caller instead of hitting the API. */
const invalidArgs = (issues: unknown): Promise<McpTextResult> =>
  Promise.resolve({
    content: [{ type: "text" as const, text: JSON.stringify(issues) }],
    isError: true,
  });

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
      if (!parsed.success) return invalidArgs(parsed.error.issues);
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
        if (!parsed.success) return invalidArgs(parsed.error.issues);
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
      if (!parsed.success) return invalidArgs(parsed.error.issues);
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
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      return callApi(cfg, "DELETE", `/api/reservations/${parsed.data.id}`);
    },
  );

  // ---- 施設ごとのキャンセル規定テンプレ (owner 2026-07-27) ----
  // 「GUI でできることは MCP でもできる」: the same four operations the web
  // form uses, so Claude can remember a hotel's fee table and reuse it.
  server.registerTool("list_policy_templates", {
    description: "登録済みのキャンセル規定テンプレ（施設ごとの規定ベース）を一覧する",
    inputSchema: z.object({}).passthrough(),
  }, () => callApi(cfg, "GET", "/api/policy-templates"));

  server.registerTool(
    "lookup_policy_template",
    {
      description:
        "施設名からキャンセル規定テンプレを引く（完全一致。全角/半角・空白・大小文字は同一視。無ければ template:null）",
      inputSchema: facilityInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = facilityInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      const q = encodeURIComponent(parsed.data.facility);
      return callApi(cfg, "GET", `/api/policy-templates/lookup?service=${q}`);
    },
  );

  server.registerTool(
    "save_policy_template",
    {
      description:
        "施設のキャンセル規定テンプレを保存する（同じ施設なら上書き。以後その施設の予約はこの規定を初期値にできる）",
      inputSchema: templateInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = templateInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      const { facility, ...body } = parsed.data;
      return callApi(cfg, "PUT", `/api/policy-templates/${encodeURIComponent(facility)}`, body);
    },
  );

  server.registerTool(
    "delete_policy_template",
    {
      description: "施設のキャンセル規定テンプレを削除する（予約自体には影響しない）",
      inputSchema: facilityInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = facilityInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      const path = `/api/policy-templates/${encodeURIComponent(parsed.data.facility)}`;
      return callApi(cfg, "DELETE", path);
    },
  );

  return server;
}

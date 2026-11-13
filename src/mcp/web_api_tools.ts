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
 * unique-uid claiming, account linking/merging, and issuing a LINE link code
 * (owner 2026-07-27) are NEVER exposed here. Sharing is NOT such an exception,
 * so the invite/role tools live here too (owner 2026-07-28).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type Clock, SystemClock } from "../core/clock/mod.ts";
import { readableInstantSchema } from "../web/instant.ts";
import {
  type ApiReservation,
  findDuplicate,
  findSameDay,
  listFilterSchema,
  presentList,
  presentReservation,
  presentResponse,
  type TripMetaInput,
} from "./web_api_view.ts";
import { webPolicyInputSchema } from "../web/policy.ts";
import { webKindSchema } from "../web/store.ts";
import { templatePolicyInputSchema } from "../web/policy-template.ts";
import { memberRoleSchema } from "../web/sharing.ts";
import { FARE_PRESETS } from "../web/fares.ts";

export interface WebApiConfig {
  /** e.g. https://plancel-app.torifo.deno.net */
  baseUrl: string;
  /**
   * Personal API token (x-plancel-token) — a fixed string, or a lazy supplier
   * for device pairing (issue #1), where the token arrives later than the
   * server starts. `null` means "not paired yet".
   */
  token: string | (() => Promise<string | null>);
  fetchFn?: typeof fetch;
  /** For 「終わった予約」 and deadline views; the system clock when absent. */
  clock?: Clock;
  /**
   * Present in pairing mode. `start()` begins (or reports) a request;
   * `forget()` drops a token the API just refused. Absent → a missing token
   * is a configuration error, reported as such.
   */
  pairing?: {
    start(force?: boolean): Promise<PairingStateView>;
    forget(): Promise<void>;
    current(): PairingStateView;
  };
}

/** What a tool reply needs to know about pairing — nothing about the token. */
export type PairingStateView =
  | { kind: "idle" }
  | { kind: "pending"; userCode: string; verificationUri: string; expiresAtMs: number }
  | { kind: "paired"; account: { label: string } }
  | { kind: "denied" }
  | { kind: "expired" };

/** Presets stay one word; any other policy goes through the stage table. */
const POLICY_DESC =
  'キャンセル規定: "unknown"/"none"(いつでも無料)/"free24"(前日まで無料)/"staged"(7日前まで無料→30%→50%→100%) ' +
  "または任意の段階。各段階は「開始の h 時間前の日いっぱいまで pct%」で、h は日数×24（前日=24、3日前=72、" +
  "当日=0）、期限は時刻でなくその日の終わりで切る。最後の段階は必ず h=0（当日）。" +
  "「前日まで無料」としか聞いていないときは free24 でよい（当日は100%と仮定する。違うと分かったら段階で直す）。" +
  '例「3日前まで無料、そのあと50%、当日100%」= {"stages":[{"h":72,"pct":0},{"h":24,"pct":50},{"h":0,"pct":100}]}、' +
  '「5日前まで無料、以降は全額」= {"stages":[{"h":120,"pct":0},{"h":0,"pct":100}]}、' +
  '航空券「55日前まで5%、それ以降は50%」= {"stages":[{"h":1320,"pct":5},{"h":0,"pct":50}]}。' +
  "料率の基準が支払額と違う（税抜運賃の◯%、1人あたりの手数料など）ときも、いちばん近い段階で入れ、正確な基準は" +
  "notes に書く（unknown のままだと期限を見張れない）";

// 「10月27日 19時」のような自然文は受け付けない（issue #2）。モデルはそのまま渡しがち
// なので、説明文で ISO に直してから渡すことを求め、zod で API に届く前に弾く。
const STARTS_AT_DESC =
  "開始日時。ISO 8601 で渡す（例 2026-10-27T19:00:00+09:00。オフセットが無ければ JST）。" +
  "「10月27日 19時」「来週の金曜」のような自然文は不可 — 今日の日付から ISO に直してから渡す";

// 終了は「日」だけが効く（その日の終わりまで予約が続いている扱いになる）。最初の
// 実走で、チェックアウトの日付は分かるのに時刻が不明だからと省かれ、宿泊が初日の
// 夜に「終わった予約」へ回る形で登録された（2026-11-12）。
const ENDS_AT_DESC =
  "終了日時（宿泊のチェックアウト日など、任意）。時刻が分からなければ日付だけでよい（例 2026-12-20）。" +
  "連泊・宿泊では必ず入れる — 無いと初日の終わりに「終わった予約」扱いになる";

const NOTES_DESC =
  "メモ（任意、2000字まで）。決まった欄に入らない情報を残す所: 食事の有無、含まれる券、人数と料金の単位" +
  "（例「税込・家族4人合計」）、予約番号・予約サイト、規定の補足（例「連絡なし不泊は100%」）。ユーザーが言った" +
  "補足は捨てずにここへ入れる";
const TRIP_DESC =
  "旅行名（任意）。同じ旅行で全部使う予約（宿・行きの便・帰りの便・食事など）をまとめる名前。plan とは別物: " +
  "plan は1件だけ確定して残りをキャンセルする候補の束、trip はどれもキャンセルされない。両方付けてよい" +
  "（例: trip=別府旅行 の中に plan=宿の候補）";
const TIME_TENTATIVE_DESC =
  "開始時刻が仮のとき true（「たぶん15時半ごろ」「時間は未定」など）。日付が確かなら時刻を仮に置いて登録し、" +
  "これを true にする。まったく未定なら startsAt を日付だけにする（自動で仮になり、応答でも日付だけで返って" +
  "needsCheck に「時刻が未定」と出る。その日の最後に並ぶ）。" +
  "時刻が確定したら update_reservation で false に戻す";

const BOOKED_DESC =
  "予約がもう取れているか（既定 true）。まだ手配していない案・検討中のものは false にする" +
  "（例: 切符をまだ買っていない特急）。false の予約にはキャンセル期限も料金も無く、プランで選ばれなかったときは" +
  "要キャンセルにならずそのまま外れる。予約を取ったら update_reservation で true にする。" +
  '予約が要らないもの（予約不要のバスなど）は、乗る・使うと決めた時点で booked: true・policy: "none" にする';

const KIND_DESC =
  '種類（任意）: "stay"(宿) / "meal"(食事) / "flight"(飛行機) / "train"(新幹線・電車・特急) / "bus"(バス) / ' +
  '"car"(レンタカー・カーシェア) / "parking"(駐車場。startsAt＝入庫、endsAt＝出庫) / "activity"(体験・チケット) / "other"。宿に限らず、キャンセル期限のある' +
  "予約は何でも登録できる";
const SERVICE_DESC =
  "お店・宿・サービス名。交通は便名・列車名を入れる（例「JAL 661便」「特急ソニック 15号」「空港バス 別府行き」" +
  "「タイムズカー 大分空港店」）。同じ日の行きと帰りは名前で分ける";
const FROM_DESC = "出発地（交通）／借りる場所（車）。例「羽田」「博多駅」。任意";
const TO_DESC = "到着地（交通）／返す場所（車）。到着時刻が分かれば endsAt に入れる。任意";
const BOOKED_BY_DESC =
  "実際に予約を取った人（例「母」。ユーザー自身なら「自分」）。誰に確認やキャンセルを頼めばよいかが分かる。任意";

const REF_DESC =
  "予約番号（任意）。1つの便・宿を人数や運賃ごとに別々に予約したときは、予約ごとに違う番号になるので、それぞれに入れる";
const FARE_DESC =
  "運賃・料金プランの名前（任意）。JAL 国内線の運賃なら「JAL スペシャルセイバー」のように入れると、policy を省いたとき" +
  'その運賃の取消規定が自動で入る（応答の policySource が "fare"）。分かる運賃: ' +
  FARE_PRESETS.map((p) => p.label).join("・") +
  "。家族がその運賃の規定を直して保存していれば、そちらが入る。航空会社が規定を変えることがあるので、予約の画面や" +
  "メールと違えば policy で直す";
const PEOPLE_DESC =
  "この予約で何人分か（任意）。家族4人で行くが2人ずつしか買えなかった便なら、それぞれ 2。宿に家族全員で泊まるなら 4。" +
  "旅行の人数（set_trip_people）と合わせて、同じ時間帯の予約が「分けて取った（全部使う）」のか「人数より多い" +
  "（外すものがある）」のかを見分ける。入れないと全員分とみなし、重なる予約は「どれか1つ」として扱う";

const createInput = z.object({
  service: z.string().min(1).describe(SERVICE_DESC),
  kind: webKindSchema.nullable().default(null).describe(KIND_DESC),
  startsAt: readableInstantSchema.describe(STARTS_AT_DESC),
  endsAt: readableInstantSchema.nullable().default(null).describe(ENDS_AT_DESC),
  from: z.string().max(100).nullable().default(null).describe(FROM_DESC),
  to: z.string().max(100).nullable().default(null).describe(TO_DESC),
  bookedBy: z.string().max(40).nullable().default(null).describe(BOOKED_BY_DESC),
  people: z.number().int().min(1).max(99).nullable().default(null).describe(PEOPLE_DESC),
  ref: z.string().max(40).nullable().default(null).describe(REF_DESC),
  fare: z.string().max(40).nullable().default(null).describe(FARE_DESC),
  plan: z.string().nullable().default(null).describe(
    "プラン名（画面では「候補グループ」と呼ぶ）。同じ予定の候補（どちらにするか迷っている店・宿）を束ねる名前で、" +
      "同じプラン名の中で確定できるのは1件、1件確定すると残りは要キャンセルになる。宿の「夕朝食付きプラン」のような" +
      "宿泊プランのことではない（それは fare に書く。plan に入れると別々の宿が束ねられ、片方の確定でもう片方が" +
      "要キャンセルになる）。候補が1つだけの予約は省略してよい。全部使う予約をまとめたいときは plan でなく trip を使う",
  ),
  trip: z.string().max(60).nullable().default(null).describe(TRIP_DESC),
  booked: z.boolean().default(true).describe(BOOKED_DESC),
  timeTentative: z.boolean().default(false).describe(TIME_TENTATIVE_DESC),
  notes: z.string().max(2000).nullable().default(null).describe(NOTES_DESC),
  amount: z.number().int().min(0).nullable().default(null).describe("金額（円、0 以上の整数）"),
  location: z.string().nullable().default(null).describe("場所（店名・住所、任意）"),
  policy: webPolicyInputSchema.default("unknown").describe(POLICY_DESC),
  confirmed: z.boolean().default(false).describe(
    "true で確定（これに決めている）として登録。迷っているものは false のまま（候補）。" +
      "決めたかどうかと、予約が取れているか（booked）は別に指定する",
  ),
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
    POLICY_DESC.replace('"unknown"/', "") + "（施設の既定規定に unknown は保存できない）",
  ),
});

const patchInput = z.object({
  id: z.string().min(1).describe("予約ID"),
  service: z.string().min(1).optional().describe(SERVICE_DESC),
  kind: webKindSchema.nullable().optional().describe(KIND_DESC),
  from: z.string().max(100).nullable().optional().describe(FROM_DESC),
  to: z.string().max(100).nullable().optional().describe(TO_DESC),
  bookedBy: z.string().max(40).nullable().optional().describe(BOOKED_BY_DESC),
  people: z.number().int().min(1).max(99).nullable().optional().describe(PEOPLE_DESC),
  ref: z.string().max(40).nullable().optional().describe(REF_DESC + "。null で消す"),
  fare: z.string().max(40).nullable().optional().describe(
    FARE_DESC + "。規定が不明の予約に運賃を入れると、その規定が入る。null で消す",
  ),
  startsAt: readableInstantSchema.optional().describe(STARTS_AT_DESC),
  endsAt: readableInstantSchema.nullable().optional().describe(ENDS_AT_DESC + "。null で消す"),
  plan: z.string().nullable().optional().describe(
    "プラン名（画面では「候補グループ」。宿泊プランではない。null で外す）",
  ),
  trip: z.string().max(60).nullable().optional().describe(TRIP_DESC + "。null で外す"),
  booked: z.boolean().optional().describe(BOOKED_DESC),
  timeTentative: z.boolean().optional().describe(TIME_TENTATIVE_DESC),
  notes: z.string().max(2000).nullable().optional().describe(
    NOTES_DESC + "。上書きになるので、足すときは既存のメモに続けて書く。null で消す",
  ),
  amount: z.number().int().min(0).nullable().optional().describe("金額（円、0 以上の整数）"),
  location: z.string().nullable().optional().describe("場所（店名・住所。null で消す）"),
  policy: webPolicyInputSchema.optional().describe(POLICY_DESC),
  rank: z.number().int().min(1).max(99).nullable().optional().describe(
    "希望順（1 が第1希望）。どれか1つにする組（一覧の overlaps や同じプランの候補）の中で、家族が" +
      "どれを一番取りたいか。共有している人にも同じ順で見える。null で外す",
  ),
});

const ROLE_DESC =
  '共有相手の権限: "viewer"（閲覧のみ・既定）/ "editor"（内容の編集も許可）。確定・キャンセル・削除・' +
  "招待・権限変更はどちらの権限でもオーナー専用";

const shareInput = z.object({
  id: z.string().min(1).describe("予約ID"),
  q: z.string().min(1).describe("相手のメールアドレスまたはユーザーID（完全一致）"),
  role: memberRoleSchema.default("viewer").describe(ROLE_DESC),
});

const memberRoleInput = z.object({
  id: z.string().min(1).describe("予約ID"),
  userId: z.string().min(1).describe("共有相手の userId（list_reservation_members が返す）"),
  role: memberRoleSchema.describe(ROLE_DESC),
});

const memberInput = z.object({
  id: z.string().min(1).describe("予約ID"),
  userId: z.string().min(1).describe("共有相手の userId"),
});

interface McpTextResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const textResult = (text: string, isError = false): McpTextResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/** The sentence Claude relays when the PC is not paired yet (issue #1). */
export function pairingInstructions(state: PairingStateView): string {
  switch (state.kind) {
    case "pending":
      return [
        "plancel との連携がまだです。スマホの plancel で次のとおり承認してください。",
        "",
        `  コード: ${state.userCode}`,
        "",
        "  1. スマホで plancel を開く（ログイン済みのアカウントで）",
        "  2. 下のメニュー「連携」→「④ Claude（PC）を承認する」",
        "  3. 上のコードを入力して「確認」→ 要求元と時刻を見て「承認する」",
        "",
        "承認が済んだら、同じ操作をもう一度頼んでください。コードは10分で失効します。",
        "このコードを Claude に伝える必要はありません（会話に貼らないでください）。",
      ].join("\n");
    case "denied":
      return "連携はスマホ側で拒否されました。やり直すときは pair_with_plancel を force: true で呼んでください。";
    case "expired":
      return "連携コードの期限が切れました。もう一度 pair_with_plancel を呼ぶと新しいコードを出します。";
    case "paired":
      // Says WHICH ledger, not just that it is paired: the local-core server
      // answers the same tool, and the two are easy to confuse (issue #3).
      return `接続先: 本番の台帳（${state.account.label}）。スマホの plancel と同じ台帳です。`;
    case "idle":
      return "plancel と連携していません。pair_with_plancel を呼ぶとコードが出ます。";
  }
}

/**
 * Which ledger this server writes to. A server on this machine is a
 * development ledger the phone never shows; anything else is the real one.
 */
function ledgerLine(cfg: WebApiConfig, account: string | null): string {
  const host = new URL(cfg.baseUrl).host;
  const who = account ?? "PLANCEL_API_TOKEN による固定接続";
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)
    ? `接続先: 開発用の台帳（${host}、${who}）。この PC の中だけの台帳で、スマホの plancel には出ません。`
    : `接続先: 本番の台帳（${host}、${who}）。スマホの plancel と同じ台帳です。`;
}

async function resolveToken(cfg: WebApiConfig): Promise<string | null> {
  return typeof cfg.token === "string" ? cfg.token : await cfg.token();
}

const nowMsOf = (cfg: WebApiConfig): number =>
  (cfg.clock ?? new SystemClock()).now().epochMilliseconds;

/** JSON of a body, or the raw text when it is not JSON. */
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** The API answer the model reads: rows in JST with deadlines, errors with a hint. */
function finish(cfg: WebApiConfig, res: Response, text: string): McpTextResult {
  // 204 (template delete) carries no body, and MCP text content must not be empty.
  if (text === "") return textResult(JSON.stringify({ ok: res.ok, status: res.status }), !res.ok);
  const body = parseJson(text);
  const shown = typeof body === "string"
    ? body
    : JSON.stringify(presentResponse(body, nowMsOf(cfg)));
  return textResult(shown, !res.ok);
}

async function callApi(
  cfg: WebApiConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<McpTextResult> {
  const r = await request(cfg, method, path, body);
  return "res" in r ? finish(cfg, r.res, r.text) : r;
}

/** One API call, or the reply that stands in for it when the PC is not paired. */
async function request(
  cfg: WebApiConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<McpTextResult | { res: Response; text: string }> {
  const token = await resolveToken(cfg);
  if (token === null) {
    // Not paired: say so with the code, and let the poll run behind the reply.
    if (cfg.pairing === undefined) {
      return textResult("PLANCEL_API_TOKEN が設定されていません。", true);
    }
    const state = await cfg.pairing.start();
    return textResult(pairingInstructions(state), true);
  }
  const fetchFn = cfg.fetchFn ?? fetch;
  const res = await fetchFn(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      "x-plancel-token": token,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (res.status === 401 && cfg.pairing !== undefined && typeof cfg.token !== "string") {
    // The token was revoked on マイページ. Drop it; the next call re-pairs.
    await cfg.pairing.forget();
    return textResult(
      "plancel との連携が解除されています（マイページで失効されたか、アカウントが変わりました）。" +
        "もう一度操作を頼むと、新しい連携コードを出します。",
      true,
    );
  }
  return { res, text };
}

/** Every row of the ledger, or the stand-in reply when the API could not answer. */
async function fetchLedger(
  cfg: WebApiConfig,
): Promise<{ rows: ApiReservation[]; trips: TripMetaInput[] } | McpTextResult> {
  const r = await request(cfg, "GET", "/api/reservations");
  if (!("res" in r)) return r;
  if (!r.res.ok) return finish(cfg, r.res, r.text);
  const body = parseJson(r.text) as { reservations?: ApiReservation[]; trips?: TripMetaInput[] };
  return {
    rows: Array.isArray(body?.reservations) ? body.reservations : [],
    trips: Array.isArray(body?.trips) ? body.trips : [],
  };
}

async function fetchRows(cfg: WebApiConfig): Promise<ApiReservation[] | McpTextResult> {
  const ledger = await fetchLedger(cfg);
  return "rows" in ledger ? ledger.rows : ledger;
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
    description:
      "台帳の予約一覧。既定ではキャンセル済みと終わった予約を除く（除いた件数は hidden に出る）。count が" +
      "この応答の件数で、total は絞り込み（status / from / to / q）をかける前の台帳の全件数。開始が早い順に最大 50 件。日時は +09:00 表記。freeUntil が無料キャンセル期限" +
      "（null は期限が無いということ: 規定不明で見張れない＝その件数が policyUnknown、または「いつでも無料」「最初から有料」。policyText で見分ける）、nextCharge.from が料金のかかり始める時刻、" +
      "feeNow がいまキャンセルした場合の料率と金額。feeSchedule は料率表を日付にしたもの（until までは pct%＝yen 円）で、" +
      "ユーザーに料金を説明するときは policyText の言い回しでなく feeSchedule の日付を使う。" +
      "possibleDuplicates は同じ店・同じ日の予約の組（自分のものと共有されたものを含む。同じ予約の二重登録かも" +
      "しれないので、ユーザーに確かめる。まとめるなら merge_reservations）。" +
      "overlaps は両方は使えない予約の組: kind が stay なら同じ夜に重なっている別々の宿、transport なら同じ時間帯に" +
      "重なっている飛行機・電車・バス、parking なら同じ期間に重なっている駐車場（自分のものと共有されたものを含む。どちらか1つにするはずなので、" +
      "金額と freeUntil、reservations の同じ id にある feeSchedule を並べてユーザーに見せ、どちらにするか聞く。" +
      "owner は共有してくれた持ち主の名前で、null は自分の予約。decideBy は組の中でいちばん早い freeUntil で、" +
      "それまでに決めればどちらを外しても無料（残す方が決まっているなら、外す方の freeUntil が実際の期限）。" +
      "決まったら choose_reservation）。overlaps の mode は、旅行の人数（party）と各予約の people から: " +
      '"choose"＝どれか1つ（人数が分からない予約がある）、"split"＝人数を分けて取った予約で全部使う（決めることは無い。' +
      "外さない。shortBy が 1 以上なら、その人数分の席がまだ無いのでユーザーに伝える）、" +
      '"over"＝人数より席が多い（peopleTotal − party 人分を drop_reservation で外す。外すと人数を割り込む予約は外さない）。' +
      "同じ便を人数を分けて2回以上取った組も split として載る。" +
      "trips の people は旅行の人数（peopleInferred は予約から推定）。" +
      "needsCheck は各予約でまだ決まっていない・確かめていないこと（要キャンセルの予約には「取り消しの連絡が要る」が出る）、trips は旅行ごとの日程と費用" +
      "（confirmedYen＝確定の合計、expectedYen＝未確定を含む見込みの最大）",
    inputSchema: listFilterSchema.passthrough(),
  }, async (args: unknown) => {
    const filter = listFilterSchema.safeParse(args ?? {});
    if (!filter.success) return invalidArgs(filter.error.issues);
    const ledger = await fetchLedger(cfg);
    if (!("rows" in ledger)) return ledger;
    return textResult(
      JSON.stringify(presentList(ledger.rows, filter.data, nowMsOf(cfg), ledger.trips)),
    );
  });

  server.registerTool(
    "create_reservation",
    {
      description:
        "台帳に予約を登録する（confirmed=true で確定として登録。確定は家族のカレンダーにも反映される）。" +
        "同じ店・同じ日の予約が既にあっても登録は行い、応答の warning と similar で知らせる" +
        "（同じ宿を別々に予約することもあるので止めない。入れ直しかどうかはユーザーに確かめる）。" +
        "キャンセル規定の決め方: 分かれば policy に入れる。分からなければ省略する（施設の既定規定が保存されて" +
        'いれば自動で適用され、応答の policySource が "template" になる）。それでも policySource が ' +
        '"unknown" で hint が返ったら、規定はユーザーに確認して update_reservation の policy で入れる' +
        "（不明のままだとキャンセル期限を見張れない）。" +
        "1つの便や宿を、人数や運賃ごとに別々に予約したとき（例: 家族4人で2席ずつ別々に購入）は、予約ごとに1件ずつ" +
        "登録し、people・amount・ref はその予約の分を入れる（同じ便なら service と日時は同じでよい）。1件にまとめて" +
        "内訳をメモに書くと、別々の予約として取り消せない。1回の予約で全員分を取ったなら1件でよい",
      inputSchema: createInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    async (args: any) => {
      const parsed = createInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      const input = parsed.data;
      // Look first, create regardless (owner 2026-11-12: 「同じ宿の同じプランを別で
      // 予約することもあるから、通知であくまでブロックはしない」). A family books
      // the same inn twice on purpose; whether a look-alike is a mistake is for
      // the person to say, so the reply names it and the reservation is made.
      const rows = await fetchRows(cfg);
      if (!Array.isArray(rows)) return rows;
      const exact = findDuplicate(rows, input.service, input.startsAt);
      const similar = exact ?? findSameDay(rows, input.service, input.startsAt);
      const r = await request(cfg, "POST", "/api/reservations", input);
      if (!("res" in r)) return r;
      if (!r.res.ok || similar === null) return finish(cfg, r.res, r.text);
      const body = parseJson(r.text);
      if (typeof body !== "object" || body === null) return finish(cfg, r.res, r.text);
      const shown = presentResponse(body, nowMsOf(cfg)) as Record<string, unknown>;
      const note = exact !== null
        ? "同じ店・同じ開始日時の予約が既にあります。"
        : "同じ店・同じ日の予約が既にあります（時刻だけ違う同じ予約かもしれません）。";
      return textResult(JSON.stringify({
        ...shown,
        // The API's own warning (past start, settled plan) keeps the first seat.
        warning: shown.warning ?? (exact !== null ? "duplicate" : "possible_duplicate"),
        similar: presentReservation(similar, nowMsOf(cfg)),
        hint: [
          shown.hint,
          note +
          "今回の分も登録しました。意図した別の予約ならそのままでよく（人数を分けて取った同じ便なら、" +
          "それぞれに people を入れればまとめずに済む）、同じ予約の入れ直しなら、" +
          "ユーザーに確かめてから merge_reservations で1件にまとめてください（similar が既存の方）。",
        ].filter((h) => typeof h === "string").join(" "),
      }));
    },
  );

  const confirmInput = idInput.extend({
    replace: z.boolean().default(false).describe(
      "true なら同プランで確定済みの予約を要キャンセルにして、この候補を確定する（確定の差し替え）",
    ),
  });
  server.registerTool(
    "confirm_reservation",
    {
      description:
        "候補を確定する（「これに決めた」。予約がまだなら needsBooking が true で返るので、予約を取るよう伝える）。" +
        "同プランの他候補は、予約済みなら自動で要キャンセル（to_cancel）に、未予約ならそのまま外れ（cancelled）、" +
        "応答の affected に出る。" +
        "要キャンセル＝お店に取り消しの連絡が必要な状態なので、ユーザーに連絡を促し、連絡が済んだと聞いたら " +
        "cancel_reservation でキャンセル済みにする（勝手にキャンセル済みにしない）。" +
        "同プランに確定済みがあると invalid_transition になる。確定を差し替えるなら replace: true" +
        "（要キャンセルになっている予約も replace: true なら一度で確定に戻せる）",
      inputSchema: confirmInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = confirmInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      return callApi(
        cfg,
        "POST",
        `/api/reservations/${parsed.data.id}/confirm`,
        parsed.data.replace ? { replace: true } : undefined,
      );
    },
  );

  const transitions: [string, string, string][] = [
    [
      "cancel_reservation",
      "cancel",
      "予約をキャンセル済みにする（お店への取り消しの連絡が済んだあとに呼ぶ。期限の見張りから外れる）",
    ],
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
      description:
        "予約の内容（店名・日時・時刻が仮かどうか・金額・場所・プラン・旅行名・規定・メモ・希望順）を編集する。" +
        "渡した項目だけが変わる。確定済みの予約の変更は家族のカレンダーにも反映される",
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

  // ---- 予約の共有（招待・権限）(owner 2026-07-28) ----
  // 「GUI でできることは MCP でもできる」: the invite box's four operations,
  // including the 「編集を許可」 grant. The API keeps every one of them
  // owner-only, so a token can only manage shares of its own reservations.
  server.registerTool(
    "list_reservation_members",
    {
      description: "予約を共有している相手と権限（viewer/editor）を一覧する",
      inputSchema: idInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = idInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      return callApi(cfg, "GET", `/api/reservations/${parsed.data.id}/members`);
    },
  );

  server.registerTool(
    "share_reservation",
    {
      description:
        "予約を相手に共有する（メール/ユーザーID完全一致。role=editor で内容の編集も許可する）",
      inputSchema: shareInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = shareInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      const { id, ...body } = parsed.data;
      return callApi(cfg, "POST", `/api/reservations/${id}/members`, body);
    },
  );

  server.registerTool(
    "set_member_role",
    {
      description: "共有相手の権限を変更する（viewer ⇄ editor）",
      inputSchema: memberRoleInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = memberRoleInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      const { id, userId, role } = parsed.data;
      return callApi(cfg, "PATCH", `/api/reservations/${id}/members/${userId}`, { role });
    },
  );

  server.registerTool(
    "unshare_reservation",
    {
      description: "共有相手を予約から外す（相手の台帳から予約が消える。予約自体は残る）",
      inputSchema: memberInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = memberInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      const { id, userId } = parsed.data;
      return callApi(cfg, "DELETE", `/api/reservations/${id}/members/${userId}`);
    },
  );

  // ---- 施設の既定規定 = 施設ごとに覚えたキャンセル規定 (owner 2026-07-27) ----
  // 「GUI でできることは MCP でもできる」: the same four operations the web
  // form uses, so Claude can remember a hotel's fee table and reuse it.
  server.registerTool("list_policy_templates", {
    description: "登録済みの施設の既定規定（施設ごとに覚えたキャンセル規定）を一覧する",
    inputSchema: z.object({}).passthrough(),
  }, () => callApi(cfg, "GET", "/api/policy-templates"));

  server.registerTool(
    "lookup_policy_template",
    {
      description:
        "施設名から既定規定を引く（完全一致。全角/半角・空白・大小文字は同一視。無ければ template:null）",
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
        "施設の既定規定を保存する（同じ施設なら上書き。以後その施設の予約はこの規定を初期値にできる）",
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
      description: "施設の既定規定を削除する（予約自体には影響しない）",
      inputSchema: facilityInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = facilityInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      const path = `/api/policy-templates/${encodeURIComponent(parsed.data.facility)}`;
      return callApi(cfg, "DELETE", path);
    },
  );

  // ---- pairing (issue #1): always registered, so a client's cached tool list
  // never differs between paired and unpaired. The token itself never passes
  // through any of these.
  server.registerTool("pair_with_plancel", {
    description:
      "plancel とこの PC を連携する（スマホで承認するコードを出す）。すでに連携済みなら接続先を返す。" +
      "force=true で拒否・期限切れのあとに出し直す",
    inputSchema: z.object({ force: z.boolean().default(false) }).passthrough(),
  }, async (args: { force?: boolean }) => {
    if (cfg.pairing === undefined) {
      return textResult(
        "この MCP は PLANCEL_API_TOKEN で固定接続されています。承認フローは使いません。",
      );
    }
    if ((await resolveToken(cfg)) !== null && !args.force) {
      return textResult(pairingInstructions(cfg.pairing.current()));
    }
    const state = await cfg.pairing.start(args.force === true);
    return textResult(pairingInstructions(state), state.kind !== "paired");
  });
  const mergeInput = z.object({
    keepId: z.string().min(1).describe(
      "残す予約のID。自分の予約か、自分に共有されていて編集を許可されている予約",
    ),
    removeId: z.string().min(1).describe("まとめて消す予約のID。自分の予約に限る"),
  });
  server.registerTool(
    "merge_reservations",
    {
      description:
        "同じ予約を別々に登録してしまった2件を1件にまとめる（家族がそれぞれ入れた場合など。一覧の " +
        "possibleDuplicates や、登録時の similar で見つかる）。keepId の予約を残し、そこに無い情報" +
        "（金額・規定・終了日・場所・メモ・予約した人など）を removeId から写してから、removeId を削除する。" +
        "残す側の店名・状態（確定など）は変わらない。削除は取り消せないので、同じ予約かどうかと、どちらを" +
        "残すかを必ずユーザーに確かめてから呼ぶ。同じ宿を2部屋取っているなど、別の予約ならまとめない",
      inputSchema: mergeInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = mergeInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      return callApi(cfg, "POST", `/api/reservations/${parsed.data.keepId}/merge`, {
        from: parsed.data.removeId,
      });
    },
  );
  const chooseInput = z.object({
    id: z.string().min(1).describe("選ぶ（残す）予約のID"),
    overIds: z.array(z.string().min(1)).min(1).max(10).describe(
      "選ばなかった（外す）予約のID。一覧の overlaps の同じ組にある、id 以外のもの",
    ),
  });
  server.registerTool(
    "choose_reservation",
    {
      description:
        "同じ夜に重なっている宿や、同じ時間帯に重なっている飛行機・電車・バス、同じ期間に重なっている駐車場（一覧の overlaps）のうち、どれにするかを" +
        "決める。id の予約を確定し、overIds の予約を" +
        "「要キャンセル」（まだ予約していない案は見送り）にする。外す方が確定済みでもそのまま呼べる（replace の" +
        "指定は要らない）。変えられるのは自分の予約だけで、共有されている" +
        "他の人の予約は変わらず、持ち主への提案になる（応答の needsOwner に、誰の予約に何を提案したかが出る。need が" +
        " confirm なら確定、cancel なら取り消しの提案で、suggested: true なら持ち主に知らせが届く）。" +
        "要キャンセルになった予約の取り消しの連絡はユーザー自身が行い、無料で取り消せる期限は一覧の" +
        "その予約の freeUntil。affected と needsOwner を" +
        "必ずユーザーに伝える。どちらにするかはユーザーが決めることなので、聞かずに呼ばない。" +
        'overlaps の mode が "split"（分けて取った予約）の組には使わない（全部使う予約を要キャンセルにしてしまう）',
      inputSchema: chooseInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = chooseInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      return callApi(cfg, "POST", `/api/reservations/${parsed.data.id}/choose`, {
        over: parsed.data.overIds,
      });
    },
  );
  const suggestInput = z.object({
    id: z.string().min(1).describe("共有されている予約のID（一覧で shared が付いているもの）"),
    action: z.enum(["cancel", "confirm", "withdraw"]).describe(
      '"cancel"＝取り消しを提案、"confirm"＝確定を提案、"withdraw"＝自分の提案を取り下げる',
    ),
  });
  server.registerTool(
    "suggest_to_owner",
    {
      description:
        "共有されている（他の人が持ち主の）予約に、取り消しか確定を提案する。確定・取り消しは持ち主だけができるので、" +
        "提案は持ち主の台帳に印として残り、持ち主に LINE（未連携ならメール）で届く。予約そのものは変わらない。" +
        "自分の予約には使わない（そのまま confirm_reservation / cancel_reservation などで変えられる）。" +
        "どちらを提案するかはユーザーが決めることなので、聞かずに呼ばない",
      inputSchema: suggestInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = suggestInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      const path = `/api/reservations/${parsed.data.id}/suggest`;
      return parsed.data.action === "withdraw"
        ? callApi(cfg, "DELETE", path)
        : callApi(cfg, "POST", path, { action: parsed.data.action });
    },
  );
  const tripPeopleInput = z.object({
    trip: z.string().min(1).max(60).describe("旅行名（予約の trip と同じ名前）"),
    people: z.number().int().min(1).max(99).nullable().describe("何人で行くか。null で消す"),
  });
  server.registerTool(
    "set_trip_people",
    {
      description:
        "旅行の人数（何人で行くか）を入れる。同じ時間帯に重なる予約が、人数を分けて取ったもの（全部使う）か、" +
        "人数より多いもの（外すものがある）かを見分けるのに使う。入れないと、旅行の予約の people の最大から推定する",
      inputSchema: tripPeopleInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = tripPeopleInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      return callApi(cfg, "PUT", `/api/trips/${encodeURIComponent(parsed.data.trip)}`, {
        people: parsed.data.people,
      });
    },
  );
  server.registerTool(
    "drop_reservation",
    {
      description:
        '人数より多く取ってある予約のうち1件を外す（一覧の overlaps の mode が "over" のとき）。自分の予約は' +
        "要キャンセル（まだ予約していない案なら見送り）になり、取り消しの連絡はユーザー自身が行う。共有された" +
        "予約は持ち主への取り消しの提案になる（応答の suggested: true）。どれを外すかはユーザーが決めることなので、" +
        "聞かずに呼ばない",
      inputSchema: idInput.passthrough(),
    }, // deno-lint-ignore no-explicit-any
    (args: any) => {
      const parsed = idInput.safeParse(args ?? {});
      if (!parsed.success) return invalidArgs(parsed.error.issues);
      return callApi(cfg, "POST", `/api/reservations/${parsed.data.id}/drop`);
    },
  );
  server.registerTool("open_in_browser", {
    description:
      "この台帳の画面をブラウザで見るための、1回だけ使えるリンクを出す（60秒以内に開く）。開くとログイン無しで" +
      "15分だけ表示できる。閲覧専用で、予約の変更・確定・削除やマイページの操作はできない。画面の見た目を確かめる" +
      "用途のもので、変更は引き続きこの MCP のツールで行う。リンクはこの PC のブラウザで開くためのもので、" +
      "他人に送らない",
    inputSchema: z.object({}).passthrough(),
  }, () => callApi(cfg, "POST", "/auth/device/view-link"));
  server.registerTool("pairing_status", {
    description:
      "どの台帳に接続しているか（本番の台帳＝スマホと同じ／そのアカウント）と連携状態を返す",
    inputSchema: z.object({}).passthrough(),
  }, async () => {
    if (cfg.pairing === undefined) {
      return textResult(ledgerLine(cfg, null));
    }
    const token = await resolveToken(cfg);
    const state = cfg.pairing.current();
    // A token from env works without any pairing, so the pairing state stays
    // idle: answer with the ledger, not 「連携していません」 (found 2026-11-11).
    if (token !== null && state.kind !== "paired") return textResult(ledgerLine(cfg, null));
    return textResult(
      state.kind === "paired" ? ledgerLine(cfg, state.account.label) : pairingInstructions(state),
    );
  });
  server.registerTool("unpair_plancel", {
    description:
      "この PC に保存された plancel の連携を消す（ローカルの資格情報のみ。サーバ側の失効はマイページで）",
    inputSchema: z.object({}).passthrough(),
  }, async () => {
    if (cfg.pairing === undefined) {
      return textResult("PLANCEL_API_TOKEN による固定接続です。環境変数を外してください。");
    }
    await cfg.pairing.forget();
    return textResult(
      "この PC の連携を消しました。サーバ側のトークンはマイページ →「連携」④ で失効できます。",
    );
  });

  return server;
}

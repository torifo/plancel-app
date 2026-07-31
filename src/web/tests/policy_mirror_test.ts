/**
 * Pins the CLIENT MIRROR in web/index.html to src/web/policy.ts.
 *
 * Why this file exists: the whole cancellation-fee model is implemented twice —
 * once here in TypeScript and once as plain JS inside the single-file web app
 * (`PRESET_STAGES` / `normalizeStages` / `stagesOfPolicy` / `freeDeadline` /
 * `maxLoss` / `pctNow` / `describePolicy`). Nothing linked the two, and the pair
 * had already drifted in production: the 2026-07-25 off-by-one-stage fix to the
 * free deadline had to be applied twice, by hand, on both sides.
 *
 * How: the mirror block is extracted from the HTML as text (the precedent is
 * `pwa_test.ts`, which already asserts against web/index.html) and evaluated
 * with `new Function`. The block is pure math — no DOM — so it runs as-is. Then
 * the client functions are compared against the imported server functions over a
 * fixed case table.
 *
 * TWO kinds of assertion, deliberately:
 *   1. equality (client === server) — catches one side moving;
 *   2. absolute values for the free-deadline rule — because on 2026-07-25 BOTH
 *      sides were wrong at the same time, and an equality-only test would have
 *      passed. The rule is 「無料キャンセル期限 = 最後の pct==0 ステージの境界」.
 *
 * NOT covered (on purpose, so nobody reads this file as a full guarantee):
 *   - date FORMATTING and the timezone split (audit §5.2): the client renders in
 *     the device zone, the server in JST. Different by design here, still unpinned.
 *   - `penaltyAfterFree` — client-only, it has no server counterpart to compare to.
 *   - the form's input widgets (`polStages`, `max=` attributes) and any wording.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import {
  describePolicy,
  freeDeadlineMs,
  MAX_STAGES,
  maxLossYen,
  pctAt,
  PRESET_STAGES,
  stagesOf,
  webCustomPolicySchema,
  type WebPolicy,
  webPolicyStageSchema,
} from "../policy.ts";
import { webStatusSchema } from "../store.ts";
import { LINE_CODE_TTL_MS } from "../users.ts";
import { STATUS_LABEL } from "../../line/web-commands.ts";

const HTML_URL = new URL("../../../web/index.html", import.meta.url);
const HOUR_MS = 3_600_000;

/** Same message on every failure: which two files, and which one to fix. */
const DRIFT = "キャンセル規定モデルの二重実装がズレています: src/web/policy.ts（サーバ・正）と " +
  "web/index.html のクライアント写し。片方だけ直した変更が原因です。" +
  "サーバ側を正として web/index.html の写しを合わせてください" +
  "（写しの範囲は index.html の `const PRESET_STAGES` 〜 `describePolicy` と `pctNow`）。";

/** The `{ … }` body that starts at the first `{` at or after `from`. */
function braceBlock(html: string, anchor: string): string {
  const start = html.indexOf(anchor);
  if (start < 0) {
    throw new Error(
      `${DRIFT}\nweb/index.html に \`${anchor}\` が見つかりません（写しが改名/削除された？）。`,
    );
  }
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${DRIFT}\n\`${anchor}\` の波括弧が閉じていません。`);
}

interface Mirror {
  PRESET_STAGES: Record<string, { h: number; pct: number }[]>;
  POL_MAX_STAGES: number;
  POL_MAX_HOURS: number;
  stagesOfPolicy(policy: unknown): { h: number; pct: number }[] | null;
  freeDeadline(r: { policy: unknown; startsAt: string }): number | null;
  maxLoss(r: { policy: unknown; amount: number | null }): number;
  describePolicy(policy: unknown): string;
  pctNow(r: { policy: unknown; startsAt: string }, now: number): number | null;
}

/** Extracts the mirror out of the shipped HTML and evaluates it. */
async function loadMirror(): Promise<Mirror> {
  const html = await Deno.readTextFile(HTML_URL);
  // From the preset table down to the end of describePolicy: one contiguous,
  // DOM-free region. Anchored on code, not on line numbers or comment wording.
  const modelStart = html.indexOf("const PRESET_STAGES = {");
  if (modelStart < 0) {
    throw new Error(`${DRIFT}\n写しの開始 \`const PRESET_STAGES = {\` が見つかりません。`);
  }
  const describeBlock = braceBlock(html, "function describePolicy(policy) {");
  const model = html.slice(
    modelStart,
    html.indexOf(describeBlock) + describeBlock.length,
  );
  // `pctNow` lives further down (with the timeline helpers) but mirrors `pctAt`.
  const pctNow = braceBlock(html, "function pctNow(r, now) {");
  const maxHours = /const POL_MAX_HOURS = ([^;]+);/.exec(html)?.[1];
  if (maxHours === undefined) {
    throw new Error(`${DRIFT}\nweb/index.html に \`const POL_MAX_HOURS\` が見つかりません。`);
  }
  const factory = new Function(`
    ${model}
    ${pctNow}
    return {
      PRESET_STAGES, POL_MAX_STAGES, POL_MAX_HOURS: ${maxHours},
      stagesOfPolicy, freeDeadline, maxLoss, describePolicy, pctNow,
    };
  `);
  return factory() as Mirror;
}

// ---- The case table: every preset, plus the custom tables that broke before ----

/** 「5日前まで無料」 — the boundary the 2026-07-25 fix was reported against. */
const FIVE_DAY: WebPolicy = { stages: [{ h: 120, pct: 0 }, { h: 0, pct: 100 }] };
/** Paid from the outset: there is no free window at all (≠ always free). */
const PAID_FROM_OUTSET: WebPolicy = { stages: [{ h: 48, pct: 50 }, { h: 0, pct: 100 }] };
/** Free right up to the start, stated in two stages. */
const ALWAYS_FREE_2: WebPolicy = { stages: [{ h: 72, pct: 0 }, { h: 0, pct: 0 }] };
/** Five bands, the deepest table a real 旅館 uses. */
const FIVE_BAND: WebPolicy = {
  stages: [
    { h: 336, pct: 0 },
    { h: 168, pct: 20 },
    { h: 72, pct: 50 },
    { h: 24, pct: 80 },
    { h: 0, pct: 100 },
  ],
};
/** Unsorted with a duplicate boundary — exercises `normalizeStages` both sides. */
const MESSY: WebPolicy = {
  stages: [{ h: 0, pct: 100 }, { h: 120, pct: 50 }, { h: 120, pct: 0 }, { h: 36, pct: 80 }],
};
/** Not a whole number of days, so `boundaryLabel` must say 「36時間前」. */
const ODD_HOURS: WebPolicy = { stages: [{ h: 36, pct: 0 }, { h: 0, pct: 100 }] };

const POLICIES: WebPolicy[] = [
  "unknown",
  "none",
  "free24",
  "staged",
  FIVE_DAY,
  PAID_FROM_OUTSET,
  ALWAYS_FREE_2,
  FIVE_BAND,
  MESSY,
  ODD_HOURS,
  { stages: [{ h: 0, pct: 0 }] },
  { stages: [{ h: 0, pct: 100 }] },
];

const STARTS_AT = "2026-08-22T15:00:00+09:00";
const START_MS = Temporal.Instant.from(STARTS_AT).epochMilliseconds;
const AMOUNTS: (number | null)[] = [null, 0, 12_345, 18_000, 30_000];
/** Hours-left probes: before/at/after every boundary the table uses, and past 0. */
const HOURS_LEFT = [400, 336, 200, 168, 121, 120, 119, 73, 72, 48, 36, 25, 24, 23, 1, 0, -5];

Deno.test("規定モデルの写し: プリセット表と上限がサーバと一致する", async () => {
  const client = await loadMirror();

  assertEquals(
    client.PRESET_STAGES,
    JSON.parse(JSON.stringify(PRESET_STAGES)),
    `${DRIFT}\nPRESET_STAGES（プリセットの段階表）が違います。`,
  );
  assertEquals(
    client.POL_MAX_STAGES,
    MAX_STAGES,
    `${DRIFT}\n段数の上限（POL_MAX_STAGES / MAX_STAGES）が違います。`,
  );

  // The stage-row cap is what the server's schema will actually accept: a client
  // that allows one more row builds a form that 400s, one that allows fewer
  // silently rejects a valid table.
  const rows = (n: number) => ({
    stages: Array.from({ length: n }, (_, i) => ({ h: (n - 1 - i) * 24, pct: i * 5 })),
  });
  assertEquals(webCustomPolicySchema.safeParse(rows(client.POL_MAX_STAGES)).success, true);
  assertEquals(webCustomPolicySchema.safeParse(rows(client.POL_MAX_STAGES + 1)).success, false);

  // Same for the boundary ceiling (POL_MAX_HOURS vs the schema's MAX_HOURS).
  assertEquals(
    webPolicyStageSchema.safeParse({ h: client.POL_MAX_HOURS, pct: 0 }).success,
    true,
    `${DRIFT}\nPOL_MAX_HOURS がサーバの受け付ける上限を超えています。`,
  );
  assertEquals(
    webPolicyStageSchema.safeParse({ h: client.POL_MAX_HOURS + 1, pct: 0 }).success,
    false,
    `${DRIFT}\nPOL_MAX_HOURS がサーバの上限より小さく、正しい入力を弾きます。`,
  );
});

Deno.test("規定モデルの写し: 無料キャンセル期限は最後の pct==0 の境界（両実装で絶対値を固定）", async () => {
  const client = await loadMirror();

  // Absolute expectations, not just client===server: on 2026-07-25 both sides
  // read the FIRST PAID stage instead (staged → start−72h), so an equality-only
  // test would have been green while every reminder fired a stage too late.
  const RULE: [string, WebPolicy, number | null][] = [
    ["free24 = 前日まで無料", "free24", 24],
    ["staged = 7日前まで無料", "staged", 168],
    ["5日前まで無料", FIVE_DAY, 120],
    ["36時間前まで無料", ODD_HOURS, 36],
    ["5段階のうち最後の無料段は 336h", FIVE_BAND, 336],
    ["重複境界は後勝ち(120h,pct0)", MESSY, 120],
    ["いつでも無料 → 期限なし", "none", null],
    ["いつでも無料(2段) → 期限なし", ALWAYS_FREE_2, null],
    ["最初から有料 → 無料期間なし", PAID_FROM_OUTSET, null],
    ["規定不明 → 期限なし", "unknown", null],
  ];

  for (const [what, policy, hours] of RULE) {
    // 境界は「引いた先の日の終わり（JST）」。予約の時刻では切れない。
    const expected = hours === null ? null : Temporal.Instant.from(
      Temporal.Instant.fromEpochMilliseconds(START_MS - hours * HOUR_MS)
        .toZonedDateTimeISO("Asia/Tokyo")
        .withPlainTime({ hour: 23, minute: 59, second: 59, millisecond: 999 })
        .toInstant(),
    ).epochMilliseconds;
    assertEquals(
      freeDeadlineMs(policy, STARTS_AT),
      expected,
      `サーバの freeDeadlineMs が規定を誤読しています (${what})。無料キャンセル期限は` +
        "「最後の pct==0 ステージの境界」です（2026-07-25 の修正）。",
    );
    assertEquals(
      client.freeDeadline({ policy, startsAt: STARTS_AT }),
      expected,
      `${DRIFT}\nfreeDeadline が規定を誤読しています (${what})。`,
    );
  }
});

Deno.test("規定モデルの写し: 段階表・期限・最大キャンセル料・文言・料率が全ケースで一致する", async () => {
  const client = await loadMirror();

  for (const policy of POLICIES) {
    const label = JSON.stringify(policy);

    assertEquals(
      client.stagesOfPolicy(policy),
      stagesOf(policy),
      `${DRIFT}\nstagesOfPolicy / stagesOf の正規化が違います (${label})。`,
    );
    assertEquals(
      client.freeDeadline({ policy, startsAt: STARTS_AT }),
      freeDeadlineMs(policy, STARTS_AT),
      `${DRIFT}\n無料キャンセル期限が違います (${label})。`,
    );
    assertEquals(
      client.describePolicy(policy),
      describePolicy(policy),
      `${DRIFT}\n規定の日本語表記（describePolicy）が違います (${label})。`,
    );

    for (const amount of AMOUNTS) {
      assertEquals(
        client.maxLoss({ policy, amount }),
        maxLossYen(policy, amount),
        `${DRIFT}\n最大キャンセル料が違います (${label}, amount=${amount})。`,
      );
    }

    // `pctAt` has no production caller — only this comparison and policy_test.ts.
    // The rate users actually see is the client's `pctNow`, so the server copy is
    // meaningful only as the reference it is checked against here.
    for (const hoursLeft of HOURS_LEFT) {
      assertEquals(
        client.pctNow({ policy, startsAt: STARTS_AT }, START_MS - hoursLeft * HOUR_MS),
        pctAt(policy, START_MS, START_MS - hoursLeft * HOUR_MS),
        `${DRIFT}\nいまの料率（pctNow / pctAt）が違います (${label}, 残り${hoursLeft}h)。`,
      );
    }
  }
});

Deno.test("状態の4語はスキーマ・LINE・web の3面で同じ", async () => {
  // Adding a status to the schema without giving it a word would otherwise ship
  // a raw identifier ("to_cancel") to whichever surface forgot it.
  assertEquals(
    Object.keys(STATUS_LABEL).sort(),
    [...webStatusSchema.options].sort(),
    "STATUS_LABEL (src/line/web-commands.ts) と webStatusSchema (src/web/store.ts) の" +
      "状態が一致していません。状態を増やすときは日本語ラベルも必ず足してください。",
  );

  const html = await Deno.readTextFile(HTML_URL);
  for (const [status, word] of Object.entries(STATUS_LABEL)) {
    assertStringIncludes(
      html,
      word,
      `web/index.html が状態 ${status} の正式表記「${word}」を使っていません。` +
        "LINE・MCP と同じ4語（候補／確定／要キャンセル／キャンセル済み）で表示してください。",
    );
  }
});

Deno.test("LINE 連携コードの有効期限: クライアントの控えがサーバとズレない", async () => {
  const html = await Deno.readTextFile(HTML_URL);
  // The client keeps a fallback for when /auth/line/code omits expiresInSec.
  // Deleting the fallback is the better fix (then the field becomes mandatory),
  // so this only fires while the copy exists — but it must agree while it does.
  const declared = /const LINE_CODE_SEC = (\d+);/.exec(html)?.[1];
  if (declared === undefined) return;
  assertEquals(
    Number(declared),
    LINE_CODE_TTL_MS / 1000,
    "web/index.html の LINE_CODE_SEC が src/web/users.ts の LINE_CODE_TTL_MS と違います" +
      "（コードの残り時間表示が実際の有効期限とズレます）。",
  );
});

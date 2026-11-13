/**
 * Fares whose cancellation rules the ledger knows (owner 2026-11-13: 「JAL だけ
 * でもまずはどれで予約したか選べたら自動でキャンセル規定入れられてもいいかも。
 * JAL が勝手に変える可能性があるから手動でも設定上書きできた方がいい」).
 *
 * Picking a fare fills the reservation's policy — on the screen and over MCP
 * alike, because the server applies it. A fare's rules change: the family can
 * correct one and save it as that fare's default (a policy template named
 * after the fare, ./policy-template.ts), which then wins over the table below;
 * deleting the saved default goes back to the table.
 *
 * The table: JAL domestic fares, read on jal.co.jp/jp/ja/dom/fare/rule/<key>/
 * on 2026-11-13. JAL charges a share of the fare before tax (税抜運賃額); the
 * ledger's rates apply to the amount paid, so they are the nearest the policy
 * can say. What it cannot say — the fee after departure, the 20-minute cutoff
 * — is in `note`, shown when the fare is picked.
 */
import { getTemplate } from "./policy-template.ts";
import type { WebPolicy } from "./policy.ts";

export interface FarePreset {
  /** What the family picks and what is stored on the reservation. */
  label: string;
  carrier: "JAL";
  policy: WebPolicy;
  /** What the policy cannot hold, in words. */
  note: string;
  /** The page the rule was read from. */
  source: string;
  /** When it was read (JST date). */
  checked: string;
}

const JAL = (key: string) => `https://www.jal.co.jp/jp/ja/dom/fare/rule/${key}/`;
const CUTOFF =
  "取り消しは出発20分前まで。料率は税抜運賃額に対するもの（台帳では支払額に掛けた近い値）";
const FREE_BEFORE = {
  policy: "none" as WebPolicy,
  note: `出発前の取り消しは無料、出発後は税抜運賃額の約20%。${CUTOFF}`,
};
const SAVER_55 = {
  policy: { stages: [{ h: 55 * 24, pct: 5 }, { h: 0, pct: 50 }] } as WebPolicy,
  note: `購入後〜出発55日前は約5%、54日前〜出発前は約50%、出発後は100%。${CUTOFF}`,
};
const HALF = {
  policy: { stages: [{ h: 0, pct: 50 }] } as WebPolicy,
  note: `出発前の取り消しは約50%、出発後は100%。${CUTOFF}`,
};
const CHECKED = "2026-11-13";

export const FARE_PRESETS: FarePreset[] = [
  ["JAL フレックス", "flex", FREE_BEFORE],
  ["JAL ビジネスフレックス", "business-flex", FREE_BEFORE],
  ["JAL JALカード割引", "jalcard-flex", FREE_BEFORE],
  ["JAL 株主割引", "shareholders-flex", FREE_BEFORE],
  ["JAL 離島割引", "remoteisland-flex", FREE_BEFORE],
  ["JAL 特定路線離島割引", "specificroute-flex", FREE_BEFORE],
  ["JAL セイバー", "saver", {
    policy: { stages: [{ h: 0, pct: 5 }] } as WebPolicy,
    note: `出発前の取り消しは約5%、出発後は100%。${CUTOFF}`,
  }],
  ["JAL スペシャルセイバー", "special-saver", SAVER_55],
  ["JAL 往復セイバー", "round-trip-saver", SAVER_55],
  ["JAL プロモーション", "promotion", SAVER_55],
  ["JAL スカイメイト", "skymate-fare", HALF],
  ["JAL 当日シニア割引", "seniorcitizen-fare", HALF],
].map(([label, key, rule]) => ({
  label: label as string,
  carrier: "JAL" as const,
  ...(rule as { policy: WebPolicy; note: string }),
  source: JAL(key as string),
  checked: CHECKED,
}));

const fold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/**
 * The preset a fare name means: 「JAL スペシャルセイバー」, 「JALスペシャルセイバー」
 * or just 「スペシャルセイバー」 (only JAL's fares are known so far). Null otherwise.
 */
export function findFare(name: string | null | undefined): FarePreset | null {
  if (name == null) return null;
  const k = fold(name);
  if (k === "") return null;
  return FARE_PRESETS.find((p) =>
    fold(p.label) === k || fold(p.label.replace(/^JAL\s*/, "")) === k
  ) ??
    null;
}

/**
 * The policy a fare gives in this ledger: the family's saved default for that
 * fare when there is one, else the table's. Null when the fare is not known.
 */
export async function farePolicy(
  kv: Deno.Kv,
  token: string,
  fareName: string | null | undefined,
): Promise<{ policy: WebPolicy; source: "saved" | "table"; preset: FarePreset } | null> {
  const preset = findFare(fareName);
  if (preset === null) return null;
  const saved = await getTemplate(kv, token, preset.label);
  return saved !== null
    ? { policy: saved.policy, source: "saved", preset }
    : { policy: preset.policy, source: "table", preset };
}

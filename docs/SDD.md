# plancel — SDD (Spec-Driven Development Document)

> 仮称: **plancel** (plan + cancel)。名称は人間側オーナーが最終決定する。
> ステータス: 設計フェーズ。**このドキュメントの段階ではコードを書かない。**

## 1. プロダクト概要

### 課題
外食・宿・イベント等の予約では「複数候補を仮押さえ → 直前に1つ確定 → 残りをキャンセル」という運用が現実的だが、既存ツールは確定済み予約の管理しかできない。結果、**キャンセル忘れ**と**キャンセル料の発生**が起きる。

### 解決
- 予約を「候補グループ(プラン)」として束ねて管理
- 1件確定すると残りが自動で「要キャンセル」状態になる
- キャンセル料が上がる**境界の直前に通知**する

### スコープ(フェーズ1)
- 利用者: 開発者本人 + 身内のみ(数名)
- 予算: **0円**(全て無料枠で構成)
- 公開・マネタイズはフェーズ2以降(予算発生後)

## 2. アーキテクチャ

三層分離の慣例に従う: **core / adapter / MCP**

```
┌─ 入口A(本人): Claude 会話 ──→ MCP server ─┐
│                                            ├─→ core (schema/validation/store)
└─ 入口B(身内): LINE Bot → parser adapter ──┘         │
                  │                                    ▼
                  └ Gemini無料枠(vision含む)      notifier adapter
                                                   ├ LINE Messaging API
                                                   └ Email (Resend)
```

### 設計上の最重要判断
1. **インサート層が最難関**。全入口は「テキスト or 画像 → 正規化 → 共通スキーマ」の1本に集約する。入口を増やしても正規化コードは増やさない。
2. **MCP は planned-but-deferred ではなく MVP スコープ**。本人の入口 = Claude + MCP であり、パース処理を Claude 本体に委譲することで LLM API コストを回避する(reclab と同じ判断)。
3. **パースの精度担保はバリデーション駆動フォールバック**(§5)。LLM の自己申告 confidence は使わない。
4. **デバッグ容易性を第一級の設計目標とする**(§10)。時刻・外部送信・LLM の3つの非決定性を全て注入可能な抽象の背後に隔離し、コアロジックはローカルで決定的にテスト・再現できること。実装コストより追跡可能性を優先する。

### デプロイ
- 第一候補: Deno Deploy(新プラットフォーム。Classic は 2026-07 廃止済み)+ Deno KV。`Deno.cron` を通知スケジューラに使う。
- 第二候補: 自前 VPS(既存の claude-usage-bot 同居先)。この場合は Deno ランタイム + SQLite に差し替え。**ストア層は interface で抽象化し、KV/SQLite を差し替え可能にすること。**

## 3. データモデル

6エンティティ。ストレージは KV 前提でキー設計するが、リレーショナルにも写像可能な形にする。

### 3.0 Event(排他性なしの束ね)
```ts
interface Event {
  id: string;              // ULID
  title: string;           // 例: "夏の北陸旅行" "○○ライブ遠征" "出張"
  date_range: { start: string; end: string } | null; // ISO date
  notes: string | null;
  created_at: string;
  updated_at: string;
}
```
- 複数の Plan / Reservation を束ねる**非排他**のコンテナ。旅行に限らず出張・遠征・冠婚葬祭など予約が複合するあらゆる文脈に使う。
- Event 自体は状態を持たない(構成要素の状態の集計ビューとして表示する)。
- 単発予約は Event なしで存在できる(所属は任意)。

### 3.1 Plan(排他的な候補グループ)
```ts
interface Plan {
  id: string;              // ULID
  event_id: string | null; // 所属 Event(任意)
  title: string;           // 例: "7/12 ディナー候補" "8/1の宿"
  date_range: { start: string; end: string } | null; // 宿泊等は range になる
  confirm_quota: number;   // 確定枠数。デフォルト 1
  status: "open" | "settled" | "closed";
  reservation_ids: string[];
  created_at: string;
  updated_at: string;
}
```
- **Plan の意味論は排他**: `confirmed` 数が `confirm_quota` に達した時点で、残りの `candidate` を全て `to_cancel` へ自動遷移させる(§4)。
- `confirm_quota` の一般化により「4候補から2つ確定」等に対応。MVP の UI/MCP はデフォルト1で扱ってよいが、ロジックは quota 前提で書くこと。

### 3.2 Reservation(予約)
```ts
interface Reservation {
  id: string;              // ULID
  plan_id: string | null;  // 単独予約は null 許容
  event_id: string | null; // Plan 経由でなく Event 直付けも可(候補なしの確定予約)
  service_name: string;    // 店名・宿名
  provider: string | null; // 予約経路(食べログ/じゃらん/電話…)
  starts_at: string;       // ISO datetime
  ends_at: string | null;
  location: string | null;
  amount_jpy: number | null;      // 予約金額(通知の損失額表示に使用)
  status: "candidate" | "confirmed" | "to_cancel" | "cancelled" | "done" | "voided";
  cancellation_policy: CancellationPolicy | "unknown"; // ← unknown を許容(§3.3)
  policy_template_id: string | null; // 補完元テンプレ(監査用。値は必ずコピー済み)
  source: "mcp" | "line" | "manual";
  raw_input_ref: string | null;   // ParseJob への参照
  notes: string | null;
  created_at: string;
  updated_at: string;
}
```

### 3.3 CancellationPolicy(段階的キャンセル料)
```ts
interface CancellationPolicy {
  stages: PolicyStage[];   // until_offset 降順(遠い方から)
}
interface PolicyStage {
  until_offset_hours: number; // 予約開始の何時間前まで。例: 168 = 7日前
  fee_percent: number;        // 0–100
  fee_fixed_jpy: number | null; // 固定額型のサービス用(percent と排他ではなく併記可)
}
```
- 検証ルール: stages は offset 降順・fee 単調非減少であること。
- `"unknown"` は**弾かずに登録を許容**する。インサート摩擦の最小化が優先。unknown の予約には専用通知(§6)で後追い入力を促す。
- UI/出力上は普段「無料キャンセル: ◯月◯日まで」の1行に要約し、全段階は折りたたみで提示する。

### 3.4 PolicyTemplate(サービス別ポリシーのキャッシュ)
```ts
interface PolicyTemplate {
  id: string;
  service_key: string;     // 正規化キー(ドメイン or "provider:service_name")
  policy: CancellationPolicy;
  hit_count: number;
  last_used_at: string;
}
```
- **デフォルト提案としてのみ機能**する。適用時は必ず Reservation 側に値をコピー(テンプレ更新が過去予約に波及してはならない)。
- 同一サービスでもプラン毎にポリシーが違い得るため、適用時は人間確認を1回挟む(ワンタップ承認)。
- フェーズ2でユーザー間共有の集合知データに育てる想定(build-to-grow)。

### 3.5 ParseJob(パース差し戻し管理)
```ts
interface ParseJob {
  id: string;
  input_type: "text" | "image";
  raw_input: string;         // テキスト or 画像の保存参照
  attempts: ParseAttempt[];  // パーサー毎の結果履歴
  status: "parsed" | "needs_review" | "resolved" | "failed";
  conflicts: FieldConflict[]; // パーサー間で食い違ったフィールド
  created_at: string;
}
interface ParseAttempt {
  parser: string;            // "gemini-flash" | "groq-llama" | "claude-mcp" ...
  raw_response: string;      // LLM の生応答を必ず全保存(リプレイ基盤 §10.4 の入力)
  output: Partial<Reservation> | null;
  validation_errors: string[];
  correlation_id: string;    // 構造化ログとの突合キー
}
interface FieldConflict {
  field: string;
  options: { parser: string; value: unknown }[]; // 「AとBどっち?」提示用
}
```

## 4. 状態遷移

```
Reservation:
 candidate ──(確定)──→ confirmed ──(来店/宿泊完了)──→ done
     │                     │
     │←──(同プラン内で他が確定)                (自発キャンセル)
     ▼                     ▼
 to_cancel ──(キャンセル実施報告)──→ cancelled
```
- Plan 内の `confirmed` 数が `confirm_quota` に達した瞬間、同プランの他 `candidate` を全て `to_cancel` に遷移させ、即時通知(§6)を発火する。**この自動遷移が本プロダクトのコア動作。**(quota=1 が通常ケース)
- `to_cancel` のまま予約日時を過ぎたものは要注意リストとして残す(消さない)。
- `voided`(誤登録の無効化)は全状態から遷移可能。物理削除は行わず `reservation.voided` イベントの追記で表現する(通知対象・一覧から除外されるが履歴には残る)。

## 5. パースパイプライン(マルチLLM・バリデーション駆動)

```
入力 → 経路判定
  画像   → Gemini Flash(vision必須のため固定)
  テキスト → 一次: 軽量無料枠(Groq等) → 二次: Gemini Flash
        ↓
  機械的バリデーション(Zod)
    ├ 必須充足 & ルール通過 → 登録
    ├ 欠損 or ルール違反 → 次段パーサーで再試行
    └ 全段失敗 → ParseJob(needs_review)化し、欠損フィールドだけ人間に質問
```

### ルールベース検証(= 精度担保の実体)
- 必須: `service_name`, `starts_at`
- `starts_at` が過去でない(過去なら警告付き確認)
- キャンセル期限 ≦ `starts_at`
- `amount_jpy` ≧ 0
- policy stages の単調性(§3.3)

### 方針
- **LLM 出力の confidence 自己申告は判定に使わない。**
- 複数パーサーの出力が食い違った場合、**食い違ったフィールドのみ** FieldConflict として人間にワンタップ選択を求める。全文再入力は絶対にさせない。
- パーサーは `Parser` interface で抽象化。チェーン構成(順序・組合せ)は設定ファイルで宣言し、コード変更なしで差し替え可能にする。フェーズ2で有料モデルへの置換は設定変更のみで完了すること。
- プライバシー: Gemini 無料枠は入力が学習利用され得る。送信前に電話番号・メールアドレスをマスクする前処理を必須で挟む。

## 6. 通知(notifier adapter)

**発火判定と送信を2段に分離する(Outbox パターン)**:

```
ドメインイベント / cron tick
  → 発火判定(純粋関数: 予約群 + Clock → 発火すべき通知のリスト)
  → Outbox に積む(冪等キー: reservation_id + trigger種別 + 境界時刻)
  → Notifier が Outbox を配送(送信成功で消込。失敗はリトライ)
```

- 冪等性は **Outbox 側で一元管理**。Notifier 実装は冪等性を意識しなくてよい。
- `Notifier` interface の実装順: **① ConsoleNotifier(標準出力/ファイル。最初の実装)** → ② LINE Messaging API(月200通無料)→ ③ Email(Resend)。送信ロジックなしで発火判定を完全にデバッグしてから実チャネルを繋ぐ。
- 通知の発火は状態遷移コードから直接呼ばず、**ドメインイベントログの購読**として実装する(§10.2)。状態遷移と通知の依存を切る。

### トリガー(優先度順)
1. **キャンセル料率が上がる境界の24時間前**(最重要)。`amount_jpy` があれば「今キャンセルすれば無料 / 明日から ¥2,400 の損」と具体額を出す。
2. プラン内で1件確定した瞬間 → 「残り N 件が要キャンセルです」即時通知。
3. `policy: unknown` の予約が存在 → 「期限不明のキャンセル候補があります」(日次ダイジェストに含める)。
4. 予約当日朝のリマインド(confirmed のみ)。

### スケジューラ
- Deno Deploy: `Deno.cron`(15分間隔で境界チェック)。VPS: systemd timer で同等処理。
- cron 本体は「Clock を読んで発火判定関数を呼び、Outbox に積む」だけの薄い層にする(テストは発火判定関数を直接叩く)。

## 7. MCP サーバー(入口A・MVPスコープ)

ツール定義(MVP 確定版 — **追加・取得 + 状態遷移のコアのみ**):
| tool | 説明 |
|---|---|
| `create_event` | Event 作成(排他性なしの束ね) |
| `create_reservation` | 構造化済み予約を登録(パースは Claude 会話側が担当) |
| `create_plan` / `add_to_plan` | 候補グループ作成・追加(confirm_quota 指定可、既定1) |
| `confirm_reservation` | 確定。quota 到達時に他候補の to_cancel 遷移を副作用として返す |
| `report_cancelled` | キャンセル実施の報告(状態遷移のコアのため MVP に残す) |
| `void_reservation` | 誤登録の無効化(物理削除でなく voided イベント追記。修正は void → 再作成で行う) |
| `set_policy` | unknown ポリシーの後追い入力(既存値の書き換えではなく policy.provided イベント) |
| `list_pending_cancellations` | 要キャンセル一覧(期限順・損失額付き) |
| `get_plan` / `get_event` | 候補一覧 / Event 配下の全構成要素と状態集計 |

先送り(v1.x): 汎用 update(タイトル・日時等の編集)、物理 delete。当面の修正は `void_reservation` → 再作成で回す(追記型イベントログと整合する唯一の修正手段として意図的にこの1本に絞る)。

- MCP はスキーマ化された読み書き口に徹する。パース知能は持たない。
- ツール入力は §3 のスキーマをそのまま Zod で検証。

## 8. LINE Bot(入口B・フェーズ1後半)

- 身内の唯一の入口。テキスト転送・スクショ・フリーテキスト(「土曜19時に◯◯を仮予約、前日まで無料」)を受け付け、§5 パイプラインに流す。
- 差し戻し(FieldConflict / 欠損質問)は LINE の Quick Reply でワンタップ回答。
- 通知チャネルと同一の Bot に統合する(双方向)。

## 9. フェーズ計画(依存レイヤー基準)

実装順序は機能単位ではなく**依存レイヤー単位**で進める。L2a / L2b / L4 は相互独立のため並行可。

| レイヤー | 内容 | 依存 |
|---|---|---|
| L0 | Zod スキーマ(単一ソース)+ Clock + Store interface + EventLog | なし |
| L1 | ドメインロジック(状態遷移・quota判定・policy計算)— **純粋関数群** | L0 |
| L2a | 発火判定 + Outbox + ConsoleNotifier | L1 |
| L2b | MCP server(+ debug ツール群) | L1 |
| L3 | cron スケジューラ | L2a |
| L4 | パーサーパイプライン + リプレイ基盤(モックLLMで開発) | L0 |
| L5 | LINE(Bot 入口 + LINENotifier)+ 実 LLM 接続 | L2a, L4 |

- **MVP-1 = L0〜L3**(ここまで外部サービス接続ゼロ、完全ローカルで動作検証可能)
- **MVP-2 = L4〜L5**、v1.x 以降(メール転送・ics・Email通知・ブックマークレット)とフェーズ2(Web拡張・Gmail直読・有料LLM・公開)は従来どおり。

## 10. デバッグ容易性の設計(第一級要件)

非決定性の源は **時刻・外部送信・LLM** の3つ。全てを注入可能な抽象の背後に隔離する。

### 10.1 Clock 抽象
- `Date.now()` / `new Date()` の直接呼び出しを**全レイヤーで禁止**(lint ルール化)。全ロジックは `Clock` interface(`now(): Temporal.Instant`)を受け取る。
- 実装: `SystemClock` / `VirtualClock`(set / advance 可能)。境界判定・通知発火・期限跨ぎのテストは VirtualClock で決定的に書く。
- 「3日進めたら何が起きるか」を dev 環境でワンコマンド実行できること。

### 10.2 ドメインイベントログ(追記型)
```ts
interface DomainEvent {
  id: string;             // ULID(= 時系列順)
  type: "reservation.created" | "reservation.confirmed" | "reservation.auto_to_cancel"
      | "reservation.cancelled" | "reservation.voided" | "policy.provided"
      | "plan.settled" | "policy.applied_from_template" | ...;
  entity_id: string;
  payload: unknown;
  caused_by: string | null;   // 因果チェーン(例: confirmed イベント → auto_to_cancel イベント)
  correlation_id: string;
  occurred_at: string;        // Clock 由来
}
```
- 全状態遷移は必ずイベントを追記する。**「なぜこの予約が to_cancel なのか」は caused_by チェーンで常に説明可能**であること。
- 現在状態はイベントの畳み込みで再構築可能とする(スナップショット併用可。KV 上の現在値は導出キャッシュと位置づける)。
- 通知の発火判定はこのイベントログの購読として実装(状態遷移コードは通知を知らない)。

### 10.3 通知プレビュー
- `previewNotifications(asOf: Instant): PendingNotification[]` — 指定時点で発火するはずの通知を**送信せずに**列挙する純粋関数。
- VirtualClock と組み合わせ「今後7日間の通知シミュレーション」を CLI / MCP から実行可能に。

### 10.4 パーサーリプレイ基盤
- ParseJob の raw_input + raw_response を全保存し、記録済みデータをフィクスチャとして再実行するハーネスを用意。
- プロンプト・パーサーチェーン変更のたびに実データ回帰テストを回す。開発中は `MockParser`(フィクスチャ返答)で L4 を LLM 接続なしに構築する。

### 10.5 可観測性
- ログは JSON Lines の構造化ログ。全リクエスト / ParseJob / cron tick に `correlation_id` を発行し、イベントログ・ParseAttempt と突合可能に。
- デバッグ用 MCP ツール(本番は環境フラグで無効化): `debug_dump_state` / `debug_advance_clock`(VirtualClock時のみ)/ `debug_preview_notifications` / `debug_replay_parse(job_id)`。
- シード用フィクスチャ(典型プラン・段階ポリシー・unknown 混在)を同梱し、初期状態を1コマンドで再現可能に。

## 11. 非機能・制約

- 予算 0 円厳守。従量課金 API は使用しない(Claude パースは既存契約、Gemini/Groq は無料枠)。
- ROADMAP.md とフィードバックチャネルを初期から用意(育てる前提)。
- ドキュメントは ADR スタイルで判断を記録。
- 命名・文言・プロンプト文面は人間側オーナーが最終決定する(エージェントは提案まで)。
- リポジトリ名は `plancel-core` / `plancel-mcp` / `plancel-line` の分割 or monorepo をオーナーと確認のこと。

## 12. 決定記録(ADR 要約・2026-07-04)

| # | 決定 | 備考 |
|---|---|---|
| 1 | 名称 **plancel** で確定 | リポジトリは `plancel-core/mcp/line` 分割 or monorepo を実装開始時に確認 |
| 2 | デプロイ先は未定継続 | ストア interface 抽象化により後決め。Deno Deploy / VPS 両対応で書く |
| 3 | **Event** エンティティを導入 | 排他なしの束ね。「Trip」は旅行に限定されるため不採用。confirm_quota も採用(既定1) |
| 4 | MCP は追加・取得 + `report_cancelled` + `void_reservation` + `set_policy` | 汎用 update / 物理 delete のみ v1.x 先送り(#7 で改訂) |
| 5 | テキスト一次パーサーは **Groq(Llama 3.3 70B)**、二次 Gemini Flash | 二次を画像経路と同一プロバイダに揃え実装共通化。**無料枠条件は流動的なため実装着手時に現行クォータを再確認すること** |
| 6 | デバッグ容易性を第一級要件に格上げ(§10) | Clock 抽象・イベントログ・Outbox・リプレイ基盤・通知プレビューを MVP-1 に含める。実装コストより追跡可能性を優先。MVP-1 は外部接続ゼロで完結 |
| 7 | 旧残課題2件を MVP に取り込み解消 | 修正手段 = `void_reservation`(voided イベント追記)→ 再作成。unknown 解消 = `set_policy`(policy.provided イベント)。いずれも書き換えではなく追記系操作として実装し、イベントログと整合させる |
| 8 | 天気連携を v1.x に採用(2026-07-05) | 気象庁公開 JSON(キー不要・実質レート制限なし・予算0と整合)を `WeatherProvider` interface の背後に置く(Mock+リプレイ、Parser/Notifier と同規律)。天気は通知の enrichment + 新トリガー `weather_alert`(台風接近×未確定候補×無料期限前)であり、コア発火判定は天気を知らない純関数のまま。予報改訂の再通知は冪等キーに予報世代を含める。無料期限が予報信頼ウィンドウ(約5〜7日)の外にある場合は「予報値」ではなく「損失曲線上の保険判断」として提示する。location 自由文字列→地域コード解決は失敗時「地域不明=天気なし」に落とす |

## 13. 残課題

なし(2026-07-04 時点)。以後発生した課題は本 ADR 表に追記する。

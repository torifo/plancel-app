# plancel Requirements

> Source: `docs/SDD.md` (2026-07-04). Scope = フェーズ1（MVP-1 = L0〜L3 中心、MVP-2 = L4〜L5 を含む）。予算 0 円。利用者は開発者本人＋身内数名。

## Overview

複数候補を仮押さえして直前に1つ確定する予約運用において、確定時に残り候補を自動で「要キャンセル」化し、キャンセル料が上がる境界の直前に通知することで、キャンセル忘れとキャンセル料の発生を防ぐ。

## User Stories

### US-001: 候補グループ（Plan）の管理
**As a** 予約する本人 **I want to** 複数の予約候補を1つのプランに束ねる **So that** どれが同じ目的の候補かを一元管理できる

**Acceptance Criteria:**
- WHEN ユーザーが Plan を作成する THE SYSTEM SHALL `confirm_quota`（既定 1）を持つ排他的候補グループを作成する
- WHEN ユーザーが Reservation を Plan に追加する THE SYSTEM SHALL その予約を `candidate` 状態で登録する
- IF Reservation が Plan に属さない THEN THE SYSTEM SHALL 単独予約（`plan_id: null`）として登録を許容する

### US-002: 確定による自動 to_cancel 遷移（コア動作）
**As a** 予約する本人 **I want to** 1件確定したら残り候補が自動で要キャンセルになる **So that** キャンセル忘れが起きない

**Acceptance Criteria:**
- WHEN Plan 内の `confirmed` 数が `confirm_quota` に達した THE SYSTEM SHALL 同 Plan の他の `candidate` を全て `to_cancel` に遷移させる
- WHEN 自動遷移が発生した THE SYSTEM SHALL 「残り N 件が要キャンセル」の即時通知を発火する
- WHEN 自動遷移が発生した THE SYSTEM SHALL `caused_by` で確定イベントに紐づく `reservation.auto_to_cancel` イベントを追記する
- IF `to_cancel` のまま予約日時を過ぎた THEN THE SYSTEM SHALL 当該予約を要注意リストに残す（削除しない）

### US-003: キャンセル料境界の通知
**As a** 予約する本人 **I want to** キャンセル料が上がる直前に具体的な損失額付きで通知を受ける **So that** 無料のうちにキャンセルできる

**Acceptance Criteria:**
- WHEN キャンセル料率が上がる境界の24時間前に達した THE SYSTEM SHALL 通知を発火する
- IF `amount_jpy` が登録されている THEN THE SYSTEM SHALL 「今キャンセルすれば無料 / 明日から ¥X の損」形式の具体額を通知に含める
- WHEN 同一（reservation_id + trigger種別 + 境界時刻）の通知が既に配送済み THE SYSTEM SHALL 再送しない（Outbox 冪等キー）
- WHEN `policy: "unknown"` の予約が存在する THE SYSTEM SHALL 日次ダイジェストで後追い入力を促す
- WHEN 予約当日の朝に達した THE SYSTEM SHALL `confirmed` 予約のリマインドを発火する

### US-004: Claude 会話からの登録（MCP・入口A）
**As a** 開発者本人 **I want to** Claude との会話から予約を登録・操作する **So that** LLM API コストゼロで自然言語入力できる

**Acceptance Criteria:**
- WHEN MCP ツールが構造化入力を受けた THE SYSTEM SHALL §3 スキーマの Zod 検証を通過した場合のみ登録する
- WHEN 検証に失敗した THE SYSTEM SHALL エラー内容（欠損・違反フィールド）を返す
- THE SYSTEM SHALL MCP 側にパース知能を持たない（パースは Claude 会話側が担当する）

### US-005: 誤登録の修正
**As a** 利用者 **I want to** 誤登録を無効化して登録し直す **So that** 履歴を壊さずに修正できる

**Acceptance Criteria:**
- WHEN `void_reservation` が呼ばれた THE SYSTEM SHALL 物理削除せず `reservation.voided` イベントを追記し、通知対象・一覧から除外する
- WHEN `set_policy` が呼ばれた THE SYSTEM SHALL `policy.provided` イベントの追記として unknown ポリシーを解消する
- THE SYSTEM SHALL 汎用 update / 物理 delete を提供しない（v1.x 先送り）

### US-006: LINE からの登録（入口B・フェーズ1後半）
**As a** 身内の利用者 **I want to** LINE にテキスト・スクショを送るだけで予約登録する **So that** 専用アプリなしで使える

**Acceptance Criteria:**
- WHEN テキスト入力を受けた THE SYSTEM SHALL 一次パーサー（Groq Llama 3.3 70B）→ 二次（Gemini Flash）の順で試行する
- WHEN 画像入力を受けた THE SYSTEM SHALL Gemini Flash（vision）でパースする
- WHEN パーサー間でフィールドが食い違った THE SYSTEM SHALL 食い違ったフィールドのみを FieldConflict として Quick Reply でワンタップ選択させる（全文再入力は要求しない）
- WHEN 全段パースに失敗した THE SYSTEM SHALL ParseJob を `needs_review` 化し、欠損フィールドだけを質問する
- WHEN 外部 LLM へ送信する THE SYSTEM SHALL 送信前に電話番号・メールアドレスをマスクする

## Functional Requirements

### FR-001: データモデル（6エンティティ）
**Priority:** P0
THE SYSTEM SHALL Event / Plan / Reservation / CancellationPolicy / PolicyTemplate / ParseJob を SDD §3 のスキーマどおりに単一の Zod スキーマソースで定義する。
**Rationale:** 全入口の正規化先を1本化するインサート層設計の土台。

### FR-002: 状態遷移
**Priority:** P0
THE SYSTEM SHALL Reservation の状態を `candidate → confirmed → done`、`candidate/confirmed → to_cancel → cancelled`、全状態 → `voided` の遷移図（SDD §4）に限定し、全遷移で DomainEvent を追記する。
**Rationale:** コア動作の正しさと caused_by による説明可能性。

### FR-003: CancellationPolicy 検証
**Priority:** P0
WHEN ポリシーが登録される THE SYSTEM SHALL stages が `until_offset_hours` 降順かつ fee 単調非減少であることを検証する。IF ポリシーが `"unknown"` THEN THE SYSTEM SHALL 登録を拒否せず受け付ける。
**Rationale:** 境界計算の前提保証と、インサート摩擦の最小化の両立。

### FR-004: PolicyTemplate の適用
**Priority:** P1
WHEN テンプレートを適用する THE SYSTEM SHALL 値を Reservation 側にコピーし（参照ではなく）、適用前に人間のワンタップ承認を1回要求する。
**Rationale:** テンプレ更新が過去予約に波及することを防ぐ。

### FR-005: 通知の Outbox パターン
**Priority:** P0
THE SYSTEM SHALL 発火判定（純粋関数: 予約群 + Clock → 通知リスト）と配送（Notifier）を分離し、冪等性を Outbox の冪等キーで一元管理する。配送失敗はリトライする。
**Rationale:** 発火判定を送信なしで完全にテスト可能にする。

### FR-006: Notifier 実装順
**Priority:** P0
THE SYSTEM SHALL `Notifier` interface に対し ① ConsoleNotifier → ② LINE Messaging API → ③ Email (Resend) の順で実装する。
**Rationale:** 送信ロジックなしで発火判定をデバッグしてから実チャネルを繋ぐ。

### FR-007: MCP ツールセット（MVP 確定版）
**Priority:** P0
THE SYSTEM SHALL 次のツールのみを提供する: `create_event` / `create_reservation` / `create_plan` / `add_to_plan` / `confirm_reservation` / `report_cancelled` / `void_reservation` / `set_policy` / `list_pending_cancellations` / `get_plan` / `get_event`（+ 環境フラグで有効化される debug ツール群）。
**Rationale:** 追記型イベントログと整合する操作に限定する。

### FR-008: Clock 抽象
**Priority:** P0
THE SYSTEM SHALL 全レイヤーで `Date.now()` / `new Date()` の直接呼び出しを lint で禁止し、`Clock` interface（`now(): Temporal.Instant`）を注入する。`SystemClock` / `VirtualClock`（set / advance）を提供する。
**Rationale:** 境界判定・期限跨ぎのテストを決定的にする。

### FR-009: ドメインイベントログ
**Priority:** P0
THE SYSTEM SHALL 全状態遷移で DomainEvent（ULID・caused_by・correlation_id 付き）を追記し、現在状態をイベント畳み込みで再構築可能にする。通知発火はイベントログの購読として実装する。
**Rationale:** 「なぜ to_cancel なのか」を常に説明可能にし、状態遷移と通知の依存を切る。

### FR-010: 通知プレビュー
**Priority:** P1
THE SYSTEM SHALL `previewNotifications(asOf)` により指定時点で発火するはずの通知を送信せずに列挙でき、VirtualClock と組み合わせて「今後7日間のシミュレーション」を CLI / MCP から実行できる。

### FR-011: パーサー抽象とリプレイ基盤
**Priority:** P1（MVP-2）
THE SYSTEM SHALL パーサーを `Parser` interface で抽象化し、チェーン構成を設定ファイルで宣言する。ParseJob の raw_input / raw_response を全保存し、フィクスチャ再実行ハーネスと `MockParser` を提供する。LLM の confidence 自己申告は判定に使用しない。

### FR-012: ストア抽象
**Priority:** P0
THE SYSTEM SHALL Store を interface で抽象化し、Deno KV / SQLite を差し替え可能にする。

### FR-013: 可観測性
**Priority:** P1
THE SYSTEM SHALL JSON Lines 構造化ログを出力し、全リクエスト / ParseJob / cron tick に correlation_id を発行する。シード用フィクスチャで初期状態を1コマンド再現可能にする。

## Non-Functional Requirements
- **予算:** 0円厳守。従量課金 API 不使用（Gemini/Groq 無料枠、Claude パースは既存契約）。
- **プライバシー:** 外部 LLM 送信前に電話番号・メールアドレスをマスクする。
- **テスト容易性:** MVP-1（L0〜L3）は外部サービス接続ゼロで完全ローカル動作・決定的テスト可能であること。
- **通知量:** LINE 無料枠 月200通以内に収まる発火設計。
- **スケジューラ:** 15分間隔の境界チェック（Deno.cron / systemd timer）。
- **ガバナンス:** 命名・文言・プロンプト文面は人間側オーナーが最終決定。ADR で判断を記録。

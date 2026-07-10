# plancel Tasks

> Wave = 依存レイヤー（design.md Implementation Order）に対応。monorepo 前提の仮パス `src/...`（リポジトリ分割 or monorepo はオーナー確認事項）。コミットに Claude/Anthropic 帰属を含めない。

## Implementation Plan

### Wave 1 — L0: 基盤（parallel — no dependencies）
- [ ] **Task 1.1**: Zod スキーマ（単一ソース）
  - What: Event / Plan / Reservation / CancellationPolicy / PolicyTemplate / ParseJob / DomainEvent の Zod スキーマ + 型導出。policy 検証ルール（offset 降順・fee 単調非減少・unknown 許容）含む
  - Files: `src/core/schema/*.ts`
  - Done when: 正常系・違反系のスキーマテストが通る
  - Depends on: none
- [ ] **Task 1.2**: Clock 抽象 + lint ルール
  - What: `Clock` interface、`SystemClock` / `VirtualClock`(set/advance)、`Date.now()`/`new Date()` 直呼び禁止 lint 設定
  - Files: `src/core/clock/*.ts`, lint 設定
  - Done when: VirtualClock の advance テストが通り、lint が違反コードを検出する
  - Depends on: none
- [ ] **Task 1.3**: Store interface + InMemory/KV 実装
  - What: `Store` interface（エンティティ CRUD + イベント append/scan）、`InMemoryStore`（テスト用）、`KvStore`。KV キー設計は design.md 準拠
  - Files: `src/core/store/*.ts`
  - Done when: 両実装が共通の契約テストスイートを通る
  - Depends on: none（スキーマ型は 1.1 と並行調整）
- [ ] **Task 1.4**: プロジェクト雛形 + ROADMAP.md
  - What: Deno 設定、テストランナー、JSON Lines 構造化ログ util（correlation_id）、ROADMAP.md
  - Files: `deno.json`, `src/lib/log.ts`, `ROADMAP.md`
  - Done when: `deno test` / `deno lint` が動く
  - Depends on: none

### Wave 2 — L1: ドメインロジック（after Wave 1）
- [ ] **Task 2.1**: 状態遷移 + quota 判定（純粋関数）
  - What: `(state, command, clock) → DomainEvent[]`。confirm 時の quota 到達判定と auto_to_cancel 一括遷移（caused_by 連結）、不正遷移の拒否、voided 全状態対応
  - Files: `src/core/domain/transitions.ts`
  - Done when: 遷移表全パターン + quota=1/2 のテストが VirtualClock で通る
  - Depends on: Task 1.1, 1.2
- [ ] **Task 2.2**: policy 境界計算
  - What: CancellationPolicy + starts_at + Clock → 現在料率・次境界時刻・損失額の算出。unknown 対応
  - Files: `src/core/domain/policy.ts`
  - Done when: 段階ポリシー・固定額・unknown・期限跨ぎのテストが通る
  - Depends on: Task 1.1, 1.2
- [ ] **Task 2.3**: イベントログ + 畳み込み
  - What: DomainEvent 追記、イベント → 現在状態の再構築（fold）、caused_by チェーン取得
  - Files: `src/core/eventlog/*.ts`
  - Done when: 「イベント列から状態再構築 = KV 現在値」の一致テストが通る
  - Depends on: Task 1.1, 1.3

### Wave 3 — L2a / L2b 並行（after Wave 2）
- [ ] **Task 3.1**: 発火判定純粋関数 + previewNotifications（L2a）
  - What: `computePendingNotifications(reservations, clock)` — 4トリガー（境界24h前/確定即時/unknownダイジェスト/当日朝）+ `previewNotifications(asOf)`
  - Files: `src/notify/trigger.ts`
  - Done when: VirtualClock で「7日間シミュレーション」テストが通る
  - Depends on: Task 2.1, 2.2
- [ ] **Task 3.2**: Outbox + ConsoleNotifier（L2a）
  - What: 冪等キー消込・リトライ・`Notifier` interface・ConsoleNotifier、イベントログ購読による発火接続
  - Files: `src/notify/outbox.ts`, `src/notify/console.ts`
  - Done when: 二重 enqueue が1配送になるテスト + 失敗リトライテストが通る
  - Depends on: Task 2.3, 3.1
- [ ] **Task 3.3**: MCP server — 登録・取得系（L2b）
  - What: `create_event` / `create_reservation` / `create_plan` / `add_to_plan` / `get_plan` / `get_event` / `list_pending_cancellations`（Zod 検証、パース知能なし）
  - Files: `src/mcp/server.ts`, `src/mcp/tools/*.ts`
  - Done when: InMemoryStore 相手のツール入出力テストが通る
  - Depends on: Task 2.1, 2.3
- [ ] **Task 3.4**: MCP server — 遷移系 + debug ツール（L2b）
  - What: `confirm_reservation`（副作用一覧返却）/ `report_cancelled` / `void_reservation` / `set_policy`、`debug_dump_state` / `debug_advance_clock` / `debug_preview_notifications`（環境フラグ）
  - Files: `src/mcp/tools/*.ts`
  - Done when: confirm → to_cancel 副作用が MCP 応答で確認でき、フラグ off で debug が消える
  - Depends on: Task 3.1, 3.3

### Wave 4 — L3 + シード（after Wave 3）
- [ ] **Task 4.1**: cron スケジューラ
  - What: `Deno.cron`（15分）薄い層 — Clock 読み → 発火判定 → Outbox 積み。VPS 用 entrypoint も用意
  - Files: `src/cron/main.ts`
  - Done when: tick 1回のスモークテスト（発火判定関数のテストは 3.1 で完了済み）
  - Depends on: Task 3.2
- [ ] **Task 4.2**: シードフィクスチャ + E2E シナリオ
  - What: 典型プラン・段階ポリシー・unknown 混在のシード、「confirm → 3日進める → previewNotifications」を1コマンド実行
  - Files: `fixtures/*.json`, `src/cli/seed.ts`
  - Done when: 1コマンドで初期状態再現 + E2E シナリオが通る（**MVP-1 完了**・外部接続ゼロ）
  - Depends on: Task 3.2, 3.4

### Wave 5 — L4: パーサー基盤（Wave 2 完了後いつでも並行可）
- [ ] **Task 5.1**: Parser interface + チェーン + MockParser
  - What: `Parser` interface、設定ファイル宣言のチェーン実行、バリデーション駆動フォールバック、FieldConflict 検出、PII マスク前処理
  - Files: `src/parse/*.ts`, `parsers.config.json`
  - Done when: MockParser 2段構成で フォールバック / 食い違い / 全段失敗の3経路テストが通る
  - Depends on: Task 1.1（+ ParseJob 保存は 1.3）
- [ ] **Task 5.2**: リプレイハーネス
  - What: ParseJob フィクスチャ再実行 + 回帰比較レポート
  - Files: `src/parse/replay.ts`, `src/mcp/tools/debug_replay_parse.ts`
  - Done when: 記録済みフィクスチャの再実行で一致/差分が報告される
  - Depends on: Task 5.1

### Wave 6 — L5: 外部接続（after Wave 4, 5）
- [ ] **Task 6.1**: 実 LLM パーサー（Groq / Gemini Flash）
  - What: 実装 + 無料枠クォータの現行条件再確認（ADR-5）。vision 経路は Gemini 固定
  - Files: `src/parse/groq.ts`, `src/parse/gemini.ts`
  - Done when: 実データ数件でリプレイ回帰が通る
  - Depends on: Task 5.2
- [ ] **Task 6.2**: LINE Bot 入口 + LINENotifier
  - What: webhook（署名検証・userId 許可リスト）→ パイプライン、Quick Reply 差し戻し、LINENotifier（月200通枠内）
  - Files: `src/line/*.ts`
  - Done when: テキスト/画像登録と差し戻しワンタップが実機で動く（**MVP-2 完了**）
  - Depends on: Task 4.1, 6.1
- [ ] **Task 6.3**: EmailNotifier (Resend) + ドキュメント整備
  - What: Resend 実装、ADR 追記、README
  - Depends on: Task 4.1

## Progress
- Total: 15 tasks | Completed: 13 (Wave 1–5 = L0–L4) | In Progress: 1 (Task 6.1)
- 残: Wave 6（Task 6.1 実LLM / 6.2 LINE Bot / 6.3 Email+docs）= 外部接続・デプロイ後フェーズ
- Wave 1–5 の全タスクは各ウェーブ後の opus レビュー（承認 3回・差し戻し 1回→修正済み）とテスト検証を通過。最終状態: 266 tests green / scenario OK / replay 3/3 identical
- Task 6.2 コード実装済み（2026-07-10）: `src/line/{signature,types,client,webhook,notifier,main}.ts` + テスト13件（`deno task line` で起動）。署名検証（HMAC-SHA256・定数時間比較）/ userId 許可リスト / text・画像→共通パイプライン / FieldConflict の Quick Reply ワンタップ解決（解決状態は conflicts の絞り込みで永続化、attempts は不変）/ 欠損は質問を返して再送依頼 / LINENotifier（Outbox 契約: 失敗 reject でリトライ）。**残: デプロイ後の実機確認（done-when）**。LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / LINE_ALLOWED_USER_IDS が必要
- Task 6.3 コード実装済み（2026-07-10）: `src/notify/email-notifier.ts`（Resend、トリガー別件名）+ テスト2件。ADR-10 追記・README（EN/JA）更新済み。**残: RESEND_API_KEY + 送信元ドメイン検証後の実送信確認**。cron エントリポイントへの Notifier 差し替え配線はデプロイ時
- Task 6.1 実装済み（2026-07-10）: `src/parse/{llm,groq,gemini,real}.ts` + `src/cli/parse_live.ts`（`deno task parse:live`）。stub fetch テスト18件込みで 284 tests green / replay 3/3 identical。ADR-5 クォータ再確認済み（Groq llama-3.3-70b: 30 RPM・1K req/日・100K tok/日 / Gemini 2.5 Flash: 10 RPM・250 req/日 — 2025-12 に無料枠縮小、デプロイ前に再々確認）。**残（キー必要）**: GROQ_API_KEY / GEMINI_API_KEY を設定し `parse:live --record` で実データ数件をフィクスチャ化 → `parsers.config.json` を real.ts の REAL_CHAIN_CONFIG に切替 → `deno task replay` 通過で Done。プロンプト文面（llm.ts RESERVATION_PARSE_PROMPT）はオーナー最終決定事項（SDD §11）で現状は提案版

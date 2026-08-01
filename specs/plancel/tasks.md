# plancel Tasks

> Wave = 依存レイヤー（design.md Implementation Order）に対応。monorepo 前提の仮パス
> `src/...`（リポジトリ分割 or monorepo はオーナー確認事項）。コミットに Claude/Anthropic
> 帰属を含めない。

## Implementation Plan

### Wave 1 — L0: 基盤（parallel — no dependencies）

- [x] **Task 1.1**: Zod スキーマ（単一ソース）
  - What: Event / Plan / Reservation / CancellationPolicy / PolicyTemplate / ParseJob / DomainEvent
    の Zod スキーマ + 型導出。policy 検証ルール（offset 降順・fee 単調非減少・unknown 許容）含む
  - Files: `src/core/schema/*.ts`
  - Done when: 正常系・違反系のスキーマテストが通る
  - Depends on: none
- [x] **Task 1.2**: Clock 抽象 + lint ルール
  - What: `Clock` interface、`SystemClock` / `VirtualClock`(set/advance)、`Date.now()`/`new Date()`
    直呼び禁止 lint 設定
  - Files: `src/core/clock/*.ts`, lint 設定
  - Done when: VirtualClock の advance テストが通り、lint が違反コードを検出する
  - Depends on: none
- [x] **Task 1.3**: Store interface + InMemory/KV 実装
  - What: `Store` interface（エンティティ CRUD + イベント
    append/scan）、`InMemoryStore`（テスト用）、`KvStore`。KV キー設計は design.md 準拠
  - Files: `src/core/store/*.ts`
  - Done when: 両実装が共通の契約テストスイートを通る
  - Depends on: none（スキーマ型は 1.1 と並行調整）
- [x] **Task 1.4**: プロジェクト雛形 + ROADMAP.md
  - What: Deno 設定、テストランナー、JSON Lines 構造化ログ util（correlation_id）、ROADMAP.md
  - Files: `deno.json`, `src/lib/log.ts`, `ROADMAP.md`
  - Done when: `deno test` / `deno lint` が動く
  - Depends on: none

### Wave 2 — L1: ドメインロジック（after Wave 1）

- [x] **Task 2.1**: 状態遷移 + quota 判定（純粋関数）
  - What: `(state, command, clock) → DomainEvent[]`。confirm 時の quota 到達判定と auto_to_cancel
    一括遷移（caused_by 連結）、不正遷移の拒否、voided 全状態対応
  - Files: `src/core/domain/transitions.ts`
  - Done when: 遷移表全パターン + quota=1/2 のテストが VirtualClock で通る
  - Depends on: Task 1.1, 1.2
- [x] **Task 2.2**: policy 境界計算
  - What: CancellationPolicy + starts_at + Clock → 現在料率・次境界時刻・損失額の算出。unknown 対応
  - Files: `src/core/domain/policy.ts`
  - Done when: 段階ポリシー・固定額・unknown・期限跨ぎのテストが通る
  - Depends on: Task 1.1, 1.2
- [x] **Task 2.3**: イベントログ + 畳み込み
  - What: DomainEvent 追記、イベント → 現在状態の再構築（fold）、caused_by チェーン取得
  - Files: `src/core/eventlog/*.ts`
  - Done when: 「イベント列から状態再構築 = KV 現在値」の一致テストが通る
  - Depends on: Task 1.1, 1.3

### Wave 3 — L2a / L2b 並行（after Wave 2）

- [x] **Task 3.1**: 発火判定純粋関数 + previewNotifications（L2a）
  - What: `computePendingNotifications(reservations, clock)` —
    4トリガー（境界24h前/確定即時/unknownダイジェスト/当日朝）+ `previewNotifications(asOf)`
  - Files: `src/notify/trigger.ts`
  - Done when: VirtualClock で「7日間シミュレーション」テストが通る
  - Depends on: Task 2.1, 2.2
- [x] **Task 3.2**: Outbox + ConsoleNotifier（L2a）
  - What: 冪等キー消込・リトライ・`Notifier`
    interface・ConsoleNotifier、イベントログ購読による発火接続
  - Files: `src/notify/outbox.ts`, `src/notify/console.ts`
  - Done when: 二重 enqueue が1配送になるテスト + 失敗リトライテストが通る
  - Depends on: Task 2.3, 3.1
- [x] **Task 3.3**: MCP server — 登録・取得系（L2b）
  - What: `create_event` / `create_reservation` / `create_plan` / `add_to_plan` / `get_plan` /
    `get_event` / `list_pending_cancellations`（Zod 検証、パース知能なし）
  - Files: `src/mcp/server.ts`, `src/mcp/tools/*.ts`
  - Done when: InMemoryStore 相手のツール入出力テストが通る
  - Depends on: Task 2.1, 2.3
- [x] **Task 3.4**: MCP server — 遷移系 + debug ツール（L2b）
  - What: `confirm_reservation`（副作用一覧返却）/ `report_cancelled` / `void_reservation` /
    `set_policy`、`debug_dump_state` / `debug_advance_clock` /
    `debug_preview_notifications`（環境フラグ）
  - Files: `src/mcp/tools/*.ts`
  - Done when: confirm → to_cancel 副作用が MCP 応答で確認でき、フラグ off で debug が消える
  - Depends on: Task 3.1, 3.3

### Wave 4 — L3 + シード（after Wave 3）

- [x] **Task 4.1**: cron スケジューラ
  - What: `Deno.cron`（15分）薄い層 — Clock 読み → 発火判定 → Outbox 積み。VPS 用 entrypoint も用意
  - Files: `src/cron/main.ts`
  - Done when: tick 1回のスモークテスト（発火判定関数のテストは 3.1 で完了済み）
  - Depends on: Task 3.2
- [x] **Task 4.2**: シードフィクスチャ + E2E シナリオ
  - What: 典型プラン・段階ポリシー・unknown 混在のシード、「confirm → 3日進める →
    previewNotifications」を1コマンド実行
  - Files: `fixtures/*.json`, `src/cli/seed.ts`
  - Done when: 1コマンドで初期状態再現 + E2E シナリオが通る（**MVP-1 完了**・外部接続ゼロ）
  - Depends on: Task 3.2, 3.4

### Wave 5 — L4: パーサー基盤（Wave 2 完了後いつでも並行可）

- [x] **Task 5.1**: Parser interface + チェーン + MockParser
  - What: `Parser`
    interface、設定ファイル宣言のチェーン実行、バリデーション駆動フォールバック、FieldConflict
    検出、PII マスク前処理
  - Files: `src/parse/*.ts`, `parsers.config.json`
  - Done when: MockParser 2段構成で フォールバック / 食い違い / 全段失敗の3経路テストが通る
  - Depends on: Task 1.1（+ ParseJob 保存は 1.3）
- [x] **Task 5.2**: リプレイハーネス
  - What: ParseJob フィクスチャ再実行 + 回帰比較レポート
  - Files: `src/parse/replay.ts`, `src/mcp/tools/debug_replay_parse.ts`
  - Done when: 記録済みフィクスチャの再実行で一致/差分が報告される
  - Depends on: Task 5.1

### Wave 7 — デプロイ配線（Deno Deploy、opulseと同じ`torifo` org）

- [x] **Task 7.1**: 統合エントリポイント + 本番 Notifier 配線（2026-07-15）
  - What: `src/deploy/main.ts` — 1 デプロイで `Deno.serve`（LINE webhook + /healthz）と
    `Deno.cron`（15分境界チェック）を共有 KvStore で同居。`src/deploy/notifier.ts` の
    `selectNotifier` が env から LINE push > Email > Console を選択
  - Files: `src/deploy/main.ts`, `src/deploy/notifier.ts`, `docs/DEPLOY.md`
  - Done when: ローカル起動で healthz=ok / 署名不正=401 / 正当=200 / cron 登録ログ、テスト
    green（`deno task deploy:serve` で確認済み・selectNotifier テスト6件）
  - 本番配線済み。外部サービスを含む実機done-whenは `docs/VERIFICATION.md` §3で追跡

### Wave 6 — L5: 外部接続（after Wave 4, 5）

- [x] **Task 6.1**: 実 LLM パーサー（Groq / Gemini Flash）
  - What: 実装 + 無料枠クォータの現行条件再確認（ADR-5）。vision 経路は Gemini 固定
  - Files: `src/parse/groq.ts`, `src/parse/gemini.ts`
  - Done when: 実データ数件でリプレイ回帰が通る
  - Depends on: Task 5.2
- [x] **Task 6.2**: LINE Bot 入口 + LINENotifier（コード完了）
  - What: webhook（署名検証・userId 許可リスト）→ パイプライン、Quick Reply
    差し戻し、LINENotifier（月200通枠内）
  - Files: `src/line/*.ts`
  - Acceptance pending: 本番実機でテキスト/画像登録と差し戻しワンタップを確認
  - Depends on: Task 4.1, 6.1
- [x] **Task 6.3**: EmailNotifier (Resend) + ドキュメント整備（コード完了）
  - What: Resend 実装、ADR 追記、README
  - Acceptance pending: Resend送信元ドメイン検証後に本番実送信を確認
  - Depends on: Task 4.1

### Wave 8 — PWA配信・明示インストール／更新

- [x] **Task 8.1**: Web台帳のPWA化（2026-07-26）
  - What: installable manifest・192/512px/maskableアイコン・Service Workerを同一originで配信。
    マイページに明示インストールと手動更新確認を置き、待機中Service Workerを利用者操作で適用する
  - Files: `web/manifest.webmanifest`, `web/sw.js`, `web/icons/`, `src/web/pwa.ts`, `web/index.html`
  - Done when: manifest/SW/アイコンの配信テスト、API/Authをキャッシュしない回帰テスト、
    実ブラウザでService Worker登録と「更新を確認」→「最新版です。」を確認
  - Acceptance pending: 本番Android/iOS端末でホーム画面追加・standalone起動・更新適用を確認

## Progress

- **実装タスク: 20/20 完了**（Wave 1〜8。Task 6.2/6.3 はコード完了として集計）
- **自動検証（2026-08-01）**: 669 tests green / scenario OK / replay 10/10 identical
- **本番で確認済み**: Deno Deploy稼働、LINE env反映、署名なしwebhookの401、LINE
  ConsoleのWebhook検証成功
- **未完了の外部acceptance**: LINE実機のテキスト/画像登録とQuick
  Reply、Resendドメイン検証と実送信、Googleログイン→Calendar同期、UIDログイン、remote
  MCP→本番台帳、cron継続稼働。`docs/VERIFICATION.md` §3を正とする
- **PWA（2026-07-26）**: installable manifest / Service Worker /
  アプリアイコンを配信し、マイページに
  明示インストール・更新確認・待機中バージョン適用を追加。ローカル実ブラウザで登録と最新版確認まで検証済み。
  本番Android/iOS端末のインストール・standalone起動・更新適用は外部acceptance
- **Web台帳堅牢化（2026-07-26）**: 確定可能状態をcandidateに限定し、同一Planの確定とsiblingsの
  `to_cancel`をKV atomic transaction化。競合時の二重winnerを防ぐ回帰テストを追加
- **Task 6.1 完了（2026-07-11）**: API キー投入 → `parse:live --record` で実データ 3
  件（レストラン確認メール / 宿の段階ポリシー / 口語 unknown、全件 groq-llama 一発通過）→ 既存 mock
  フィクスチャ 3 件はパーサー名を実名に移行して温存 → `parsers.config.json`
  を実チェーン（groq→gemini / image=gemini）へ切替
- **Task 6.1 精度・枠最適化（2026-08-01）**: 通常テキストはGroq一発で完了し、ルール警告・複数暦日・
  チェックイン/アウト併記・住所/キャンセル条件の読み落とし時だけGemini査読を追加。査読理由を
  ParseJobへ保存し、日時のタイムゾーン表記違いは同一時刻として比較。無効な後段出力は有効なGroq結果を
  上書きしない。「N日前から◯%」と画像は従来どおりGemini優先/固定
- **検証の力点修正（2026-07-11 オーナーFB）**: plancel は家計簿ではなく予定台帳 —
  一級の検証対象は**日時と場所**（金額・ポリシーは二次）。対応: ①プロンプトに Clock
  経由で「今日の日付（JST）」を注入し年無し日付の将来解釈ルールを追加（`reservationPromptForClock`、Clock
  なしなら規則自体を省く）＋ location 抽出を最優先と明示 ②validate に「2年以上先=
  年の読み違い疑い」警告 ③日付・場所特化の実データ 3 件を追加記録（年推論 1/15→2027 ✓ / 住所抽出 ✓ /
  チェックイン15:00・アウト10:00 ✓、いずれも値を目視検証済み）
- Wave 1–5
  の全タスクは各ウェーブ後のレビューとテスト検証を通過。過去のテスト件数は履歴値のため、現在値は上記「自動検証」を参照
- Task 6.2 コード実装済み（2026-07-10）:
  `src/line/{signature,types,client,webhook,notifier,main}.ts` + テスト13件（`deno task line`
  で起動）。署名検証（HMAC-SHA256・定数時間比較）/ userId 許可リスト / text・画像→共通パイプライン /
  FieldConflict の Quick Reply ワンタップ解決（解決状態は conflicts の絞り込みで永続化、attempts
  は不変）/ 欠損は質問を返して再送依頼 / LINENotifier（Outbox 契約: 失敗 reject でリトライ）。**残:
  デプロイ後の実機確認（done-when）**。LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN が必要。
  LINE_ALLOWED_USER_IDS は**レガシー**（2026-07-27 にユーザー毎の LINE 連携が認可になった。統合
  エントリポイントでは未連携者を絞る追加制限のみで、連携済みユーザーはブロックしない。`deno task line`
  単体モードだけは連携インデックスを持たないため従来どおり必須）
- Task 6.3 コード実装済み（2026-07-10）: `src/notify/email-notifier.ts`（Resend、トリガー別件名）+
  テスト2件。ADR-10 追記・README（EN/JA）更新済み。**残: RESEND_API_KEY +
  送信元ドメイン検証後の実送信確認**。cronは`selectNotifier`でLINE > Email > Consoleへ配線済み
- Task 6.1 実装済み（2026-07-10、実データ検証完了 2026-07-11）:
  `src/parse/{llm,groq,gemini,real}.ts` +
  `src/cli/parse_live.ts`（`deno task parse:live`）。Groq→Gemini / image=Gemini
  の実チェーンへ切替済みで、実データを含む replay 9/9 identical

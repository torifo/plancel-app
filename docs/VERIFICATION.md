# plancel 検証ガイド（デプロイ前ローカル検証 + ドキュメント整合）

> 最終更新: 2026-07-11（全コマンドはこの日に実行して期待出力を確認済み）。
> デプロイ前は §1 を上から順に全部通すこと。§2 はドキュメントを触ったとき・リリース前の照合用。

## 1. ローカル検証ランブック

### 1.0 事前準備

- Deno 2.9+。
- 実 LLM を使う手順（1.5 以降）だけ `.env` が必要: `GROQ_API_KEY=...` / `GEMINI_API_KEY=...`（`KEY=VALUE` 形式・1行1キー）。読み込みは `set -a && source .env && set +a`。
- 1.1〜1.4 は**外部接続ゼロ**で完結する（MVP-1 の設計保証）。

### 1.1 静的検査 + 全テスト（必須）

```sh
deno task check     # 型 + Date直呼び禁止lint → "no_direct_date_check: OK"
deno lint           # 0 problems
deno task test      # 303 passed | 0 failed
```

テストが検証している主なもの: 状態遷移・quota 一括遷移（VirtualClock）/ policy 境界計算 /
Outbox 冪等・リトライ / MCP ツール入出力 / パーサーチェーン 3 経路（フォールバック・食い違い・全段失敗）/
Groq・Gemini パーサー（stub fetch）/ LINE webhook（署名・許可リスト・Quick Reply 解決・画像）/
Email(Resend) Notifier / **年推論プロンプト（JST 日付注入）と 2 年先警告**。

### 1.2 パース回帰リプレイ（必須）

```sh
deno task replay    # → 9/9 identical, 0/9 changed（LLM 接続なし）
```

`fixtures/parse/` の回帰コーパス（実データ 6 + 合成 3）を現行チェーン・現行検証ロジックで再実行。
**プロンプト・チェーン・validate を変更したら必ずここが green であること**。
日時・場所の読み取り（年推論 1/15→翌年 / 住所→location / チェックイン・アウト時刻）はこのコーパスが守っている。

### 1.3 E2E シナリオ（必須）

```sh
deno task seed        # 初回のみ（2回目以降は --force で追加投入 or 省略）
deno task scenario    # → "=== scenario OK ===" で終了
```

確定 → quota 到達で他候補が to_cancel → 3 日進めて previewNotifications、まで 1 コマンド。
出力に fee_boundary_24h（損失額つき）/ policy_unknown_digest / day_of_reminder が並ぶこと。

### 1.4 cron 1 tick スモーク（必須）

```sh
deno task cron:once   # → 最終行 "tick end" の JSON で enqueued/delivered が 0 以上、failed:0
```

ConsoleNotifier で配送されるので送信は発生しない。2 回連続実行すると冪等キー消込で `deduped` が増える（重複配送しないことの確認）。

### 1.5 実 LLM ライブパース（.env 必要・任意だがプロンプト変更時は必須）

```sh
set -a && source .env && set +a
deno task parse:live "8/20 18:30 〇〇 4名"        # 一次 Groq で parsed になること
deno task parse:live --image path/to/screenshot.png  # vision 経路（Gemini）
```

確認観点（予定台帳としての一級項目）:
- **starts_at**: 年なし日付が「今日以降の最近傍」になる（過去日付にならない）
- **location**: 住所・場所が service_name と分離して入る
- 宿: チェックイン時刻 → starts_at / チェックアウト → ends_at
- 良い結果は `--record <name>` でフィクスチャ化して回帰コーパスに追加する

### 1.6 LINE webhook ローカルスモーク（実チャネル不要・任意）

```sh
LINE_CHANNEL_SECRET=dummy-secret LINE_CHANNEL_ACCESS_TOKEN=dummy-token \
LINE_ALLOWED_USER_IDS=U-owner PORT=18080 deno task line &

curl -s http://localhost:18080/healthz                     # → ok
BODY='{"events":[{"type":"message","replyToken":"r1","source":{"type":"user","userId":"U-stranger"},"message":{"id":"m1","type":"text","text":"test"}}]}'
SIG=$(deno eval --unstable-temporal 'import { signLineBody } from "./src/line/signature.ts"; console.log(await signLineBody("dummy-secret", Deno.args[0]));' "$BODY")
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:18080/webhook -H 'x-line-signature: invalid' -d "$BODY"   # → 401
curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:18080/webhook -H "x-line-signature: $SIG" -d "$BODY"      # → 200（許可外userIdなので無処理）
```

ここで検証できる範囲は**署名検証と許可リストまで**。返信（reply）・画像取得は LINE の実トークンが要るため
実機確認（デプロイ後）に属する。返信メッセージ生成・Quick Reply 解決のロジック自体は 1.1 のユニットテストが担保。

### 1.7 MCP サーバー（任意）

```sh
claude mcp add plancel -- deno run --allow-env --allow-read --allow-write --unstable-temporal --unstable-kv $(pwd)/src/mcp/main.ts
```

Claude から `create_reservation` → `confirm_reservation` して副作用一覧（siblings の to_cancel）が返ることを確認。
`PLANCEL_DEBUG=1` なら `debug_dump_state` / `debug_preview_notifications` も使える。

### 1.8 デプロイ直前チェックリスト

- [ ] 1.1〜1.4 全部 green（1.5 はプロンプト変更があった場合）
- [ ] `git status` clean / main が最新コミット
- [ ] `.env` / `local/` がコミットされていない（`git check-ignore .env local/` で確認）
- [ ] 無料枠の現行条件を再確認（ADR-5 / ADR-10: Groq・Gemini・LINE 月200通・Resend）
- [ ] デプロイ初手は ADR-2 のスパイク: ローカル MCP → Deploy KV リモート接続の実測
- [ ] デプロイ後: LINE webhook URL 設定 → 実機でテキスト/画像登録と Quick Reply ワンタップ（Task 6.2 done-when）
- [ ] デプロイ後: Resend ドメイン検証 → 実送信 1 通（Task 6.3 done-when）

## 2. ドキュメント整合チェック（既存ドキュメントの検証）

ドキュメントの「実装状態を主張する記述」と実体の照合表。**コード・テスト数・タスク状態を変えたら該当行を更新すること**。
2026-07-11 監査時の結果: README のテスト数（299→303）とステータス欄が古く、本コミットで修正済み。他は一致。

| ドキュメント | 照合する主張 | 実体（確認コマンド） |
|---|---|---|
| README（両言語）冒頭 | テスト件数 | `deno task test` の passed 数 |
| README「構成」表 | src/ ディレクトリ一覧と役割 | `ls src/`（core/notify/mcp/parse/cron/line/cli/lib） |
| README「ステータス」 | 実装済みレイヤーと残作業 | `specs/plancel/tasks.md` の Progress 節 |
| README 環境変数 | 変数名 | `grep -rn "Deno.env.get" src/ scripts/` |
| SDD §12 ADR 表 | 決定と実装の一致（ADR-5 モデル名 / ADR-10 チャネル） | `src/parse/{groq,gemini}.ts` の DEFAULT_MODEL、`src/line/` `src/notify/email-notifier.ts` |
| ROADMAP / tasks.md | レイヤー進捗 | tasks.md Progress が唯一の進捗ソース（ROADMAP は構造のみ） |
| parsers.config.json | 実チェーン宣言 | `{"text":["groq-llama","gemini-flash"],"image":["gemini-flash"]}` |
| fixtures/parse/ | 回帰コーパス件数 | `deno task replay` の N/N と README/tasks の記述 |

未整備（ドキュメントに書かれていない実装 — 次回ドキュメント更新の候補）:
- `deno task verify`（本コミットで追加した 1.1〜1.4 の一括実行タスク）
- Web UI プロトタイプは Artifact 上にあり、リポジトリには未収録（HTTP API 層とともに今後）

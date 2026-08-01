# plancel 検証ガイド（ローカル検証 + ドキュメント整合 + 本番実機）

> 最終更新: 2026-08-01。§1 のローカルコマンドは 2026-08-01 に再実行して期待出力を確認済み
> （669 passed | 0 failed、replay 10/10 identical）。
> §3（ログイン・カレンダー・MCP・LINE・Resend の本番トラック）は 2026-07-26 時点の実装を反映。
> デプロイ前は §1 を上から順に全部通すこと。§2 はドキュメントを触ったとき・リリース前の照合用。 §3
> はデプロイ後の実機確認（done-when）。

## 1. ローカル検証ランブック

### 1.0 事前準備

- Deno 2.9+。
- 実 LLM を使う手順（1.5 以降）だけ `.env` が必要: `GROQ_API_KEY=...` /
  `GEMINI_API_KEY=...`（`KEY=VALUE` 形式・1行1キー）。読み込みは `set -a && source .env && set +a`。
- 1.1〜1.4 は**外部接続ゼロ**で完結する（MVP-1 の設計保証）。

### 1.1 静的検査 + 全テスト（必須）

```sh
deno task check     # 型 + Date直呼び禁止lint → "no_direct_date_check: OK"
deno lint           # 0 problems
deno task test      # 669 passed | 0 failed
deno task verify    # fmt check + 上記検査 + replayを一括実行
```

テストが検証している主なもの: 状態遷移・quota 一括遷移（VirtualClock）/ policy 境界計算 / Outbox
冪等・リトライ / MCP ツール入出力 / パーサーチェーン（Groq主系・条件付きGemini査読・フォールバック・
食い違い・全段失敗・日時の意味的同値比較・無効な査読結果を採用しないこと）/
Groq・Gemini パーサー（stub fetch）/ LINE webhook（署名・ユーザー毎連携での送信者解決と台帳の分離・
連携コードの発行/単回性/期限・未連携時の案内・Quick Reply 解決・画像）/
Email(Resend) Notifier / **年推論プロンプト（JST 日付注入）と 2 年先警告**。 PWA manifest / Service
Worker / アイコン配信、API/Authをキャッシュしないこと、明示更新メッセージ。 施設の既定規定
（施設名の正規化・`unknown` 拒否・上書き・削除の冪等性・台帳間の非公開性）。 予約の共有（招待・
viewer/editor 権限・メンバー一覧・脱退、オーナー専用操作の 403、メールアドレスを返さないこと）。
メール転送インテーク（宛先の秘密による本人判定・`from` 不信任・Svix 署名検証・日次上限・
`email_id` 重複排除）。

### 1.2 パース回帰リプレイ（必須）

```sh
deno task replay    # → 10/10 identical, 0/10 changed（LLM 接続なし）
```

`fixtures/parse/` の回帰コーパス（実データ 7 + 合成 3）を現行チェーン・現行検証ロジックで再実行。
**プロンプト・チェーン・validate を変更したら必ずここが green であること**。
日時・場所の読み取り（年推論 1/15→翌年 / 住所→location /
チェックイン・アウト時刻）はこのコーパスが守っている。

### 1.3 E2E シナリオ（必須）

```sh
deno task seed        # 初回のみ（2回目以降は --force で追加投入 or 省略）
deno task scenario    # → "=== scenario OK ===" で終了
```

確定 → quota 到達で他候補が to_cancel → 3 日進めて previewNotifications、まで 1 コマンド。 出力に
fee_boundary_24h（損失額つき）/ policy_unknown_digest / day_of_reminder が並ぶこと。

### 1.4 cron 1 tick スモーク（必須）

```sh
deno task cron:once   # → 最終行 "tick end" の JSON で enqueued/delivered が 0 以上、failed:0
```

ConsoleNotifier で配送されるので送信は発生しない。2 回連続実行すると冪等キー消込で `deduped`
が増える（重複配送しないことの確認）。

### 1.5 実 LLM ライブパース（.env 必要・任意だがプロンプト変更時は必須）

```sh
set -a && source .env && set +a
deno task parse:live "8/20 18:30 〇〇 4名"        # 一次 Groq で parsed になること
deno task parse:live --image path/to/screenshot.png  # vision 経路（Gemini）
deno task parse:live "8/20 18:30 〇〇 4名 キャンセルは7日前から20%"  # 「から」表記だけ Gemini 優先
```

確認観点（予定台帳としての一級項目）:

- **starts_at**: 年なし日付が「今日以降の最近傍」になる（過去日付にならない）
- **location**: 住所・場所が service_name と分離して入る
- 宿: チェックイン時刻 → starts_at / チェックアウト → ends_at
- **無料キャンセル期限**: 「7日前から20%」は `192/0, 0/20`（台帳で「8日前まで無料 → 当日20%」）。
  無料の段が無い＝無料キャンセル期限が null になり、24時間前の通知が丸ごと出なくなる。境界は
  原文から `impliedFreeBoundaryHours` が決めて取り込み時に上書きするので、どちらのパーサーが
  答えても 192 になる（モデルが 168 と答えても台帳は 192）。Gemini の有効枠はプロジェクト／モデルごとに
  AI Studioで確認し、画像経路と共用する。Geminiが使えず groq-llama に落ちたときに差が出るのは内側の段だけ
- **Gemini査読条件**: Groqがルール上validでも、警告・複数の暦日・チェックイン/アウト併記・住所の
  読み落とし・キャンセル条件の読み落としがあればGeminiも実行する。理由はParseJobの
  `review_reasons`に保存する。通常の完全なテキストはGroqだけで終了する
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

ここで検証できる範囲は**署名検証と許可リストまで**。返信（reply）・画像取得は LINE
の実トークンが要るため 実機確認（デプロイ後）に属する。返信メッセージ生成・Quick Reply
解決のロジック自体は 1.1 のユニットテストが担保。

### 1.6b 統合デプロイ・エントリポイントのローカルスモーク（任意）

本番と同じ `src/deploy/main.ts`（`Deno.serve` webhook + `Deno.cron` を共有 KV
で同居）を丸ごと起動する。

```sh
LINE_CHANNEL_SECRET=dummy LINE_CHANNEL_ACCESS_TOKEN=dummy \
LINE_ALLOWED_USER_IDS=U-owner PORT=18091 deno task deploy:serve &

curl -s http://localhost:18091/healthz    # → ok
# 起動ログに cron registered（notifier: line/email/console）と webhook configured が出る
```

`--unstable-cron` はタスクに含めてある（Deploy 上はフラグ不要）。デプロイ手順は
[`DEPLOY.md`](./DEPLOY.md)。

> 統合エントリポイントでは台帳が繋がるため、送信者は**ユーザー毎の LINE 連携**で解決される
> （`LINE_ALLOWED_USER_IDS` は未連携者だけを絞るクローズドベータ用ゲートで、公開時は空）。未連携の userId で送ると
> 200 + 連携案内が返り、ParseJob も予約も作られない。`deno task line` 単体モードは連携インデックスを
> 持たないので、従来どおり許可リストが唯一の認可。

### 1.7 MCP サーバー（任意）

```sh
claude mcp add plancel -- deno run --allow-env --allow-read --allow-write --unstable-temporal --unstable-kv $(pwd)/src/mcp/main.ts
```

Claude から `create_reservation` → `confirm_reservation` して副作用一覧（siblings の
to_cancel）が返ることを確認。 `PLANCEL_DEBUG=1` なら `debug_dump_state` /
`debug_preview_notifications` も使える。

### 1.8 デプロイ・本番acceptanceチェックリスト

- [ ] 1.1〜1.4 全部 green（1.5 はプロンプト変更があった場合）
- [ ] `git status` clean / main が最新コミット
- [ ] `.env` / `local/` がコミットされていない（`git check-ignore .env local/` で確認）
- [ ] 無料枠の現行条件を再確認（ADR-5 / ADR-10: Groq・Gemini・LINE 月200通・Resend）
- [x] Deno Deploy本番、マネージドKV、Web UI、認証・共有・Calendar・remote MCPの配線を実装
- [x] 本番read-only smoke（2026-07-26）: `GET /healthz` = 200 `ok`、未ログイン `GET /auth/me` = 401
- [x] デプロイ後: LINE webhook URL 設定（2026-07-26 完了: env 設定→再デプロイで 503→401、LINE
      console「検証」成功。プロバイダー plancel / channel 2010848177 / Bot @791wbdma）
- [ ] デプロイ後: LINE をユーザー毎に連携（マイページで連携コード発行 → トークに送信 →
      返信に自分のアカウント名が出る。未連携のトークには連携案内だけが返る）
- [ ] デプロイ後: LINE 実機でテキスト/画像登録と Quick Reply ワンタップ（Task 6.2 done-when —
      友だち追加してトークから送信。登録先は**送信者自身の**台帳＝Web UI
      に候補として出る。ROADMAP「LINE v2」#4）。2アカウント連携して、互いの予約が見えないことも確認
- [ ] デプロイ後: Resend ドメイン検証 → 実送信 1 通（Task 6.3 done-when）

## 2. ドキュメント整合チェック（既存ドキュメントの検証）

ドキュメントの「実装状態を主張する記述」と実体の照合表。**コード・テスト数・タスク状態を変えたら該当行を更新すること**。
2026-08-01 時点: 669（Groq主系＋条件付きGemini査読、意味的日時比較、採用出力の検証を追加）。
2026-07-31 時点: 653（キャンセル規定の境界表記まわりを追加。コーパスに「N日前から◯%」表記の実データ2件）。2026-07-28 時点: README・本ガイドのテスト数を621へ統一（予約の共有編集権限・施設の既定規定・
メール転送インテーク・文字サイズ3段階の追加分を含む。`specs/plancel/tasks.md` は本更新の対象外
なので別途確認すること）。コード実装済みと本番実機acceptance未完了を分けて記載。

| ドキュメント         | 照合する主張                                         | 実体（確認コマンド）                                                                      |
| -------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| README（両言語）冒頭 | テスト件数                                           | `deno task test` の passed 数                                                             |
| README「構成」表     | src/ ディレクトリ一覧と役割                          | `ls src/`（core/notify/mcp/parse/cron/line/cli/lib）                                      |
| README「ステータス」 | 実装済みレイヤーと残作業                             | `specs/plancel/tasks.md` の Progress 節                                                   |
| README 環境変数      | 変数名                                               | `grep -rn "Deno.env.get" src/ scripts/`                                                   |
| SDD §12 ADR 表       | 決定と実装の一致（ADR-5 モデル名 / ADR-10 チャネル） | `src/parse/{groq,gemini}.ts` の DEFAULT_MODEL、`src/line/` `src/notify/email-notifier.ts` |
| ROADMAP / tasks.md   | レイヤー進捗                                         | tasks.md Progress が唯一の進捗ソース（ROADMAP は構造のみ）                                |
| parsers.config.json  | 実チェーン宣言                                       | `{"text":["groq-llama","gemini-flash"],"image":["gemini-flash"]}`                         |
| fixtures/parse/      | 回帰コーパス件数                                     | `deno task replay` の N/N と README/tasks の記述                                          |

2026-07-21〜25 の大規模変更（ログイン一本化・カレンダー連携・容量設計・MCP remote）で追加した
照合ポイント:

| ドキュメント          | 照合する主張                             | 実体（確認コマンド）                                                                          |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| DEPLOY.md §3 env 表   | 認証・容量系の変数名                     | `src/deploy/main.ts` ヘッダコメント / `env.get(...)` 呼び出し                                 |
| DEPLOY.md §2 容量設計 | 開放50 / 設計70 / 警告100                | `src/web/auth/routes.ts` の `DESIGN_TOTAL_USERS` `ADMIN_WARN_USERS`、`PLANCEL_MAX_USERS` 既定 |
| DEPLOY.md §4 uid 規約 | 英小文字・6〜20・予約語                  | `src/web/users.ts` の `uidSchema` `MIN_PUBLIC_UID_LEN` `RESERVED_UIDS`                        |
| DEPLOY.md §5 同期方式 | キュー不使用（inline + dirty + cron）    | `src/web/calendar/sync.ts` ヘッダと `requestSync`/`sweepDirtySync`                            |
| DEPLOY.md §6 MCP      | remote 15 ツール（予約7 + 施設の既定規定4 + 共有4）と GUI 専用の例外 | `src/mcp/web_api_tools.ts` の `registerTool` 呼び出し（`confirm/cancel/restore_reservation` はループ登録で3本）、`src/mcp/main.ts` の mode 分岐 |
| DEPLOY.md PWA routes  | manifest / SW / icons の配信とキャッシュ | `src/web/pwa.ts`、`web/manifest.webmanifest`、`web/sw.js`                                     |

2026-07-27〜28 の変更（メール転送インテーク・予約の共有編集権限・施設の既定規定・LINEユーザー毎連携・
文字サイズ3段階）で追加した照合ポイント:

| ドキュメント                     | 照合する主張                                                   | 実体（確認コマンド）                                                                              |
| --------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| DEPLOY.md §3.1 メール転送インテーク | 宛先の秘密のみで本人判定（`from` 不信任）・Svix 署名検証・日次上限・添付は読まない | `src/web/email-intake.ts` ヘッダコメント、`MAIL_DAILY_CAP_DEFAULT`（`PLANCEL_MAIL_DAILY_CAP` 既定 50） |
| web/index.html 取り込みモーダルの転送導線 | 「📨 メールを転送する」はマイページと同じアドレスをその場に開き、**確認画面が無い** | `web/index.html` の `data-imp="forward"` クリックハンドラと `renderMailFeature`                       |
| DEPLOY.md §1 共有（招待・権限）  | editor は内容編集のみ・確定/キャンセル/削除/招待/権限変更はオーナー専用 | `src/web/tests/sharing_test.ts`、`src/web/api.ts` の `memberGate`                                     |
| DEPLOY.md §1 施設の既定規定       | 施設名の正規化キー・`unknown` は保存不可・台帳ごとに非公開            | `src/web/policy-template.ts` ヘッダコメント、`src/web/tests/policy_template_test.ts`                  |
| web/index.html 文字サイズ3段階    | 標準/大きめ/特大（`--fs` 1 / 1.15 / 1.28）・端末のブラウザにのみ保存 | `web/index.html` の `FS_LABEL`／`--fs` 定義（`localStorage` 保存、サーバ側の状態ではない）             |

## 3. 本番実機トラック（デプロイ後の done-when）

以下のトラックを本番 URL `https://plancel-app.torifo.deno.net` で再現する。コード実装・stubテストの
成功だけでは、この節のdone-whenを完了扱いにしない。

### 3.0 curl 本番スモーク（外部から到達確認）

```sh
BASE=https://plancel-app.torifo.deno.net
curl -s "$BASE/healthz"                                   # → ok
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/auth/me"  # → 401（未ログイン）
# 管理者トークンでの台帳直アクセス（PLANCEL_ADMIN_TOKEN を設定している場合）:
curl -s "$BASE/api/reservations" \
  -H "x-plancel-admin: $PLANCEL_ADMIN_TOKEN" \
  -H "x-plancel-token: <任意の台帳ID>"                    # → その台帳の予約 JSON
```

### 3.0.1 PWA実機: インストール → standalone起動 → 明示更新

1. Android Chromeで本番URLへログインし、マイページの「アプリをインストール」から追加する。
   iPhone/iPadは同ボタンの案内どおりSafariの共有メニュー→「ホーム画面に追加」を使う。
2. ホーム画面のplancelアイコンから、ブラウザUIなしのstandalone表示で起動できることを確認する。
3. マイページの「更新を確認」で「最新版です。」になることを確認する。
4. `web/sw.js` の `CACHE_VERSION` を上げた版をデプロイ後、再び「更新を確認」し、画面上部の更新バナーの
   「今すぐ更新」で再読み込みされ新しい版になることを確認する。

> ローカルChromiumではmanifest認識・Service Worker登録・手動更新確認まで検証済み。OSホーム画面への
> インストールとデプロイ差分の更新適用は、本番実機でのみ完了扱いにする。

### 3.1 トラック1: Google 実ログイン → カレンダー反映 → 削除同期

1. ブラウザで `$BASE/` を開き「Google でログイン」→ 同意（scope に「アプリが作成した
   カレンダー」が出ること）→ `/` に戻りログイン済みになる。
2. 予約を1件登録し**確定**する。Google カレンダーに専用「plancel」カレンダーが作られ、確定予約が
   即時に入ること（iCal のポーリングを待たない）。`LOCATION`
   を入れた予約は会場がカレンダー側に出る。
3. その予約を**削除**（または候補へ戻す）→ Google カレンダーからイベントが消えること。
4. 全員向けフィード `$BASE/calendar/<secret>.ics`（マイページに表示）を購読すると、確定予約のみが
   `Asia/Tokyo`・+1h で見えること。`POST /auth/ics/rotate` で URL を変えると旧 URL が無効化される。

> refresh token が切れると UI に「要再接続」（`googleError: "reauth"`）が出る。再接続で OAuth を
> やり直せば復旧する。

### 3.2 トラック2: メール+パスワード登録 → UID ログイン

1. `$BASE/` の登録フォームで email + パスワード（8文字以上）で `POST /auth/register`。作成直後は
   **メール未検証**（`emailVerified: false`）。
2. マイページで **uid**（英小文字・6〜20文字）を設定。予約語（`admin` 等）は一般アカウントでは
   403（`uid_reserved`）になること。
3. ログアウト → `POST /auth/login` に **uid**（email でなく）+ パスワードでログインできること。
4. 同一 email で Google ログインを試すと乗っ取り防止で `auth_error=email_taken` になり、自動合流
   しないこと。マイページから明示的に Google を「連携」すると検証済みへ昇格し合流する。

### 3.3 トラック3: MCP トークン → ツール操作

1. マイページのカレンダー連携画面でパーソナル API トークンを発行（`POST /auth/token`）。
2. env を設定して MCP を remote モードで起動:

```sh
PLANCEL_API_URL=https://plancel-app.torifo.deno.net \
PLANCEL_API_TOKEN=<発行トークン> \
deno run --allow-env --allow-net --unstable-temporal --unstable-kv src/mcp/main.ts
# 起動ログに mode: "web-api" が出る（env 無しなら "local-core"）
```

3. Claude Desktop からは `claude_desktop_config.json` に上記 env を書く（DEPLOY.md §6 の JSON 例）。
4. `create_reservation`（`confirmed: true`）→ `list_reservations` で本番台帳に入ること、確定分が
   トラック1のカレンダーにも流れることを確認。uid 確定・アカウント連携/マージ・LINE連携コード発行の
   各ツールは**存在しない**（GUI 専用）ことも確認。

### 3.4 トラック4: LINE実機 → 台帳

1. 許可済みownerアカウントでテキスト予約を送り、返信内容を確認してWeb UIに候補が追加されること。
2. 画像予約を送り、解析・競合解決Quick Reply後にWeb UIへ候補が追加されること。
3. `確認`で無料キャンセル期限・最大キャンセル料を含む一覧が返ること。
4. 確定/キャンセル済みQuick Replyで台帳とGoogle Calendarが同じ結果へ遷移すること。
5. 期限通知がownerにはLINE push、他ユーザーにはEmail/consoleで配送されること。

### 3.5 トラック5: Resend実送信

1. 送信元ドメインを検証し、`RESEND_API_KEY` / `PLANCEL_EMAIL_FROM` / `PLANCEL_EMAIL_TO`を設定。
2. EmailNotifierから実メールを1通送り、件名・本文・宛先を確認。
3. LINE未設定時のcron Emailフォールバックも必要に応じて確認。

### 3.6 継続運用確認

- Deployログで15分ごとの`tick end`が継続し、`failed:0`であること。
- Calendarの`gcal_dirty`が発生した場合、次回sweepで`gcal sweep repaired`になること。

### 3.7 未整備（次回ドキュメント更新の候補）

- `deno task verify`（1.1〜1.4 の一括実行タスク）は §1 に反映済み。

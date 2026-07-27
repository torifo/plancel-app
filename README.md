[**日本語**](./README.md) ・ [English](./README.en.md)

# plancel — 仮押さえ予約とキャンセル期限の管理台帳

<!-- tech-stack:start (auto-generated) -->
<p align="center">
  <img src="https://img.shields.io/badge/Deno-000000?style=for-the-badge&logo=deno&logoColor=white" alt="Deno">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
</p>
<!-- tech-stack:end -->

外食・宿・イベントの「**複数候補を仮押さえ → 直前に1つ確定 →
残りをキャンセル**」という運用で起きる、
キャンセル忘れと余計なキャンセル料を防ぐ台帳。**1件確定すると残りの候補が自動で「要キャンセル」になり**、
キャンセル料が上がる境界の**直前に損失額つきで通知**が届く。plan + cancel。

```sh
deno task seed        # デモデータ投入
deno task scenario    # E2E: 確定 → 3日進める → 通知列挙 を1コマンドで体験
deno task test        # 465 tests — 外部サービス接続ゼロで完結
deno task verify      # fmt + check + lint + test + replay を一括実行
```

## なぜ plancel（カレンダー / 予約アプリと何が違う）

確定済み予約の管理なら既存ツールで十分。plancel が埋めるのは、**候補が複数ある間**：

- 🔀 **排他的な候補グループ（Plan）** — 1件確定した瞬間、残りが自動で `to_cancel`
  に遷移。この自動遷移がコア動作。
- 💸 **段階的キャンセル料をデータで持つ** —
  「5日前まで無料→3日前まで30%→当日100%」のような**任意の段階**を配列で保持（プリセット固定ではない。境界は1時間単位・最大8段。モデルと期限/損失計算は
  `src/web/policy.ts`
  が単一ソースで、Web台帳・LINE要約・カレンダー説明・Web UIが同じ段階表を読む）。料率が上がる**境界の24時間前**に「今なら無料
  / 明日から ¥5,400 の損」と具体額で通知。
- 🗓 **規定の入力が1操作** — Web UI のキャンセル料は「不明 / いつでも無料 / 前日まで無料 /
  期限つき（日数で指定）」の4択。「期限つき」で無料期限を日数（5・10・14…）で打ち、必要なら「3日前まで30%」の段階を足すだけ。プリセットに一致する内容はプリセット名で保存するので既存データと互換。
- 🤷 **ポリシー不明でも登録できる** —
  インサート摩擦を最小化。不明分は日次ダイジェストで後追い入力を促す。
- 🔍 **なぜこの状態かを常に説明できる** — core台帳は追記型イベントログ + caused_by
  因果チェーンで物理削除なし。Web台帳は認証・共有・カレンダー連携向けの別モデル。

## 構成

coreとadapterを分離し、Web / LINE /
MCPから利用する。非決定性の源（**時刻・外部送信・LLM**）はすべて注入可能な抽象の背後に隔離し、コアはローカルで決定的にテストできる。

| ディレクトリ  | 役割                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/core/`   | Zod スキーマ（単一ソース）・Clock 抽象・Store 抽象（Deno KV / InMemory）・純粋関数の状態遷移・イベントログ畳み込み |
| `src/notify/` | 発火判定（純粋関数）＋ Outbox（冪等配送）＋ Notifier（Console / LINE / Email=Resend）                              |
| `src/mcp/`    | Claude 向け入口（stdio・11ツール＋フラグ付き debug ツール）。パース知能は持たない                                  |
| `src/parse/`  | バリデーション駆動フォールバックのパーサーチェーン（Groq / Gemini + Mock）・PII マスク・リプレイ回帰基盤           |
| `src/line/`   | LINE Bot webhook（署名検証・userId 許可リスト・Quick Reply ワンタップ差し戻し）＋ LINENotifier                     |
| `src/cron/`   | 15分毎の境界チェック（Deno Deploy `Deno.cron` / VPS systemd timer 両対応の薄い層）                                 |
| `src/web/`    | Web台帳・認証・共有・iCal / Google Calendar同期・Web API・PWAアセット配信                                          |
| `src/deploy/` | Web / LINE / cron を1つのDeno Deployプロジェクトへ配線する統合エントリポイント                                     |
| `web/`        | Web UI・PWA manifest・Service Worker・192/512pxアプリアイコン                                                      |

仕様: [`specs/`](./specs/) ・ 設計判断（ADR）: [`docs/SDD.md`](./docs/SDD.md) ・ ロードマップ:
[`ROADMAP.md`](./ROADMAP.md)

## スタック

- **ランタイム**: Deno 2.9（TypeScript・`unstable-temporal` / `unstable-kv`）
- **検証**: Zod（全エンティティ単一ソース、MCP 入力・パーサー出力・Store 境界を同一スキーマで検証）
- **ストア**: Deno KV（追記型イベントログ + 導出キャッシュ。Store 抽象で SQLite に差し替え可）
- **入口**: Claude MCP（`@modelcontextprotocol/sdk`）＋ LINE Bot webhook（2026-07-26
  本番開通・署名検証まで実機確認済み）
- **テスト**: `deno test` 458件 + 契約テスト（Store 2実装共通）+ E2E シナリオ + パース回帰リプレイ

## 使い方（Claude MCP）

```sh
claude mcp add plancel -- deno run --allow-env --allow-read --allow-write --unstable-temporal --unstable-kv /path/to/plancel/src/mcp/main.ts
```

あとは会話で「7/12 19時に◯◯を仮予約、前日まで無料」「◯◯に決めた」と伝えるだけ。

## ステータス

**MVP-1（L0〜L3）＋パーサー基盤（L4）＋ L5（実 LLM / LINE / Email）を実装済み。Deno Deploy では Web
UI・認証・共有・Google Calendar・remote MCP用Web API・LINE webhook のコードが稼働中**です。Web
UIはPWA対応済みで、マイページから明示的にインストールでき、更新確認・新バージョン適用も画面から行えます。LINE
は、コア台帳と Web 台帳の期限通知、Web台帳の「確認」（`確認`/`予定`/`一覧`）・「限定更新」（Quick
Replyで確定／キャンセル済み）・「追加」（テキスト/画像の解析結果を候補登録）まで実装済みです。Web台帳の操作はWeb
APIと同じ関数を通るため、同一Plan候補の原子的な確定・自動`to_cancel`とカレンダー同期も同じ挙動になります。不正な再確定は拒否します。コア台帳（イベントソース）はstandalone/ローカル（`src/line/main.ts`単体・MCP
local）モードで引き続き使用します。

本番で確認済みなのはLINE環境変数の反映、署名なしwebhookの401応答、LINE
ConsoleのWebhook検証成功までです。LINE実機のテキスト/画像登録・Quick
Reply、Resend実送信、Googleログインからのカレンダー同期、UIDログイン、remote MCP操作、cron継続稼働は
PWAの本番端末インストール／更新確認とあわせて [`docs/VERIFICATION.md`](./docs/VERIFICATION.md)
のdone-whenとして未完了です。

外部接続の環境変数: `GROQ_API_KEY` / `GEMINI_API_KEY`（パーサー）、`LINE_CHANNEL_SECRET` /
`LINE_CHANNEL_ACCESS_TOKEN` /
`LINE_ALLOWED_USER_IDS`（`deno task line`）、`RESEND_API_KEY`（EmailNotifier、送信元/宛先はコンストラクタ注入）。

フェーズ1は本人＋身内数名・**予算0円**（無料枠のみ）。公開・マネタイズはフェーズ2以降。

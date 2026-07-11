[**日本語**](./README.md) ・ [English](./README.en.md)

# plancel — 仮押さえ予約とキャンセル期限の管理台帳

<!-- tech-stack:start (auto-generated) -->
<p align="center">
  <img src="https://img.shields.io/badge/Deno-000000?style=for-the-badge&logo=deno&logoColor=white" alt="Deno">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
</p>
<!-- tech-stack:end -->

外食・宿・イベントの「**複数候補を仮押さえ → 直前に1つ確定 → 残りをキャンセル**」という運用で起きる、
キャンセル忘れと余計なキャンセル料を防ぐ台帳。**1件確定すると残りの候補が自動で「要キャンセル」になり**、
キャンセル料が上がる境界の**直前に損失額つきで通知**が届く。plan + cancel。

```sh
deno task seed        # デモデータ投入
deno task scenario    # E2E: 確定 → 3日進める → 通知列挙 を1コマンドで体験
deno task test        # 303 tests — 外部サービス接続ゼロで完結
deno task verify      # check + lint + test + replay を一括実行
```

## なぜ plancel（カレンダー / 予約アプリと何が違う）

確定済み予約の管理なら既存ツールで十分。plancel が埋めるのは、**候補が複数ある間**：

- 🔀 **排他的な候補グループ（Plan）** — 1件確定した瞬間、残りが自動で `to_cancel` に遷移。この自動遷移がコア動作。
- 💸 **段階的キャンセル料をデータで持つ** — 「7日前まで無料→30%→50%→100%」を配列で保持し、料率が上がる**境界の24時間前**に「今なら無料 / 明日から ¥5,400 の損」と具体額で通知。
- 🤷 **ポリシー不明でも登録できる** — インサート摩擦を最小化。不明分は日次ダイジェストで後追い入力を促す。
- 🔍 **なぜこの状態かを常に説明できる** — 追記型イベントログ + caused_by 因果チェーン。物理削除なし。

## 構成

三層分離（core / adapter / MCP）。非決定性の源（**時刻・外部送信・LLM**）はすべて注入可能な抽象の背後に隔離し、コアはローカルで決定的にテストできる。

| ディレクトリ | 役割 |
|---|---|
| `src/core/` | Zod スキーマ（単一ソース）・Clock 抽象・Store 抽象（Deno KV / InMemory）・純粋関数の状態遷移・イベントログ畳み込み |
| `src/notify/` | 発火判定（純粋関数）＋ Outbox（冪等配送）＋ Notifier（Console / LINE / Email=Resend） |
| `src/mcp/` | Claude 向け入口（stdio・11ツール＋フラグ付き debug ツール）。パース知能は持たない |
| `src/parse/` | バリデーション駆動フォールバックのパーサーチェーン（Groq / Gemini + Mock）・PII マスク・リプレイ回帰基盤 |
| `src/line/` | LINE Bot webhook（署名検証・userId 許可リスト・Quick Reply ワンタップ差し戻し）＋ LINENotifier |
| `src/cron/` | 15分毎の境界チェック（Deno Deploy `Deno.cron` / VPS systemd timer 両対応の薄い層) |

仕様: [`specs/`](./specs/) ・ 設計判断（ADR）: [`docs/SDD.md`](./docs/SDD.md) ・ ロードマップ: [`ROADMAP.md`](./ROADMAP.md)

## スタック

- **ランタイム**: Deno 2.9（TypeScript・`unstable-temporal` / `unstable-kv`）
- **検証**: Zod（全エンティティ単一ソース、MCP 入力・パーサー出力・Store 境界を同一スキーマで検証）
- **ストア**: Deno KV（追記型イベントログ + 導出キャッシュ。Store 抽象で SQLite に差し替え可）
- **入口**: Claude MCP（`@modelcontextprotocol/sdk`）＋ LINE Bot webhook（実機確認はデプロイ後）
- **テスト**: `deno test` 303件 + 契約テスト（Store 2実装共通）+ E2E シナリオ + パース回帰リプレイ

## 使い方（Claude MCP）

```sh
claude mcp add plancel -- deno run --allow-env --allow-read --allow-write --unstable-temporal --unstable-kv /path/to/plancel/src/mcp/main.ts
```

あとは会話で「7/12 19時に◯◯を仮予約、前日まで無料」「◯◯に決めた」と伝えるだけ。

## ステータス

**MVP-1（L0〜L3）＋パーサー基盤（L4）＋ L5 コード（実 LLM / LINE / Email）実装済み**・外部接続ゼロで動作検証可能。デプロイ先は Deno Deploy（VPS 退避可）。
残り: デプロイ（初手は ADR-2 の KV リモート接続スパイク）+ LINE/メールの実機確認、天気（台風）連携。実チェーン切替・実データ回帰は完了済み（replay 9/9）。ローカル検証手順は [`docs/VERIFICATION.md`](./docs/VERIFICATION.md)。

外部接続の環境変数: `GROQ_API_KEY` / `GEMINI_API_KEY`（パーサー）、`LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_ALLOWED_USER_IDS`（`deno task line`）、`RESEND_API_KEY`（EmailNotifier、送信元/宛先はコンストラクタ注入）。

フェーズ1は本人＋身内数名・**予算0円**（無料枠のみ）。公開・マネタイズはフェーズ2以降。

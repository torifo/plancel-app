# plancel

仮押さえ予約とキャンセル期限の管理台帳。**1件確定すると残りの候補が自動で「要キャンセル」になり、キャンセル料が上がる境界の直前に通知**が届きます。

> plan + cancel。外食・宿・イベントの「複数候補を仮押さえ → 直前に1つ確定 → 残りをキャンセル」という運用で起きる、キャンセル忘れと余計なキャンセル料を防ぎます。

## コア動作

```
candidate ──(確定)──→ confirmed ──(完了)──→ done
    │                     │
    │←──(同プラン内で他が確定 = 自動遷移)
    ▼                     ▼
to_cancel ──(報告)──→ cancelled
```

- **Plan（排他的候補グループ）**: `confirmed` が確定枠数に達した瞬間、残り候補を全て `to_cancel` へ自動遷移
- **通知**: 料率境界の24時間前（損失額つき）/ 確定時の即時通知 / ポリシー不明の日次ダイジェスト / 当日朝リマインド
- **キャンセルポリシー**: 段階的料率（7日前まで無料→30%→…）を配列で保持。不明のままでも登録可

## アーキテクチャ

三層分離（core / adapter / MCP）+ 追記型イベントログ。非決定性の源（時刻・外部送信・LLM）はすべて注入可能な抽象の背後に隔離し、コアはローカルで決定的にテストできます。

| レイヤー | 内容 |
|---|---|
| core | Zod スキーマ（単一ソース）/ Clock 抽象 / Store 抽象（Deno KV・InMemory）/ 純粋関数の状態遷移 / イベントログ畳み込み・caused_by 因果チェーン |
| notify | 発火判定（純粋関数）+ Outbox（冪等配送）+ Notifier（Console → LINE → Email 予定） |
| mcp | Claude 向け入口。11ツール + フラグ付き debug ツール（stdio、パース知能は持たない） |
| parse | バリデーション駆動フォールバックのパーサーチェーン + PII マスク + リプレイ回帰基盤（実 LLM 接続は今後） |
| cron | 15分毎の境界チェック（Deno Deploy `Deno.cron` / VPS systemd timer 両対応の薄い層） |

## 開発

```bash
deno task test        # 全テスト（外部接続ゼロで完結）
deno task check       # 型チェック + no-direct-Date ガード
deno task seed        # デモデータ投入（--dry-run / --force / --db <path>）
deno task scenario    # E2E: seed → 確定 → 3日進める → 通知列挙 を1コマンドで
deno task replay      # パース回帰（fixtures/parse/ を現行ロジックで再実行）
deno task cron:once   # cron tick を1回実行
```

MCP サーバーの登録:

```bash
claude mcp add plancel -- deno run --allow-env --allow-read --allow-write --unstable-temporal --unstable-kv /path/to/plancel/src/mcp/main.ts
```

## ステータス

- **MVP-1（L0〜L3）+ パーサー基盤（L4）実装済み**: 267 tests green・外部サービス接続ゼロで動作
- 今後: 実 LLM パーサー（Groq/Gemini）→ LINE Bot 入口 → Email 通知 → 天気（台風）連携。詳細は [ROADMAP.md](ROADMAP.md)
- 設計判断は [docs/SDD.md](docs/SDD.md) の ADR 表に記録（デプロイ先: Deno Deploy 確定・VPS 退避可）

## スコープ

フェーズ1は本人 + 身内数名・予算0円（無料枠のみ）で運用。公開・マネタイズはフェーズ2以降。

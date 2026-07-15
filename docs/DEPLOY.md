# plancel デプロイ手順（Deno Deploy）

> 最終更新: 2026-07-15。方式・env・エントリポイントは実装（`src/deploy/main.ts`）に対応。
> 前提の合否は先に [`docs/VERIFICATION.md`](./VERIFICATION.md) の §1（`deno task verify`
> ほか）を通すこと。

## 0. opulse との共通判断（2026-07-15 決定）

plancel と opulse はどちらも Deno Deploy を使うが、**org は分離する**。

- **org 分離**: 無料枠は organization 合算（月100万req / 帯域100GB / KV 1GiB）で、超過すると同 org
  の全アプリが停止する（ADR-2）。opulse は公開 Web でトラフィック不定、plancel は身内公開の
  cron/webhook。相互停止を避けるため別 org にする。
- **方式は共通**: どちらも「console.deno.com の GitHub 連携デプロイ + マネージド KV」。deployctl
  は使わない（opulse の調査ノートの推奨に揃える）。
- **リポジトリ**: plancel = `torifo/plancel-app`（連携可能）。opulse は GitHub remote
  未設定のため、先に repo 作成＆push が必要（opulse 側の作業）。

この手順書は plancel 側のみを扱う。opulse は Fresh プリセット（ビルド自動 `deno task build` →
`_fresh/server.js`）で別途。

## 1. 方式とエントリポイント

- **方式**: console.deno.com の GitHub 連携（main への push
  で自動デプロイ）。ビルドステップなし（素の Deno）。
- **エントリポイント**: `src/deploy/main.ts`（統合版）。1 デプロイで下記の両方を動かす:
  - `Deno.serve` — LINE webhook（`POST /webhook`）+ ヘルスチェック（`GET /healthz`）
  - `Deno.cron` — 15分毎の境界チェック（`plancel-boundary-check`）
- cron と webhook は起動時に開く 1 つのマネージド KV（`KvStore.open()` = 引数なし）を共有する。
- 通知チャネルは env から自動選択（`selectNotifier`）: **LINE push（owner宛）> Email（Resend）>
  Console**。

## 2. デプロイ手順（console.deno.com、ダッシュボード操作）

1. **org 作成**: opulse と別の org を作る（例: `plancel`）。
2. **プロジェクト作成 + GitHub 連携**: `torifo/plancel-app` をリンク、Production branch = `main`。
3. **エントリポイント指定**: `src/deploy/main.ts`。ビルドコマンドは空（不要）。
4. **KV データベース作成 + リンク**: プロジェクトに KV を作成してリンクする（新 Deploy
   は自動アタッチしない）。以後、コードの `Deno.openKv()` が自動接続する。
5. **環境変数（Environment Variables）を設定**: §3 の表のとおり。TOKEN/SECRET/KEY を含む名前は自動で
   secret 扱い。
6. **デプロイ**: main に push（または「Deploy」実行）。`GET https://<project>.deno.dev/healthz` が
   `ok` を返すことを確認。
7. **LINE webhook URL 設定**: LINE Developers コンソールで Messaging API の Webhook URL を
   `https://<project>.deno.dev/webhook` にし、検証（Verify）を通す。

## 3. 環境変数

| 変数                                                         | 必須 | 用途                                                  |
| ------------------------------------------------------------ | ---- | ----------------------------------------------------- |
| `GROQ_API_KEY`                                               | ◯    | テキスト一次パーサー（Groq）                          |
| `GEMINI_API_KEY`                                             | ◯    | 二次パーサー + 画像（Gemini）                         |
| `LINE_CHANNEL_SECRET`                                        | ◯    | webhook 署名検証                                      |
| `LINE_CHANNEL_ACCESS_TOKEN`                                  | ◯    | 返信・push・画像取得                                  |
| `LINE_ALLOWED_USER_IDS`                                      | ◯    | 許可 userId（カンマ区切り。身内数名）                 |
| `PLANCEL_OWNER_USER_ID`                                      | 任意 | cron 通知の push 先。省略時は許可リストの先頭         |
| `RESEND_API_KEY` / `PLANCEL_EMAIL_FROM` / `PLANCEL_EMAIL_TO` | 任意 | LINE 未設定時の Email フォールバック（3つ揃うと有効） |

通知チャネルの選択: LINE のトークンと push 先が揃えば **LINE**、無くて Resend 3点が揃えば
**Email**、どちらも無ければ **Console**（ログのみ・落ちない安全側）。

## 4. ADR-2 スパイク（任意・ローカル MCP → Deploy KV リモート接続）

ローカルの MCP（`deno task` 系や Claude MCP）から、Deploy が読む KV と同じ DB
に書きたい場合のみ必要。コードは `KvStore.open(path)` が対応済み:

```sh
export DENO_KV_ACCESS_TOKEN=<Deno Deploy の access token>
# path に KV Connect URL を渡す（例）:
#   https://api.deno.com/databases/<database-id>/connect
```

`KvStore.open("https://api.deno.com/databases/<id>/connect")`
で接続確認する。不可なら「書き込み用の薄い HTTP 層を Deploy 側に追加」か「VPS + SQLite
退避」に切り替える（ADR-2）。**この実測がデプロイの初手。**

## 5. デプロイ後の実機確認（done-when）

- **Task 6.2（LINE）**: 実機からテキスト/画像を送信 → 登録サマリ返信、FieldConflict の Quick Reply
  ワンタップ解決が動くこと。
- **Task 6.3（Email）**: Resend の送信元ドメイン検証後、`RESEND_API_KEY` 等を設定して通知 1
  通が実際に届くこと（LINE 併用時は Email はフォールバック）。
- cron は Deploy のログで 15分毎の `tick end`（`failed:0`）を確認。

## 6. ロールバック / 退避

- Deploy の無料枠が厳しくなったら VPS + SQLite に退避（Store 抽象で経路確保済み。cron は
  `vps_main.ts` = systemd timer run-once）。
- KV は追記型イベントログが真実の源。導出値が壊れても再構築可能（`verify-projection`）。

# plancel デプロイ手順（Deno Deploy）

> 最終更新: 2026-07-25。方式・env・エントリポイントは実装（`src/deploy/main.ts` の
> ヘッダコメントが正）に対応。前提の合否は先に [`docs/VERIFICATION.md`](./VERIFICATION.md)
> の §1（`deno task verify` ほか）を通すこと。

## 0. org 構成（2026-07-21 再編）

plancel と opulse（現 opulse-monitor）は **1 つの org に軽量2アプリ同居**する。

- **org は2つ**: `torifo`（表示名 `torifo-org`、`plancel-app` + `opulse-monitor` が同居）と
  `techub`（空・今後の新規用）。
- **旧方式（廃止）**: 当初は「無料枠の道連れ停止を避けるため org を分離する」方針だった（旧
  ADR-2）。個人利用では無料枠の相互停止リスクが小さいと判断し、**org 分離はやめた**。旧
  opulse org のアプリは削除済み（旧 URL `opulse-monitor.opulse.deno.net` は 404）、その org を
  slug `techub` にリネームして転用した。
- **方式は共通**: どちらも「console.deno.com の GitHub 連携デプロイ + マネージド KV」。deployctl
  は使わない。
- **リポジトリ**: plancel = `torifo/plancel-app`（main への push で自動デプロイ）。

### 無料枠（org 合算・超過で org 内の全アプリ停止）

無料枠は organization 単位の合算で、超過すると同 org の**全アプリが停止**する。`plancel-app` と
`opulse-monitor` は枠を共有するので、片方の使いすぎがもう片方を止める点に注意。

| 資源 | 無料枠（org 合算） |
| --- | --- |
| リクエスト | 月 100 万 req |
| CPU 時間 | 15 時間 |
| 帯域 | 100 GB |
| KV ストレージ | 1 GiB |

この枠が §2 の容量設計（開放50 + 保証リスト）の根拠になっている。

## 1. 方式とエントリポイント

- **方式**: console.deno.com の GitHub 連携（`main` への push で自動デプロイ）。ビルドステップ
  なし（素の Deno、Install/Build コマンドは空）。
- **本番 URL**: https://plancel-app.torifo.deno.net
  （org slug を 2026-07-21 に `plancel` → `torifo` へリネーム済み。旧 URL
  `plancel-app.plancel.deno.net` は 404。Google OAuth の承認済みリダイレクト URI もオーナーが
  新 URL に更新済み。）
- **エントリポイント**: `src/deploy/main.ts`（統合版）。1 デプロイで全サーフェスを動かす:
  - `Deno.serve` — 下記のルーティング
  - `Deno.cron` — 15分毎の境界チェック（`plancel-boundary-check`）＋カレンダー同期の dirty スイープ
- `Deno.serve` のルート:
  | パス | 用途 |
  | --- | --- |
  | `GET /`, `GET /index.html` | Web UI（`web/index.html`、MVP の主サーフェス） |
  | `/auth/*` | ログイン・マイページ・API トークン・カレンダー連携（§4） |
  | `GET /calendar/<secret>.ics` | 全員向け iCal 購読フィード（§5） |
  | `POST /api/parse` | 貼り付けメール／画像の取り込み（**ログイン必須**・401 で拒否） |
  | `/api/reservations…` | 予約 CRUD（ログインまたは API トークン必須） |
  | `GET /healthz` | ヘルスチェック（`ok`） |
  | `POST /webhook` | LINE webhook（LINE env 未設定時は 503） |
- cron・webhook・Web は起動時に開く 1 つのマネージド KV（`KvStore.open()` = 引数なし）を共有する。
- cron の通知チャネルは env から自動選択（`selectNotifier`）: **LINE push（owner宛）> Email（Resend）
  > Console**。

## 2. アカウント容量設計（オーナー 2026-07-23）

Google ログインは誰でも通せる設計なので、**アプリ側でアカウント総数を制限**する。

- **開放枠 50**（`PLANCEL_MAX_USERS`、既定 50）: 一般の新規サインアップ上限。既存ユーザーは常に
  ログイン可、上限で拒否されるのは**新規アカウント作成だけ**。`0` で無制限。
- **保証リスト**（`PLANCEL_ALLOWED_EMAILS`、カンマ区切り）: 開放枠が埋まっていても必ず作成できる
  アドレス。身近な知り合い（~20 想定）を確実に入れるための保険で、開放枠と**並行**に効く。
- **設計総数 70** = 開放50 + 保証~20。無料枠の実測は ~100 ユーザーまで耐える見込みで、50 は
  リクエストクォータの半分を余裕として残す意図（org を opulse と共有するため）。
- **超過時の挙動**:
  - 70 超の新規作成: 開発者向けに `log.warn`（"user count above design capacity"）を残すだけ。
    サインアップは止めない。
  - 100 到達: 管理者（`PLANCEL_ADMIN_EMAILS`）の `GET /auth/me` に `capacityWarning: true` が付き、
    UI が赤いバナーを出す（プールを見直す合図）。

## 3. 環境変数

TOKEN/SECRET/KEY を含む名前は Deploy が自動で secret 扱いにする。

### 認証・カレンダー・容量（ログイン一本化 2026-07-21〜23）

| 変数 | 必須 | 用途 |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 実質必須 | Google OAuth（ログイン + カレンダー連携）。両方揃わないと `/auth/google` は 503 |
| `PLANCEL_KEK` | 強く推奨 | Google refresh token を封緘する base64 32byte 鍵。**未設定だと平文保存**（`plain:` プレフィクス、起動ログで警告） |
| `PLANCEL_BASE_URL` | 任意 | OAuth リダイレクト・マジックリンクの origin を固定。省略時はリクエストの origin |
| `PLANCEL_MAX_USERS` | 任意 | 開放サインアップ上限（既定 50、`0` で無制限） |
| `PLANCEL_ALLOWED_EMAILS` | 任意 | 定員を無視して作成できる保証アドレス（カンマ区切り） |
| `PLANCEL_ADMIN_EMAILS` | 任意 | 管理者アドレス。`/auth/me` に userCount と 100人警告が付く。予約語 uid を取れるのもこのアカウントのみ |
| `PLANCEL_LINE_OWNER_EMAIL` | 任意 | Web台帳の期限リマインドを LINE push で受ける web アカウントの email。省略時は `PLANCEL_ADMIN_EMAILS` の先頭 |
| `PLANCEL_DEV_USER` | ローカルのみ | OAuth を踏まず、全リクエストをこの email のユーザーとして扱う（本番では設定しない） |
| `PLANCEL_ADMIN_TOKEN` | 任意 | 本番スモーク用。`x-plancel-admin` ヘッダと一致すれば `x-plancel-token` を台帳として直接使える |
| `RESEND_API_KEY` / `PLANCEL_EMAIL_FROM` | 任意 | **メールログイン（マジックリンク）**の前提。両方揃うと `/auth/email` が有効化。未設定ならマジックリンクは休眠（コードは残るが送信されない） |

### 取り込み・通知・LINE（既存）

| 変数 | 必須 | 用途 |
| --- | --- | --- |
| `GROQ_API_KEY` | ◯ | テキスト一次パーサー（Groq） |
| `GEMINI_API_KEY` | ◯ | 二次パーサー + 画像（Gemini） |
| `LINE_CHANNEL_SECRET` | 任意 | webhook 署名検証（未設定なら webhook は 503）。**設定済み（2026-07-26 開通）** |
| `LINE_CHANNEL_ACCESS_TOKEN` | 任意 | 返信・push・画像取得。長期トークン（Messaging API タブで発行）。**設定済み** |
| `LINE_ALLOWED_USER_IDS` | 任意 | 許可 userId（カンマ区切り）。オーナーの userId はチャネル基本設定タブ最下部「あなたのユーザーID」。**設定済み** |
| `PLANCEL_OWNER_USER_ID` | 任意 | cron 通知の push 先。省略時は許可リストの先頭 |
| `PLANCEL_EMAIL_TO` | 任意 | LINE 未設定時の Email 通知先（`RESEND_API_KEY` + `PLANCEL_EMAIL_FROM` と合わせて cron 通知の Email フォールバック） |

> `RESEND_API_KEY` + `PLANCEL_EMAIL_FROM` はマジックリンク送信と cron の Email 通知を兼ねる。
> `PLANCEL_EMAIL_TO` が加わると cron 通知の宛先になる。

## 4. 認証（ログイン一本化）

ログインが唯一の入口。**旧方式（ブラウザローカルの匿名トークンが現行）は廃止**。旧トークン台帳は
ログイン後 `POST /auth/adopt` で自分の ledgerId として一度だけ引き継げる（自分の台帳が空のときのみ）。

- **Google OAuth**: `/auth/google` → state + PKCE 保存 → 同意画面（scope
  `openid email https://www.googleapis.com/auth/calendar.app.created`、
  `access_type=offline&prompt=consent`）→ `/auth/callback` で code 交換 → sub/email でユーザー
  解決 → refresh token 封緘保存 → セッション Cookie（httpOnly、90日）。
- **メール + パスワード**: `POST /auth/register`（email + パスワード、PBKDF2 ハッシュ）。この経路で
  作ったアカウントは**メール未検証**（`emailVerified: false`）。`POST /auth/login` は
  **email または uid** とパスワードで認証（失敗は 15分で10回まで）。
- **マジックリンク（休眠）**: `POST /auth/email` は 15分トークンを Resend で送る設計だが、Resend
  未設定のため現状は休眠（503）。コードは残置。
- **未検証アカウントは Google と自動合流しない**: 同一アドレスの未検証パスワードアカウントがある
  状態で Google ログインすると、乗っ取り防止のため自動マージせず `auth_error=email_taken` を返す。
  合流は GUI から明示的に Google を「連携」した場合のみ（`?link=1`）で、リンク成功時に検証済みへ昇格。
- **マイページ**:
  - **表示名**（`displayName`、重複可）
  - **uid**（`POST /auth/profile`）: 任意・**英小文字のみ**・一般は **6〜20文字**。予約語
    （`admin` / `torifo` / `plancel` ほか、`src/web/users.ts` の `RESERVED_UIDS` が正）は
    **管理者アカウントのみ**取得可（予約語に限り6文字未満も可）。開発者は自分のマイページから
    `admin` / `torifo` を取る想定。
  - **追加ログインメール**（`altEmail`、例 iCloud）
  - **パスワード設定/変更**（`POST /auth/password`）: Google アカウントにパスワードログインを足せる。
  - **パーソナル API トークン**（`POST/DELETE /auth/token`、§6 MCP 用）。

## 5. カレンダー連携（2層・キューなし）

同期対象は**確定予約の本体のみ**。confirm / 確定済み編集 / cancel / delete をカレンダーへ反映する。

- **全員向け iCal 購読フィード**: `GET /calendar/<secret>.ics`。confirmed のみ、`TZID=Asia/Tokyo`、
  終了時刻はモデルに無いので一律 +1h、`LOCATION` 対応（会場を渡すとカレンダー側でマップ表示）。
  Google/iCloud/TimeTree いずれも購読可。秘密 URL は `POST /auth/ics/rotate` でローテートできる。
- **Google 連携ユーザー向け**: `calendar.app.created` スコープで専用「plancel」カレンダーを自動作成し、
  Calendar API で**即時プッシュ**（iCal のポーリング遅延を埋める）。
- **同期はユーザー操作を絶対に失敗させない**（reconcile 型）: 予約の現在状態から「確定→upsert /
  それ以外・削除→イベント削除」を決めるので、再実行・順序前後が無害。
- **⚠ キュー禁止（2026-07-25）**: **Deploy 本番の KV Connect は `kv.enqueue`/`listenQueue`
  非対応**（ローカル KV は対応するためテストをすり抜ける。起動ログに "KV Connect does not support
  queues"）。カレンダー同期はキューを使わず、**書き込み時インライン同期 + `gcal_dirty` フラグ +
  15分 cron スイープ**で再試行する。`invalid_grant`（refresh token 失効・取り消し）は恒久エラーと
  してユーザーを `reauth`（UI: 要再接続）に落とし再試行しない。**今後もキュー前提の設計は本番で
  動かないので禁止。**

> 補足: アプリは**本番公開済み**なので、テスト中アプリにあった「refresh token が7日で失効」の
> 制約は無い（旧設計の記述）。

## 6. MCP 連携（remote モード）

Claude Desktop 等から本番 Web 台帳を直接操作できる。

- **remote モード**: env `PLANCEL_API_URL` + `PLANCEL_API_TOKEN` が揃うと、`src/mcp/main.ts` は
  ローカル core ストアではなく本番 `/api/reservations` を叩く 7 ツールを serve する
  （list / create / confirm / cancel / restore / update / delete）。トークンはマイページの
  カレンダー連携画面で発行するパーソナル API トークン（`x-plancel-token`）。Claude で作った予約が
  家族の見る台帳に入り、確定はカレンダーにも流れる。
- **local core モード**: env 無しなら従来どおりローカル KV の core ストアを操作する。
- **原則**: 「GUI でできることは MCP でもできる」を目指す。ただし**uid 確定とアカウント連携/マージは
  GUI 専用**（アイデンティティ確定は人手のみ）で MCP には出さない。

Claude Desktop の設定例（`claude_desktop_config.json`）:

```json
{
  "mcpServers": {
    "plancel": {
      "command": "deno",
      "args": [
        "run", "--allow-env", "--allow-net",
        "--unstable-temporal", "--unstable-kv",
        "/absolute/path/to/plancel/src/mcp/main.ts"
      ],
      "env": {
        "PLANCEL_API_URL": "https://plancel-app.torifo.deno.net",
        "PLANCEL_API_TOKEN": "<マイページで発行したトークン>"
      }
    }
  }
}
```

## 7. デプロイ手順（console.deno.com、ダッシュボード操作）

1. **org**: `torifo` org を使う（新規なら作成）。
2. **プロジェクト作成 + GitHub 連携**: `torifo/plancel-app` をリンク、Production branch = `main`。
3. **エントリポイント指定**: `src/deploy/main.ts`。Install/Build コマンドは空。
4. **KV データベース作成 + リンク**: プロジェクトに KV（`torifo-kv`）を作成/リンクする。
   **新 Deploy は KV を自動アタッチしない** — 未リンクだと起動時に `Deno.openKv()` が落ちて
   healthz も返らない。無料プランは org あたり KV インスタンス1つのため `plancel-app` と
   `opulse-monitor` が同一インスタンスに相乗りするが、インスタンス内で app 毎に隔離 DB が切られ
   データは分離される（ストレージ/読み書きクォータは 2 アプリ合算）。
5. **環境変数を設定**: §3 の表のとおり。少なくとも `GROQ_API_KEY` / `GEMINI_API_KEY` /
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `PLANCEL_KEK`、必要に応じ容量・管理者・LINE 系。
6. **デプロイ**: `main` に push（または「Deploy」実行）。`GET .../healthz` が `ok` を返すことを確認。
7. **LINE webhook URL 設定**（LINE を使う場合）: Messaging API の Webhook URL を
   `https://plancel-app.torifo.deno.net/webhook` にし、「Webhookの利用」をオン、検証を通す。
   **2026-07-26 設定・検証成功済み**（チャネル: プロバイダー plancel / channel 2010848177 / Bot @791wbdma）。
   注意: Deploy の env 変更は **再デプロイ（Deploy Default Branch）まで反映されない**。
   curl での素の POST /webhook は 401（署名なし）が正常。未設定サインは 503。
   現状の LINE 通知はコア台帳の cron 通知のみで、Web 台帳の期限通知（src/web/notify.ts）は
   Email/console のまま — LINE 化は ROADMAP「LINE v2」#1。

## 8. オーナー側の外部作業（一度きり）

1. Google Cloud Console「データアクセス」でスコープ `calendar.app.created` を追加。
2. OAuth 承認済みリダイレクト URI に `https://plancel-app.torifo.deno.net/auth/callback` を登録。
   **アプリは本番公開済み**（テストユーザー限定・7日失効の段階は終了）。
3.（メールログインを使うなら）Resend ドメイン検証 + `RESEND_API_KEY` / `PLANCEL_EMAIL_FROM`。
4. `PLANCEL_KEK`（base64 32byte）/ `PLANCEL_ADMIN_TOKEN` / `PLANCEL_ADMIN_EMAILS` を Deploy env に設定。

## 9. デプロイ後の実機確認（done-when）

再現手順の詳細は [`docs/VERIFICATION.md`](./VERIFICATION.md) §3（3トラック）を参照。

- **認証**: Google 実ログイン → 専用「plancel」カレンダーへ確定予約が即時反映 → 削除で同期消去。
- **メール+パスワード**: 登録 → uid 設定 → uid でログイン。
- **MCP**: マイページで API トークン発行 → env 設定 → Claude から予約操作が本番台帳に入る。
- **cron**: Deploy のログで 15分毎の `tick end`（`failed:0`）と、必要時 `gcal sweep repaired` を確認。

## 10. ロールバック / 退避

- Deploy の無料枠が厳しくなったら VPS + SQLite に退避（Store 抽象で経路確保済み。cron は
  `vps_main.ts` = systemd timer run-once）。
- KV は追記型イベントログが真実の源。導出値が壊れても再構築可能（`verify-projection`）。
</content>
</invoke>

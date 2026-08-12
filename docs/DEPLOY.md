# plancel デプロイ手順（Deno Deploy）

> 最終更新: 2026-07-28。方式・env・エントリポイントは実装（`src/deploy/main.ts` の
> ヘッダコメントが正）に対応。前提の合否は先に [`docs/VERIFICATION.md`](./VERIFICATION.md) の
> §1（`deno task verify` ほか）を通すこと。

## 0. org 構成（2026-07-21 再編）

plancel と opulse（現 opulse-monitor）は **1 つの org に軽量2アプリ同居**する。

- **org は2つ**: `torifo`（表示名 `torifo-org`、`plancel-app` + `opulse-monitor` が同居）と
  `techub`（空・今後の新規用）。
- **旧方式（廃止）**: 当初は「無料枠の道連れ停止を避けるため org を分離する」方針だった（旧
  ADR-2）。個人利用では無料枠の相互停止リスクが小さいと判断し、**org 分離はやめた**。旧 opulse org
  のアプリは削除済み（旧 URL `opulse-monitor.opulse.deno.net` は 404）、その org を slug `techub`
  にリネームして転用した。
- **方式は共通**: どちらも「console.deno.com の GitHub 連携デプロイ + マネージド KV」。deployctl
  は使わない。
- **リポジトリ**: plancel = `torifo/plancel-app`（main への push で自動デプロイ）。

### 無料枠（org 合算・超過で org 内の全アプリ停止）

無料枠は organization 単位の合算で、超過すると同 org の**全アプリが停止**する。`plancel-app` と
`opulse-monitor` は枠を共有するので、片方の使いすぎがもう片方を止める点に注意。

| 資源          | 無料枠（org 合算） |
| ------------- | ------------------ |
| リクエスト    | 月 100 万 req      |
| CPU 時間      | 15 時間            |
| 帯域          | 100 GB             |
| KV ストレージ | 1 GiB              |

この枠が §2 の容量設計（開放50 + 保証リスト）の根拠になっている。

## 1. 方式とエントリポイント

- **方式**: console.deno.com の GitHub 連携（`main` への push で自動デプロイ）。ビルドステップ
  なし（素の Deno、Install/Build コマンドは空）。
- **本番 URL**: https://plancel-app.torifo.deno.net （org slug を 2026-07-21 に `plancel` → `torifo`
  へリネーム済み。旧 URL `plancel-app.plancel.deno.net` は 404。Google OAuth の承認済みリダイレクト
  URI もオーナーが 新 URL に更新済み。）
- **エントリポイント**: `src/deploy/main.ts`（統合版）。1 デプロイで全サーフェスを動かす:
  - `Deno.serve` — 下記のルーティング
  - `Deno.cron` — 15分毎の境界チェック（`plancel-boundary-check`）＋カレンダー同期の dirty スイープ
- `Deno.serve` のルート:
  | パス                         | 用途                                                           |
  | ---------------------------- | -------------------------------------------------------------- |
  | `GET /`, `GET /index.html`   | Web UI（`web/index.html`、MVP の主サーフェス）                 |
  | `GET /manifest.webmanifest`  | PWA manifest（インストール名・テーマ・アイコン）               |
  | `GET /sw.js`                 | Service Worker（no-cache、明示更新・オフラインshell）          |
  | `GET /icons/*`               | PWAアイコン（192/512px・maskable、ブラウザキャッシュ1日）      |
  | `/auth/*`                    | ログイン・マイページ・API トークン・カレンダー/LINE 連携（§4） |
  | `GET /calendar/<secret>.ics` | 全員向け iCal 購読フィード（§5）                               |
  | `POST /api/parse`            | 貼り付けメール／画像の取り込み（**ログイン必須**・401 で拒否） |
  | `/api/reservations…`         | 予約 CRUD ＋ 共有（招待・権限、下記）（ログインまたは API トークン必須） |
  | `/api/policy-templates…`     | 施設の既定規定（下記・台帳ごとに非公開）                       |
  | `GET /healthz`               | ヘルスチェック（`ok <ビルドID>`。下記「どのビルドが入っているか」）|
  | `POST /webhook`              | LINE webhook（LINE env 未設定時は 503）                        |
  | `POST /webhook/email`        | メール転送インテーク（Resend inbound webhook、下記 §3.1）      |
- **予約の共有（招待）と権限**（オーナー
  2026-07-28「招待する時に編集を許可すれば細かい修正を参加者もできるように」）: 予約は**オーナーの
  台帳に置いたまま参照で共有**する（相手の台帳にコピーは作らない）。KV は
  `["resv_members", <ownerUserId>, <resvId>, <memberUserId>] → { addedAt, role }` と 逆引き
  `["shared_in", <memberUserId>, <ownerUserId>, <resvId>] →`（同じ値）の2本を常に同一 atomic
  で更新する。`role` は **`viewer`（既定・閲覧のみ）** と **`editor`（内容の編集も可）** の2種類で、
  role キーを持たない旧行は viewer として読む（既存の共有は読み取り専用のまま）。
  - `GET /api/reservations/:id/members` — オーナーまたはメンバーが閲覧 →
    `{members:[{userId,displayName,uid,label,role}]}`
  - `POST /api/reservations/:id/members` `{q, role?}` — 招待（オーナー専用）。`role` 省略は
    `viewer`、未知の role は 400、相手が見つからなければ 404 `user_not_found`、自分宛て・重複は
    200 の no-op（**再招待で権限は変わらない** — 変更は下の PATCH で明示的に）
  - `PATCH /api/reservations/:id/members/:userId` `{role}` — 権限変更（オーナー専用）→ 200
    `{member}`。未知の role は 400、その userId が共有相手でなければ 404
  - `DELETE /api/reservations/:id/members/me` — メンバー自身が脱退
  - `DELETE /api/reservations/:id/members/:userId` — オーナーが外す

  **権限の分界**（`src/web/api.ts` の `memberGate` 一箇所で強制）: editor に許すのは
  `PATCH /api/reservations/:id`（service / startsAt / amount / location / policy / plan）**だけ**。
  **確定・キャンセル・復元・削除・招待・権限変更はオーナー専用** — 確定はプラン全体を決着させ
  （同プランの他候補が自動で要キャンセル）、削除は取り消せないため、参加者に渡した「細かい修正」の
  範囲を超える。権限不足のメンバーには 403 `{error:"forbidden",reason:"role",role}`、そもそも共有
  されていない相手には 404（予約の存在を教えない）。editor の編集は**オーナーの台帳へ直接**適用され、
  オーナーの Google/ICS を追随させる同じ同期フックが発火する。最後に書いた人は予約の
  `updated_by`（userId、旧レコードは null）に残る。メンバーに見せるオーナー名・相手名は
  `displayName → @uid →「共有ユーザー」`の順で、**メールアドレスは絶対に返さない**（招待検索 API
  と同じ規律）。
- **施設の既定規定**（オーナー 2026-07-27「ホテルごとに規定(ベース)を設定できるといいかも」）:
  施設名をキーに規定を1件だけ覚えておき、同じ宿・同じ店の次の予約で初期値にする。KV は
  `["web", <ledger>, "policy_tpl", <正規化施設名>]`（NFKC + trim + 空白畳み + 小文字化。
  「ＡＢＣ」と「ABC」、全角スペースと半角スペースは同一キー）。表示名は入力どおり保存。
  - `GET /api/policy-templates` — 一覧（表示名順）→ `{templates:[…]}`
  - `PUT /api/policy-templates/<施設名>` `{policy}` — 保存・上書き → 200 `{template}`、
    不正な規定と `unknown` は 400
  - `DELETE /api/policy-templates/<施設名>` — 削除 → 204（存在しなくても 204・冪等）
  - `GET /api/policy-templates/lookup?service=<施設名>` — フォーム初期値の引き当て →
    `{template}` または `{template:null}`

  施設名はパスで percent-encode する。引き当ては**正規化後の完全一致のみ**（あいまい一致は誤った
  料率表を黙って埋めるので入れない）。`unknown` はテンプレとして保存できない（規定を「言っていない」
  テンプレは無いより悪い）。テンプレは**台帳ごとに非公開**で、予約を共有しても相手には見えない。
- cron・webhook・Web は起動時に開く 1 つのマネージド KV（`KvStore.open()` = 引数なし）を共有する。
- cron の通知チャネルは env から自動選択（`selectNotifier`）: **LINE push（owner宛）>
  Email（Resend）
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

| 変数                                        | 必須         | 用途                                                                                                                                        |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 実質必須     | Google OAuth（ログイン + カレンダー連携）。両方揃わないと `/auth/google` は 503                                                             |
| `PLANCEL_KEK`                               | 強く推奨     | Google refresh token を封緘する base64 32byte 鍵。**未設定だと平文保存**（`plain:` プレフィクス、起動ログで警告）                           |
| `PLANCEL_BASE_URL`                          | 任意         | OAuth リダイレクト・マジックリンクの origin を固定。省略時はリクエストの origin                                                             |
| `PLANCEL_MAX_USERS`                         | 任意         | 開放サインアップ上限（既定 50、`0` で無制限）                                                                                               |
| `PLANCEL_ALLOWED_EMAILS`                    | 任意         | 定員を無視して作成できる保証アドレス（カンマ区切り）                                                                                        |
| `PLANCEL_ADMIN_EMAILS`                      | 任意         | 管理者アドレス。`/auth/me` に userCount と 100人警告が付く。予約語 uid を取れるのもこのアカウントのみ                                       |
| `PLANCEL_DEV_USER`                          | ローカルのみ | OAuth を踏まず、全リクエストをこの email のユーザーとして扱う（本番では設定しない）                                                         |
| `PLANCEL_ADMIN_TOKEN`                       | 任意         | 本番スモーク用。`x-plancel-admin` ヘッダと一致すれば `x-plancel-token` を台帳として直接使える                                               |
| `RESEND_API_KEY` / `PLANCEL_EMAIL_FROM`     | 任意         | **メールログイン（マジックリンク）**の前提。両方揃うと `/auth/email` が有効化。未設定ならマジックリンクは休眠（コードは残るが送信されない）。`RESEND_API_KEY` は**受信メール本文の読み出し（§3.1）にも必要** |

### 取り込み・通知・LINE（既存）

| 変数                        | 必須 | 用途                                                                                                                |
| --------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| `GROQ_API_KEY`              | ◯    | テキスト一次パーサー（Groq）                                                                                        |
| `GEMINI_API_KEY`            | ◯    | 条件付き査読 + 画像（Gemini）。「N日前から◯%」型の規定を含むテキストではこれが一次になる。有効枠はAI Studioのプロジェクト/モデル表示を確認し、画像経路と共用 |
| `LINE_CHANNEL_SECRET`       | 任意 | webhook 署名検証（未設定なら webhook は 503）。**設定済み（2026-07-26 開通）**                                      |
| `LINE_CHANNEL_ACCESS_TOKEN` | 任意 | 返信・push・画像取得。長期トークン（Messaging API タブで発行）。**設定済み**                                        |
| `LINE_ALLOWED_USER_IDS`     | 任意 | **クローズドベータ用のゲート。公開アカウントでは空（未設定）が正しい** — 設定すると、**まだ連携していない**送信者を全員はじくので、新しい人が連携コードを送ることすらできなくなる。認可はユーザー毎の LINE 連携（§4）なので、連携済みユーザーは絶対にブロックしない。`deno task line` 単体モードは連携インデックスを持たないため、従来どおりこれが唯一の許可リスト（空なら全拒否） |
| `PLANCEL_OWNER_USER_ID`     | 任意 | **コア台帳** cron 通知（`selectNotifier`）の push 先。省略時は許可リストの先頭。台帳の期限リマインドは各ユーザー自身の連携済み LINE へ飛ぶので、この変数は関係ない |
| `PLANCEL_EMAIL_TO`          | 任意 | LINE 未設定時の Email 通知先（`RESEND_API_KEY` + `PLANCEL_EMAIL_FROM` と合わせて cron 通知の Email フォールバック） |
| `PLANCEL_EMAIL_DAILY_CAP`   | 任意 | 期限リマインドの **1日あたり Email 送信数上限**（既定 **90**）。用途: Resend の日100通上限に当てないための自前ガード。到達分は**翌日に繰り越し**（マーカーを書かないので翌日の sweep で再送）。未設定・0・数値でない値は既定値にフォールバックする（打ち間違いでリマインドが黙って止まらないように） |

> `RESEND_API_KEY` + `PLANCEL_EMAIL_FROM` はマジックリンク送信と cron の Email 通知を兼ねる。
> `PLANCEL_EMAIL_TO` が加わると cron 通知の宛先になる。

**期限リマインドの送信枠（オーナー 2026-07-27「知人優先で枠を使いたい」）**
台帳の無料キャンセル期限リマインド（`src/web/notify.ts`、15分 cron）は Resend
無料枠（日100通）の唯一の大口消費者なので、次の2段構えで枠を守る。

- **ユーザーごとに1通へバンドル**: 同じ sweep で期限を跨いだ予約が複数あっても、送るのは1通だけ
  （件名は「無料キャンセル期限が近い予約が3件あります」、本文は1予約1行 =
  サービス/開始/◆無料キャンセル期限/期限後の最大キャンセル料）。冪等マーカーは**予約ごとに**据え置きで、その1通の送信が
  成功した後にまとめて書く（失敗時は1件も書かないので、次の sweep で束ごと再送される）。
- **保証リスト優先**: 送信順は `PLANCEL_ALLOWED_EMAILS`（保証リスト = 知人）→ それ以外、各グループ内は
  ユーザーID順。上限に当たった時点で打ち切られるので、**知人には必ず先に届いている**。
- 日次カウンタは KV `["email_quota", <Asia/Tokyo の YYYY-MM-DD>]`（`expireIn` 約3日、Email 送信成功
  時のみ +1）。**LINE 連携済みユーザーは対象外** — LINE push は別クォータで Resend を消費しない。
  上限到達時は `web.notify` に `warn`（"daily email cap reached; deferring to the next JST day"）。

### 3.1 メール転送インテーク（オーナー 2026-07-27「メールの内容をコピーするのではなく転送してもらうとかがいいな」）

予約確認メールを貼り付ける代わりに、**転送するだけ**で自分の台帳に候補として入る
（`src/web/email-intake.ts`）。Deno Deploy は SMTP を受けられないので、受信は Resend の inbound
webhook 経由。設計の根拠は `local/reports/2026-07-27-email-forward-intake.md`。

| 変数                      | 必須                 | 用途                                                                                                                          |
| ------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `PLANCEL_INBOUND_DOMAIN`  | 転送機能を使うなら◯ | 受信ドメイン。**本番は Resend が自動発行した `ferouhelee.resend.app`**（独自ドメイン・DNS 設定は不要）。未設定なら `/auth/me` は `mailAddress: null` を返し、UI は転送先を出さない |
| `RESEND_WEBHOOK_SECRET`   | 転送機能を使うなら◯ | Resend ダッシュボードの Svix signing secret（`whsec_…`）。未設定なら `POST /webhook/email` は **503**                          |
| `RESEND_API_KEY`          | 転送機能を使うなら◯ | webhook は**メタデータのみ**なので、本文は Received-Emails API（`GET /emails/receiving/{id}`）で取得する。未設定なら 503       |
| `PLANCEL_MAIL_DAILY_CAP`  | 任意                 | 1ユーザーが 24 時間に受け付けられる転送数（既定 **50**）。超過分は 200 を返して**何も書かない**（転送ループ・アドレス流出時の歯止め） |

**ユーザーごとの転送先アドレス**: `p-<mailSecret>@<PLANCEL_INBOUND_DOMAIN>`。`mailSecret` は
`icsSecret` と同型の 32byte 乱数で、逆引き索引 `["mail_secret", <secret>] → userId` を持つ
（`src/web/users.ts`）。`GET /auth/me` が完成形のアドレスを `mailAddress` で返し、漏洩時は
`POST /auth/mail/rotate` で発行し直す（旧アドレスは即座に解決しなくなる）。2026-07-28 より前に
作られたアカウントは秘密を持たないので、`/auth/me` の初回アクセス時に1度だけ発行される。

**`from` は絶対に信用しない**: 送信元アドレスは偽装できるので、**どの台帳かを決めるのは宛先
ローカルパートの秘密だけ**。実在ユーザーのアドレスを騙った `from` は何も解決しない（ログにだけ残す）。
これに Svix 署名検証（`svix-id`/`svix-timestamp`/`svix-signature`、生ボディに対する HMAC-SHA256、
タイムスタンプのずれ 5 分超はリプレイとして拒否）が重なって、なりすましとエンドポイント直叩きの
両方を止める。

**ステータスコードはリトライ契約**（Resend は非 2xx を再送する）:

| 状況                                             | 応答    |
| ------------------------------------------------ | ------- |
| `RESEND_WEBHOOK_SECRET` / `RESEND_API_KEY` 未設定 | **503** |
| 署名が無い・不一致・タイムスタンプが 5 分超ずれている | **401** |
| ボディが JSON でない／`email.received` の形でない  | **400** |
| 生ボディが 64KiB 超                               | **413** |
| `type` が `email.received` 以外（delivered 等）    | **200**（何もしない） |
| 宛先の秘密がどのユーザーにも一致しない            | **200**（ログのみ・応答は一致有無を明かさない） |
| 同じ `email_id` の再送                            | **200**（`["mail_seen", <email_id>]` を atomic に確保・TTL 60日） |
| 1日の上限超過                                     | **200**（ログのみ） |
| AI が読み取れなかった                             | **200**（何も書かず、**LINE 連携済みなら**「貼り付けてください」と push。メール返信はしない — 送信ドメイン検証が必要で、リマインドの無料枠を食う） |
| 受信本文の取得に失敗（Resend 側の一時障害）        | **502**（唯一リトライさせたいケース。冪等マーカーは解放する） |
| 登録成功                                          | **200** |

本文はテキストパートを優先し、HTML のみのメールはタグを除去して使う（上限 100KB）。**添付は v1 では
対象外**でログに残すだけ。パーサーチェーンは `/api/parse`・LINE と**同じインスタンス**を共有し、
登録は HTTP API と同じ `createReservation`（`confirmed: false` = 候補）＋同じカレンダー同期フック。
メールが規定を書いていなかった場合は**施設の既定規定**（§1）で補完し、
メールが規定を書いていた場合はテンプレで上書きしない。

**オーナーがダッシュボードでやること**: ① Resend で受信を有効化（独自ドメインなしなら
`*.resend.app` が自動割当）→ ② Webhook を `https://plancel-app.torifo.deno.net/webhook/email`
に向けて `email.received` を購読し signing secret を控える → ③ Deploy の環境変数に
`PLANCEL_INBOUND_DOMAIN` と `RESEND_WEBHOOK_SECRET` を入れて**再デプロイ**（env 変更は再デプロイまで
効かない）→ ④ 各ユーザーがマイページで自分の転送先アドレスをメールの連絡先に保存。

## 4. 認証（ログイン一本化）

ログインが唯一の入口。**旧方式（ブラウザローカルの匿名トークンが現行）は廃止**。旧トークン台帳は
ログイン後 `POST /auth/adopt` で自分の ledgerId
として一度だけ引き継げる（自分の台帳が空のときのみ）。

- **Google OAuth**: `/auth/google` → state + PKCE 保存 → 同意画面（scope
  `openid email https://www.googleapis.com/auth/calendar.app.created`、
  `access_type=offline&prompt=consent`）→ `/auth/callback` で code 交換 → sub/email でユーザー 解決
  → refresh token 封緘保存 → セッション Cookie（httpOnly、90日）。
- **メール + パスワード**: `POST /auth/register`（email + パスワード、PBKDF2 ハッシュ）。この経路で
  作ったアカウントは**メール未検証**（`emailVerified: false`）。`POST /auth/login` は **email または
  uid** とパスワードで認証（失敗は 15分で10回まで）。
- **マジックリンク（休眠）**: `POST /auth/email` は 15分トークンを Resend で送る設計だが、Resend
  未設定のため現状は休眠（503）。コードは残置。
- **未検証アカウントは Google と自動合流しない**: 同一アドレスの未検証パスワードアカウントがある
  状態で Google ログインすると、乗っ取り防止のため自動マージせず `auth_error=email_taken` を返す。
  合流は GUI から明示的に Google
  を「連携」した場合のみ（`?link=1`）で、リンク成功時に検証済みへ昇格。
- **マイページ**:
  - **表示名**（`displayName`、重複可）
  - **uid**（`POST /auth/profile`）: 任意・**英小文字のみ**・一般は **6〜20文字**。予約語 （`admin`
    / `torifo` / `plancel` ほか、`src/web/users.ts` の `RESERVED_UIDS` が正）は
    **管理者アカウントのみ**取得可（予約語に限り6文字未満も可）。開発者は自分のマイページから
    `admin` / `torifo` を取る想定。
  - **追加ログインメール**（`altEmail`、例 iCloud）
  - **パスワード設定/変更**（`POST /auth/password`）: Google
    アカウントにパスワードログインを足せる。
  - **パーソナル API トークン**（`POST/DELETE /auth/token`、§6 MCP 用）。
  - **メール転送先アドレス**（2026-07-27、§3.1）: `GET /auth/me` の `mailAddress`
    （`p-<mailSecret>@<PLANCEL_INBOUND_DOMAIN>`、ドメイン未設定なら `null`）。
    `POST /auth/mail/rotate` で再発行 → 新しい `mailAddress` を返し、旧アドレスは即座に無効。
    **UI 実装済み**（2026-07-28）: マイページ「メールを転送して予約を取り込む」にアドレス表示・
    コピー・再発行の3操作があり、取り込みモーダルの「📨 メールを転送する」を押しても同じアドレスが
    その場に開く（コピーのみ、再発行はマイページ側）。`mailAddress` が `null`（ドメイン未設定）の環境では
    両方の導線が丸ごと隠れる（`web/index.html` の `renderMailFeature`）。**取り込みモーダル経由の
    転送だけは確認画面が無い** — 貼り付け・スクショ経路は解析後にプレビューで確認してから登録するが、
    転送は読み取れた時点でそのまま候補として台帳に並ぶ。
  - **LINE 連携**（ユーザー毎、2026-07-27）: `POST /auth/line/code` が**8文字の連携コード**
    （曖昧な O/0/I/l/1 を除く英数字、**10分間有効・1回限り**、発行し直すと前のコードは即無効）を
    返し、それを LINE のトークに送ると連携が完了する。`DELETE /auth/line` で解除。`GET /auth/me`
    は `line: { linked: true|false }` だけを返す（LINE userId 自体はクライアントに出さない）。
    コード発行は 15分で10回まで（パスワードログインと同じリミッタ・バケットは別）。
    LINE の `userId` を身分証明として信用せず、**ログイン済みセッションから出したコードだけ**を
    信用する設計。KV: `["line_user", <LINE userId>] → userId`（逆引き・1 LINE = 最大1アカウント）、
    `["line_link_code", <code>] → { userId, created_at }`（`expireIn` 10分）。退会時は両方削除。

## 5. カレンダー連携（2層・キューなし）

同期対象は**確定予約の本体のみ**。confirm / 確定済み編集 / cancel / delete をカレンダーへ反映する。

- **全員向け iCal 購読フィード**: `GET /calendar/<secret>.ics`。confirmed のみ、`TZID=Asia/Tokyo`、
  終了時刻はモデルに無いので一律 +1h、`LOCATION` 対応（会場を渡すとカレンダー側でマップ表示）。
  Google/iCloud/TimeTree いずれも購読可。秘密 URL は `POST /auth/ics/rotate` でローテートできる。
- **Google 連携ユーザー向け**: `calendar.app.created`
  スコープで専用「plancel」カレンダーを自動作成し、 Calendar API で**即時プッシュ**（iCal
  のポーリング遅延を埋める）。
- **同期はユーザー操作を絶対に失敗させない**（reconcile 型）: 予約の現在状態から「確定→upsert /
  それ以外・削除→イベント削除」を決めるので、再実行・順序前後が無害。
- **⚠ キュー禁止（2026-07-25）**: **Deploy 本番の KV Connect は `kv.enqueue`/`listenQueue`
  非対応**（ローカル KV は対応するためテストをすり抜ける。起動ログに "KV Connect does not support
  queues"）。カレンダー同期はキューを使わず、**書き込み時インライン同期 + `gcal_dirty` フラグ + 15分
  cron スイープ**で再試行する。`invalid_grant`（refresh token 失効・取り消し）は恒久エラーと
  してユーザーを `reauth`（UI: 要再接続）に落とし再試行しない。**今後もキュー前提の設計は本番で
  動かないので禁止。**

> 補足: アプリは**本番公開済み**なので、テスト中アプリにあった「refresh token が7日で失効」の
> 制約は無い（旧設計の記述）。

## 6. MCP 連携（remote モード）

Claude Desktop 等から本番の台帳を直接操作できる。

- **remote モード**: env `PLANCEL_API_URL` + `PLANCEL_API_TOKEN` が揃うと、`src/mcp/main.ts` は
  ローカル core ストアではなく本番 Web API を叩く 15 ツールを serve する。予約 7
  （list / create / confirm / cancel / restore / update / delete）＋
  施設の既定規定 4（`list_policy_templates` / `lookup_policy_template` /
  `save_policy_template` / `delete_policy_template` → `/api/policy-templates`）＋
  共有 4（`list_reservation_members` / `share_reservation`（`role` で「編集を許可」）/
  `set_member_role` / `unshare_reservation` → `/api/reservations/:id/members`）。トークンはマイページの
  カレンダー連携画面で発行するパーソナル API トークン（`x-plancel-token`）。Claude で作った予約が
  家族の見る台帳に入り、確定はカレンダーにも流れる。
- **local core モード**: env 無しなら従来どおりローカル KV の core ストアを操作する。
- **原則**: 「GUI でできることは MCP でもできる」を目指す。ただし**uid 確定・アカウント連携/マージ・
  LINE 連携コードの発行は GUI 専用**（アイデンティティ確定は人手のみ）で MCP には出さない。
  施設の既定規定と共有（招待・権限）はこの例外に当たらないので MCP にも出す（上記8ツール）。
  共有ツールも API 側の分界に従うので、オーナー専用の操作は MCP からも実行できない。

Claude Desktop の設定例（`claude_desktop_config.json`）:

```json
{
  "mcpServers": {
    "plancel": {
      "command": "deno",
      "args": [
        "run",
        "--allow-env",
        "--allow-net",
        "--unstable-temporal",
        "--unstable-kv",
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
4. **KV データベース作成 + リンク**: プロジェクトに KV（`torifo-kv`）を作成/リンクする。 **新 Deploy
   は KV を自動アタッチしない** — 未リンクだと起動時に `Deno.openKv()` が落ちて healthz
   も返らない。無料プランは org あたり KV インスタンス1つのため `plancel-app` と `opulse-monitor`
   が同一インスタンスに相乗りするが、インスタンス内で app 毎に隔離 DB が切られ
   データは分離される（ストレージ/読み書きクォータは 2 アプリ合算）。
5. **環境変数を設定**: §3 の表のとおり。少なくとも `GROQ_API_KEY` / `GEMINI_API_KEY` /
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `PLANCEL_KEK`、必要に応じ容量・管理者・LINE 系。
6. **デプロイ**: `main` に push（または「Deploy」実行）。`GET .../healthz` が
   `ok <ビルドID>` を返し、**ビルドIDが push 前と変わっている**ことを確認。PWAを更新した場合、`sw.js` の `CACHE_VERSION` も上げる。利用者はマイページの
   「更新を確認」から新しいService Workerを取得し、「今すぐ更新」で待機版を適用できる。
7. **LINE webhook URL 設定**（LINE を使う場合）: Messaging API の Webhook URL を
   `https://plancel-app.torifo.deno.net/webhook` にし、「Webhookの利用」をオン、検証を通す。
   **2026-07-26 設定・検証成功済み**（チャネル: プロバイダー plancel / channel 2010848177 / Bot
   @791wbdma）。 注意: Deploy の env 変更は **再デプロイ（Deploy Default
   Branch）まで反映されない**。 curl での素の POST /webhook は 401（署名なし）が正常。未設定サインは
   503。 LINE ConsoleによるWebhook検証までは成功済み。台帳の期限通知、確認・限定更新・追加も
   コード上は台帳へ統合済みだが、再デプロイ後のLINE実機E2Eは未確認（§9）。
   **2026-07-27: LINE はユーザー毎連携に移行。`PLANCEL_LINE_OWNER_EMAIL` は削除し（コードは読まない）、
   `LINE_ALLOWED_USER_IDS` も空にする（公開アカウントでは空が正しい。設定したままだと未連携の人が
   連携コードを送れない）。既に連携済みだったオーナーは、初回だけマイページで連携コードを
   発行して LINE に送り直す（旧 env ベースの紐付けは KV に残らないため移行データは無い）。**

### どのビルドが入っているかを外から確かめる（2026-08-12）

Deploy はデプロイを識別するヘッダを返さず、`/healthz` も `ok` しか言わなかったので、push した
コードが本番に入ったかどうかを外から確かめる手段が無かった（同じ `ok` がどちらでも返る）。
いまは走っているビルドのIDを返す。

```sh
curl -s https://plancel-app.torifo.deno.net/healthz   # → ok <ビルドID>
```

- 中身は `DENO_DEPLOY_BUILD_ID`（走っているビルド＝デプロイごとに変わる）。無ければ
  `DENO_DEPLOYMENT_ID`（アプリ・ビルド・コンテキスト・環境変数・接続を含むデプロイ設定のID）。
  どちらも無いローカルでは `dev`。実装は `src/lib/build.ts`。
- **push の前に一度叩いてIDを控え、後で変わったかを見る**のが確実。ビルドIDとコミットの対応は
  Deploy のダッシュボード（console.deno.com/torifo/plancel-app）で確認できる。
- コミットSHAそのものを載せてはいない。ビルド工程を持たない構成では、そのコミット自身のSHAを
  そのコミットの中に書けない（書けるのは1つ前のSHAで、かえって誤解を招く）。

### LINE トークのコマンド（リッチメニュー前提・2026-07-28）

リッチメニュー本体は **LINE 側（LINE Official Account Manager）でオーナー／運用者が作る**。
メニューのボタンにできるのは「固定テキストを送る」か「URL を開く」の 2 つだけなので、ボタンに
仕込むテキストは必ず下表のどれかにすること。表にない語は AI 解析に流れ、短文なら**コマンド一覧**が、
長文なら従来どおり解析結果が返る。

判定は **NFKC 正規化 → 前後の空白除去 → ASCII の小文字化** のあとで行うので、全角英字・半角カナ・
大文字小文字・全角スペースは区別しない（`src/line/web-commands.ts` の `COMMANDS` が唯一の表）。

| 送るテキスト           | 返信                                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| `確認` / `予定` / `一覧` | 有効な予約一覧（状態ラベル・無料キャンセル期限）＋ 次の無料キャンセル期限／最大キャンセル料フッタ ＋ 確定/キャンセル済みの Quick Reply |
| `締切` / `期限`         | **7日以内**に無料キャンセル期限が切れる予約のみ（近い順・無料キャンセル期限日と過ぎた場合の最大キャンセル料）。0件なら「ありません」＋ 7日より先の次の期限 |
| `今日`                 | JST の今日始まる予約（時刻つき）                                             |
| `今週`                 | JST の今日から7日以内に始まる予約                                            |
| `連携` / `設定`         | このトークがつながっている plancel アカウント名＋解除手順（未連携なら連携案内） |
| `使い方` / `ヘルプ` / `help` | サービスの説明・コマンド一覧・予約の追加方法・サイト URL（8行）             |

- **返信には必ずコマンドの Quick Reply が付く**（`確認`/`締切`/`今日`/`今週`/`使い方` のうち、その
  返信自身を除いた 4〜5 個）。リッチメニューが無い状態でもトークだけで回せる。Quick Reply の上限は
  13 個なので、`確認` の予約別ボタンはコマンド分を残した数で打ち切る。
- **未連携の送信者**には台帳を一切読まずに連携案内だけを返す（コマンドも解析も走らない）。
- **短文フォールバック**: 連携済みの送信者が送った **12文字以下**のテキストがどのコマンドにも
  一致しなければ、解析にかけず（ParseJob も作らず）コマンド一覧を返す。13文字以上と画像は従来どおり
  解析パイプラインへ。しきい値は `MAX_COMMAND_GUESS_CHARS`。

#### 返信から張るディープリンク（フラグメント）

LINE の返信からサイトへ誘導するときは、必ず用途ごとのフラグメントを付ける（オリジン直打ちは禁止）。

| フラグメント                                     | 遷移先             |
| ------------------------------------------------ | ------------------ |
| `https://plancel-app.torifo.deno.net/#import`    | 取り込み（メール本文・スクショの貼り付け） |
| `https://plancel-app.torifo.deno.net/#link`      | マイページの「LINE連携」（連携コード発行・解除） |
| `https://plancel-app.torifo.deno.net/#help`      | 使い方             |

`web/index.html` の `routeHash` が4経路を処理する。ログイン前はフラグメントを保持し、ログイン後に
対象画面を開いてから履歴から取り除くため、再読み込みで同じモーダルを開き直さない。

## 8. オーナー側の外部作業（一度きり）

1. Google Cloud Console「データアクセス」でスコープ `calendar.app.created` を追加。
2. OAuth 承認済みリダイレクト URI に `https://plancel-app.torifo.deno.net/auth/callback` を登録。
   **アプリは本番公開済み**（テストユーザー限定・7日失効の段階は終了）。
3. （メールログインを使うなら）Resend ドメイン検証 + `RESEND_API_KEY` / `PLANCEL_EMAIL_FROM`。
4. `PLANCEL_KEK`（base64 32byte）/ `PLANCEL_ADMIN_TOKEN` / `PLANCEL_ADMIN_EMAILS` を Deploy env
   に設定。

## 9. デプロイ後の実機確認（done-when）

再現手順の詳細は [`docs/VERIFICATION.md`](./VERIFICATION.md) §3を参照。

- **認証**: Google 実ログイン → 専用「plancel」カレンダーへ確定予約が即時反映 → 削除で同期消去。
- **メール+パスワード**: 登録 → uid 設定 → uid でログイン。
- **MCP**: マイページで API トークン発行 → env 設定 → Claude から予約操作が本番台帳に入る。
- **cron**: Deploy のログで 15分毎の `tick end`（`failed:0`）と、必要時 `gcal sweep repaired`
  を確認。
- **LINE**: 未連携のトークに何か送ると連携案内が返る → マイページで連携コード発行 → コードを送って
  連携完了（返信に自分のアカウント名が出る）→ テキスト/画像登録が**自分の**台帳に入る →
  Quick Replyで確定/キャンセル済み → 期限リマインドが自分のLINEに届く。
  2人目のアカウントを連携して、互いの予約が見えないことも確認する。
- **Resend**: ドメイン検証後に実メールを1通送信。

## 10. ロールバック / 退避

- Deploy の無料枠が厳しくなったら VPS + SQLite に退避（Store 抽象で経路確保済み。cron は
  `vps_main.ts` = systemd timer run-once）。
- ローカルcore台帳のKVは追記型イベントログが真実の源で、導出値は`verify-projection`で照合できる。
  本番の台帳はユーザー別のWebストアとして管理され、coreイベントログとは別モデルである。

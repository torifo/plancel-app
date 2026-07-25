# ログイン一本化 + カレンダー連携 設計（2026-07-21）

オーナー承認済み（会話 2026-07-21）。

> **⚠ この文書は 2026-07-21 時点の設計スナップショット。実装で変わった点は下記に追記
> （実装・運用の正は `src/deploy/main.ts` ヘッダ／`docs/DEPLOY.md`／`docs/VERIFICATION.md`）:**
> - **同期はキュー不使用に再設計（2026-07-25）**: Deploy 本番の KV Connect は
>   `kv.enqueue`/`listenQueue` 非対応。§5 の「KV queue + 指数バックオフ最大5回」は**旧方式**。
>   現行は書き込み時インライン同期 + `gcal_dirty` フラグ + 15分 cron スイープ（`src/web/calendar/sync.ts`）。
> - **アプリは本番公開済み**: §「オーナー側の作業」2 の「テスト中は refresh_token が7日失効」は
>   もう当てはまらない（`invalid_grant` は取り消し時のみ → `reauth` 表示）。
> - **メール/UID + パスワード（PBKDF2）を追加（2026-07-23）**: ログインは email または uid。
>   マジックリンクはコードに残るが Resend 未設定で**休眠**。未検証メールアカウントは Google と
>   自動合流しない（GUI からの明示リンクのみ）。
> - **容量設計・MCP remote モード**を追加（DEPLOY.md §2・§6）。

## 決定事項

1. **認証はログインに一本化**: Google OAuth または メール（マジックリンク、Resend送信）。
   家族が Google 圏外（iCloud / TimeTree）でも使えるよう、メールログインを同格で用意する。
2. **既存ブラウザトークン台帳の引き継ぎ**: store のキー `["web", token, "resv", id]` の
   `token` を「台帳ID (ledgerId)」と読み替える。ユーザーは `ledgerId` を指す間接参照を持ち、
   初回ログイン時に旧トークンをそのまま `ledgerId` に採用（データコピー無し）。store.ts は無変更。
3. **カレンダー連携（plancel → カレンダー）は2層**:
   - 全員向け: iCal 購読フィード `GET /calendar/<secret>.ics`（confirmed のみ、TZID=Asia/Tokyo、
     終了時刻はモデルに無いので一律 +1h）。Google/iCloud/TimeTree いずれも購読可。
   - Google 連携ユーザー向け: Calendar API 即時プッシュ。専用「plancel」カレンダーを
     `calendar.app.created` スコープ（アプリが作ったカレンダーのみ操作可）で自動作成。
4. **同期対象は確定予約の本体のみ**（キャンセル期限イベントは将来拡張）。
   confirm / 確定済み編集 / cancel / delete をカレンダーへ反映。
5. **同期はユーザー操作を絶対に失敗させない**: API 成功後に KV queue (`kv.enqueue`) へ投げ、
   失敗は指数バックオフで最大5回再試行。`invalid_grant`（テスト中アプリの7日失効・取り消し）は
   再試行せず「要再接続」をユーザーに表示。
6. **開発・検証バイパス**:
   - テスト: ハンドラ直呼びでヘッダ認証（従来どおり）
   - ローカル: `PLANCEL_DEV_USER=<email>` で OAuth を踏まず自動ログイン
   - 本番スモーク: `x-plancel-admin: <PLANCEL_ADMIN_TOKEN>` + `x-plancel-token: <ledger>`

## データモデル（KV 追加分）

```
["webuser", userId]           WebUser { id, email, ledgerId, icsSecret, google: {sub,
                              refreshTokenSealed, calendarId, error} | null, created_at, updated_at }
["webuser_email", email]      userId
["webuser_google", sub]       userId
["websession", sid]           { userId, expiresAt(ms) }   90日
["magic", token]              { email, expiresAt(ms) }    15分TTL・使い捨て
["magic_rate", email]         { count }                   expireIn 1h・3通まで
["oauth_state", state]        { verifier }                expireIn 10分
["ics_secret", secret]        userId
["gcal_map", userId, resvId]  { eventId, syncedAt }
```

refresh_token は `PLANCEL_KEK`（base64 32byte）で AES-GCM 封緘（`v1:` プレフィクス）。
KEK 未設定時は `plain:` プレフィクスで平文保存（起動ログで警告）。

## モジュール

- `src/lib/encoding.ts` … base64 / base64url / hex
- `src/lib/seal.ts` … AES-GCM seal/unseal
- `src/web/users.ts` … ユーザー・セッション・マジックリンク・state・ics secret・gcal_map の KV 操作
- `src/web/auth/session.ts` … Cookie ヘルパ（httpOnly/SameSite=Lax/Secure は https 時）
- `src/web/auth/google.ts` … OAuth コードフロー（state+PKCE、コード交換、refresh）
- `src/web/auth/routes.ts` … `/auth/*` ルーティング + `resolveIdentity`（セッション/dev/admin）
- `src/web/calendar/ics.ts` … フィード生成 + `/calendar/<secret>.ics` ハンドラ
- `src/web/calendar/gcal.ts` … Calendar API クライアント（ensureCalendar/upsert/delete）
- `src/web/calendar/sync.ts` … 同期メッセージ処理（reconcile 型: 予約の現在状態から決める）
- 変更: `src/web/api.ts`（opts.ledger / onMutate 追加、ヘッダは後方互換で残す）、
  `src/deploy/main.ts`（配線 + listenQueue）、`web/index.html`（ログイン画面・連携設定 UI）

## 認証フロー

- Google: `/auth/google` → state+PKCE 保存 → Google 同意画面
  （scope: `openid email https://www.googleapis.com/auth/calendar.app.created`,
  `access_type=offline&prompt=consent`）→ `/auth/callback` で code 交換 →
  sub/email でユーザー解決（sub → email → 新規作成の順）→ refresh_token 封緘保存 → セッション。
- メール: `POST /auth/email {email}` →（3通/時に制限）15分トークン発行 → Resend で
  `/auth/verify?token=` リンク送信 → verify で使い捨て消費 → セッション。
- 同一 email の Google / メールログインは `webuser_email` 経由で同一ユーザーに合流。
- セッション: 128bit ランダム sid、KV 90日、Cookie は httpOnly。
- 引き継ぎ: ログイン後にクライアントが `POST /auth/adopt {token}`（localStorage の旧トークン）。
  ユーザー台帳が空のときだけ `ledgerId = token` に差し替え。

## 環境変数（追加）

`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `PLANCEL_BASE_URL`（省略時は req origin）/
`PLANCEL_KEK` / `PLANCEL_ADMIN_TOKEN` / `PLANCEL_DEV_USER` /
（メールログイン）`RESEND_API_KEY` / `PLANCEL_EMAIL_FROM`

## オーナー側の作業

1. Google Console「データアクセス」でスコープ `calendar.app.created` を追加
2. 「対象」でテストユーザー追加（テスト中は refresh_token が7日失効 → 面倒になったら本番公開）
3. Resend ドメイン検証 + `RESEND_API_KEY` / `PLANCEL_EMAIL_FROM`（メールログインの前提）
4. `PLANCEL_KEK` / `PLANCEL_ADMIN_TOKEN` を Deploy env に設定

# plancel Roadmap

Implementation proceeds by **dependency layer**, not by feature. Layers L2a / L2b / L4 are mutually
independent and can be built in parallel once L1 is done.

| Layer | Contents                                                                               | Depends on |
| ----- | -------------------------------------------------------------------------------------- | ---------- |
| L0    | Zod schemas (single source of truth) + Clock + Store interface + EventLog              | none       |
| L1    | Domain logic (state transitions, quota judgement, policy calculation) — pure functions | L0         |
| L2a   | Notification trigger detection + Outbox + ConsoleNotifier                              | L1         |
| L2b   | MCP server (+ debug tools)                                                             | L1         |
| L3    | Cron scheduler                                                                         | L2a        |
| L4    | Parser pipeline + replay harness (developed against a mock LLM)                        | L0         |
| L5    | LINE (bot entry point + LINENotifier) + real LLM connections                           | L2a, L4    |

## MVP-1 = L0 – L3

Fully local, zero external service connections, end-to-end verifiable via `debug_*` MCP tools and
seed fixtures.

## MVP-2 = L4 – L5

Adds the multi-LLM parser pipeline and the LINE bot entry point (real LLM + LINE messaging quota
apply here).

## v1.x and beyond

Already delivered after MVP-2: Web UI and per-user Web ledger, Google/password/UID authentication,
sharing, iCal subscription, Google Calendar push sync, generic update/delete, production Web API,
remote MCP mode, and installable PWA delivery with an explicit update flow.

Remaining product candidates: bookmarklet entry point and weather-aware deadline notices. Production
acceptance checks are tracked in `docs/VERIFICATION.md`, not as new implementation layers.

Email-forward intake (owner 2026-07-27:
「メールの内容をコピーするのではなく転送してもらうとかがいいな」): **the backend is done** —
`POST /webhook/email` receives Resend's inbound webhook (`src/web/email-intake.ts`), verifies the
Svix signature over the raw body with a 5-minute replay window (`src/web/email-signature.ts`),
resolves the ledger from the per-user receive address `p-<mailSecret>@PLANCEL_INBOUND_DOMAIN` —
never from the forgeable `from` — reads the body through Resend's Received-Emails API, runs the SAME
parser chain as `/api/parse` and LINE, and creates a **candidate** through the same
`createReservation` + calendar-sync hook, filling an unstated policy from the facility template.
Anti-abuse: a per-user 24h cap (`PLANCEL_MAIL_DAILY_CAP`, default 50), a 64KiB raw-body ceiling, a
100KB parser input ceiling, and `["mail_seen", <email_id>]` claimed atomically so a redelivery can
never create a second reservation. Everything the app decides answers 200 so Resend stops retrying;
an unparseable forward writes nothing and tells the forwarder over LINE when they are linked. **The
UI is done too (2026-07-28)**: マイページ shows the address with copy and 再発行 controls, and
「取り込む」 opens the same address inline as 「📨 メールを転送する」 so it is offered where a
reservation is actually added. Forwarding is the one intake route with no confirmation screen, which
both surfaces say. Ops setup (Resend receiving + webhook + the two env vars) is in `docs/DEPLOY.md`
§3.1. Remaining: a real forwarded mail has not yet been run through production end to end.

Facility policy templates (owner 2026-07-27:
「ホテルごとに規定(ベース)を設定できるといいかも。プランごとになるかもだけど基本的に同じことが多いため」):
the backend is done — a per-ledger library keyed by the normalized facility name
(`src/web/policy-template.ts`), its four HTTP routes under `/api/policy-templates`, and the matching
remote-MCP tools. **The web UI is done (2026-07-28)**: the add/edit form looks the facility up and
pre-fills the fee table, offers the 「この施設の規定として覚える」 save, and マイページ lists the
saved defaults for deleting. The 「fill it only when the policy is unknown」 rule now lives once, in
`createReservation` (`src/web/store.ts`), so every intake route — web form, MCP, mail forward, LINE
— applies it identically; it used to be written per-route, and LINE and MCP had simply been missed.

Share roles (owner 2026-07-28: 「招待する時に編集を許可すれば細かい修正を参加者もできるように」):
the backend is done — a `viewer`/`editor` role on the membership (`src/web/sharing.ts`), the `role`
parameter on `POST /api/reservations/:id/members`, the new owner-only
`PATCH /api/reservations/:id/members/:userId`, an editor's PATCH applied to the OWNER's ledger with
the same calendar-sync hook, `updated_by` attribution on every reservation write, and the matching
remote-MCP tools. **The invite UI is done (2026-07-28)**: the invite box carries the 「編集を許可」
checkbox, the member list shows each role and can switch it, and a shared row is editable for an
editor (the list response carries `shared.role`). 確定・キャンセル・削除・招待 stay owner-only, and
the 使い方 says so — confirming settles the whole plan and deleting cannot be undone.

Weather integration (ADR-8): JMA public JSON (key-free, effectively rate-limit-free) behind a
`WeatherProvider` interface (+ Mock/replay, same discipline as Parser/Notifier). Weather enriches
notification messages and adds a `weather_alert` trigger (typhoon approach × unsettled candidates ×
before free-cancellation deadline). Core fire-decision stays weather-free and pure. New design
point: forecast-revision re-notification needs a forecast-generation component in the idempotency
key. Key insight: the value is highest when the free-cancel deadline falls outside the reliable
forecast window (~5-7 days) — the UI/notification should present the loss curve as an insurance
decision, not a weather report.

## LINE v2 (after webhook went live 2026-07-26)

Purpose of the LINE channel: **(1) push deadline reminders / notices to each user's own LINE**
(primary), **(2) let each user check, update, and narrowly add reservations from LINE** (secondary).
Every plancel user has their own LINE account, so the binding is a per-user link (2026-07-27) — not
one env-configured owner. Status and remaining work, in priority order:

| # | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Status                                   |
| - | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1 | Web-ledger deadline reminders via LINE push — `src/web/notify.ts` pushes to the ledger owner's OWN linked LINE account (`user.lineUserId`); users without a link keep email/console. Needs only `LINE_CHANNEL_ACCESS_TOKEN`. Send-quota discipline (2026-07-27): reminders are **bundled into one message per user per sweep** (per-reservation idempotency markers unchanged, written only after that one delivery succeeds), and email is capped per JST day (`PLANCEL_EMAIL_DAILY_CAP`, default 90, counter `["email_quota", <JST date>]`) with the 保証リスト (`PLANCEL_ALLOWED_EMAILS`) served FIRST so the 知人 always get the free-tier quota; LINE-linked users are exempt from the cap                                                                                                                                                                                                                                                                                                                                                                                                                                    | code done; production E2E pending        |
| 2 | "Check" commands from LINE — `確認`/`予定`/`一覧` reply with the SENDER'S OWN WEB ledger's active reservations (status label, free-cancel deadline) plus 次の無料キャンセル期限 / 最大キャンセル料 footer (`src/line/web-commands.ts`); every reply names the account it read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | code done; device check pending          |
| 3 | Narrow "update" commands — Quick Reply `確定:…` / `済:…` postbacks (`webact\|confirm\|<id>`) call the SAME `confirmReservation` / `cancelReservation` + calendar-sync hook as the web API, so plan-sibling auto to_cancel is identical. `set policy` done 2026-07-28: a registration with no readable policy answers with preset Quick Replies (`webact\|policy\|<id>\|<preset>`); a tap saves it and names the deadline it just bought                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | code done; device check pending          |
| 4 | Ledger unification — LINE **add** now writes the SENDER'S OWN WEB ledger: a parsed reservation (text or screenshot, incl. the Quick Reply conflict-resolution path) is created as a web-ledger **candidate** via the same `createReservation` + `onMutate` the HTTP API uses, so it shows up in the web UI. Parsed cancellation policies keep their own stages: `fromCoreStages` (`src/web/policy.ts`) preserves any stage table, collapsing to a preset name (`none`/`free24`/`staged`) only when it matches one exactly; `unknown` is left only when the policy has no percentage form at all (fixed-yen fee, no stages). The core event-sourced ledger remains the sink for standalone/MCP-local mode (`src/line/main.ts` without the `web` dep)                                                                                                                                                                                                                                                                                                                                                                                | code done; device check pending          |
| 5 | Rich menu + command table (owner 2026-07-28「トーク画面に予定を確認するバナーみたいなのを常駐させないと使いにくい」) — the **rich menu itself is configured on the LINE side** (LINE Official Account Manager) by the operator. A menu button can only send a fixed text or open a URL, so `src/line/web-commands.ts` now holds ONE command table — `確認`/`予定`/`一覧`, `締切`/`期限`, `今日`, `今週`, `連携`/`設定`, `使い方`/`ヘルプ`/`help` — matched after NFKC + trim + ASCII lower-case; every command reply carries the command Quick Reply (message actions, so a tap sends what a menu button sends), and a linked sender's ≤12-char text that matches nothing answers with the command list instead of dead-ending in 「読み取れませんでした」 (no ParseJob). The deep-link fragments the replies point at are routed (2026-07-28): `/#import` opens 取り込み, `/#link` the 「連携と通知」 modal at its LINE section, `/#help` the 使い方, `/#mail` the forwarding address. **Remaining: the rich menu's background image must be uploaded in LINE Official Account Manager** (the menu itself is created and waiting) | code done; rich menu image pending       |
| ✓ | Per-user LINE linking (2026-07-27) — `["line_user", <LINE userId>] → userId` reverse index + a one-time 8-char / 10-minute code issued from a logged-in session (`POST /auth/line/code`, `DELETE /auth/line`, `/auth/me → line.linked`). Every LINE command operates on the SENDER'S ledger, so reminders and 確認 reach whoever owns the ledger — not one env-configured owner. `PLANCEL_LINE_OWNER_EMAIL` is gone; `LINE_ALLOWED_USER_IDS` can never block a linked sender; it is a closed-beta gate over UNLINKED senders, so a public account keeps it empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | code done; device check pending          |
| ✓ | Webhook live: deployed env, unsigned-request 401, and LINE Console webhook verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | verified 2026-07-26; message E2E pending |
| ✓ | Core-ledger cron notifications push to LINE (`selectNotifier` → LineNotifier, owner userId)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | done (env-gated)                         |

## Phase 2

Browser extension, direct Gmail reading, paid LLM tiers, public release.

---

See `specs/plancel/design.md` (§ Implementation Order) and `docs/SDD.md` (§9 フェーズ計画) for the
authoritative source of this plan.

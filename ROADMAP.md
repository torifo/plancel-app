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

Remaining product candidates: email-forward parsing, bookmarklet entry point, and weather-aware
deadline notices. Production acceptance checks are tracked in `docs/VERIFICATION.md`, not as new
implementation layers.

Facility policy templates (owner 2026-07-27:
「ホテルごとに規定(ベース)を設定できるといいかも。プランごとになるかもだけど基本的に同じことが多いため」):
the backend is done — a per-ledger library keyed by the normalized facility name
(`src/web/policy-template.ts`), its four HTTP routes under `/api/policy-templates`, and the matching
remote-MCP tools. **The web UI hookup is still pending**: the add/edit form does not yet call
`GET /api/policy-templates/lookup?service=…` to pre-fill the fee table, offer a
「この施設の規定として覚える」 save, or expose a management list for editing/deleting templates.

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

| # | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                   |
| - | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1 | Web-ledger deadline reminders via LINE push — `src/web/notify.ts` pushes to the ledger owner's OWN linked LINE account (`user.lineUserId`); users without a link keep email/console. Needs only `LINE_CHANNEL_ACCESS_TOKEN`. Send-quota discipline (2026-07-27): reminders are **bundled into one message per user per sweep** (per-reservation idempotency markers unchanged, written only after that one delivery succeeds), and email is capped per JST day (`PLANCEL_EMAIL_DAILY_CAP`, default 90, counter `["email_quota", <JST date>]`) with the 保証リスト (`PLANCEL_ALLOWED_EMAILS`) served FIRST so the 知人 always get the free-tier quota; LINE-linked users are exempt from the cap                                                     | code done; production E2E pending        |
| 2 | "Check" commands from LINE — `確認`/`予定`/`一覧` reply with the SENDER'S OWN WEB ledger's active reservations (status label, free-cancel deadline) plus next-deadline / 放置損失 footer (`src/line/web-commands.ts`); every reply names the account it read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | code done; device check pending          |
| 3 | Narrow "update" commands — Quick Reply `確定:…` / `済:…` postbacks (`webact\|confirm\|<id>`) call the SAME `confirmReservation` / `cancelReservation` + calendar-sync hook as the web API, so plan-sibling auto to_cancel is identical. `set policy` deferred (needs a second Quick Reply round)                                                                                                                                                                                                                                                                                                                                                                                                                                                    | code done; device check pending          |
| 4 | Ledger unification — LINE **add** now writes the SENDER'S OWN WEB ledger: a parsed reservation (text or screenshot, incl. the Quick Reply conflict-resolution path) is created as a web-ledger **candidate** via the same `createReservation` + `onMutate` the HTTP API uses, so it shows up in the web UI. Parsed cancellation policies keep their own stages: `fromCoreStages` (`src/web/policy.ts`) preserves any stage table, collapsing to a preset name (`none`/`free24`/`staged`) only when it matches one exactly; `unknown` is left only when the policy has no percentage form at all (fixed-yen fee, no stages). The core event-sourced ledger remains the sink for standalone/MCP-local mode (`src/line/main.ts` without the `web` dep) | code done; device check pending          |
| ✓ | Per-user LINE linking (2026-07-27) — `["line_user", <LINE userId>] → userId` reverse index + a one-time 8-char / 10-minute code issued from a logged-in session (`POST /auth/line/code`, `DELETE /auth/line`, `/auth/me → line.linked`). Every LINE command operates on the SENDER'S ledger, so reminders and 確認 reach whoever owns the ledger — not one env-configured owner. `PLANCEL_LINE_OWNER_EMAIL` is gone; `LINE_ALLOWED_USER_IDS` is legacy and can never block a linked sender                                                                                                                                                                                                                                                          | code done; device check pending          |
| ✓ | Webhook live: deployed env, unsigned-request 401, and LINE Console webhook verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | verified 2026-07-26; message E2E pending |
| ✓ | Core-ledger cron notifications push to LINE (`selectNotifier` → LineNotifier, owner userId)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | done (env-gated)                         |

## Phase 2

Browser extension, direct Gmail reading, paid LLM tiers, public release.

---

See `specs/plancel/design.md` (§ Implementation Order) and `docs/SDD.md` (§9 フェーズ計画) for the
authoritative source of this plan.

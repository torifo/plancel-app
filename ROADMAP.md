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

Email-forward parsing, `.ics` calendar integration, bookmarklet entry point, generic `update`,
physical `delete`.

Weather integration (ADR-8): JMA public JSON (key-free, effectively rate-limit-free) behind a
`WeatherProvider` interface (+ Mock/replay, same discipline as Parser/Notifier). Weather enriches
notification messages and adds a `weather_alert` trigger (typhoon approach × unsettled candidates ×
before free-cancellation deadline). Core fire-decision stays weather-free and pure. New design
point: forecast-revision re-notification needs a forecast-generation component in the idempotency
key. Key insight: the value is highest when the free-cancel deadline falls outside the reliable
forecast window (~5-7 days) — the UI/notification should present the loss curve as an insurance
decision, not a weather report.

## LINE v2 (after webhook went live 2026-07-26)

Purpose of the LINE channel: **(1) push deadline reminders / notices to the owner's LINE** (primary),
**(2) let the owner check, update, and narrowly add reservations from LINE** (secondary). Status and
remaining work, in priority order:

| # | Item | Status |
| - | ---- | ------ |
| 1 | Web-ledger deadline reminders via LINE push — `src/web/notify.ts` routes the owner ledger (`PLANCEL_LINE_OWNER_EMAIL`, default = first `PLANCEL_ADMIN_EMAILS`) to LINE push; email/console stays for everyone else | done (prod-pending redeploy) |
| 2 | "Check" commands from LINE (today / upcoming / next deadline summary) | TODO |
| 3 | Narrow "update" commands (confirm / cancelled-it / set policy via Quick Reply) | TODO |
| 4 | Ledger unification — LINE-added reservations go to the core event-sourced ledger and never appear in the web UI; either bind the webhook to the owner's web ledger or retire one ledger | TODO (decide) |
| ✓ | Webhook live: signature check, allowlist, text/image parse → Quick Reply one-tap review → register | done (prod, 2026-07-26) |
| ✓ | Core-ledger cron notifications push to LINE (`selectNotifier` → LineNotifier, owner userId) | done (env-gated) |

## Phase 2

Browser extension, direct Gmail reading, paid LLM tiers, public release.

---

See `specs/plancel/design.md` (§ Implementation Order) and `docs/SDD.md` (§9 フェーズ計画) for the
authoritative source of this plan.

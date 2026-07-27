[日本語](./README.md) ・ [**English**](./README.en.md)

# plancel — a ledger for tentative bookings and cancellation deadlines

<!-- tech-stack:start (auto-generated) -->
<p align="center">
  <img src="https://img.shields.io/badge/Deno-000000?style=for-the-badge&logo=deno&logoColor=white" alt="Deno">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
</p>
<!-- tech-stack:end -->

For the common pattern of **holding multiple candidate bookings → confirming one at the last minute
→ cancelling the rest**, plancel prevents forgotten cancellations and avoidable cancellation fees.
**Confirming one reservation automatically flips its siblings to "needs cancellation"**, and you get
notified **right before each fee boundary** with the concrete amount at stake. plan + cancel.

```sh
deno task seed        # load demo data
deno task scenario    # one-command E2E: confirm → advance 3 days → list notifications
deno task test        # 514 tests — completes with zero external connections
deno task verify      # fmt + check + lint + test + replay in one go
```

## Why plancel (vs. calendars / booking apps)

Existing tools manage confirmed bookings. plancel covers the window **while candidates coexist**:

- 🔀 **Exclusive candidate groups (Plans)** — the moment one is confirmed, the rest auto-transition
  to `to_cancel`. This transition is the core of the product.
- 💸 **Staged cancellation fees as data** — ANY stage table, not a fixed set of presets: "free until
  5 days out → 30% until 3 days → 100% on the day" is stored as an array (hour-granular boundaries,
  up to 8 stages). `src/web/policy.ts` is the single source for the model and the deadline/loss math
  that the ledger, the LINE summary, the calendar descriptions and the web UI all read. 24h before
  each boundary you get "free if you cancel now / ¥5,400 from tomorrow".
- 🗓 **One-gesture policy entry** — the web form offers 不明 / いつでも無料 / 前日まで無料 /
  期限つき (deadline in days): type the free-cancel deadline as a number of days (5, 10, 14 …) and
  optionally add 「3日前まで30%」 rows. A table matching a preset is stored under the preset name, so
  older records stay compatible.
- 🤷 **Register with unknown policies** — minimal insert friction; a daily digest nudges you to fill
  them in later.
- 🔍 **Every core-ledger state is explainable** — append-only event log with caused_by chains and no
  physical deletes. The authenticated Web ledger is a separate model for sharing and calendar sync.

## Architecture

The core and adapters are separated and consumed by Web, LINE, and MCP entry points. All sources of
nondeterminism (**clock, outbound sends, LLMs**) are isolated behind injectable abstractions, so the
core is deterministically testable offline.

| Directory     | Role                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/`   | Zod schemas (single source), Clock abstraction, Store abstraction (Deno KV / InMemory), pure-function state transitions, event-log folding |
| `src/notify/` | Pure fire-decision + idempotent Outbox + Notifier (Console / LINE / Email=Resend)                                                          |
| `src/mcp/`    | Entry point for Claude (stdio, 11 tools + flag-gated debug tools). No parsing intelligence                                                 |
| `src/parse/`  | Validation-driven fallback parser chain (Groq / Gemini + Mock), PII masking, replay regression harness                                     |
| `src/line/`   | LINE Bot webhook (signature check, per-user LINE link resolving the sender, one-tap Quick Reply review) + LINE notifier                    |
| `src/cron/`   | Thin 15-minute boundary check (Deno Deploy `Deno.cron` / VPS systemd timer)                                                                |
| `src/web/`    | Web ledger, authentication, sharing, iCal / Google Calendar sync, Web API, and PWA asset serving                                           |
| `src/deploy/` | Unified Deno Deploy wiring for Web, LINE, and cron                                                                                         |
| `web/`        | Web UI, PWA manifest, service worker, and 192/512px app icons                                                                              |

Specs: [`specs/`](./specs/) ・ Design decisions (ADR): [`docs/SDD.md`](./docs/SDD.md) ・ Roadmap:
[`ROADMAP.md`](./ROADMAP.md)

## Stack

- **Runtime**: Deno 2.9 (TypeScript, `unstable-temporal` / `unstable-kv`)
- **Validation**: Zod — one schema source validates MCP inputs, parser outputs, and Store boundaries
- **Store**: Deno KV (append-only event log + derived cache; swappable to SQLite via the Store
  interface)
- **Entry point**: Claude MCP (`@modelcontextprotocol/sdk`) + LINE Bot webhook (live in production
  since 2026-07-26; signature path device-verified)
- **Tests**: 514 via `deno test`, shared contract suite across both Store implementations,
  one-command E2E, parse replay regression

## Usage (Claude MCP)

```sh
claude mcp add plancel -- deno run --allow-env --allow-read --allow-write --unstable-temporal --unstable-kv /path/to/plancel/src/mcp/main.ts
```

Then just talk: "hold a table at ◯◯ for 7pm Sat, free cancellation until the day before", "going
with ◯◯".

## Status

**MVP-1 (L0–L3), the parser foundation (L4), and L5 (real LLM / LINE / Email) are implemented. The
Deno Deploy service runs the web UI, authentication, sharing, Google Calendar integration, the Web
API used by remote MCP, and the LINE webhook.** The web UI is PWA-enabled: My Page offers explicit
installation, manual update checks, and one-tap application of a waiting version. LINE is bound
**per user**: My Page issues an 8-character, 10-minute link code (`POST /auth/line/code`,
`DELETE /auth/line`) that the user sends into the LINE chat. Support then includes core- and
web-ledger deadline notifications plus web-ledger "check" (`確認`/`予定`/`一覧`), narrow "update"
(Quick Reply confirm / report-cancelled), and "add" (register parsed text/image input as a
candidate) — **all scoped to the sender's own ledger**; an unlinked chat only gets linking guidance.
Web-ledger actions use the same functions as the Web API, including atomic
plan confirmation, sibling auto-`to_cancel`, invalid reconfirmation rejection, and calendar sync.
The event-sourced core ledger remains available to standalone/local LINE and MCP modes.

Production verification currently covers the deployed LINE environment, unsigned-webhook 401
response, and successful LINE Console webhook verification. End-to-end device checks for LINE
text/image registration and Quick Reply, Resend delivery, Google login and calendar sync, UID login,
remote MCP operations, and sustained cron execution remain open in
[`docs/VERIFICATION.md`](./docs/VERIFICATION.md), together with production-device PWA install and
update acceptance.

External-connection env vars: `GROQ_API_KEY` / `GEMINI_API_KEY` (parsers), `LINE_CHANNEL_SECRET` /
`LINE_CHANNEL_ACCESS_TOKEN`, `LINE_ALLOWED_USER_IDS` (**legacy** — per-user linking is the
authorization now, so production does not need it; still required by the standalone
`deno task line`), `RESEND_API_KEY` (EmailNotifier; from/to are constructor-injected).

Phase 1 is personal + family use on a **¥0 budget** (free tiers only). Public release is Phase 2.

[日本語](./README.md) ・ [**English**](./README.en.md)

# plancel — a ledger for tentative bookings and cancellation deadlines

<!-- tech-stack:start (auto-generated) -->
<p align="center">
  <img src="https://img.shields.io/badge/Deno-000000?style=for-the-badge&logo=deno&logoColor=white" alt="Deno">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript">
</p>
<!-- tech-stack:end -->

For the common pattern of **holding multiple candidate bookings → confirming one at the last minute → cancelling the rest**, plancel prevents forgotten cancellations and avoidable cancellation fees. **Confirming one reservation automatically flips its siblings to "needs cancellation"**, and you get notified **right before each fee boundary** with the concrete amount at stake. plan + cancel.

```sh
deno task seed        # load demo data
deno task scenario    # one-command E2E: confirm → advance 3 days → list notifications
deno task test        # 267 tests — completes with zero external connections
```

## Why plancel (vs. calendars / booking apps)

Existing tools manage confirmed bookings. plancel covers the window **while candidates coexist**:

- 🔀 **Exclusive candidate groups (Plans)** — the moment one is confirmed, the rest auto-transition to `to_cancel`. This transition is the core of the product.
- 💸 **Staged cancellation fees as data** — "free until 7 days out → 30% → 50% → 100%" stored as an array; 24h before each boundary you get "free if you cancel now / ¥5,400 from tomorrow".
- 🤷 **Register with unknown policies** — minimal insert friction; a daily digest nudges you to fill them in later.
- 🔍 **Every state is explainable** — append-only event log with caused_by chains. No physical deletes.

## Architecture

Three layers (core / adapter / MCP). All sources of nondeterminism (**clock, outbound sends, LLMs**) are isolated behind injectable abstractions, so the core is deterministically testable offline.

| Directory | Role |
|---|---|
| `src/core/` | Zod schemas (single source), Clock abstraction, Store abstraction (Deno KV / InMemory), pure-function state transitions, event-log folding |
| `src/notify/` | Pure fire-decision + idempotent Outbox + Notifier (Console → LINE → Email planned) |
| `src/mcp/` | Entry point for Claude (stdio, 11 tools + flag-gated debug tools). No parsing intelligence |
| `src/parse/` | Validation-driven fallback parser chain, PII masking, replay regression harness |
| `src/cron/` | Thin 15-minute boundary check (Deno Deploy `Deno.cron` / VPS systemd timer) |

Specs: [`specs/`](./specs/) ・ Design decisions (ADR): [`docs/SDD.md`](./docs/SDD.md) ・ Roadmap: [`ROADMAP.md`](./ROADMAP.md)

## Stack

- **Runtime**: Deno 2.9 (TypeScript, `unstable-temporal` / `unstable-kv`)
- **Validation**: Zod — one schema source validates MCP inputs, parser outputs, and Store boundaries
- **Store**: Deno KV (append-only event log + derived cache; swappable to SQLite via the Store interface)
- **Entry point**: Claude MCP (`@modelcontextprotocol/sdk`); LINE Bot planned
- **Tests**: 267 via `deno test`, shared contract suite across both Store implementations, one-command E2E, parse replay regression

## Usage (Claude MCP)

```sh
claude mcp add plancel -- deno run --allow-env --allow-read --allow-write --unstable-temporal --unstable-kv /path/to/plancel/src/mcp/main.ts
```

Then just talk: "hold a table at ◯◯ for 7pm Sat, free cancellation until the day before", "going with ◯◯".

## Status

**MVP-1 (L0–L3) + parser foundation (L4) implemented**, verifiable with zero external connections. Deploy target: Deno Deploy (VPS fallback). Next: real LLM parsers (Groq / Gemini free tier) → LINE Bot entry → Email notifications → weather (typhoon) integration.

Phase 1 is personal + family use on a **¥0 budget** (free tiers only). Public release is Phase 2.

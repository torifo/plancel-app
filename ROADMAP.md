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

## Phase 2

Browser extension, direct Gmail reading, paid LLM tiers, public release.

---

See `specs/plancel/design.md` (§ Implementation Order) and `docs/SDD.md` (§9 フェーズ計画) for the
authoritative source of this plan.

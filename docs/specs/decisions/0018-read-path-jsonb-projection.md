# ADR 0018 — Read-path jsonb projection + `describe_context` sync mode + duration instrumentation

**Status:** Accepted · shipped wave-11d (`read-path-roundtrip-reduction`, merged into `main`).

## Context

The gateway's speed moat is **round-trip count, not per-call latency** — a cache read is already milliseconds, but each agent round-trip is a full inference turn (read result → think → next call). Dogfooding a remote agent showed the cost concretely: reaching a detail value that lives in `raw` (e.g. a Home Assistant error string in `attributes`) took `query` → `get_record`, two network hops + two turns. Separately, an agent had no factual signal for whether a sector's cache was already live (push) and so issued needless `fetch_live` calls. And every perf decision beyond this was a guess — nothing measured read latency.

## Decision

1. **Project (not filter) jsonb.** `query()`'s `select` may include a sector's jsonb columns (`raw` on every sector; `attributes` on home, `attendees` on calendar) so a row **and** its raw detail return in one call. Projection only: `where` / `orderBy` / `aggregate` / `groupBy` keep validating against flat REGISTRY `fields` exclusively — jsonb stays **non-filterable / non-sortable / non-aggregatable**. The default `select` (omitted) is unchanged — flat fields only, so `raw` is never returned unless explicitly requested (payloads stay lean; the per-row TOAST fetch is opt-in).
2. **Expose sync `mode` in `describe_context`.** Each connection reports its connector's `SyncPolicy.mode` (`push|poll|on_demand|null`) — a factual signal so the agent can skip `fetch_live` on a push-fresh sector. No derived freshness/staleness policy (no LLM on our side).
3. **Instrument every core read.** `query`/`getRecord`/`fetchLive` are wrapped to log `{sector, mode, rows, duration_ms}` to stderr **after** the result resolves (off the hot path; never blocks/throws into the read; stdout stays clean for MCP stdio). No timing data on the wire.

## Consequences

- "Find it + read its detail" is one call, not two — removes an inference turn (the real moat win). The `mode` hint removes a needless upstream hop on push sectors.
- The perf program becomes **evidence-driven**: the parked `read-path-perf-hardening` levers (L2/L3/L5/L6/L8) now earn (or fail to earn) their complexity from real `duration_ms` numbers rather than speculation. (This ADR ships L7 and reframes L4 from "never select `raw`" to "never select `raw` *by default*".)
- **SQL-safety preserved:** projected jsonb names are REGISTRY-declared identifiers, never agent-interpolated; the timing meta carries only sector/mode/counts, never values or secrets.
- **Supersedes** the prior CLAUDE.md claim that jsonb columns are "store-only until the query engine supports them" — they are now projectable (still not filterable).

## Alternatives rejected

- jsonb **filtering** / JSON-path extraction — still future; this is projection only.
- A derived freshness label in `describe_context` — only the factual `mode` here.
- Returning `duration_ms` on the wire — stderr logging only this unit.

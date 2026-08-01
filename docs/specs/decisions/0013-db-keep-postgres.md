# ADR 0013 — Database engine: keep Postgres (V1 / dogfood)

**Status:** accepted · **Date:** 2026-06-14 · **Context:** the 2026-06-14 direction reset (dogfood-first)

## Context

V1 packaging is a Docker Compose stack: a `postgres:16` container + the app, talking over the compose
network (ADR 0009). Before the dogfood phase the question was raised whether to keep Postgres or move to SQLite —
the heaviest dependency for a "run it **locally**" tool is requiring Docker + a Postgres container.

## Decision

**Keep Postgres for V1 and the dogfood phase.** No engine change.

Reasons:
- **The code is Postgres-deep.** `jsonb` (every `raw` column + `attributes`/`attendees`), `text[]` (mail
  `labels`), `pg_advisory_lock` (the migrator's concurrency guard, ADR 0010), `gen_random_uuid()`, partial +
  composite indexes, `is distinct from` null semantics (query-v2), and the planned `to_tsvector` full-text for
  mail-body search. SQLite would be a real rewrite and would lose JSONB richness (JSON1 is weaker).
- **Concurrency.** Multiple agents + the poll scheduler + push + the REST edge all hit the DB concurrently;
  Postgres handles that natively. SQLite is single-writer.
- **One backend.** The (parked) hosted tier needs Postgres regardless — SQLite would mean maintaining two
  storage backends forever.
- **It already works.** The `docker compose up` smoke passed; for dogfooding (real data, one operator) the
  Postgres-in-Docker path is proven.

## Consequences

- The one real downside — **Docker friction for a pure-local tool** (some users won't want Docker) — is a
  **packaging** problem, NOT a DB-engine problem. It is solvable *after* dogfooding **without** a rewrite:
  embedded Postgres (`pglite` / postgres-wasm) or a bundled-Postgres `npx` path can give "no Docker" while
  keeping Postgres SQL. Tracked as a post-dogfood packaging task, not now.
- The **stress-test/volume** question (10k+ mail envelopes, multi-year finance, concurrent agents — does the
  "Postgres-is-the-cache, bounded-full / unbounded-lazy" footprint model hold) is a dogfood-phase finding, not
  an engine decision. Revisit indexing/footprint empirically during dogfooding, on Postgres.
- Revisit the engine only if dogfooding surfaces a concrete Postgres limitation the above options can't fix.

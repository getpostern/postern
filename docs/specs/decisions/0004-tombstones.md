# ADR 0004 — Tombstones: source deletions in the faithful cache

**Status:** accepted · **Date:** 2026-06-09 · **Wave:** 4 (`tombstones-engine` ‖ `ha-removals` ‖ `query-v2`)

## Context

The cache was strictly upsert-only: Plaid `removed` ids were warn-logged and dropped, and Home
Assistant entities removed at the source stayed in `home_entities` forever — still served by
`query()`, still resolvable as action targets ("unlock the front door" against a deleted entity).
Silent staleness is the credibility killer for a *faithful* cache.

## Decision

1. **Tombstone, never hard-delete.** Every domain table gains `deleted_at timestamptz` (null =
   live). A source-removed object keeps its row, normalized columns, and `raw` — the lossless-cache
   invariant — but is stamped `deleted_at = now()`.
2. **Deletion is provider-signaled state, not derived data.** A tombstone is only ever set from a
   provider deletion signal (Plaid `removed`) or a faithful snapshot reconcile (HA `get_states` ∪
   entity-registry diff). No inference, no correlation.
3. **Last writer of a live record resurrects.** EVERY live-record write path explicitly clears
   `deleted_at` (runner upsert AND HA's hand-rolled `upsertEntity`). A wrong or stale tombstone
   self-heals on the next live sighting.
4. **Deletes take a dedicated UPDATE path** (`set deleted_at = now() where connection_id and
   source_object_id`), never the upsert — a deletion stub must not overwrite normalized
   columns/`raw`, and an unknown id must not insert a ghost row.
5. **Read semantics:** `query()` (and aggregates) serve only `deleted_at is null`. `get_record` is
   the **truthful drill**: it returns the row with `deleted_at` visible (documented in the tool
   description) — an agent holding a stale id learns the truth instead of an unexplained null.
6. **`deleted_at` is NOT in the REGISTRY** — an infra column like `ingested_at`, invisible to
   `get_schema`/`query` filtering.
7. **SimpleFIN: no deletion detection (accepted gap).** The `/accounts` API has no removal signal;
   window-diffing the 3-day overlap risks mass-tombstoning on a flaky bridge response. Removed bank
   transactions are rare corrections; revisit with the conformance harness.
8. **Plaid backlog: one-time cursor reset at rollout.** Pre-rollout `removed` ids are already past
   the cursor; `connectors.cursor` is nulled for `provider='plaid'` at merge so one full
   re-walk applies history (idempotent upsert absorbs the replay).

## Consequences

- Schema pre-stage adds the column to all NINE domain tables + idempotent `alter table … add column
  if not exists` backfill (the `create table if not exists` statements alone would no-op on the
  existing volume-backed database and brick every sync).
- HA reads that feed actions (`resolveSelector`, `loadCachedEntities` catalog) must filter
  tombstones, or removed entities remain action targets.
- Future connectors declare their deletion detection in the spec (explicit signal, snapshot
  reconcile, or accepted-none) — a conformance-harness check later.

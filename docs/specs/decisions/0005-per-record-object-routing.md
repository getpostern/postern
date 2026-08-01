# ADR 0005 — Per-record object routing (`RawRecord.object`)

**Status:** accepted (backfilled) · **Date shipped:** 2026-06-07 (day 2, `app-bootstrap` + `simplefin`) · **Recorded:** 2026-06-13
**Context wave:** Day 2 finance connectors. Backfilled per working-style rule 7 (a shipped, load-bearing mechanism that lacked an ADR; the connector wave depends on it).

## Context

The original connector model assumed one connector → one domain table (`connector.objectType` named the single destination). But real sources emit **multiple object types in one sync stream**: SimpleFIN returns accounts AND transactions; Whoop will return recovery + sleep + workout; a calendar returns events that are one object but contacts another. Forcing one table per connector would mean either N connectors per credential or a bespoke fan-out in every connector — neither generic.

## Decision

1. **`RawRecord` carries an optional `object` field** (`src/connectors/types.ts`). A connector tags each yielded record with its destination object type; unset falls back to `connector.objectType` (single-object connectors are unchanged).
2. **The runner resolves the destination table PER RECORD** via `tableForObject(sector, objectType)` (`src/sync/runner.ts`), not once per connector. One connector fans a single `sync()` stream out across multiple domain tables (SimpleFIN → `finance_accounts` + `finance_transactions`).
3. **The cursor stays GLOBAL per connection** — it tracks progress through the source stream, not per table. The runner persists the last non-null `RawRecord.cursor` regardless of which object types the stream interleaved.
4. **`tableForObject` is fail-closed** — an unknown `(sector, object)` pair throws, flipping the connection to `status='error'` rather than silently dropping or misrouting a record. Only REGISTRY-known tables are ever written.
5. **REGISTRY keys encode the object** — multi-object sectors use dotted keys (`finance.account`, `finance.transaction`, `health.sample`, `health.workout`, `health.sleep_session`); the `object` value maps to the dotted key under the connection's sector.

## Consequences

- A new multi-object connector adds no control-plane change: it yields records tagged with `object`, and the REGISTRY + domain tables already define the destinations. (Whoop health.* is the next consumer.)
- Single-object connectors (Home Assistant, mail, contacts, calendar) ignore the field entirely — additive, no migration.
- Strong keys / `source_object_id` remain per-object (the `unique(connection_id, source_object_id)` key is per destination table), so two object types from one stream never collide.
- Pairs with ADR 0006 (multi-sector routing): `object` selects the table WITHIN a sector; `sector` (ADR 0006) selects the sector. Together they let one credential and one connector instance populate any combination of sectors × objects.

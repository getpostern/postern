# REGISTRY objects, domain tables, migrations

## Adding a REGISTRY object

The REGISTRY is `src/core/schema.ts:46`; its entry type `SectorSchema` (`src/core/schema.ts:3`) documents every field with the reasoning inline. A new sector object = one REGISTRY entry + one domain table. It is never a control-plane change.

- **Key naming.** Multi-object sectors use dotted `sector.object` keys (`finance.account`, `health.workout`); single-object sectors use the bare sector name (`mail`, `home`). `getSchema()` prefix-matches, so `getSchema("finance")` returns every finance object — the key prefix *is* the sector, and `tableForObject(sector, object)` resolves on it (`src/sync/runner.ts:85`).
- **`fields` holds flat scalars only.** That map is the entire filter/sort/aggregate surface: `where` / `orderBy` / `groupBy` / `aggregate` validate against it and nothing else.
- **`jsonb` is projectable, not filterable.** Columns listed there (`raw` everywhere, plus `attendees` on calendar, `attributes` on home) can be pulled via `select` for one-call find-then-detail, but never filtered, sorted, or aggregated. Array columns (mail `labels`) and scoping/audit columns (`connection_id`, `user_id`, `ingested_at`) are deliberately absent — arrays aren't queryable yet, and scoping is applied by core, never by the agent.
- **`primaryTime`** is the default sort column *and* the column both indexes below are built on. Pick the field an agent would naturally range over.
- **`serveDeduped`** is finance-only (it makes `query()` append one `shadowed_by_id is null` predicate). Leave it undefined anywhere else — an unset flag emits no clause at all, which is what keeps every other sector's SQL byte-for-byte unchanged.

## The REGISTRY doubles as the ingest write allow-list

`applyRecords` (`src/sync/runner.ts:218`) validates every key `normalize()` emits against the resolved entry's `fields` and throws fail-closed on an unknown one — obligation H2, the throw at `src/sync/runner.ts:287`. Two consequences worth internalizing before you add a column:

- Adding a column to `fields` **grants connectors permission to write it**, not just agents permission to read it. Columns that core owns and connectors must never set — `deleted_at`, `shadowed_by_id`, `dedup_group_id` — are kept out of `fields` on purpose, and reach the agent (when they do) as a read-only core-applied projection instead.
- `source_object_id` in the reserved `union:%` namespace is rejected at ingest, on both live writes (`src/sync/runner.ts:280`) and tombstones (`:247`). That namespace belongs to the finance-dedup engine's synthetic winner rows.

## The domain-table template

One table per REGISTRY object, all on the same shape — `db/migrations/0001_baseline.sql:300` (`calendar_events`) is a representative one, and `db/migrations/0010_finance_holdings.sql` is the best end-to-end example of adding a *new* one (table + all three indexes in a single migration).

```
id                uuid primary key default gen_random_uuid()
connection_id     uuid not null references connectors(id) on delete cascade
user_id           uuid not null references users(id)
source_object_id  text not null
<normalized flat scalar columns>
<jsonb columns: raw, plus any drill-only structure>
ingested_at       timestamptz not null default now()
deleted_at        timestamptz            -- tombstone; null = live (ADR 0004)
unique (connection_id, source_object_id)
```

No joins between domains, ever. The unique constraint is the upsert conflict target the generic `buildUpsert` relies on (H4). Source-removed objects are **stamped `deleted_at`, never hard-deleted**; every live write clears it, `query()` serves only live rows, `get_record` still drills truthfully.

**Two indexes per new table**, both required:

- the scope index `(user_id, connection_id, <primaryTime>)` — the per-connection drill;
- the companion partial `(user_id, <primaryTime> desc, id) where deleted_at is null` — this is what makes the default no-connection sector query an O(limit) index walk instead of a full-table top-N sort. The reasoning and the full set are in `db/migrations/0006_perf_primarytime_index.sql`; a `serveDeduped` table folds `shadowed_by_id is null` into the same partial predicate (see `db/migrations/0009_finance_dedup.sql`).

## Migrations

Forward-only. Files are `db/migrations/NNNN_<slug>.sql`, applied in numeric order, one transaction each, under an advisory lock, with the version + a checksum recorded in `schema_migrations`. There are **no down migrations**, and **editing an already-applied migration is a hard error** that refuses boot. The runner is `src/db/migrate.ts` and its header explains the whole model.

- **A new migration takes `max(version) + 1`** — read the highest number in `db/migrations/` and add one. Never hardcode the next number from a document: this line has been stale before. **`0015` is permanently reserved and must never be back-filled** — a renumbering left that slot empty, and filling it now would make the sequence ambiguous for every database that already skipped it. Re-check `db/migrations/` immediately before you commit: parallel worktrees and un-merged specs claim numbers, and a collision is only visible at merge time. Renumbering is cheap before merge and expensive after.
- Write idempotent DDL (`create table if not exists`, `create index if not exists`, guarded `alter`) — `0001_baseline.sql` is a no-op replay on already-existing databases, so every later migration must survive being applied to a DB that already has the object.
- `npm run migrate` applies; `npm run migrate:status` reports. Boot runs migrations too and refuses to start on failure. `npm run test:db` creates and migrates `pci_test` before running the suite; `db/schema.sql` remains only as the raw `db:schema` escape hatch and is not the source of truth.

# ADR 0010 — Forward-only migrations

**Status:** accepted · **Date:** 2026-06-13 · **Wave:** 9B (`migrations`)

## Context

Schema lived in one flat `db/schema.sql` applied by `npm run db:schema` (raw `psql` pipe — no
transaction, no record of what ran), plus a hand-maintained `alter table … add column if not exists`
block. That expresses only **additive** change; renames/type-changes/drops/backfills have no idempotent
form, there's no applied-state record or ordering, and a mid-file failure half-migrates. The first real
schema change after shipping (with real user data) was data-loss roulette.

## Decision

A minimal forward-only migrator (node + `pg`, no ORM) — `src/db/migrate.ts`:
1. **`schema_migrations`** ledger (`version` pk, `name`, `checksum`, `applied_at`), created by the runner
   outside any tracked migration.
2. **Ordered immutable files** `db/migrations/NNNN_<slug>.sql`; `0001_baseline.sql` = the current
   `db/schema.sql` **verbatim** (already fully `if not exists`).
3. **Algorithm:** `pg_advisory_lock` (serialize concurrent boots/replicas) → read files sorted →
   **checksum drift-guard** (an edited already-applied file = hard error: applied migrations are
   immutable) → apply each pending file in its **own** `BEGIN/exec/COMMIT` (a failure rolls back THAT
   migration; earlier stay recorded) → unlock. **Fail-closed** (throws → 9A's boot refuses to start
   behind the code).
4. **Baseline = run-and-record:** because `0001` is `if not exists`, running it on an existing `pci` +
   the per-unit test DBs (which already have the tables) is a safe no-op, then recorded; a fresh DB is
   created + recorded by the same call. A `--mark-applied <version>` escape hatch records without
   executing (for a future non-idempotent baseline).
5. **Forward-only** — no down migrations (recovery = restore-from-backup + a fix-forward migration).
   `db/schema.sql` stays as the raw `db:schema` escape hatch; `npm run migrate` is canonical.

## Consequences

- Future schema changes are a new `NNNN_*.sql` — never an edit to an applied file or the hand `alter`
  block. The hazard ("keep the alter block in sync by hand") is gone.
- 9A runs `runMigrations()` at boot + in the container entrypoint (fail-closed).
- Follow-ups (recorded, minor): acquire the advisory lock before the (idempotent) ledger-create; the
  drift-guard skips a NULL stored checksum; a future non-transactional migration (e.g. `CREATE INDEX
  CONCURRENTLY`) needs an opt-out of the per-file transaction.

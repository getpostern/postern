# ADR 0015 — Test-DB isolation: a fail-closed guard, run only on a disposable *_test database

**Status:** accepted · **Date:** 2026-06-17 · **Context:** the 2026-06-17 finance-wipe during the dogfood phase

## Context

The DB-gated test suites (~16% of tests, skipped when `DATABASE_URL` is unset) exercise the real vault, sync, query, and REST paths against a live Postgres — and several of them MUTATE and DELETE rows. `src/rest/admin.db.test.ts` in particular drives the admin revoke/erase paths, which delete seed-user `provider_credentials` whose FK cascade removes the connector and every domain row under it.

On 2026-06-17, with `DATABASE_URL` pointed at the single shared `pci` database that also holds real data, a local run of `admin.db.test.ts` deleted the seed-user SimpleFIN credential and FK-cascaded ~700 finance rows out of the live store. The root cause was structural: **one shared `pci` database served both the running app and the test suite**, so a test run was one `npm test` away from destroying real data. Test-side hygiene (throwaway users, tighter delete predicates — tracked separately as sub-unit 17b) reduces the blast radius but does not remove the structural hazard: nothing *prevented* the suite from connecting to a non-disposable DB in the first place.

## Decision

**The test suite runs only against a disposable database whose name ends in `_test` (canonically `pci_test`), enforced by a fail-closed guard that aborts the run before any test module loads.**

1. **Fail-closed guard** — `vitest.globalSetup.ts`, wired as `test.globalSetup` in `vitest.config.ts`, runs ONCE before any test module. Rule:
   - `DATABASE_URL` unset → no-op (DB-gated suites self-skip via their own `HAS_DB` check).
   - db name matches `/_test$/i` → allow.
   - `PCI_TEST_DB === '1'` → allow (a deliberate, documented escape hatch).
   - otherwise → throw, naming the offending DB and the remedy, which aborts the entire run.
   The db name is parsed as the last path segment of `new URL(DATABASE_URL)` (dependency-free). The thrown message names the **DB only** — never the full URL or its password.
2. **Disposable DB everywhere** — CI's ephemeral Postgres service container is renamed `pci` → `pci_test` (pure rename; the container is thrown away each run), so CI keeps running the full DB-gated suite and now passes the guard via the name rule. Local runs use `npm run test:db`, which creates/migrates/runs against `pci_test`. `.env.example` documents that its `DATABASE_URL` is the app/dev DB and the suite needs a separate `pci_test`.

Coverage is preserved — nothing is disabled or skipped; only the *target database* is constrained.

## Consequences

- It is now structurally impossible to run the suite against the live `pci` database (or any non-`_test` DB) without consciously setting `PCI_TEST_DB=1`. The fat-finger path that caused the finance-wipe is closed.
- The guard is fail-closed and dependency-free, so it cannot itself become a silent no-op: an unparseable or non-`_test` URL aborts rather than proceeds.
- The escape hatch (`PCI_TEST_DB=1`) exists for the rare case of a deliberately-named scratch DB that does not end in `_test`; it is explicit and audited by its own visibility in the command line.
- Restoring the wiped dogfood data is a separate recovery (the 9C `pg_dump` backup, ADR 0011); this ADR prevents the recurrence, it does not undo the incident.
- Sub-unit 17b (per-test throwaway users + delete-predicate tightening) is complementary defense-in-depth and is tracked independently.

# ADR 0012 — Data control plane (manage + own your data)

**Status:** accepted · **Date:** 2026-06-14 · **Wave:** 10 (`data-control-plane`)

## Context

The gateway could ingest + serve data but gave the operator no way to **manage or own** it: no
pause/disconnect, no way to revoke a credential, no erase, no portability export, no operator-triggered
sync, and only a bare connector list. This is the data layer the (next) Console lifecycle UX consumes, and
the safety floor for putting real data in during dogfooding.

## Decision

1. **Three independent, orthogonal verbs** (deliberately not a two-tier delete):
   - **pause/resume** — flip `connectors.status` paused⇄active (the scheduler/push loops only pick up
     `active`/`error`, so a pause just stops; push gets a best-effort `stop()`). Keeps data; reversible.
   - **revoke-credential** — flip the credential + ALL its connectors to `revoked` (one txn) and
     `deleteSecret` the vault token(s). **KEEPS the cached domain rows** (read-only orphaned cache) and
     **does NOT delete the credential row** — the FK `on delete cascade` would wipe connectors → domain
     rows, breaking verb independence. Re-onboard to reconnect.
   - **erase** — destroy cached data (below). "forget-data" in UI language == erase at connection scope.
   The Console composes these for a "remove completely" button; the core exposes only the primitives.
2. **Erase = real hard-delete** (`DELETE`), NOT a tombstone. Tombstone (ADR 0004) is the *fidelity*
   mechanism for source-removed objects (last-writer-**resurrects** — a soft-erase would be undone by the
   next sync while the connector is live, and leaves `raw` on disk). Operator erase is *custody/destruction*:
   the bytes leave. Scope = connection | sector | all, all `user_id`-scoped, only REGISTRY table names in
   SQL, all values parameterized. Gated by a **confirmation token** (`confirm` must equal the connectionId /
   sector / `ERASE-ALL`) checked BEFORE any DELETE → a mismatch is 400 with zero rows touched. The Console
   offers an **export first**. (`VACUUM`/backup-WAL caveats → runbook.)
3. **Export = a single JSON bundle** (`manifest` + `data`, includes `raw`; live rows only). Portability /
   takeout + the pre-erase safety copy. **No import path** — faithful-cache: "undo an erase" = reconnect +
   re-sync from the live source; "restore the whole gateway" = the 9C `pg_dump` backup/restore (ADR 0011).
   **Operator-only (loopback `localOnly`), NOT a bearer/agent route** — it returns everything unscoped, so it
   must be the operator at the box; an agent's data access stays the sector-grant-scoped, capped `query` mirror.
4. **Audit kept intact** on erase (it records actions/metadata, not row values — preserves "audit is the only
   oversight"). The destructive admin ops (erase/revoke/pause/resume/sync_now) now **write an async audit
   entry** (`agent_id='operator'`) — advancing the wave-11 "audit the admin mutations" item for the
   high-stakes ones. `AuditTool` extended with these verbs.
5. **Operator sync-now** (per-connection): poll/on_demand → `syncConnection` with a 30s bounded wait;
   push → no-op (the source reconciles itself). **Enriched status**: `GET /api/connectors` now returns
   `last_error`/`last_error_at`, `scopes`, `policy_mode`, `next_sync_at`, credential `{status, expires_at}`,
   `webhook_secret_set_at`; `GET /api/connectors/:id` adds per-table live-row counts. New additive columns
   `connectors.last_error`/`last_error_at` (migration `0002`, idempotent — the first real use of the 9B
   migrator); `markError` records the **masked, secret-free** reason, the success write-back clears it.
6. **Authorization = loopback only.** Every new route is `localOnly` (the Host-allowlist DNS-rebinding guard).
   The erase `confirm` token is a **fat-finger guard, NOT auth** — if `/api/erase` were ever wired without
   `localOnly` it would be an unauthenticated data-destruction primitive. The wiring is applied at merge.
7. **Finance backfill parity:** Plaid Link now requests `days_requested: 365` to match SimpleFIN's
   one-year default (was Plaid's ~90-day default) — a neutrality fix, not a control-plane change.

## Consequences

- The operator can pause/revoke/erase/export/sync/inspect — the "own + manage your data" floor for dogfooding.
- The merge folded two security nits: sync-now's returned error is now `maskError`-ed (the durable
  `last_error` already was); each `deleteSecret` in revoke is guarded so a failure can't orphan-and-skip-audit.
- Recorded nits (non-blocking): empty `?sector=` falls through to a full export (benign); confirm-mismatch
  isn't audited (intentional — a fat-finger, not a security event); `raw` in an export faithfully includes
  whatever a connector stored (connector hygiene, bounded by loopback-only access). No JSON import; no
  composite "delete-everything" verb; no scheduled/auto erase or trash-can (parked); no `VACUUM` automation.

## Wave 11b extension — Disconnect (#18) + functional Revoke (#8)

A `disconnect` verb (`DELETE /api/connectors/:id`, `lifecycle.disconnectConnection`, the router's first `delete()`) completes the clean-slate floor: connectionId- + user-scoped, it best-effort-stops the connector, hard-deletes the connector row + its domain rows, and removes the shared credential + its vault secret **only when its last connector goes** — the sibling count is taken AFTER the connector delete, and the FK `ON DELETE CASCADE` can only delete a connector, never orphan a live sibling (so a Google credential's contacts+calendar siblings are safe). Reuses the erase confirm-token (echo the connectionId; a fat-finger guard — loopback is the only authz). Also closes #8: `credentialId` is now exposed on the connector-detail contract (`STATUS_SELECT` / `ConnectorDetail`), so the soft Revoke button (`status='revoked'`, keeps data) is no longer a no-op. The route is wired in `src/rest/index.ts` at merge-time integration, with a DB-free dispatch test in `app.test.ts`.

-- sync-cadence-control (ADR 0025) — per-connection poll cadence override.
-- Poll cadence is a USER setting bounded by CONNECTOR policy: effective = clamp(user_override ??
-- connector_default, floor: policy.minIntervalSec), computed in ONE helper (effectiveIntervalSec)
-- shared by the scheduler, next_sync_at, and both freshness call sites so the timer, the displayed
-- expectation, and the staleness judgment can never disagree. Nullable, no SQL default — null =
-- "use the connector's defaultIntervalSec" (a user who never touches this sees zero change). The
-- Console sets it via POST /api/connectors/:id/sync-interval; the API rejects below-floor with a
-- typed 400 (never a silent clamp of explicit input); the scheduler clamps at read time anyway so a
-- hand-edited row cannot hammer a provider. Additive + idempotent (0005/0011 template).
alter table connectors add column if not exists sync_interval_sec int;

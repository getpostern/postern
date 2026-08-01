-- Wave 10A — connector last-error surface.
-- Records the MASKED, secret-free reason from the last failed sync so the operator/Console can see
-- WHY a connection is in status='error'; the next successful sync write-back clears both columns.
-- Additive + idempotent (re-applies safely on an existing volume; `add column if not exists` no-ops).
alter table connectors add column if not exists last_error    text;
alter table connectors add column if not exists last_error_at timestamptz;

-- push-freshness-honesty (#39/#40, ADR 0023) — persisted push-stream health.
-- Three additive nullable columns on connectors, SEPARATE from status (the scan/ingest/describe
-- filters keep their exact semantics — deliberately NEW COLUMNS, not a new status value) and from
-- last_error (the poll-sync fault channel):
--   stream_state      'connected' | 'retrying' | 'down' (text, unconstrained like status)
--   stream_error      the MASKED, secret-free reason while the stream is not connected
--   stream_changed_at stamped ONLY on a stream_state TRANSITION ("since when" for Console/agents)
-- Additive + idempotent (re-applies safely on an existing volume; `add column if not exists` no-ops).
alter table connectors add column if not exists stream_state      text;
alter table connectors add column if not exists stream_error      text;
alter table connectors add column if not exists stream_changed_at timestamptz;

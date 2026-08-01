-- Wave 12a — per-connection mail recency window (#22).
-- Unbounded mail connectors (Microsoft Graph, Gmail IMAP) previously pulled ALL history, so a heavy
-- mailbox meant a slow, page-capped, token-expiry-prone initial sync. Bound the fetch to a configurable
-- recency window: the runner reads sync_window_days for a mail connection and threads it into
-- SyncContext.windowDays (default 180 days in CODE when this column is null — NO migration backfill, so
-- existing + new mail connections default to a 6-month window). null = all-history opt-in. The Console
-- sets it via POST /api/connectors/:id/sync-window. Non-mail connectors ignore the field.
-- Nullable, no SQL default (the 180-day default is applied in code at read). Additive + idempotent.
alter table connectors add column if not exists sync_window_days int;

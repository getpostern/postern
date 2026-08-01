-- Wave 11e — primary-time partial index (kill the full-table sort on the default sector query).
-- The existing hot index leads (user_id, connection_id, <primaryTime>), but the most common screen's
-- query has NO connection filter and orders by <primaryTime> desc — so Postgres can't walk that index
-- in time order; it reads all of the user's matching rows and runs a top-N Sort (at single-operator
-- scale user_id prunes nothing, so it effectively reads + sorts the whole table every time).
-- Add one partial index per domain table leading (user_id, <primaryTime> desc, id) WHERE deleted_at
-- is null — matching query()'s exact ORDER BY (<primaryTime> desc, id asc) AND the predicate it always
-- appends (deleted_at is null) — so the default query becomes an O(limit) index walk with NO Sort node.
-- The trailing id column covers the within-ties tiebreak, eliminating even the residual sort.
-- The existing (user_id, connection_id, <primaryTime>) "scope" indexes are KEPT (the per-connection
-- drill still needs them). Additive + idempotent (create index if not exists). primaryTime per table
-- is taken from the src/core/schema.ts REGISTRY. Small single-operator tables — plain (non-CONCURRENTLY)
-- CREATE INDEX inside the migrator's transaction is fine at this scale.
create index if not exists finance_accounts_user_primarytime      on finance_accounts      (user_id, balance_at desc, id)      where deleted_at is null;
create index if not exists finance_transactions_user_primarytime  on finance_transactions  (user_id, posted_at desc, id)       where deleted_at is null;
create index if not exists health_samples_user_primarytime        on health_samples        (user_id, window_start desc, id)    where deleted_at is null;
create index if not exists health_workouts_user_primarytime       on health_workouts       (user_id, started_at desc, id)      where deleted_at is null;
create index if not exists health_sleep_sessions_user_primarytime on health_sleep_sessions (user_id, started_at desc, id)      where deleted_at is null;
create index if not exists mail_messages_user_primarytime         on mail_messages         (user_id, received_at desc, id)     where deleted_at is null;
create index if not exists contacts_user_primarytime              on contacts              (user_id, updated_at desc, id)      where deleted_at is null;
create index if not exists calendar_events_user_primarytime       on calendar_events       (user_id, starts_at desc, id)       where deleted_at is null;
create index if not exists home_entities_user_primarytime         on home_entities         (user_id, state_timestamp desc, id) where deleted_at is null;

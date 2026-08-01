-- Wave 12 (finance dogfood, #34b) — cross-provider deterministic dedup, 3-row synthetic-union.
--
-- The same real-world account/card connected via TWO providers (e.g. Amex via Plaid + SimpleFIN) is
-- deduped deterministically WITHIN finance (ADR 0021). The store holds THREE rows per dedup group:
-- both provider rows kept PRISTINE (never mutated) + SHADOWED (shadowed_by_id → the winner), PLUS one
-- explicitly-SYNTHETIC best-per-field winner (source_object_id='union:…', raw=null, dedup_status='winner')
-- that query() serves via a single reversible `shadowed_by_id is null` predicate.
--
-- New columns (all nullable; null shadowed_by_id = served — the synthetic winner OR a single-provider
-- unique row). Forward-only (ADR 0010).
alter table finance_accounts     add column if not exists mask            text;
alter table finance_accounts     add column if not exists org_domain      text;
alter table finance_accounts     add column if not exists shadowed_by_id  uuid;
alter table finance_accounts     add column if not exists dedup_status    text;
alter table finance_accounts     add column if not exists dedup_group_id  uuid;
alter table finance_transactions add column if not exists shadowed_by_id  uuid;
alter table finance_transactions add column if not exists dedup_status    text;

-- Reversibility safety: the synthetic winner's connection_id is a real provider's connection, so when
-- that provider disconnects the synthetic is FK-cascaded away — ON DELETE SET NULL makes the surviving
-- shadowed real auto-un-shadow (its pointer nulls) and serve IMMEDIATELY, even before reconcile re-runs.
alter table finance_accounts     drop constraint if exists finance_accounts_shadowed_by_fk;
alter table finance_accounts     add  constraint finance_accounts_shadowed_by_fk
  foreign key (shadowed_by_id) references finance_accounts(id) on delete set null;
alter table finance_transactions drop constraint if exists finance_transactions_shadowed_by_fk;
alter table finance_transactions add  constraint finance_transactions_shadowed_by_fk
  foreign key (shadowed_by_id) references finance_transactions(id) on delete set null;

-- Recreate the wave-11e partial primary-time indexes with the shadow predicate folded in, so the
-- default sector query (no connection filter, ORDER BY primaryTime desc, id) serves only LIVE + UNSHADOWED
-- rows (the synthetic winner) as an O(limit) index walk — the deduped union costs zero read-latency, and
-- the common single-provider path (no synthetic, shadowed_by_id null) is untouched. CREATE-new-then-DROP-old
-- (rename) shrinks the in-txn ACCESS-EXCLUSIVE window; small finance tables make this fine (document the
-- CONCURRENTLY path for scale — it cannot run inside the migrator's per-file transaction).
create index if not exists finance_accounts_user_primarytime_v2
  on finance_accounts (user_id, balance_at desc, id) where deleted_at is null and shadowed_by_id is null;
drop index if exists finance_accounts_user_primarytime;
alter index finance_accounts_user_primarytime_v2 rename to finance_accounts_user_primarytime;

create index if not exists finance_transactions_user_primarytime_v2
  on finance_transactions (user_id, posted_at desc, id) where deleted_at is null and shadowed_by_id is null;
drop index if exists finance_transactions_user_primarytime;
alter index finance_transactions_user_primarytime_v2 rename to finance_transactions_user_primarytime;

-- Reverse-lookup shadow indexes — drill "what merged into this synthetic" + fast un-shadow on removal.
create index if not exists finance_accounts_shadow
  on finance_accounts (shadowed_by_id) where shadowed_by_id is not null;
create index if not exists finance_transactions_shadow
  on finance_transactions (shadowed_by_id) where shadowed_by_id is not null;

-- Backfill mask/org_domain on already-cached rows (the next sync also fills these via normalize()):
--   SimpleFIN: mask = the (dddd) suffix in the NAME; org_domain = raw.org.domain.
--   Plaid:     mask = raw.mask (clean field, only when exactly 4 digits); org_domain from raw.institution_domain
--              (older raws carry none) — canonicalInstitution name-folds as the fallback when absent.
update finance_accounts a
   set org_domain = a.raw->'org'->>'domain'
  from connectors c
 where c.id = a.connection_id and c.provider = 'simplefin'
   and a.org_domain is null and a.raw->'org'->>'domain' is not null;
update finance_accounts a
   set mask = substring(a.name from '\((\d{4})\)\s*$')
  from connectors c
 where c.id = a.connection_id and c.provider = 'simplefin'
   and a.mask is null and a.name ~ '\((\d{4})\)\s*$';
update finance_accounts a
   set mask = a.raw->>'mask'
  from connectors c
 where c.id = a.connection_id and c.provider = 'plaid'
   and a.mask is null and a.raw->>'mask' ~ '^\d{4}$';
update finance_accounts a
   set org_domain = a.raw->>'institution_domain'
  from connectors c
 where c.id = a.connection_id and c.provider = 'plaid'
   and a.org_domain is null and a.raw->>'institution_domain' is not null;

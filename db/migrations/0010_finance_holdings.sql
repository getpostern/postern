-- finance-holding (#36) — investment holdings become queryable AND deduped (spec docs/specs/finance-holding.md).
--
-- finance_holdings on the standard domain-table template: id uuid pk / connection_id / user_id /
-- source_object_id / <normalized cols> / raw jsonb / ingested_at / deleted_at /
-- unique(connection_id, source_object_id). Holdings are a SNAPSHOT, not an event stream — every sync
-- upserts the current positions and tombstones (ADR 0004) positions absent from the fresh snapshot,
-- per connection (the generic reconcileObjectSnapshot fence in src/sync/runner.ts).
--
-- Dedup columns copy migration 0009's finance_accounts pattern exactly: shadowed_by_id self-FK
-- ON DELETE SET NULL (a disconnected provider's synthetic is FK-cascaded away and the surviving
-- shadowed real auto-un-shadows + serves immediately), dedup_status marker, dedup_group_id anchor.
-- query() serves via the same single reversible `shadowed_by_id is null` predicate (serveDeduped),
-- folded into the partial primary-time index below. Forward-only (ADR 0010).
create table if not exists finance_holdings (
  id                uuid primary key default gen_random_uuid(),
  connection_id     uuid not null references connectors(id) on delete cascade,
  user_id           uuid not null references users(id),
  source_object_id  text not null,                   -- SimpleFIN holding id ('HOL-…') | Plaid '<account_id>:<security_id>'
  account_source_id text,                            -- parent account's provider id (intra-sector link, NOT a cross-domain join)
  symbol            text,                            -- SimpleFIN symbol | Plaid securities.ticker_symbol; null for cash rows
  name              text,                            -- SimpleFIN description | Plaid securities.name
  security_type     text,                            -- enrichment: Plaid securities.type; SimpleFIN null — agent infers
  quantity          numeric,                         -- SimpleFIN shares | Plaid quantity
  market_value      numeric,                         -- SimpleFIN market_value | Plaid institution_value
  cost_basis        numeric,                         -- both, as reported (SimpleFIN junk "0.00" stored faithfully)
  currency          text,                            -- nullable (SimpleFIN CASH rows are empty → null)
  as_of             timestamptz,                     -- primary sort; SimpleFIN created | Plaid institution_price_as_of, else sync time
  shadowed_by_id    uuid references finance_holdings(id) on delete set null,  -- dedup: → the synthetic winner (null = served)
  dedup_status      text,                            -- dedup: winner | shadow | unique | ambiguous (core-applied)
  dedup_group_id    uuid,                            -- dedup: per-(account group × symbol) anchor (shared by the reals + the synthetic)
  raw               jsonb,                           -- SimpleFIN holding verbatim | Plaid holding + its security under __pci_security
  ingested_at       timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this position (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);

-- Per-connection drill index (the standard (user_id, connection_id, primaryTime) scope index).
create index if not exists finance_holdings_scope
  on finance_holdings (user_id, connection_id, as_of);
-- Default sector query (no connection filter, ORDER BY primaryTime desc, id) — partial on LIVE +
-- UNSHADOWED rows (wave-11e convention + the 0009 shadow predicate), an O(limit) index walk.
create index if not exists finance_holdings_user_primarytime
  on finance_holdings (user_id, as_of desc, id) where deleted_at is null and shadowed_by_id is null;
-- Reverse-lookup shadow index — drill "what merged into this synthetic" + fast un-shadow on removal.
create index if not exists finance_holdings_shadow
  on finance_holdings (shadowed_by_id) where shadowed_by_id is not null;

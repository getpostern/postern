-- finance-dedup-trust-batch (child A) — operator-CONFIRMED merge pairs: deterministic ground truth
-- for account pairs the mask gate can't prove (≥1 side maskless), NEVER fuzzy matching (ADR 0021).
-- Confirmations live in their OWN small table so they survive marker recompute and provider-row
-- churn: soid-keyed (source_object_ids are stable across re-syncs), FK-cascade on connector removal
-- (disconnect cleans up), user-scoped. The pair is stored in CANONICAL order — a < b bytewise
-- (collate "C") on the engine's 'conn|soid' pair key, enforced by a CHECK — so the unique constraint
-- dedups unordered pairs. reconcileAccounts consumes these as groups under key 'confirmed:<pairhash>'
-- (winner soid 'union:confirmed:<pairhash>'), bypassing ONLY the mask gate; the currency/class/
-- intra-item refusals still apply and SUSPEND the confirmation fail-open (group not formed, row
-- kept — never honored, never silently deleted). Additive + idempotent (0005/0011 template).
create table if not exists finance_dedup_confirmations (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id),
  a_connection_id     uuid not null references connectors(id) on delete cascade,
  a_source_object_id  text not null,
  b_connection_id     uuid not null references connectors(id) on delete cascade,
  b_source_object_id  text not null,
  created_at          timestamptz not null default now(),
  unique (user_id, a_connection_id, a_source_object_id, b_connection_id, b_source_object_id),
  -- Canonical pair ordering: a < b on 'conn|soid', bytewise ("C") to match the engine's JS comparator.
  check ((a_connection_id::text || '|' || a_source_object_id) < (b_connection_id::text || '|' || b_source_object_id) collate "C")
);

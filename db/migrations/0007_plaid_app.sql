-- Wave 13 — grounded Plaid (#14): the BYO Plaid app creds + per-Item credential keying + connection
-- health columns. Forward-only (ADR 0010), idempotent (re-applies safely on an existing volume).

-- ── BYO Plaid app (sub-unit A) ───────────────────────────────────────────────
-- The operator's own Plaid app: client_id (public) + the Production/Sandbox client secret (SEALED in
-- the vault — the row holds only the opaque secret_ref; CLAUDE.md invariant) + the env. Singleton:
-- `id boolean primary key default true check (id)` admits exactly one row. Mirrors oauth_provider_apps.
create table if not exists plaid_app (
  id                 boolean primary key default true check (id),
  client_id          text not null,
  client_secret_ref  text not null,                       -- 'sec_<uuid>' into the vault (purpose 'plaid_secret')
  env                text not null check (env in ('sandbox', 'production')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);

-- ── Per-Item keying + connection health (sub-units A + B) ─────────────────────
-- external_item_id is the Plaid Item id. There is NO Plaid endpoint to list the Items behind a
-- credential — the gateway DB is the SOLE source of truth for "which banks did I connect", so each
-- Item is its OWN credential row keyed by it (a wrong key silently overwrites bank #1 with bank #2).
-- The item_* columns + consent_expiration_time hold the /item/get health poll's findings (sub-unit B).
-- All additive + idempotent.
alter table provider_credentials add column if not exists external_item_id        text;
alter table provider_credentials add column if not exists item_error_code         text;
alter table provider_credentials add column if not exists consent_expiration_time timestamptz;
alter table provider_credentials add column if not exists item_status             text;  -- classified health: ok|action_required|transient|dead

-- ── Per-Item credential uniqueness ───────────────────────────────────────────
-- The baseline's table-level unique(user_id, provider) forbids a SECOND Plaid Item for one user (each
-- Item = its own access_token = its own credential row). Replace it with TWO partial unique indexes:
--   * NON-Plaid providers keep exactly-one-row-per-(user, provider) — external_item_id stays NULL.
--   * Plaid gets one-row-per-(user, provider, external_item_id) — multi-Item, no silent overwrite.
-- The bare `on conflict (user_id, provider)` upserts (admin/oauth credential onboarding) gain a
-- `where external_item_id is null` predicate so they infer the first partial index.
alter table provider_credentials drop constraint if exists provider_credentials_user_id_provider_key;
create unique index if not exists provider_credentials_user_provider_no_item
  on provider_credentials (user_id, provider) where external_item_id is null;
create unique index if not exists provider_credentials_user_provider_item
  on provider_credentials (user_id, provider, external_item_id) where external_item_id is not null;

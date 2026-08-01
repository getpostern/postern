-- Wave 11 — BYO OAuth provider apps (guided UI-first onboarding).
-- Per-provider app credentials the operator pastes in the Console: `client_id` stored plain,
-- `client_secret` sealed in the vault and referenced ONLY by a `secret_ref` (CLAUDE.md invariant:
-- rows hold no secret material). `client_secret_ref` is NULL for public clients (microsoft).
-- Additive + idempotent: re-applies safely on an existing volume (`create table if not exists`).
create table if not exists oauth_provider_apps (
  provider          text primary key,
  client_id         text not null,
  client_secret_ref text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);

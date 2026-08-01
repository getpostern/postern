-- Personal Context Gateway — beta schema.
-- Neutral gateway: a faithful read cache + lossless action passthrough (commands go OUT to the
-- source, then a targeted re-sync reflects the result). NO cross-domain correlation; per-domain
-- stores only. The store is never written with DERIVED data (agent-authored facts = chapter 2/3).
-- (No source_events / entity resolution / derived_facts — chapter 2/3, not the beta.)
--
-- The gateway IS the cache: connectors sync each source into the local store on a
-- cadence; agents read the store, never the provider API on the hot path. The only
-- thing that varies per sector is declarative connector policy (SyncPolicy in TS) and
-- the REGISTRY contract — never a code path or a bespoke table shape.
--
-- Domain-table template (identical for every sector):
--   id uuid pk / connection_id (FK->connectors) / user_id (FK->users) /
--   source_object_id / <normalized cols> / raw jsonb / ingested_at / deleted_at /
--   unique(connection_id, source_object_id)
--
-- Tombstones (ADR 0004): deleted_at timestamptz, null = live. Set when the SOURCE removes the
-- object (provider-signaled or snapshot-reconciled) — never a derived judgment, never a hard
-- delete (the row + raw are retained for get_record drill-down). EVERY live-record write path
-- clears it ("last writer of a live record resurrects"). query() serves only deleted_at is null;
-- get_record returns the row truthfully, deleted_at visible. NOT in the REGISTRY (infra column,
-- like ingested_at).
--
-- Cross-cutting conventions:
--   * Instants are timestamptz, normalized to UTC by the connector. A *_tz text column
--     is added ONLY where local wall-clock matters (calendar).
--   * Multi-valued data: flat tag sets -> text[]; structured/variable -> jsonb (drill-only).
--   * Money: amount is SIGNED — NEGATIVE = money out, POSITIVE = money in.
--   * raw jsonb holds the full original payload on every row (get_record drill target);
--     normalization is therefore lossless and auditable.
--   * uuid surrogate PK is the get_record key; the provider id lives in source_object_id;
--     unique(connection_id, source_object_id) is the idempotent upsert key.

-- ════════════════════════════════════════════════════════════════════════════
-- CONTROL PLANE
-- ════════════════════════════════════════════════════════════════════════════

-- Tenancy anchor. One seeded row in self-host; multi-user = more rows, no migration.
create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  label      text,
  created_at timestamptz not null default now()
);

-- The vault. Tokens NEVER live in credential/domain rows — only an opaque ref does.
-- V0 = local AEAD envelope under a master key; hosted swaps to per-user KMS DEK behind the same ref.
create table if not exists secrets (
  ref        text primary key,                       -- 'sec_<uuid>'; provider_credentials.secret_ref points here
  user_id    uuid not null references users(id) on delete cascade,
  ciphertext bytea not null,
  nonce      bytea not null,
  key_id     text not null,                           -- which master/KEK encrypted this (rotation without re-ref)
  aad        text,                                    -- binds blob to a credential (anti-replay)
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

-- THE credential. One row per authenticated provider consent (one Google OAuth = one row).
create table if not exists provider_credentials (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  provider        text not null,                      -- simplefin | plaid | google | microsoft | whoop | apple_health | home_assistant | gmail
  custody         text not null default 'static_token', -- static_token | first_party | byo_app | on_device
  secret_ref      text references secrets(ref),       -- access token / access-url / user token (purpose 'access')
  refresh_ref     text references secrets(ref),       -- OAuth refresh token (purpose 'refresh'); null for static-token custody
  username        text,                                -- IMAP/static identity (e.g. Gmail email for the app-password)
  instance_url    text,                                -- per-instance address (e.g. Home Assistant WebSocket URL); not secret; HA_URL env is the fallback
  client_app_ref  text references secrets(ref),       -- byo_app: the operator's own OAuth client id/secret
  external_item_id        text,                        -- Plaid Item id (0007) — per-Item keying; NULL for every non-Plaid provider
  item_error_code         text,                        -- Plaid /item/get error_code (0007); null = healthy
  consent_expiration_time timestamptz,                 -- Plaid consent clock (0007); pollable re-consent deadline
  item_status             text,                        -- Plaid classified health (0007): ok | action_required | transient | dead
  granted_scopes  text[] not null default '{}',
  status          text not null default 'active',     -- active | needs_reauth | revoked
  expires_at      timestamptz,
  created_at      timestamptz not null default now()
  -- uniqueness moved to TWO partial indexes (0007): non-Plaid = one row per (user, provider) [item null];
  -- Plaid = one row per (user, provider, external_item_id) [item not null] for multi-Item support.
);
-- Per-Item credential uniqueness (0007). The baseline's table-level unique(user_id, provider) is
-- replaced so a user can hold multiple Plaid Items (each Item = its own access_token = its own row).
create unique index if not exists provider_credentials_user_provider_no_item
  on provider_credentials (user_id, provider) where external_item_id is null;
create unique index if not exists provider_credentials_user_provider_item
  on provider_credentials (user_id, provider, external_item_id) where external_item_id is not null;

-- THE per-sector connector mapping. Many connectors point at one credential.
-- One Google credential -> three connectors (mail, contacts, calendar). connectors.id is the connection_id FK below.
-- Runtime sync state (cursor, last_synced_at) lives here; sync POLICY (push/poll/cadence) lives in the connector code (SyncPolicy).
create table if not exists connectors (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,  -- denormalized for cheap read-path scoping
  credential_id  uuid not null references provider_credentials(id) on delete cascade,
  sector         text not null,                       -- finance | health | mail | contacts | calendar | home
  provider       text not null,                       -- denormalized copy for describe_context without a join
  scopes         text[] not null default '{}',
  status         text not null default 'active',      -- active | paused | error | revoked | syncing
  cursor         text,                                -- incremental-sync cursor
  last_synced_at timestamptz,                          -- freshness signal exposed by describe_context
  created_at     timestamptz not null default now(),
  unique (credential_id, sector)
);
create index if not exists connectors_user_sector on connectors (user_id, sector, status);

-- Per-agent grants: default-deny (empty array = nothing readable), scoped per sector, revocable.
create table if not exists agent_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  agent_id    text not null,                          -- 'claude' | 'cursor' | 'local:llama'
  key_hash    text,                                   -- sha256 of the agent's bearer; raw key never stored
  sectors     text[] not null default '{}',           -- empty = default-deny
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  expires_at  timestamptz,                            -- key expiry (migration 0014): null = never (default)
  unique (user_id, agent_id)
);

-- Append-only audit on EVERY core call -- reads AND actions. Written ASYNC (off the response hot
-- path); detective, not preventive. Insert-only; the app role has UPDATE/DELETE revoked.
create table if not exists audit_log (
  id           bigserial primary key,
  user_id      uuid references users(id),
  agent_id     text,
  tool         text not null,                         -- describe_context|get_schema|query|get_record|fetch_live|list_actions|invoke_action
  sector       text,
  decision     text not null,                         -- allow | deny (domain-level grant check)
  deny_reason  text,
  args         jsonb,                                 -- validated args, sensitive values redacted
  result_count int,                                   -- rows returned (reads)
  outcome      text,                                  -- actions record ok | error (connector-reported); reads record ok
  request_id   text,
  created_at   timestamptz not null default now()
);
create index if not exists audit_user_ts on audit_log (user_id, created_at desc);

-- ════════════════════════════════════════════════════════════════════════════
-- DOMAIN STORES — one engine, six configs. FK connection_id -> connectors(id).
-- The (user_id, connection_id, <primaryTime>) index is the per-connection drill index; the companion
-- (user_id, <primaryTime> desc, id) where deleted_at is null partial index serves the default sector
-- query (no connection filter, ORDER BY primaryTime desc) as an O(limit) walk with no Sort (wave 11e).
-- Both are mirrored from each REGISTRY object's primaryTime hint.
-- ════════════════════════════════════════════════════════════════════════════

-- ── FINANCE (Plaid + SimpleFIN) — OFX/Plaid account+transaction model ────────
-- Neutral core = the SimpleFIN floor; Plaid richness = nullable enrichment columns.
-- Balances live on the account row. counterparty/logo/website stay in raw.

create table if not exists finance_accounts (
  id                       uuid primary key default gen_random_uuid(),
  connection_id            uuid not null references connectors(id) on delete cascade,
  user_id                  uuid not null references users(id),
  source_object_id         text not null,            -- Plaid account_id | SimpleFIN account id
  name                     text,                     -- core
  account_type             text,                     -- enrichment: Plaid type; SimpleFIN none
  currency                 text,                     -- core
  current_balance          numeric,                  -- core
  available_balance        numeric,                  -- enrichment
  balance_at               timestamptz,              -- SimpleFIN balance-date; Plaid: ingest time
  balance_at_is_synthetic  boolean not null default false,  -- true when stamped at ingest (Plaid), not provider-reported
  institution_name         text,                     -- enrichment: SimpleFIN org.name; Plaid via /institutions/get
  mask                     text,                     -- dedup key (#34b): last-4 — Plaid raw.mask; SimpleFIN (dddd) name suffix
  org_domain               text,                     -- dedup key (#34b): SimpleFIN raw.org.domain; Plaid institution domain
  shadowed_by_id           uuid references finance_accounts(id) on delete set null,  -- #34b: → the synthetic winner (null = served); ON DELETE SET NULL auto-un-shadows the survivor
  dedup_status             text,                     -- #34b: winner | shadow | unique | ambiguous (core-applied)
  dedup_group_id           uuid,                     -- #34b: cross-provider dedup group anchor (shared by the reals + the synthetic)
  raw                      jsonb,
  ingested_at              timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this object (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists finance_accounts_scope on finance_accounts (user_id, connection_id, balance_at);
-- Default sector query (no connection filter, ORDER BY primaryTime desc, id) — partial on LIVE + UNSHADOWED rows
-- (wave 11e + #34b shadow predicate; serves only the synthetic winner / single-provider rows).
create index if not exists finance_accounts_user_primarytime on finance_accounts (user_id, balance_at desc, id) where deleted_at is null and shadowed_by_id is null;
create index if not exists finance_accounts_shadow on finance_accounts (shadowed_by_id) where shadowed_by_id is not null;

create table if not exists finance_transactions (
  id                uuid primary key default gen_random_uuid(),
  connection_id     uuid not null references connectors(id) on delete cascade,
  user_id           uuid not null references users(id),
  source_object_id  text not null,                   -- Plaid transaction_id | SimpleFIN id
  account_source_id text,                            -- parent account's provider id (intra-sector link, NOT a cross-domain join)
  posted_at         timestamptz,                     -- core; primary sort key. Plaid date->UTC | SimpleFIN posted (unix)
  amount            numeric,                          -- core; SIGNED, negative = money out. Plaid amount is NEGATED on write; SimpleFIN as-is
  currency          text,                            -- core (SimpleFIN inherits the account currency)
  description       text,                            -- core; Plaid name | SimpleFIN description
  merchant          text,                            -- enrichment; Plaid merchant_name | SimpleFIN payee
  pending           boolean default false,           -- core (SimpleFIN default false when absent)
  category          text,                            -- enrichment; Plaid PFC.primary. SimpleFIN = null -> agent infers at query time. Vocabulary: Plaid PFC taxonomy
  payment_channel   text,                            -- enrichment; Plaid only
  authorized_at     timestamptz,                     -- enrichment; Plaid authorized_date(time); SimpleFIN null
  location_city     text,                            -- enrichment; Plaid location.city
  location_region   text,                            -- enrichment; Plaid location.region
  shadowed_by_id    uuid references finance_transactions(id) on delete set null,  -- #34b: → the synthetic winner (null = served); ON DELETE SET NULL auto-un-shadows
  dedup_status      text,                            -- #34b: winner | shadow | pending | ambiguous (core-applied)
  raw               jsonb,                           -- full payload: counterparties, logo_url, website, PFC.detailed; SimpleFIN memo/transacted_at/extra
  ingested_at       timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this object (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists finance_transactions_scope on finance_transactions (user_id, connection_id, posted_at);
create index if not exists finance_transactions_user_primarytime on finance_transactions (user_id, posted_at desc, id) where deleted_at is null and shadowed_by_id is null;
create index if not exists finance_transactions_shadow on finance_transactions (shadowed_by_id) where shadowed_by_id is not null;

-- Investment holdings (#36, migration 0010) — a SNAPSHOT store (every sync upserts current positions
-- and tombstones absentees per connection). Prices are deliberately NOT floor columns (no honest shared
-- meaning across providers) — they stay in raw; agents derive unit price as market_value / quantity.
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
  shadowed_by_id    uuid references finance_holdings(id) on delete set null,  -- dedup: → the synthetic winner (null = served); ON DELETE SET NULL auto-un-shadows
  dedup_status      text,                            -- dedup: winner | shadow | unique | ambiguous (core-applied)
  dedup_group_id    uuid,                            -- dedup: per-(account group × symbol) anchor (shared by the reals + the synthetic)
  raw               jsonb,                           -- SimpleFIN holding verbatim | Plaid holding + its security under __pci_security
  ingested_at       timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this position (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists finance_holdings_scope on finance_holdings (user_id, connection_id, as_of);
create index if not exists finance_holdings_user_primarytime on finance_holdings (user_id, as_of desc, id) where deleted_at is null and shadowed_by_id is null;
create index if not exists finance_holdings_shadow on finance_holdings (shadowed_by_id) where shadowed_by_id is not null;

-- Operator-CONFIRMED merge pairs (migration 0013, finance-dedup-trust-batch) — deterministic ground
-- truth for account pairs the mask gate can't prove (≥1 side maskless); NEVER fuzzy (ADR 0021).
-- Own table (survives marker recompute + row churn), soid-keyed (stable across re-syncs), FK-cascade
-- on connector removal. Pair stored in CANONICAL order (a < b bytewise on 'conn|soid', CHECK-enforced)
-- so the unique constraint dedups unordered pairs. reconcileAccounts consumes these as groups under
-- key 'confirmed:<pairhash>' (winner soid 'union:confirmed:<pairhash>'), bypassing ONLY the mask gate;
-- currency/class/intra-item refusals SUSPEND the confirmation fail-open (kept, never honored).
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

-- ── HEALTH (Whoop + Apple Health) — HealthKit/FHIR typed-observation model ───
-- Tall sample table + dedicated workouts + sleep. HRV kept distinct per algorithm.

create table if not exists health_samples (
  id                uuid primary key default gen_random_uuid(),
  connection_id     uuid not null references connectors(id) on delete cascade,
  user_id           uuid not null references users(id),
  source_object_id  text not null,                   -- Apple HKSample.uuid | Whoop '{object}:{id}:{metric}'
  metric_type       text not null,                   -- neutral vocab: heart_rate|resting_heart_rate|hrv_rmssd|hrv_sdnn|step_count|
                                                     --   active_energy_burned|respiratory_rate|spo2|skin_temperature|body_temperature|
                                                     --   day_strain|recovery_score|sleep_performance
  value             numeric,
  unit              text,                            -- UCUM-ish: count/min|count|kcal|ms|%|Cel|/min|1
  aggregation       text not null default 'sample',  -- 'sample' (point/interval) | 'daily_total' (pre-aggregated). Never SUM across mixed aggregation.
  window_start      timestamptz,                     -- primary range/sort
  window_end        timestamptz,
  source            text,                            -- enrichment; Apple HKSource.name | Whoop 'whoop'
  raw               jsonb,
  ingested_at       timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this object (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists health_samples_scope on health_samples (user_id, connection_id, window_start);
create index if not exists health_samples_metric on health_samples (user_id, metric_type, window_start);
create index if not exists health_samples_user_primarytime on health_samples (user_id, window_start desc, id) where deleted_at is null;

create table if not exists health_workouts (
  id                uuid primary key default gen_random_uuid(),
  connection_id     uuid not null references connectors(id) on delete cascade,
  user_id           uuid not null references users(id),
  source_object_id  text not null,                   -- Whoop workout.id | Apple HKWorkout.uuid
  sport             text,                            -- neutral lowercase: running|cycling|strength
  started_at        timestamptz,                     -- primary sort/range
  ended_at          timestamptz,
  duration_seconds  numeric,
  energy_kcal       numeric,                         -- Apple kcal; Whoop kilojoule/4.184 (native kJ in raw)
  distance_meters   numeric,
  avg_heart_rate    numeric,                         -- enrichment; Whoop only at base ingest (Apple null)
  max_heart_rate    numeric,                         -- enrichment; Whoop only at base ingest
  strain            numeric,                         -- enrichment; Whoop only (0-21)
  raw               jsonb,
  ingested_at       timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this object (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists health_workouts_scope on health_workouts (user_id, connection_id, started_at);
create index if not exists health_workouts_user_primarytime on health_workouts (user_id, started_at desc, id) where deleted_at is null;

create table if not exists health_sleep_sessions (
  id                   uuid primary key default gen_random_uuid(),
  connection_id        uuid not null references connectors(id) on delete cascade,
  user_id              uuid not null references users(id),
  source_object_id     text not null,               -- Whoop sleep.id | Apple synth id
  started_at           timestamptz,                 -- primary sort/range
  ended_at             timestamptz,
  is_nap               boolean,
  time_asleep_seconds  numeric,
  time_in_bed_seconds  numeric,
  efficiency_pct       numeric,                     -- enrichment
  respiratory_rate     numeric,                     -- enrichment; Apple lands in health_samples instead
  raw                  jsonb,                        -- per-stage timeline / sleep_needed kept here
  ingested_at          timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this object (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists health_sleep_scope on health_sleep_sessions (user_id, connection_id, started_at);
create index if not exists health_sleep_sessions_user_primarytime on health_sleep_sessions (user_id, started_at desc, id) where deleted_at is null;

-- ── MAIL (Gmail + Microsoft Graph) — RFC 5322 envelope model ─────────────────
-- folder is a NEUTRAL enum resolved by both connectors (never an opaque GUID).
-- labels is text[] in the store; it becomes queryable once query() supports array containment (M-phase) — not in the REGISTRY yet.
-- FOOTPRINT (ADR 0001): mail caches the ENVELOPE/metadata only. The body + attachments are NOT stored —
-- they are fetched on demand (fetch_live/get_record). raw below holds the envelope-level payload, not the body.

create table if not exists mail_messages (
  id                uuid primary key default gen_random_uuid(),
  connection_id     uuid not null references connectors(id) on delete cascade,
  user_id           uuid not null references users(id),
  source_object_id  text not null,                   -- Gmail Message.id | Graph message.id (ImmutableId)
  thread_id         text,
  message_id_header text,                            -- RFC 5322 Message-ID
  from_address      text,
  from_name         text,
  sender_address    text,                            -- Graph sender (delegate/shared); Gmail null
  subject           text,
  snippet           text,                            -- preview only; body fetched on demand, NOT stored (ADR 0001)
  sent_at           timestamptz,
  received_at       timestamptz,                     -- primary sort key
  is_read           boolean,
  has_attachments   boolean,
  folder            text,                            -- neutral enum: inbox|sent|drafts|spam|trash|archive|other
  importance        text,                            -- enrichment; Outlook only
  labels            text[],                          -- Gmail labelIds | Outlook categories (store-only until array filtering lands)
  raw               jsonb,                            -- envelope-level payload only — NOT body/attachments (fetched on demand; ADR 0001)
  ingested_at       timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this object (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists mail_messages_scope on mail_messages (user_id, connection_id, received_at);
create index if not exists mail_messages_user_primarytime on mail_messages (user_id, received_at desc, id) where deleted_at is null;

-- ── CONTACTS (Google People + Microsoft Graph) — vCard model ─────────────────
-- Multi-valued emails/phones beyond the primary live in raw.

create table if not exists contacts (
  id                uuid primary key default gen_random_uuid(),
  connection_id     uuid not null references connectors(id) on delete cascade,
  user_id           uuid not null references users(id),
  source_object_id  text not null,                   -- Google resourceName | Graph id (ImmutableId)
  display_name      text,
  given_name        text,
  family_name       text,
  primary_email     text,
  primary_phone     text,                            -- normalized to E.164 by the connector
  company           text,
  job_title         text,
  updated_at        timestamptz,                     -- enrichment for Google (derived); primary sort
  raw               jsonb,
  ingested_at       timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this object (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists contacts_scope on contacts (user_id, connection_id, updated_at);
create index if not exists contacts_user_primarytime on contacts (user_id, updated_at desc, id) where deleted_at is null;

-- ── CALENDAR (Google Calendar + Microsoft Graph) — iCalendar/RFC 5545 VEVENT ─
-- The one sector needing a tz column: starts_at/ends_at are UTC, start_tz keeps local wall-clock.

create table if not exists calendar_events (
  id                   uuid primary key default gen_random_uuid(),
  connection_id        uuid not null references connectors(id) on delete cascade,
  user_id              uuid not null references users(id),
  source_object_id     text not null,               -- Google event.id | Graph event.id (ImmutableId)
  summary              text,
  description          text,                         -- preview; full HTML body in raw
  location             text,
  starts_at            timestamptz,                  -- UTC; primary sort/filter
  ends_at              timestamptz,                  -- all-day end is EXCLUSIVE, stored as given
  start_tz             text,                         -- IANA tz; preserves local wall-clock
  all_day              boolean,
  status               text,                         -- confirmed | tentative | cancelled
  organizer_email      text,
  owner_response       text,                         -- the calendar owner's own RSVP
  is_recurring         boolean,
  recurrence_master_id text,                         -- Google recurringEventId | Graph seriesMasterId
  original_start       timestamptz,                  -- moved-occurrence identity
  original_start_tz    text,
  html_link            text,                         -- enrichment; select-only
  updated_at           timestamptz,                  -- delta-sync watermark
  attendees            jsonb,                        -- [{email,response,role,self}] (drill-only)
  raw                  jsonb,                         -- recurrence rule, showAs, importance, etc.
  ingested_at          timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this object (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists calendar_events_scope on calendar_events (user_id, connection_id, starts_at);
create index if not exists calendar_events_user_primarytime on calendar_events (user_id, starts_at desc, id) where deleted_at is null;

-- ── HOME (Home Assistant; SmartThings/Matter reserved) — entity/state model ──
-- V0 ships HA-shaped (one row per entity). device_id/capability/location are deferred
-- to the second home provider — added then, not now.

create table if not exists home_entities (
  id               uuid primary key default gen_random_uuid(),
  connection_id    uuid not null references connectors(id) on delete cascade,
  user_id          uuid not null references users(id),
  source_object_id text not null,                    -- HA entity_id ('light.kitchen')
  entity_id        text,                             -- HA-native dotted handle
  domain           text,                             -- light | lock | climate | sensor ... (prefix of entity_id)
  area             text,                             -- enrichment; HA area registry
  state            text,
  unit             text,                             -- attributes.unit_of_measurement, promoted out of the bag
  availability     text,                             -- online | offline | unavailable | unknown
  state_timestamp  timestamptz,                      -- HA last_changed; primary sort
  attributes       jsonb,                            -- full HA attributes{} (drill-only)
  raw              jsonb,
  ingested_at      timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this object (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists home_entities_scope on home_entities (user_id, connection_id, state_timestamp);
create index if not exists home_entities_user_primarytime on home_entities (user_id, state_timestamp desc, id) where deleted_at is null;

-- ── Tombstone column backfill (ADR 0004) ─────────────────────────────────────
-- `create table if not exists` is a no-op on existing databases, so the column is also added
-- idempotently here. Keep this list in sync with the CREATE statements above (all TEN domain tables).
alter table finance_accounts       add column if not exists deleted_at timestamptz;
alter table finance_transactions   add column if not exists deleted_at timestamptz;
alter table finance_holdings       add column if not exists deleted_at timestamptz;
alter table health_samples         add column if not exists deleted_at timestamptz;
alter table health_workouts        add column if not exists deleted_at timestamptz;
alter table health_sleep_sessions  add column if not exists deleted_at timestamptz;
alter table mail_messages          add column if not exists deleted_at timestamptz;
alter table contacts               add column if not exists deleted_at timestamptz;
alter table calendar_events        add column if not exists deleted_at timestamptz;
alter table home_entities          add column if not exists deleted_at timestamptz;

-- ── Push-ingest webhook secret (push-ingest) ─────────────────────────────────
-- Per-connection webhook secret for the authenticated push endpoint (POST /api/ingest/:connectionId).
-- We persist ONLY the sha256 hex of the minted secret (never the raw secret); null = ingest disabled.
-- `create table if not exists` no-ops on existing volumes, so these are added idempotently here.
alter table connectors add column if not exists webhook_secret_hash text;
alter table connectors add column if not exists webhook_secret_set_at timestamptz;

-- ── Connector last-error surface (wave 10A) ──────────────────────────────────
-- MASKED, secret-free reason from the last failed sync (so the operator can see WHY a connection is
-- in status='error'); cleared by the next successful sync write-back. Keep in sync with migration
-- 0002 (db/migrations/0002_connector_last_error.sql). Idempotent on existing volumes.
alter table connectors add column if not exists last_error    text;
alter table connectors add column if not exists last_error_at timestamptz;

-- ── BYO OAuth provider apps (wave 11, migration 0003_oauth_provider_apps.sql). client_id plain;
-- client_secret_ref → vault secret_ref (NULL for public clients e.g. microsoft). Idempotent. ──
create table if not exists oauth_provider_apps (
  provider          text primary key,
  client_id         text not null,
  client_secret_ref text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz
);

-- ── BYO Plaid app (wave 13, migration 0007_plaid_app.sql). client_id plain; client_secret_ref → vault
-- secret_ref (purpose 'plaid_secret'). Singleton (id boolean pk default true check (id)). Idempotent. ──
create table if not exists plaid_app (
  id                 boolean primary key default true check (id),
  client_id          text not null,
  client_secret_ref  text not null,
  env                text not null check (env in ('sandbox', 'production')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);

-- ── Gateway public exposure (console-exposure-surface, ADR 0035 §D1; migration
-- 0016_gateway_exposure.sql). The gateway's own public address as a Console-owned setting. Singleton
-- (id boolean pk default true check (id)), same shape as plaid_app. NO SECRET: a public URL lands in a
-- public certificate ledger by construction, so nothing is sealed and no secret_ref exists here.
-- Row present = exposure configured (wins over MCP_PUBLIC_URL); absent = fall through to the env var,
-- then off. consented_at records the ADR 0035 §D1 consent and is re-stamped on every save. Idempotent. ──
create table if not exists gateway_exposure (
  id           boolean primary key default true check (id),
  public_url   text not null,
  consented_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);

-- ── Mail recency window (wave 12a, migration 0005_sync_window.sql). Per-connection fetch bound; NULL →
-- mail default 180d via resolveWindowDays(); a large value = "all history". ──
alter table connectors add column if not exists sync_window_days int;

-- ── Push-stream health (#39/#40, migration 0011_connector_stream_state.sql). stream_state
-- ('connected' | 'retrying' | 'down') is the push connector's live-socket health, SEPARATE from
-- status (the scan/ingest/describe filters keep their exact semantics) and from last_error (the
-- poll-sync fault channel). stream_error is MASKED, secret-free; stream_changed_at stamps state
-- TRANSITIONS only. Keep in sync with migration 0011. Idempotent. ──
alter table connectors add column if not exists stream_state      text;
alter table connectors add column if not exists stream_error      text;
alter table connectors add column if not exists stream_changed_at timestamptz;

-- ── Per-connection poll cadence (ADR 0025, migration 0012_connector_sync_interval.sql). User
-- override in SECONDS, clamped to the connector's declared floor (SyncPolicy.minIntervalSec) by the
-- ONE effectiveIntervalSec helper; NULL = the connector's defaultIntervalSec. Keep in sync with
-- migration 0012. Idempotent. ──
alter table connectors add column if not exists sync_interval_sec int;

-- ── MCP OAuth bridge + bearer-key expiry (mcp-auth-bridge, migration 0014, ADR 0029) ─────────────
-- The opt-in same-origin OAuth 2.1 bridge on the MCP HTTP edge (MCP_PUBLIC_URL is the switch).
-- HASHES ONLY (sha256 of the full prefixed pcgac_/pcgat_/pcgrt_ value); every table FK-cascades
-- from agent_grants (derived credentials die with the grant row on DELETE; revoke/rotate/expiry are
-- enforced at resolve + /token because the grant row survives those). GC is hygiene, never
-- revocation. Keep in sync with migration 0014. Idempotent.
alter table agent_grants add column if not exists expires_at timestamptz;

-- Dynamically-registered OAuth clients (RFC 7591 DCR). Unauthenticated by design; bounded by the
-- 50-live-client cap + per-IP buckets. redirect_uris validated https-or-loopback at registration.
-- last_used_at bumps on token issue AND refresh so the 90-day-unused GC never reaps a live client.
create table if not exists oauth_bridge_clients (
  id            uuid primary key default gen_random_uuid(),
  client_id     text unique not null,
  client_name   text,
  redirect_uris text[] not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

-- Authorization codes AS ROWS (a mid-flow restart survives). Single-use enforced atomically on
-- consumed_at; bound to and verified against client_id/redirect_uri/resource; TTL 5 min.
create table if not exists oauth_bridge_codes (
  id              uuid primary key default gen_random_uuid(),
  code_hash       text unique not null,
  client_id       text not null,
  agent_grant_id  uuid not null references agent_grants(id) on delete cascade,
  code_challenge  text not null,
  redirect_uri    text not null,
  resource        text,
  expires_at      timestamptz not null,
  consumed_at     timestamptz
);
create index if not exists oauth_bridge_codes_grant on oauth_bridge_codes (agent_grant_id);

-- Bridge tokens: short-lived access (3600s) + rotating refresh (sliding 30d idle window capped by
-- grant expiry). Rotation inserts a successor row (rotated_from = predecessor); a refresh whose row
-- already has a successor is rotated-out — presenting it revokes the whole chain (RFC 9700), which
-- is why the predecessor's refresh_hash is retained as the reuse-detection key.
create table if not exists oauth_bridge_tokens (
  id                 uuid primary key default gen_random_uuid(),
  agent_grant_id     uuid not null references agent_grants(id) on delete cascade,
  client_id          text not null,
  access_hash        text unique,
  refresh_hash       text,
  access_expires_at  timestamptz not null,
  refresh_expires_at timestamptz not null,
  rotated_from       uuid,
  created_at         timestamptz not null default now()
);
create index if not exists oauth_bridge_tokens_grant on oauth_bridge_tokens (agent_grant_id);
create index if not exists oauth_bridge_tokens_refresh on oauth_bridge_tokens (refresh_hash) where refresh_hash is not null;
create index if not exists oauth_bridge_tokens_rotated_from on oauth_bridge_tokens (rotated_from) where rotated_from is not null;
create index if not exists oauth_bridge_tokens_client on oauth_bridge_tokens (client_id);

-- ── Self-host seed: one local user so single-tenant works out of the box ─────
insert into users (id, label)
values ('00000000-0000-0000-0000-000000000001', 'local')
on conflict (id) do nothing;

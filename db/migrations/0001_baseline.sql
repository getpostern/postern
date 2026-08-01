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
  client_app_ref  text references secrets(ref),       -- byo_app: the operator's own OAuth client id/secret
  granted_scopes  text[] not null default '{}',
  status          text not null default 'active',     -- active | needs_reauth | revoked
  expires_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_id, provider)
);

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
  status         text not null default 'active',      -- active | paused | error | revoked
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
-- The (user_id, connection_id, <primaryTime>) index is the generic hot-read index,
-- mirrored from each REGISTRY object's primaryTime hint.
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
  raw                      jsonb,
  ingested_at              timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this object (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists finance_accounts_scope on finance_accounts (user_id, connection_id, balance_at);

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
  raw               jsonb,                           -- full payload: counterparties, logo_url, website, PFC.detailed; SimpleFIN memo/transacted_at/extra
  ingested_at       timestamptz not null default now(),
  deleted_at        timestamptz,                     -- tombstone: source removed this object (null = live; ADR 0004)
  unique (connection_id, source_object_id)
);
create index if not exists finance_transactions_scope on finance_transactions (user_id, connection_id, posted_at);

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

-- ── Tombstone column backfill (ADR 0004) ─────────────────────────────────────
-- `create table if not exists` is a no-op on existing databases, so the column is also added
-- idempotently here. Keep this list in sync with the CREATE statements above (all NINE domain tables).
alter table finance_accounts       add column if not exists deleted_at timestamptz;
alter table finance_transactions   add column if not exists deleted_at timestamptz;
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

-- ── Self-host seed: one local user so single-tenant works out of the box ─────
insert into users (id, label)
values ('00000000-0000-0000-0000-000000000001', 'local')
on conflict (id) do nothing;

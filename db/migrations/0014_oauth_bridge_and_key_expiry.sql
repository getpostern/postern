-- mcp-auth-bridge (child A) — the opt-in same-origin OAuth 2.1 bridge on the MCP HTTP edge (ADR
-- 0029) + first-class bearer-key expiry. Three control-plane tables, HASHES ONLY (sha256 of the
-- full prefixed value — pcgac_/pcgat_/pcgrt_ included in the preimage; a raw code/token never
-- touches a row), all FK-cascading from agent_grants: the pasted agent key IS the login, so every
-- derived credential dies with its grant row (DELETE /api/agents cascades; revoke/rotate/expiry are
-- enforced at resolve + /token because the grant row SURVIVES those — the cascade never fires there).
-- GC (gcBridgeRows) is hygiene, never revocation: a code/token is dead at its expiry instant
-- regardless of row retention. Additive + idempotent (0005/0011/0013 template).

-- Bearer-key expiry: null = never (default; existing rows unchanged). Enforced in resolveBearer
-- (child B) and per-call via the session-cached ctx.expiresAt deadline; bridge refresh lifetimes
-- are capped by it (a refresh chain can never outlive its key).
alter table agent_grants add column if not exists expires_at timestamptz;

-- Dynamically-registered OAuth clients (RFC 7591 DCR — claude.ai/ChatGPT register themselves).
-- Unauthenticated by design (public DCR); bounded by the in-unit 50-live-client cap + per-IP
-- buckets. redirect_uris are validated https-or-loopback at registration. last_used_at bumps on
-- token issue AND refresh so the 90-day-unused GC never reaps a live client.
create table if not exists oauth_bridge_clients (
  id            uuid primary key default gen_random_uuid(),
  client_id     text unique not null,
  client_name   text,
  redirect_uris text[] not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

-- Authorization codes AS ROWS (not memory — a mid-flow gateway restart survives). Single-use is
-- enforced ATOMICALLY (update … set consumed_at = now() where consumed_at is null returning *);
-- each code is bound to and verified against its client_id, redirect_uri and resource; TTL 5 min.
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

-- Bridge tokens: short-lived access (3600s) + rotating refresh (sliding 30d idle window, capped by
-- grant expiry). Rotation inserts a successor row (rotated_from = predecessor); a refresh whose row
-- already HAS a successor is rotated-out — presenting it revokes the whole chain (RFC 9700 reuse
-- response), which is why the predecessor's refresh_hash is retained as the reuse-detection key.
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

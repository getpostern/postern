-- console-exposure-surface (ADR 0035 §D1/§D2) — the gateway's own public address, as a setting the
-- Console owns rather than a line in the operator's .env. Forward-only (ADR 0010), idempotent.
--
-- Singleton on the plaid_app pattern: `id boolean primary key default true check (id)` admits exactly
-- one row. NO SECRET — a public URL is published to a public certificate ledger by construction the
-- moment tailnet HTTPS issues its certificate, so there is nothing to seal and sealing it would only
-- make it unreadable at boot.
--
-- Row present = exposure configured (it WINS over MCP_PUBLIC_URL). Row absent = fall through to
-- MCP_PUBLIC_URL, then off. Neither ⇒ resolveBridgeConfig returns no config ⇒ every bridge path 404s.
--
-- 0016, not 0015: 0015 is claimed by the pending memory-floor DRAFT (0015_memories.sql). The migrator
-- keys on set membership, not a high-water mark, so taking 0016 while 0015 is unbuilt is safe.
create table if not exists gateway_exposure (
  id           boolean primary key default true check (id),
  public_url   text not null,
  consented_at timestamptz not null default now(),  -- ADR 0035 §D1: consent, recorded, not just a checkbox
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);

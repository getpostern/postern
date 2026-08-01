// The gateway's own public address — the `gateway_exposure` singleton read/write helper
// (console-exposure-surface, ADR 0035 §D1, migration 0016_gateway_exposure.sql).
//
// Mirrors src/plaid/app-config.ts MINUS the vault: a public URL is NOT a secret. Tailnet HTTPS
// publishes the machine name to a public certificate ledger the instant it issues the certificate, so
// there is nothing here to seal — and sealing it would only make the address unreadable at boot for no
// gain (CLAUDE.md: "Secrets are never stored in rows — only a secret_ref"; the converse is that a
// non-secret must not be dressed up as one).
//
// This module does NOT validate. `POST /api/exposure` runs validatePublicUrl BEFORE calling
// setExposure, so a row can only be written through a value the gateway can also boot with; a row
// planted by a different build is caught at resolution time (resolveBridgeConfig → problem
// "db_invalid") rather than here.

import { pool } from "../db.js";

export interface ExposureRow {
  /** Normalized origin, trailing slash trimmed — the exact literal the discovery documents state. */
  publicUrl: string;
  /** When the operator accepted the exposure consent. Never null on a stored row. */
  consentedAt: Date;
  updatedAt: Date | null;
}

/** Row present = exposure configured. Null = no row. Throws ONLY on a real DB fault. */
export async function getExposure(): Promise<ExposureRow | null> {
  const res = await pool.query(
    `select public_url, consented_at, updated_at from gateway_exposure where id = true`,
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    publicUrl: row.public_url as string,
    consentedAt: new Date(row.consented_at as string | Date),
    updatedAt: row.updated_at == null ? null : new Date(row.updated_at as string | Date),
  };
}

/**
 * Upsert the singleton. `consented_at = now()` on BOTH branches, deliberately: ADR 0035 §D1 puts
 * consent at the moment of enabling, and changing the published address IS enabling a new one — so a
 * re-save re-records the consent rather than carrying the old one forward.
 */
export async function setExposure(publicUrl: string): Promise<ExposureRow> {
  const res = await pool.query(
    `insert into gateway_exposure (id, public_url, consented_at, created_at, updated_at)
     values (true, $1, now(), now(), now())
     on conflict (id) do update set
       public_url   = excluded.public_url,
       consented_at = now(),
       updated_at   = now()
     returning public_url, consented_at, updated_at`,
    [publicUrl],
  );
  const row = res.rows[0];
  return {
    publicUrl: row.public_url as string,
    consentedAt: new Date(row.consented_at as string | Date),
    updatedAt: row.updated_at == null ? null : new Date(row.updated_at as string | Date),
  };
}

/** Stop publishing at the next boot. Idempotent — a no-op when there is no row. */
export async function clearExposure(): Promise<void> {
  await pool.query(`delete from gateway_exposure where id = true`);
}

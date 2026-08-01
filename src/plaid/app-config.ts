// BYO Plaid app config — the `plaid_app` singleton read/write helper (wave 13, ADR 0019).
//
// Mirrors src/oauth/provider-apps.ts: the operator pastes their own Plaid `client_id` (public — it
// travels in /link/token/create) + `client_secret` (sealed in the vault under purpose 'plaid_secret';
// the row holds ONLY the opaque secret_ref — CLAUDE.md invariant) + the env. Singleton: a single row
// keyed on `id = true`.
//
// NEVER logs the client secret or the sealed bytes; getPlaidApp NEVER returns the secret.

import { pool } from "../db.js";
import { open, seal, deleteSecret } from "../secrets/index.js";
import { LOCAL_USER_ID } from "../auth/sectors.js";
import { ConfigError } from "../oauth/providers.js";

/** Sandbox (test data, free) or Production (real banks, per-Item billed on a paid plan). */
export type PlaidEnv = "sandbox" | "production";

/** Vault purpose tag for the AEAD AAD binding of the Plaid app client secret. */
const SECRET_PURPOSE = "plaid_secret";
/** The provider tag (part of the vault AAD); Plaid is always a confidential client. */
const PROVIDER = "plaid";

interface AppRow {
  client_id: string;
  client_secret_ref: string;
  env: PlaidEnv;
}

/** Read the raw singleton row (client_id + sealed-secret ref + env), or null when unconfigured. */
async function readRow(): Promise<AppRow | null> {
  const res = await pool.query(
    `select client_id, client_secret_ref, env from plaid_app where id = true`,
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    client_id: row.client_id as string,
    client_secret_ref: row.client_secret_ref as string,
    env: row.env as PlaidEnv,
  };
}

/**
 * Status of the BYO Plaid app — for the GET /api/plaid/app route. Returns the public `client_id` and
 * `env` only; the secret NEVER leaves the vault. `env` defaults to 'production' (the self-host safety
 * floor — an unconfigured app must read as real banks, never silently sandbox; sandbox is the dev-only
 * opt-in, #30) when unconfigured.
 */
export async function getPlaidApp(): Promise<{ configured: boolean; clientId: string | null; env: PlaidEnv }> {
  const row = await readRow();
  return { configured: row !== null, clientId: row?.client_id ?? null, env: row?.env ?? "production" };
}

/**
 * Resolve the Plaid app for plaidConfig: the `client_id` + the OPENED client secret (decrypted from the
 * vault) + the env. Returns null when no row exists (caller falls back to env vars). NEVER logs the secret.
 */
export async function loadPlaidApp(): Promise<{ clientId: string; clientSecret: string; env: PlaidEnv } | null> {
  const row = await readRow();
  if (!row) return null;
  const clientSecret = (
    await open(row.client_secret_ref, {
      userId: LOCAL_USER_ID,
      provider: PROVIDER,
      purpose: SECRET_PURPOSE,
    })
  ).toString("utf8");
  return { clientId: row.client_id, clientSecret, env: row.env };
}

/**
 * Upsert the BYO Plaid app. Plaid is always confidential, so a `client_secret` is REQUIRED; the secret
 * is SEALED in the vault BEFORE the upsert (a seal failure leaves no half-written row), and only the
 * `secret_ref` is stored. Re-paste supersedes: the new secret is sealed and the superseded vault row is
 * retired best-effort. `client_id` is trimmed; an empty id / secret / a bad env is rejected (ConfigError → 400).
 */
export async function setPlaidApp(clientId: string, clientSecret: string, env: PlaidEnv): Promise<void> {
  const id = (clientId ?? "").trim();
  if (!id) throw new ConfigError("client_id is required for the plaid app");

  const secret = clientSecret && clientSecret.trim().length > 0 ? clientSecret.trim() : null;
  if (!secret) throw new ConfigError("a client_secret is required for the plaid app");

  if (env !== "sandbox" && env !== "production") {
    throw new ConfigError("plaid env must be 'sandbox' or 'production'");
  }

  // Seal BEFORE the upsert so a seal failure leaves no half-written row.
  const newRef = await seal({ userId: LOCAL_USER_ID, provider: PROVIDER, purpose: SECRET_PURPOSE }, secret);

  const prior = await readRow();

  await pool.query(
    `insert into plaid_app (id, client_id, client_secret_ref, env, created_at, updated_at)
     values (true, $1, $2, $3, now(), now())
     on conflict (id) do update set
       client_id         = excluded.client_id,
       client_secret_ref = excluded.client_secret_ref,
       env               = excluded.env,
       updated_at        = now()`,
    [id, newRef, env],
  );

  // Retire the superseded secret row (best-effort — vault hygiene must not fail the save).
  if (prior?.client_secret_ref && prior.client_secret_ref !== newRef) {
    try {
      await deleteSecret(prior.client_secret_ref);
    } catch {
      // best-effort only: the row is already superseded; leaving the blob is harmless.
    }
  }
}

/**
 * Clear the BYO Plaid app (DELETE /api/plaid/app). Removes the singleton row, THEN deletes its sealed
 * vault secret (delete the row first so nothing references the secret). Idempotent — a no-op when unconfigured.
 */
export async function clearPlaidApp(): Promise<void> {
  const prior = await readRow();
  await pool.query(`delete from plaid_app where id = true`);
  if (prior?.client_secret_ref) {
    try {
      await deleteSecret(prior.client_secret_ref);
    } catch {
      // best-effort only — at worst an orphaned, now-unreferenced encrypted blob remains.
    }
  }
}

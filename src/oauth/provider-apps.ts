// BYO OAuth provider apps — the `oauth_provider_apps` read/write helper (ADR 0014).
//
// The operator pastes their per-provider app credentials in the Console: `client_id` is stored
// plain (it is public, it travels in the authorize URL), `client_secret` is sealed in the vault and
// the row holds ONLY the opaque `secret_ref` (CLAUDE.md invariant — rows hold no secret material).
// Public clients (microsoft) carry no secret → `client_secret_ref` stays NULL.
//
// NEVER logs the client secret or the sealed bytes.

import { pool } from "../db.js";
import { open, seal, deleteSecret } from "../secrets/index.js";
import { LOCAL_USER_ID } from "../auth/sectors.js";
import { ConfigError, isConfidential, type OAuthProvider } from "./providers.js";

/** Vault purpose tag for the AEAD AAD binding of a provider-app client secret. */
const SECRET_PURPOSE = "oauth_client_secret";

interface AppRow {
  client_id: string;
  client_secret_ref: string | null;
}

/** Read the raw row for a provider (client_id + sealed-secret ref), or null when unconfigured. */
async function readRow(p: OAuthProvider): Promise<AppRow | null> {
  const res = await pool.query(
    `select client_id, client_secret_ref from oauth_provider_apps where provider = $1`,
    [p],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    client_id: row.client_id as string,
    client_secret_ref: (row.client_secret_ref ?? null) as string | null,
  };
}

/**
 * Status of a provider's BYO app — for the GET /api/oauth/:provider/app route. Returns the public
 * `client_id` only; the secret NEVER leaves the vault.
 */
export async function getProviderApp(
  p: OAuthProvider,
): Promise<{ configured: boolean; clientId: string | null }> {
  const row = await readRow(p);
  return { configured: row !== null, clientId: row?.client_id ?? null };
}

/**
 * Resolve a provider's app credentials for providerConfig: the `client_id` plus the OPENED client
 * secret (decrypted from the vault). Returns null when no row exists (caller falls back to env).
 * Confidential rows always carry a `client_secret_ref`; if it's somehow absent, clientSecret is null.
 */
export async function loadProviderApp(
  p: OAuthProvider,
): Promise<{ clientId: string; clientSecret: string | null } | null> {
  const row = await readRow(p);
  if (!row) return null;
  let clientSecret: string | null = null;
  if (row.client_secret_ref) {
    clientSecret = (
      await open(row.client_secret_ref, {
        userId: LOCAL_USER_ID,
        provider: p,
        purpose: SECRET_PURPOSE,
      })
    ).toString("utf8");
  }
  return { clientId: row.client_id, clientSecret };
}

/**
 * Upsert a provider's BYO app. Validates the client type (a secret is REQUIRED for confidential
 * providers and REJECTED for public ones), seals any secret in the vault, and stores only the
 * `secret_ref`. Re-paste supersedes: a new secret is sealed and the superseded vault row retired
 * best-effort. `client_id` is trimmed; an empty id is rejected.
 */
export async function setProviderApp(
  p: OAuthProvider,
  clientId: string,
  clientSecret: string | null,
): Promise<void> {
  const id = (clientId ?? "").trim();
  if (!id) throw new ConfigError(`client_id is required for oauth provider '${p}'`);

  // Normalize an empty/whitespace secret to "absent".
  const secret = clientSecret && clientSecret.trim().length > 0 ? clientSecret.trim() : null;

  if (isConfidential(p)) {
    if (!secret) {
      throw new ConfigError(`oauth provider '${p}' is confidential: a client_secret is required`);
    }
  } else if (secret) {
    throw new ConfigError(`oauth provider '${p}' is a public client: a client_secret is not allowed`);
  }

  // Seal the secret BEFORE the upsert so a seal failure leaves no half-written row.
  const newRef = secret
    ? await seal({ userId: LOCAL_USER_ID, provider: p, purpose: SECRET_PURPOSE }, secret)
    : null;

  const prior = await readRow(p);

  await pool.query(
    `insert into oauth_provider_apps (provider, client_id, client_secret_ref, created_at, updated_at)
     values ($1, $2, $3, now(), now())
     on conflict (provider) do update set
       client_id         = excluded.client_id,
       client_secret_ref = excluded.client_secret_ref,
       updated_at        = now()`,
    [p, id, newRef],
  );

  // Retire the superseded secret row (best-effort — vault hygiene must not fail the save).
  if (prior?.client_secret_ref && prior.client_secret_ref !== newRef) {
    try {
      await deleteSecret(prior.client_secret_ref);
    } catch {
      // best-effort only: the row is already superseded; leaving it is harmless.
    }
  }
}

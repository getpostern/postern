// OAuth token refresh on the sync path — the generic credential-resolution seam.
//
// `runner.syncConnection` calls resolveAccessToken() once, in step 3, to turn a credential row into a
// usable access token. For static / non-OAuth credentials (SimpleFIN, Home Assistant, Gmail IMAP,
// Plaid) this is exactly what the runner did before: open secret_ref at purpose 'access'. For an
// OAuth credential (google / microsoft / whoop) whose access token is at/within EXPIRY_MARGIN of
// expiry — or whose expiry is unknown — we proactively trade the refresh token for a fresh access
// token, re-seal it, repoint the credential row, retire the superseded vault rows, and return the
// fresh token. One seam, zero per-connector code; fetch_live will reuse it.
//
// Concurrency (Wave 5): one credential fans out to MULTIPLE connections (google →
// calendar+contacts), so overlapping syncs can race the refresh. Two guards, both in-process only
// (V0 is a single-process box):
//   - SINGLE-FLIGHT: a per-credential Map of in-flight promises — overlapping callers share ONE
//     refresh instead of racing the token endpoint (the second race loses the rotated refresh token).
//   - RE-READ: inside the critical section the credential row is re-read by id — a caller holding a
//     stale snapshot (refs captured before a sibling's refresh retired them) short-circuits to the
//     CURRENT refs instead of double-refreshing with a dead refresh token.
//
// NEVER logs access tokens, refresh tokens, or any secret material. Errors carry status only (see
// exchange.ts — a non-2xx surfaces the status code, never the token-bearing body).

import { pool } from "../db.js";
import { deleteSecret, open, seal } from "../secrets/index.js";
import { refreshToken } from "./exchange.js";
import { isOAuthProvider, type OAuthProvider } from "./providers.js";

/** Everything resolveAccessToken needs from a connector's credential row (no secret material). */
export interface CredentialRef {
  credentialId: string;
  userId: string;
  provider: string;
  secretRef: string | null;
  refreshRef: string | null;
  expiresAt: Date | null;
}

/**
 * What resolveAccessToken hands back: the plaintext token plus the CURRENT vault ref behind it —
 * the NEW ref after a refresh, the existing one otherwise — so callers (runner → SyncContext)
 * never carry a retired secretRef forward.
 */
export interface ResolvedCredential {
  token: string | null;
  secretRef: string | null;
}

/** Refresh a token this many ms before it actually expires (clock-skew + in-flight headroom). */
const EXPIRY_MARGIN_MS = 120_000; // 120s

/**
 * Per-credential single-flight slot. `finally` clears it — a failed refresh must reject every
 * sharer but never wedge the slot. In-process only (V0 single-process box; no cross-process lock).
 */
const inflight = new Map<string, Promise<ResolvedCredential>>();

/**
 * Return a usable access token + its CURRENT vault ref (plaintext never logged), refreshing +
 * persisting first when an OAuth credential is at/within EXPIRY_MARGIN of expiry (or its
 * expires_at is null). Static credentials and non-OAuth providers are opened as-is, lock-free —
 * the pre-refresh behaviour, byte-for-byte.
 *
 * Throws on refresh failure (open/refreshToken/seal) so the caller (syncConnection) flips the
 * connection to status='error'. Nothing is half-written: the credential row is repointed ONLY after a
 * successful refresh + re-seal — never on failure.
 */
export async function resolveAccessToken(cred: CredentialRef): Promise<ResolvedCredential> {
  const { credentialId, userId, provider, secretRef, refreshRef, expiresAt } = cred;

  // 1. Static / non-refreshable — non-OAuth provider, or no refresh token to trade. Open access
  //    as-is, lock-free. (SimpleFIN / Home Assistant / Gmail / Plaid — identical to the pre-refresh path.)
  if (!isOAuthProvider(provider) || refreshRef == null) {
    return openAsResolved(userId, provider, secretRef);
  }

  // 2. OAuth, still valid — expiry is known and comfortably beyond the margin: open access,
  //    no refresh, no lock.
  if (expiresAt != null && expiresAt.getTime() - Date.now() > EXPIRY_MARGIN_MS) {
    return openAsResolved(userId, provider, secretRef);
  }

  // 3. OAuth, expired / expiring / unknown expiry PER THE CALLER'S SNAPSHOT — a refresh may be
  //    needed. Single-flight: an overlapping caller shares the in-flight promise; the critical
  //    section re-reads the row so a stale snapshot can never trigger a second refresh.
  const existing = inflight.get(credentialId);
  if (existing) return existing;
  const flight = refreshLocked(cred).finally(() => inflight.delete(credentialId));
  inflight.set(credentialId, flight);
  return flight;
}

/**
 * The critical section. RE-READS the credential row by id — never trusts the caller's snapshot
 * (a sibling's refresh may have already rotated the refs and retired the old vault rows) — and
 * short-circuits to the open-access path if the row is now fresh. Otherwise: trade the refresh
 * token, re-seal, repoint the row, retire the superseded vault rows.
 */
async function refreshLocked(cred: CredentialRef): Promise<ResolvedCredential> {
  const { credentialId, userId, provider } = cred;

  const reread = await pool.query(
    `select secret_ref, refresh_ref, expires_at from provider_credentials where id = $1`,
    [credentialId],
  );
  const row = reread.rows[0];
  if (!row) throw new Error(`credential not found: ${credentialId}`);
  const secretRef = (row.secret_ref ?? null) as string | null;
  const refreshRef = (row.refresh_ref ?? null) as string | null;
  const expiresAt = (row.expires_at ?? null) as Date | null;

  const now = Date.now();

  // Fresh now (a sibling refreshed between the snapshot and the lock) — or the refresh token is
  // gone from the row: open the CURRENT access ref, no second refresh.
  if (refreshRef == null || (expiresAt != null && expiresAt.getTime() - now > EXPIRY_MARGIN_MS)) {
    return openAsResolved(userId, provider, secretRef);
  }

  // Still expired / expiring / unknown — trade the refresh token for a fresh access token.
  const rt = (await open(refreshRef, { userId, provider, purpose: "refresh" })).toString("utf8");
  // refreshToken throws on a non-2xx (status only, never the body) — let it propagate (→ markError).
  const tokens = await refreshToken(provider as OAuthProvider, rt);

  // Re-seal the new tokens. A refresh response MAY rotate the refresh token; if it doesn't, keep the
  // existing refresh_ref (and don't retire it).
  const newSecretRef = await seal({ userId, provider, purpose: "access" }, tokens.accessToken);
  const rotated = tokens.refreshToken != null;
  const newRefreshRef = rotated
    ? await seal({ userId, provider, purpose: "refresh" }, tokens.refreshToken!)
    : refreshRef;
  const newExpiresAt = tokens.expiresInSec != null ? new Date(now + tokens.expiresInSec * 1000) : null;

  // Repoint the credential row — ONLY now, after a successful refresh + re-seal (never on failure).
  await pool.query(
    `update provider_credentials set secret_ref = $1, refresh_ref = $2, expires_at = $3 where id = $4`,
    [newSecretRef, newRefreshRef, newExpiresAt, credentialId],
  );

  // Retire the superseded vault rows (best-effort — a delete failure must not fail the sync).
  if (secretRef) await bestEffortDelete(secretRef);
  if (rotated) await bestEffortDelete(refreshRef);

  return { token: tokens.accessToken, secretRef: newSecretRef };
}

/** Open a credential's access secret (when present) and return it with its CURRENT ref. */
async function openAsResolved(
  userId: string,
  provider: string,
  secretRef: string | null,
): Promise<ResolvedCredential> {
  if (!secretRef) return { token: null, secretRef: null };
  const token = (await open(secretRef, { userId, provider, purpose: "access" })).toString("utf8");
  return { token, secretRef };
}

/** deleteSecret, swallowing failure — vault hygiene must never escalate into a sync failure. */
async function bestEffortDelete(ref: string): Promise<void> {
  try {
    await deleteSecret(ref);
  } catch {
    // best-effort only: the row is already superseded; leaving it is harmless.
  }
}

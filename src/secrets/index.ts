// Secret Store — local AEAD vault. Public API consumed by rest-onboarding (seal) and
// sync-runner/connectors (open). Every provider token/URL is sealed under a master key and
// referenced in credential rows only by an opaque `sec_<uuid>`.
//
// NEVER logs plaintext, key bytes, or ciphertext.

import { randomUUID } from "node:crypto";
import { aeadSeal, aeadOpen } from "./aead.js";
import { activeKey, keyById } from "./key.js";
import { insertSecret, selectSecret, deleteSecret as deleteSecretRow } from "./store.js";

// Key custody + fail-closed vault verification (#97). Re-exports ONLY — the implementations live in
// key.ts / verify.ts, which import from each other directly (never through this barrel).
export {
  vaultKeyStatus,
  acknowledgeVaultKey,
  vaultBackupNotice,
  type VaultKeyCustody,
  type VaultKeyStatus,
} from "./key.js";
export {
  verifyVaultKey,
  assertVaultKey,
  VaultKeyError,
  type VaultFailureReason,
  type VaultKeyFailure,
  type VaultVerifyResult,
  type VaultVerifyOptions,
} from "./verify.js";

export interface SecretContext {
  userId: string; // owning user (FK secrets.user_id)
  provider: string; // 'simplefin' | 'plaid' | 'google' | ... (part of the AAD)
  purpose: string; // 'access_url' | 'access_token' | 'refresh_token' | 'oauth_client' ...
}

export class SecretNotFound extends Error {} // ref absent
// `override name` is load-bearing, not cosmetic: an ES class that extends Error inherits
// `name === "Error"`, so every downstream rule that classifies a failure by `err.name` (the sync
// runner's terminal-vs-retryable split) is DEAD CODE against a real instance. Matches the idiom
// already used by ConfigError (src/oauth/providers.ts) and TokenEndpointError (src/oauth/exchange.ts).
export class SecretAuthError extends Error {
  override name = "SecretAuthError";
} // GCM tag or AAD mismatch (tamper / wrong key / wrong context)
export class MasterKeyError extends Error {} // no key for the row's key_id, or malformed configured key

/** Bind the sealed blob to its owning context (anti-replay / confused-deputy defense). */
function deriveAad(ctx: SecretContext): string {
  return `${ctx.userId}|${ctx.provider}|${ctx.purpose}`;
}

/** Seal a plaintext secret. Writes one `secrets` row, returns its opaque ref ('sec_<uuid>'). */
export async function seal(ctx: SecretContext, plaintext: string | Buffer): Promise<string> {
  const aad = deriveAad(ctx);
  const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const { keyId, key } = activeKey();
  const { ciphertext, nonce } = aeadSeal(key, pt, aad);
  const ref = "sec_" + randomUUID();
  await insertSecret({ ref, userId: ctx.userId, ciphertext, nonce, keyId, aad });
  return ref;
}

/**
 * Retire a sealed secret row by ref. Used for vault hygiene after a token refresh repoints a
 * credential to a freshly-sealed ref, so the superseded row doesn't linger. Idempotent (an absent
 * ref is a no-op). There is no plaintext here — only the opaque ref — so nothing sensitive is logged.
 */
export async function deleteSecret(ref: string): Promise<void> {
  await deleteSecretRow(ref);
}

/**
 * Resolve a ref to plaintext, AEAD-verified. `expect` re-derives the AAD and requires it to equal
 * the sealed AAD before decrypting (swapped-ref defense), then GCM verifies tag + AAD.
 * Throws SecretNotFound | SecretAuthError | MasterKeyError.
 */
export async function open(ref: string, expect: SecretContext): Promise<Buffer> {
  const row = await selectSecret(ref);
  if (!row) throw new SecretNotFound(`secret ref not found: ${ref}`);

  const wantAad = deriveAad(expect);
  if (row.aad !== wantAad) {
    // Context mismatch: the ref was sealed for a different user/provider/purpose.
    throw new SecretAuthError("AAD mismatch: secret context does not match expected context");
  }

  // keyById throws MasterKeyError when the sealing key is unavailable for this key_id.
  const { key } = keyById(row.keyId);

  try {
    return aeadOpen(key, row.ciphertext, row.nonce, wantAad);
  } catch {
    // GCM verification failed: tampered ciphertext/nonce, wrong key, or mismatched AAD.
    throw new SecretAuthError("secret failed authentication (tag/AAD verification)");
  }
}

// Vault key verification — does the master key this gateway resolved actually open the credentials
// this database already holds?
//
// Why it exists (#97): the key lives in a Docker volume and the DB in another. Restore one without
// the other — or let `docker compose down -v` regenerate a fresh key — and the gateway boots GREEN,
// serves a healthy Console, and only fails weeks later at the first sync with a SecretAuthError per
// connection. This check turns that into a refusal to start, at boot, naming the remedy.
//
// SHAPE: pick ONE representative row per distinct `key_id` and attempt a raw AEAD open with the key
// `keyById` resolves for that id. A key that opens one row of a key_id opens all of them (same key,
// same algorithm), so one open per key id is a COMPLETE check at O(number of key ids) — typically 1.
// It also stays correct across a partially-completed rotation, where the vault legitimately holds
// two key ids.
//
// READ-ONLY: this file issues no insert/update/delete, anywhere. It never writes and never logs.
// Errors it constructs carry counts, key ids, opaque `sec_` refs and file paths — and nothing else:
// no key bytes, no plaintext, no ciphertext, no AAD.
//
// NO AuthContext, deliberately: verifyVaultKey is not a core data-returning function and returns no
// user data — only counts, key-id labels and opaque refs. Its one query names fixed control-plane
// columns with parameterized values, so the REGISTRY rule (which governs agent-composed queries over
// domain tables) is satisfied by construction.

import { pool } from "../db.js";
import { aeadOpen } from "./aead.js";
import { keyById, vaultKeyStatus } from "./key.js";

/** Why a representative sealed row failed to open. */
export type VaultFailureReason = "no_key" | "did_not_open";

export interface VaultKeyFailure {
  keyId: string; // secrets.key_id whose representative row failed
  ref: string; // the opaque 'sec_<uuid>' that failed (never any secret material)
  rows: number; // how many in-scope rows carry this key_id
  reason: VaultFailureReason;
}

export interface VaultVerifyResult {
  sealedRows: number; // total in-scope rows in `secrets` (0 = empty vault = a first run)
  scannedKeyIds: string[]; // distinct in-scope key_id values, ascending
  failures: VaultKeyFailure[];
}

/**
 * NARROWING test seams only. Both are `undefined` in production and MUST NOT be derivable from
 * process.env, config, or any caller-supplied string parsed at runtime. They can only shrink the
 * scan — there is no widening, and no way to skip it.
 */
export interface VaultVerifyOptions {
  keyIds?: string[];
  refs?: string[];
}

/** Thrown by assertVaultKey. Message carries counts / key ids / opaque refs / file paths ONLY. */
export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultKeyError";
  }
}

/**
 * The IN-SCOPE set: every secret ref a live connector depends on, and nothing else.
 *
 * WHY THIS EXISTS — this gate refused to boot PRODUCTION on 2026-07-25, its first real deploy, and
 * it was a false positive. The original scan was a bare `from secrets`, on the assumption that every
 * sealed row belongs to a working credential. On a deployment with any rotation history that
 * assumption is wrong for MOST of the table: `secret_ref` is OVERWRITTEN on every credential
 * re-paste, OAuth re-consent,
 * iCloud re-onboard and Plaid re-link WITHOUT retiring the previous blob (a known, deliberately
 * deferred defect — issue #105 item 1), so the vault accumulates orphans under the key ids of past
 * rotations (`rt-old-…`, `rt-new-…`, `k_…`). Every orphan raised `no_key`, and the gate refused.
 *
 * Scoping to "referenced by any credential" is NOT sufficient, and that deploy proved it too: a leftover
 * `rotatetest-<uuid>` credential from a rotation test still referenced a row under an `rt-new-…` key
 * id. It has no connector, so it cannot break a sync — but it would still have bricked the boot.
 *
 * So the scope is the set the gate's PURPOSE implies: a sync runs per connector and opens that
 * connector's credential, so the rows whose failure actually produces the later `SecretAuthError`
 * are exactly those reachable from a credential with a live connector. That is narrow enough to
 * ignore orphans and test artifacts, and wide enough to catch the real disaster — a restored or
 * migrated box whose key opens nothing, which fails here on every real credential at once.
 *
 * A revoked credential already has its refs NULLed by `revokeCredential`, so it drops out naturally.
 */
const LIVE_SECRET_REFS = `
  select unnest(array[pc.secret_ref, pc.refresh_ref, pc.client_app_ref])
    from provider_credentials pc
   where exists (
     select 1 from connectors c
      where c.credential_id = pc.id and c.status <> 'revoked'
   )`;

interface RepresentativeRow {
  key_id: string;
  ref: string;
  ciphertext: Buffer;
  nonce: Buffer;
  aad: string | null;
  rows_for_key: number;
}

/**
 * Read-only. Never writes, never throws for an empty vault.
 *
 * Postgres evaluates window functions BEFORE `DISTINCT ON`, so `rows_for_key` is the full in-scope
 * count for that key id, not 1. The `order by` must start with `key_id` (required by DISTINCT ON);
 * `ref desc` is the deterministic tie-break for rows sharing a `created_at`.
 */
export async function verifyVaultKey(opts?: VaultVerifyOptions): Promise<VaultVerifyResult> {
  // SCOPE (corrected 2026-07-25 after this gate refused to boot production — see the block comment
  // above `LIVE_SECRET_REFS`). Only rows a live connector actually depends on.
  const res = await pool.query<RepresentativeRow>(
    `select distinct on (key_id)
            key_id, ref, ciphertext, nonce, aad,
            count(*) over (partition by key_id)::int as rows_for_key
       from secrets
      where ref in (${LIVE_SECRET_REFS})
        and ($1::text[] is null or key_id = any($1))
        and ($2::text[] is null or ref = any($2))
      order by key_id, created_at desc, ref desc`,
    [opts?.keyIds ?? null, opts?.refs ?? null],
  );

  const scannedKeyIds: string[] = [];
  const failures: VaultKeyFailure[] = [];
  let sealedRows = 0;

  for (const row of res.rows) {
    const keyId = row.key_id;
    const rows = row.rows_for_key;
    scannedKeyIds.push(keyId);
    sealedRows += rows;

    let key: Buffer;
    try {
      key = keyById(keyId).key;
    } catch {
      // Caught untyped on purpose: importing MasterKeyError from ./index.js would add a SECOND
      // import cycle through the barrel (key.ts:11 already has one).
      failures.push({ keyId, ref: row.ref, rows, reason: "no_key" });
      continue;
    }
    try {
      // Sealed rows always carry an AAD; a null is defended as the empty string (mirrors rotate.ts).
      // The returned plaintext is DISCARDED immediately — it is never bound to a name that could
      // reach a log, an error message, or the returned result.
      aeadOpen(key, row.ciphertext, row.nonce, row.aad ?? "");
    } catch {
      failures.push({ keyId, ref: row.ref, rows, reason: "did_not_open" });
    }
  }

  // "Nothing to check" and "checked and passed" are the SAME branch by construction: an empty vault
  // yields no rows, hence no failures. A first run has nothing sealed and MUST boot.
  return { sealedRows, scannedKeyIds, failures };
}

/**
 * verifyVaultKey + fail-closed: throws VaultKeyError when `failures` is non-empty.
 *
 * NON-BYPASSABLE. There is no env var, no config field and no flag that skips this. `keyIds`/`refs`
 * only NARROW the scan and are unreachable from the environment. (`PCI_TEST_DB=1` is this repo's
 * standing lesson about what a bypass costs — do not add an equivalent here.)
 */
export async function assertVaultKey(opts?: VaultVerifyOptions): Promise<void> {
  const result = await verifyVaultKey(opts);
  if (result.failures.length === 0) return;

  const keyPath = vaultKeyStatus().keyPath ?? "(PCI_MASTER_KEY, env-managed)";
  const first = result.failures[0];
  const lines = [
    `vault key check FAILED: ${first.rows} sealed secret(s) under key_id '${first.keyId}' did not ` +
      `open with the master key this gateway resolved (first failing ref ${first.ref}; reason: ${first.reason}).`,
    `Refusing to start: every stored credential is sealed under a DIFFERENT key, and every sync would fail later with SecretAuthError.`,
    `  - Check PCI_MASTER_KEY_ID FIRST: rows are looked up by key_id, so the key can be perfectly fine and only its LABEL diverged. If PCI_MASTER_KEY_ID changed (or was set, unset, or picked up a stray value), set it back to '${first.keyId}' and start again — nothing needs restoring.`,
    `  - Docker: the key that seals this database lives at ${keyPath} INSIDE the \`pci_master_key\` volume. A host-side ./.pci/master.key is a DIFFERENT, stale key.`,
    `  - Otherwise restore the key that sealed this database, or set PCI_MASTER_KEY to its base64 value (see docs/runbooks/host-migration.md, "The master-key trap").`,
    `  - NEVER run \`docker compose down -v\`: it deletes the volume, and every credential becomes permanently unopenable.`,
    `Nothing was modified.`,
  ];
  for (const extra of result.failures.slice(1)) {
    lines.push(
      `  - also: ${extra.rows} sealed secret(s) under key_id '${extra.keyId}' did not open ` +
        `(first failing ref ${extra.ref}; reason: ${extra.reason}).`,
    );
  }
  throw new VaultKeyError(lines.join("\n"));
}

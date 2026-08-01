// Master-key rotation — re-seal every vault secret IN PLACE BY REF under a new master key.
//
// Why this exists: `secrets.key_id` labels which master key sealed each row and `secrets.rotated_at`
// is the rotation seam (db/schema.sql). Until now nothing exercised it — a row decrypts only under
// the key that sealed it, with no way to re-key. `rotateMasterKey` closes that gap: it enumerates the
// vault, opens each row with the OLD key, re-seals it with the NEW key, and stamps
// `key_id = newKeyId`, `rotated_at = now()` WHERE `ref = $ref`. Because credential/domain rows
// reference a secret only by its opaque `ref` (never by the key), re-sealing IN PLACE needs NO
// repoint — every `secret_ref` stays valid and points at the same, now-re-keyed, row.
//
// Idempotent + resumable: a row already at `newKeyId` is SKIPPED, so a re-run after a mid-rotation
// crash completes only the unfinished rows. Each row is its own UPDATE (autocommit) — mirroring
// refresh.ts's transactional shape (nothing half-written; the row is rewritten ONLY after a
// successful open+re-seal), so a crash leaves a clean mix of old-key and new-key rows, never a torn
// row, and the re-run picks up exactly where it stopped.
//
// SAFETY: this tool holds BOTH keys locally and calls the pure AEAD primitives directly — it does
// NOT touch key.ts/index.ts, so the gateway needs no global dual-key state. It NEVER logs key bytes,
// plaintext, ciphertext, or the AAD. A wrong old key (or a tampered row) makes `aeadOpen` fail the
// GCM tag/AAD check; we translate that into a fail-closed error that names only the opaque `ref` —
// the row is left untouched, so there is no silent corruption.
//
// Operational model (ADR 0011): V1 rotation runs with the gateway STOPPED, after a backup. We do not
// build online-rotation locking — a quiesced box cannot race a live seal. The full procedure
// (backup -> rotate -> swap the active key -> verify) lives in docs/runbooks/key-rotation.md.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { aeadOpen, aeadSeal } from "./aead.js";
import { pool } from "../db.js";
import { activeKey } from "./key.js";
import { config } from "../config.js";

/** AES-256 key length — every key (old and new) must be exactly this many bytes. */
const KEY_BYTES = 32;

/**
 * Errors deliberately constructed by this tool. Their messages carry ONLY opaque refs / key-id labels
 * / lengths — never key bytes, plaintext, ciphertext, or AAD — so the CLI surfaces them verbatim.
 * Anything that is NOT a RotateError (e.g. a Postgres-driver error) may embed library internals, so
 * the CLI prints a fixed, sanitized line for those instead of echoing the raw message.
 */
export class RotateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RotateError";
  }
}

export interface RotateOptions {
  oldKey: Buffer; // 32 bytes — the key that currently seals the vault (from PCI_MASTER_KEY / key file)
  oldKeyId: string; // the label that current rows carry in secrets.key_id
  newKey: Buffer; // 32 bytes — the target key
  newKeyId: string; // the label to stamp on re-sealed rows (MUST differ from oldKeyId)
  /**
   * Restrict the rotation to rows whose `key_id` is in this set. Omit to rotate the WHOLE vault —
   * the production default (every secret is under the one master key). This is a scoping seam for
   * isolated tests that share a database with other suites: by sealing its fixtures under a unique
   * key id and passing it here, a test rotates only its own rows and never collides with a
   * concurrently-running suite's secrets.
   */
  keyIds?: string[];
}

export interface RotateResult {
  reSealed: number; // rows opened under oldKey and re-sealed under newKey
  skipped: number; // rows already at newKeyId (idempotent / resumable)
}

interface SecretScanRow {
  ref: string;
  ciphertext: Buffer;
  nonce: Buffer;
  key_id: string;
  aad: string | null;
}

/**
 * Re-seal every vault row under `newKey`, in place by `ref`. Rows already at `newKeyId` are skipped
 * (idempotent / resumable). Throws (fail-closed) the moment a row that should open under `oldKey`
 * does not — the offending `ref` is named, but no key bytes / plaintext are ever included, and the
 * row is left untouched (no silent corruption). Returns the re-sealed and skipped counts.
 */
export async function rotateMasterKey(opts: RotateOptions): Promise<RotateResult> {
  const { oldKey, newKey, newKeyId, keyIds } = opts;
  if (oldKey.length !== KEY_BYTES) throw new RotateError(`oldKey must be exactly ${KEY_BYTES} bytes`);
  if (newKey.length !== KEY_BYTES) throw new RotateError(`newKey must be exactly ${KEY_BYTES} bytes`);
  if (opts.oldKeyId === newKeyId) {
    // With the CLI's byte-derived ids (a sha256 fingerprint of the key bytes) oldKeyId === newKeyId
    // means the OLD and NEW keys are byte-identical — a no-op "rotation" the skip-by-newKeyId guard
    // would mask entirely. Refuse it rather than silently do nothing. (For a direct caller passing
    // hand-picked labels it still means "indistinguishable ids", which breaks resume the same way.)
    throw new RotateError("oldKeyId and newKeyId must differ");
  }

  const scan = keyIds
    ? await pool.query<SecretScanRow>(
        `select ref, ciphertext, nonce, key_id, aad from secrets where key_id = any($1)`,
        [keyIds],
      )
    : await pool.query<SecretScanRow>(`select ref, ciphertext, nonce, key_id, aad from secrets`);

  let reSealed = 0;
  let skipped = 0;

  for (const row of scan.rows) {
    // Already re-keyed (a prior run, or the completed half of a crashed run) — leave it untouched.
    // This skip is what makes the rotation idempotent and a re-run safe.
    if (row.key_id === newKeyId) {
      skipped++;
      continue;
    }

    // The AAD is bound into the GCM tag; re-seal under the SAME context so every credential `ref`
    // keeps resolving. Sealed rows always carry an AAD; treat a null defensively as the empty string.
    const aad = row.aad ?? "";

    // Open under the OLD key. A wrong key (or a tampered ciphertext/nonce) fails the tag/AAD check;
    // we surface a fail-closed error that names ONLY the opaque ref — never the key or the plaintext.
    let plaintext: Buffer;
    try {
      plaintext = aeadOpen(oldKey, row.ciphertext, row.nonce, aad);
    } catch {
      throw new RotateError(
        `rotateMasterKey: secret ${row.ref} did not open under the provided old key ` +
          `(wrong old key or tampered row); rotation aborted, no rows corrupted`,
      );
    }

    // Re-seal under the NEW key (fresh random nonce) and rewrite the row in place. A single UPDATE is
    // atomic, and the row is rewritten ONLY after a successful open+re-seal — nothing is half-written.
    const { ciphertext, nonce } = aeadSeal(newKey, plaintext, aad);
    plaintext.fill(0); // wipe our plaintext copy promptly — defense in depth.

    await pool.query(
      `update secrets set ciphertext = $1, nonce = $2, key_id = $3, rotated_at = now() where ref = $4`,
      [ciphertext, nonce, newKeyId, row.ref],
    );
    reSealed++;
  }

  return { reSealed, skipped };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
// `node dist/secrets/rotate.js --new <path|->`  (or `tsx src/secrets/rotate.ts --new <path|->`).
//
//   --new <path>   The new key file. If <path> exists and is exactly 32 bytes it is LOADED as the new
//                  key (operator pre-generated it, e.g. `head -c32 /dev/urandom > <path>`); otherwise
//                  a fresh 32-byte key is GENERATED. Either way the key is persisted at <path>, 0600,
//                  BEFORE any row is re-sealed — so a crash mid-rotation is recoverable (re-run with
//                  the same path resumes; the freshly-sealed rows are never orphaned).
//   --new -        Stage the new key next to the active key file (`<PCI_MASTER_KEY_PATH>.new`): reuse
//                  an existing 32-byte staged key if one is already there (so a re-run RESUMES), else
//                  generate a fresh one; persisted 0600 before rotation. Never clobbers the ACTIVE key
//                  — the operator swaps it in only after verifying (see the runbook).
//
// The OLD key is whatever the gateway currently resolves (env > file > autogen) via activeKey(). BOTH
// key ids are DERIVED DETERMINISTICALLY from the key BYTES (a short sha256 fingerprint), so re-running
// with the SAME new key recomputes the SAME newKeyId — already-re-keyed rows are skipped and the
// rotation RESUMES to completion. (The previous random/timestamped id regenerated a brand-new id every
// run, so a re-run could neither skip the done rows nor open them under the old key, and aborted.) The
// tool prints the re-sealed/skipped counts, the new key id, and the new key's path — it NEVER prints
// key bytes. The printed newKeyId is EXACTLY what the operator sets as PCI_MASTER_KEY_ID to activate
// (key.ts resolves the configured id -> the env key); activation + verification are the operator's
// next steps; see docs/runbooks/key-rotation.md.

/** Parse the new-key spec from argv. Throws on a missing/empty `--new`. */
function parseNewSpec(argv: string[]): string {
  const i = argv.indexOf("--new");
  if (i < 0) throw new RotateError("usage: rotate --new <path|->");
  const spec = argv[i + 1];
  if (!spec) throw new RotateError("--new requires a <path|-> argument");
  return spec;
}

/**
 * Deterministic key id = a short sha256 fingerprint of the key BYTES. Stable across runs: the same key
 * always yields the same id, so a resumed rotation recomputes the SAME newKeyId, finds the already-
 * re-keyed rows at that id, and SKIPS them — that is what makes the CLI genuinely resumable. (The old
 * random/timestamped id regenerated every run, so a re-run could neither skip the done rows nor open
 * them under the old key, and aborted.) A truncated sha256 is a one-way fingerprint: it identifies the
 * key without revealing it, so it is safe to store in `secrets.key_id` and to print. It is also exactly
 * the id the operator sets as PCI_MASTER_KEY_ID — key.ts's resolver maps the configured id to the env
 * key, so the derivation round-trips through activation.
 */
export function deriveKeyId(key: Buffer): string {
  return "k_" + createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** Read a 32-byte key file (fail closed on a wrong length). */
function loadKeyFile(path: string): Buffer {
  const key = readFileSync(path);
  if (key.length !== KEY_BYTES) {
    throw new RotateError(`new key file ${path} must be exactly ${KEY_BYTES} bytes`);
  }
  return key;
}

/** Persist a key 0600 with a 0700 parent dir (mirrors key.ts's writeKeyFile hardening). */
function persistKeyFile(path: string, key: Buffer): void {
  const dir = dirname(path);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // mkdir(recursive) won't re-tighten an already-existing dir
  }
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFile's mode only applies on create; enforce on a pre-existing file
}

/**
 * Resolve the new key + its destination path from the `--new` spec, persisting BEFORE rotation. `-`
 * targets `<active key path>.new` (never the active key); any other value is the destination path.
 * If a 32-byte key already exists at the destination it is REUSED — the operator pre-generated it, OR
 * a prior interrupted run already staged it; reusing the same key is what lets a re-run RESUME the
 * rotation under the same derived id rather than start a divergent one. Otherwise a fresh 32-byte key
 * is generated and persisted 0600.
 */
function resolveNewKey(spec: string): { newKey: Buffer; newKeyPath: string } {
  const newKeyPath = spec === "-" ? `${config.secretsKeyPath}.new` : spec;
  if (existsSync(newKeyPath)) {
    return { newKey: loadKeyFile(newKeyPath), newKeyPath };
  }
  const newKey = randomBytes(KEY_BYTES);
  persistKeyFile(newKeyPath, newKey);
  return { newKey, newKeyPath };
}

async function runCli(argv: string[]): Promise<void> {
  const spec = parseNewSpec(argv);

  // The OLD key = whatever the running gateway resolves today (env > file > autogen). We label it by a
  // fingerprint of its BYTES, not by activeKey()'s storage label ('file'/'env'/...), so old/new ids
  // are derived the same way and the "must differ" guard catches a byte-identical no-op rotation.
  const { key: oldKey } = activeKey();
  const oldKeyId = deriveKeyId(oldKey);

  // The NEW key is persisted to disk FIRST (durability: a crash mid-rotation must be recoverable),
  // then labelled by the SAME deterministic fingerprint — so a re-run with the same key recomputes the
  // same newKeyId, skips the already-re-keyed rows, and RESUMES the rotation to completion.
  const { newKey, newKeyPath } = resolveNewKey(spec);
  const newKeyId = deriveKeyId(newKey);

  const { reSealed, skipped } = await rotateMasterKey({ oldKey, oldKeyId, newKey, newKeyId });

  // Counts + activation hint only — never key bytes.
  process.stderr.write(`rotate: re-sealed ${reSealed}, skipped ${skipped} (already at the new key)\n`);
  process.stderr.write(`rotate: new key id = ${newKeyId}; key written to ${newKeyPath} (0600)\n`);
  process.stderr.write(
    `rotate: activate by pointing the gateway at the new key, e.g.\n` +
      `        export PCI_MASTER_KEY="$(base64 < ${newKeyPath} | tr -d '\\n')"\n` +
      `        export PCI_MASTER_KEY_ID="${newKeyId}"\n` +
      `        then restart and verify; see docs/runbooks/key-rotation.md\n`,
  );
}

// Guard: false on import (so the test can import rotateMasterKey without running the CLI), true only
// when this file is the process entrypoint. stderr-only logging; secrets are never written to a log.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((e) => {
      // RotateError messages are constructed by this tool and carry only opaque refs / labels /
      // lengths — safe to surface verbatim. Anything else (e.g. a Postgres-driver error) may embed
      // library internals, so print a fixed, sanitized line rather than echoing the raw message.
      // Neither path can leak the key/plaintext — neither is ever a SQL parameter or an error field.
      const detail = e instanceof RotateError ? e.message : "an unexpected error occurred";
      process.stderr.write(
        `rotate failed: ${detail} (no key bytes or plaintext were exposed; see the gateway logs)\n`,
      );
      process.exit(1);
    });
}

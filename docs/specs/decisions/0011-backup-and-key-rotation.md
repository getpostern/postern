# ADR 0011 — Backup/restore + master-key rotation

**Status:** accepted · **Date:** 2026-06-14 · **Wave:** 9C (`ops-hygiene`)

## Context

Two operational gaps made the gateway unsafe to actually run with real data: (1) **no backup story** —
losing `.pci/master.key` = total, unrecoverable data loss (the key and the DB are mutually useless apart),
and (2) the **`key_id` rotation seam was unused** — rows decrypt under whatever key sealed them, but nothing
could re-key them, so a leaked/aging master key could never be retired. Plus the repo had **no CI** (a DB-less
run is false-green — ~16% of tests skip without `DATABASE_URL`) and no lint/format gate.

## Decision

1. **Backup = key + `pg_dump` as ONE atomic tarball** (a single backup script): timestamped staging dir →
   copy the master key (or note an env-managed key supplied out-of-band; refuse a keyless backup) →
   `docker compose exec -T db pg_dump -Fc` → `tar -czf` → `chmod 600` (the key rides inside). `umask 077`
   at the top closes the file-create-time window; an `EXIT` trap drops the staging dir on a mid-dump abort.
   **One tarball is the unit** — a key-without-DB and a DB-without-key are both dead. Manual script + runbook
   for V1; no cron / no remote/object-store target (the gateway owner's job).
2. **Restore** (`docs/runbooks/backup-restore.md`): provision Postgres → untar → restore the key
   (`.pci/master.key` 0600 / dir 0700, or `PCI_MASTER_KEY`) → `pg_restore` the dump → verify `open()` on a
   known `secret_ref`. **Forward consistency rule:** quiesce rotation w.r.t. backups — a rotation between two
   snapshots orphans an old-key dump.
3. **Rotation = re-seal in place BY REF** (`src/secrets/rotate.ts` `rotateMasterKey`): enumerate the `secrets`
   vault → `aeadOpen(oldKey)` → `aeadSeal(newKey)` → `UPDATE … set ciphertext, nonce, key_id=newKeyId,
   rotated_at=now() where ref=$`. Credential rows reference only `ref`, so **no repoint** is needed. Per-row
   write (row rewritten only after a successful re-seal) → a crash leaves a clean old/new mix, never a torn row.
4. **Idempotent / resumable via a deterministic key id.** The CLI derives the key id from the key bytes —
   `deriveKeyId(key) = "k_" + sha256(key).hex.slice(0,16)` (a one-way 64-bit fingerprint, **never** the key) —
   for BOTH the old and new key, and reuses an already-staged new-key file. So a re-run after a crash recomputes
   the **same** `newKeyId`, **skips** rows already at it, and finishes the rest. (An earlier random-per-run id
   made re-runs abort — the wave-9C adversarial blocker; fixed here.) Rows already at `newKeyId` are skipped;
   `oldKeyId === newKeyId` (byte-identical keys) is rejected.
5. **Fail-closed:** a wrong old key fails the AEAD tag check → a `RotateError` naming only the opaque `ref` (no
   key/plaintext/ciphertext in any log or error) → the row is left untouched, the run aborts. The decrypted
   buffer is `fill(0)`-wiped. The CLI's top-level catch surfaces only tool-built `RotateError` messages; any
   other error collapses to a fixed line (a driver error can't leak — key bytes are never a SQL parameter).
6. **Run gateway-stopped, after a backup** (V1 — avoids racing live seals; online rotation is a later
   enhancement). **Activation:** the printed `newKeyId` is what the operator sets as `PCI_MASTER_KEY_ID`
   (env-managed activation is the reliable path; `key.ts` resolves the configured id → the env key).
7. **agent-key rotation = runbook only** (`docs/runbooks/key-rotation.md`): mint a new key (`POST /api/agents`,
   shown once) + revoke the old (`POST /api/agents/:id/revoke`). No new code.
8. **CI** (`.github/workflows/ci.yml`): a health-gated `postgres:16` service so the DB-gated suite genuinely
   runs (closes the false-green gap) → `typecheck` → `build` → `migrate` → `test` (with `DATABASE_URL`) →
   `lint` → `npm audit --omit=dev --audit-level=high` (the 5 known high-sev vulns are dev-toolchain only).
   **lint/format** = a deliberately light *forward* gate (`eslint.config.js` flat config — `no-console` allows
   stderr only; pre-existing style is `warn`, not `error`, so `npm run lint` exits 0 today).

## Consequences

- A self-hoster can take a single restorable backup and rotate the master key without re-onboarding anything.
- CI makes the DB-backed suite a real gate; the `key_id`/`rotated_at` seam is now wired.
- **Known caveat (runbook):** a file-custody key is labelled `file` by `key.ts`, so a rotated *file* key won't
  resolve by the derived id — env-managed activation is the reliable path; resolving a rotated file key by id is
  a `key.ts` follow-up. Minor nits (recorded): `rotate.db.test.ts` isn't prettier-formatted (CI doesn't enforce
  prettier `--check`); `deriveKeyId` is a 64-bit truncation (collision ~2⁻⁶⁴, and an old/new collision is caught
  by the must-differ guard). The rotation scan is NOT scoped to a derived `oldKeyId` (production rows carry
  `key.ts`'s storage label, not a byte-derived id) — resume is delivered by the stable `newKeyId` alone.

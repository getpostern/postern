# Runbook — master-key rotation (and agent-key rotation)

Two independent kinds of key live in the gateway. They rotate by **different** procedures:

- the **AEAD master key** — seals every secret in the vault. Rotated by re-sealing the vault under a new key (`src/secrets/rotate.ts`). Covered first.
- per-agent **scoped bearer keys** — authenticate agents to the remote MCP / REST surface. Rotated by mint-new + revoke-old over the existing admin API. Covered last; no master-key involvement.

---

## Master-key rotation

### Model (ADR 0011)

`secrets.key_id` labels which master key sealed each row; `secrets.rotated_at` records the re-seal. `rotateMasterKey` enumerates the vault, **opens each row with the OLD key and re-seals it with the NEW key, in place by `ref`** — stamping `key_id = <newKeyId>`, `rotated_at = now()`. Because every credential/domain row references a secret only by its opaque `ref` (never by the key), re-sealing in place needs **no repoint**: all `secret_ref`s keep pointing at the same, now-re-keyed, rows.

Properties:

- **Idempotent / resumable.** The new key id is **derived deterministically from the new key bytes** (a short sha256 fingerprint), so re-running with the **same** new key reproduces the **same** id. A row already at that id is skipped; the rest are opened under the old key and re-sealed. So if a rotation is interrupted, re-running the same command with the same new key skips the already-re-keyed rows and **completes** the remainder — it never starts a divergent rotation under a fresh id.
- **Fail-closed.** A wrong old key (or a tampered row) fails the GCM tag/AAD check; the row is left untouched (no silent corruption) and rotation aborts naming only the opaque `ref`.
- **No leaks.** The tool never logs key bytes, plaintext, ciphertext, or the AAD.
- **Offline, by design.** Rotation runs with the **gateway stopped** (after a backup). There is no online-rotation locking — a quiesced box cannot race a live seal. Online rotation is a later enhancement.

### Before you start: where the key actually lives

Everything below assumes the shipped Docker layout. The master key is **inside the `pci_master_key` volume**, mounted at `/app/.pci` — never in your checkout, and never at a host-side `./.pci/master.key`. A host copy is a **different key**, and pairing one with this vault is the exact failure [`backup-restore.md`](backup-restore.md) exists to prevent. Read that runbook's warning section first if you have not.

Resolve the real volume name once — Docker prefixes it with your project name — and reuse it throughout:

```bash
KEYVOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/.pci"}}{{.Name}}{{end}}{{end}}' \
  "$(docker compose ps -aq app)")
echo "$KEYVOL"   # e.g. <yourdirectory>_pci_master_key
```

### Procedure: back up → rotate → swap → verify

**1. Back up first.** Capture the *current* key and database as one archive, so you can recover if anything goes wrong. Follow **[`backup-restore.md`](backup-restore.md) → "Take a backup"** exactly as written; do not improvise a shortcut here, because a rotation is precisely the operation that makes an inconsistent archive unrestorable.

**2. Stop the gateway.** Rotation is offline. Leave Postgres up — the rotation tool needs it.

```bash
docker compose stop app
docker compose up -d db     # if it is not already running
```

**3. Rotate.** Run the CLI as a one-off container from the same service. `docker compose run` gives it the service's environment (so it resolves the *current* key exactly as the gateway does) and the same volumes (so the new key it writes actually persists):

```bash
docker compose run --rm --entrypoint node app \
  dist/secrets/rotate.js --new /app/.pci/master.key.new
```

> **The `--new` path must be inside `/app/.pci`.** That directory is the mounted volume; anything the one-off container writes anywhere else vanishes with `--rm`, taking your only copy of the new key with it — after the vault has already been re-sealed under it.

`--new <path>` semantics:

- if `<path>` already holds a 32-byte key it is **loaded** as the new key (you pre-generated it);
- otherwise a fresh 32-byte key is **generated** and written to `<path>`, mode `0600`;
- `--new -` stages the key beside the active one (`<PCI_MASTER_KEY_PATH>.new`) instead of taking a path.

The new key is persisted **before** any row is re-sealed, so an interruption is always recoverable. The tool prints the **re-sealed / skipped counts**, the **new key id** (the deterministic fingerprint of the new key), the new key's path, and the two variables to set — never the key bytes. **Copy the new key id down now**; you need it in step 4.

*Interrupted?* Re-run the exact same command. The new key id is derived from the key bytes, so the re-run resolves the **same** staged key (an existing 32-byte key file at the `--new` path is reused, never regenerated), recomputes the **same** new key id, skips the already-re-keyed rows, and finishes the rest.

*Running from a source checkout instead of the image?* `npm run rotate -- --new .pci/master.key.new` is the same tool, and `npm run build && node dist/secrets/rotate.js --new …` is the compiled equivalent. Both act on whatever key that process resolves — which is **not** the container's key unless you point them at it. On a Docker install, use the `docker compose run` form above.

**4. Swap the active key — and it must be env-managed.** The gateway now has to resolve `<newKeyId>` to the new bytes, and a key loaded from a file is *always* labelled `file`, a label that cannot distinguish the old key from the new one. So activation goes through the two environment variables, which the shipped compose file passes into the container for exactly this purpose.

Read the new key out of the volume and base64 it:

```bash
docker run --rm -v "$KEYVOL":/k alpine cat /k/master.key.new | base64 | tr -d '\n'
```

Then put both lines in your `.env` (alongside `POSTGRES_PASSWORD`), using the id the tool printed:

```
PCI_MASTER_KEY=<the base64 string from the command above>
PCI_MASTER_KEY_ID=<newKeyId printed in step 3>
```

> **Set both, and set them together.** `PCI_MASTER_KEY_ID` defaults to the literal `env`, so a key supplied without its id resolves under the wrong label, matches none of the freshly re-sealed rows, and the gateway **refuses to boot** naming a `key_id` it cannot open. That refusal is working as designed ([ADR 0033](../specs/decisions/0033-vault-key-fail-closed-boot.md)) — a diverged *label* is the most common way anyone meets it, and the key itself is usually fine.

**5. Start and verify.** Do not trust a clean boot; force a real secret open.

```bash
docker compose up -d app
docker compose logs app | grep -iE 'SecretAuth|MasterKey'   # must be empty
curl -fsS http://localhost:8787/healthz                     # {"status":"ok"}
```

Then open the Console at <http://localhost:8787>, pick a connection, and **sync it now** — a sync opens that connection's sealed credential, which is the only end-to-end proof that the swapped key and the re-sealed vault agree. Every connection returning to `ok` is the real green light. A wrong-key failure here means the id or the bytes you set do not match what step 3 wrote.

**6. Destroy the old key — only after verifying.** Once every connection is green, remove the retired key material: the staged file is now redundant (its bytes live in `.env`), and the old active key file must not be left lying in the volume.

```bash
docker run --rm -v "$KEYVOL":/k alpine sh -c 'rm -f /k/master.key /k/master.key.new'
```

**Keep the pre-rotation backup archive** until you are confident — it is the only thing that can bring back a vault sealed under the old key, and deleting the old key is what makes it irreplaceable.

### Forward consistency rule (rotation vs. backups)

A backup is a `{key, dump}` pair captured together. A rotation changes the key the dump is sealed under. Therefore: **take a fresh backup immediately before rotating, and never run a rotation across a backup's key-capture / database-dump window.** A rotation that lands between the two halves orphans the older dump — it is now sealed under a key no surviving backup holds. Restore a key and a dump only from the **same** archive. Full detail in [`backup-restore.md`](backup-restore.md).

Note that after step 4 your vault key is **env-managed**, not file-managed. Subsequent backups therefore have nothing to capture from the volume: the key is the `PCI_MASTER_KEY` value in your `.env`, and protecting it means storing that value out of band. `backup-restore.md` calls this the self-managed custody case and covers it.

---

## Agent-key rotation (no code — existing admin API)

Per-agent bearer keys (remote MCP / REST) are independent of the master key, and rotating one needs no restart and no downtime. The Console does this with the **Rotate** action on the Agents screen (the new key is revealed on the mint page, so a plaintext key never reaches a URL). The API underneath is:

1. **Mint a replacement** with the same domain grant. Re-posting an existing `agentId` *is* the rotation — it replaces the key hash in place and keeps the grant. The new key is shown **once**:
   ```bash
   curl -X POST http://localhost:8787/api/agents \
     -H 'content-type: application/json' \
     -d '{"agentId":"my-agent","sectors":["finance","calendar"]}'
   # response includes the new bearer key — copy it into the agent now; it is never shown again.
   ```
   Only the `sha256` of the key is stored (`agent_grants.key_hash`), and any OAuth-bridge tokens derived from the previous key die in the same transaction — rotation is the compromise response, so derived credentials must not outlive the key.

2. **Roll the agent over** to the new key and confirm it works.

3. **Revoke** if you were retiring the agent rather than re-keying it (idempotent — stamps `revoked_at`, and sweeps live sessions rather than waiting for the next handshake):
   ```bash
   curl -X POST http://localhost:8787/api/agents/my-agent/revoke
   ```

These admin routes carry no authentication — the loopback `Host`-allowlist is a same-origin guard, not a credential check — so run them from the box itself, or from the Console. See [`../../SECURITY.md`](../../SECURITY.md).

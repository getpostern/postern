# Runbook — backup & restore

Your gateway's durable state is two things that are **useless apart**:

- the **AEAD master key** — decrypts the secrets vault (`secrets.ciphertext`);
- the **Postgres database** — holds the sealed vault rows, every credential, connector, grant, and the whole normalized cache.

The key without the database decrypts nothing; the database without the key is an opaque blob, because every token, password and access URL in it is sealed. **Losing the master key is total, unrecoverable data loss** — every source has to be re-authenticated from scratch.

So a backup is **one archive containing both**, and that archive is as sensitive as the key itself. Write it `0600`, keep it off the box, and treat it exactly like the credentials it contains — because that is what it is.

---

## ⚠️ Read this before you back anything up

**The master key lives inside a Docker volume, not in your checkout.**

`docker-compose.yml` mounts the named volume `pci_master_key` at `/app/.pci`, and the gateway writes its key to `/app/.pci/master.key` (32 bytes, mode `0600`) on first boot. That file is the only copy.

Two ways this goes wrong, both of them quiet:

- **Backing up a host-side `./.pci/master.key`.** A checkout may contain one from a non-Docker run, or you may create one by hand expecting it to be read. It is a **different key**. Pair it with a dump taken from the container and you get an archive that restores cleanly, boots, and then fails — because the key and the vault do not match. Always take the key **from the running container or from the volume**, never off the host disk.
- **`docker compose down -v`.** The `-v` deletes named volumes, including this one. There is no recovery: every sealed credential in your database becomes undecryptable. **Never run it.** Use `docker compose down` to stop the stack; the data survives.

The gateway now refuses to boot when the key it resolves cannot open the vault, rather than starting green and failing later at the first sync ([ADR 0033](../specs/decisions/0033-vault-key-fail-closed-boot.md)). That turns a silent restore failure into a loud one — but its scope is deliberately narrow, so a real read is still the verification that counts. See "Verify" below.

### Which custody are you in?

- **Gateway-managed (the default).** You never set `PCI_MASTER_KEY`, so the gateway generated a key and persists it in the `pci_master_key` volume. **The volume is the key.** Everything below assumes this case.
- **Self-managed.** You set `PCI_MASTER_KEY` in `.env` (base64 of exactly 32 bytes). There is nothing in the volume to capture: the key is the value in your `.env`, and backing it up means **storing that value out of band** — in a password manager, not beside the dump. Skip the key-capture step below and skip the key-seeding step on restore; just make sure `PCI_MASTER_KEY` (and `PCI_MASTER_KEY_ID`, if you set one) are in `.env` before the gateway's first boot on the new machine.

---

## Take a backup

Run these from the directory holding your `docker-compose.yml` and `.env`. The gateway can stay up; see "Consistency" for when it must not.

**1. Capture the master key from the running container** — not from the host, not from your checkout.

```bash
mkdir -p ./backup-staging && chmod 700 ./backup-staging
docker compose exec -T app cat /app/.pci/master.key > ./backup-staging/master.key
chmod 600 ./backup-staging/master.key

wc -c < ./backup-staging/master.key      # MUST print 32 — anything else means you captured the wrong thing
shasum -a 256 ./backup-staging/master.key # note this; you will check it again at restore
```

If the app container is stopped, read the volume directly instead — same bytes, no running container needed. Resolve the volume's real name first (Docker prefixes it with your project name); this is the same idiom the restore below and [`key-rotation.md`](key-rotation.md) use:

```bash
KEYVOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/.pci"}}{{.Name}}{{end}}{{end}}' \
  "$(docker compose ps -aq app)")

docker run --rm -v "$KEYVOL":/k alpine cat /k/master.key > ./backup-staging/master.key
```

**2. Dump the database.** `-Fc` is Postgres's custom format, which `pg_restore` needs.

```bash
docker compose exec -T db pg_dump -U pci -d pci -Fc > ./backup-staging/pci.dump
```

Substitute your own values if you changed `POSTGRES_USER` / `POSTGRES_DB` in `.env`. No password is needed here: the command runs *inside* the database container and connects over its local socket. The `db` service publishes no host port, which is why this goes through `docker compose exec` rather than a `psql -h localhost`.

**3. Archive both together, and lock it down.**

```bash
tar -czf "postern-backup-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C ./backup-staging .
chmod 600 postern-backup-*.tar.gz
rm -rf ./backup-staging
```

Inside the archive:

```
master.key    # 32 raw bytes  (absent under self-managed custody — the value lives in your .env)
pci.dump      # pg_dump -Fc
```

> **Scheduling and off-box storage are yours to arrange.** The gateway ships no scheduler and no remote target. A backup that only exists on the machine you are protecting is not a backup — copy it somewhere else, and remember it is a plaintext-equivalent secret in transit and at rest.

---

## Restore

The order matters: **the key must be in the volume before the gateway's first boot**, because boot opens the vault.

**1. Put the configuration in place.** On the target machine, in an empty directory, place `docker-compose.yml` and a `.env` carrying at minimum `POSTGRES_PASSWORD` (compose refuses to start without it) plus any other variables you had set. Do not start the stack yet.

**2. Unpack the archive** somewhere private:

```bash
mkdir -p ./restore && chmod 700 ./restore
tar -xzf postern-backup-<stamp>.tar.gz -C ./restore
wc -c < ./restore/master.key                # 32
shasum -a 256 ./restore/master.key          # must equal what you recorded at backup time
```

**3. Bring up Postgres only, and create the app container without starting it.** Creating the container is what materialises the `pci_master_key` volume, so there is somewhere to put the key.

```bash
docker compose up -d db          # wait until `docker compose ps` reports it healthy
docker compose create app        # creates the container and its volumes; does NOT start it
```

**4. Seed the key into the volume.** Resolve the real volume name first — Docker prefixes it with your project name:

```bash
KEYVOL=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/.pci"}}{{.Name}}{{end}}{{end}}' \
  "$(docker compose ps -aq app)")
echo "$KEYVOL"   # e.g. <yourdirectory>_pci_master_key

docker run --rm -i -v "$KEYVOL":/k alpine \
  sh -c 'cat > /k/master.key && chmod 600 /k/master.key && chown 1000:1000 /k/master.key' \
  < ./restore/master.key
```

`1000:1000` is the `node` user the image runs as — the gateway cannot read a key it does not own. Piping the key through stdin keeps it off any host bind-mount.

*Self-managed custody:* skip this step entirely. Make sure `PCI_MASTER_KEY` (and `PCI_MASTER_KEY_ID` if you used one) are set in `.env`, and go to step 5.

**5. Restore the database.** On a genuinely fresh machine the database is already empty and the `pg_restore` line alone is enough. Restoring **over an existing** gateway means dropping first, so the dump lands on an empty schema:

```bash
docker compose exec -T db dropdb   -U pci --if-exists pci </dev/null
docker compose exec -T db createdb -U pci pci </dev/null
docker compose exec -T db pg_restore -U pci -d pci --no-owner < ./restore/pci.dump
```

> **The stdin trap.** `docker compose exec -T` reads standard input, so a command that does not need stdin will happily swallow the rest of a script you piped in — silently truncating everything after it. Give every such command an explicit `</dev/null`, exactly as above, and run multi-step restores from a saved script file rather than a heredoc.

**6. Start the gateway.**

```bash
docker compose up -d app
```

The schema migrations run inside boot and will see an already-current schema, so they are a no-op.

**7. Clean up.** `rm -rf ./restore` once you have verified. Keep the archive.

---

## Verify — do not trust a clean boot

A healthy `/healthz` proves the database is reachable, not that the key matches the vault. Force a real secret open:

```bash
docker compose logs app | grep -iE 'SecretAuth|MasterKey'   # must be empty
curl -fsS http://localhost:8787/healthz                     # {"status":"ok"}
```

Then open the Console at <http://localhost:8787>, pick a connection, and **sync it now** — a sync opens that connection's sealed credential, which is the only end-to-end proof that the key and the dump belong together. Every connection returning to `ok` is the real green light.

A `SecretAuthError` or `MasterKeyError` — or a gateway that refuses to boot naming a `key_id` it cannot open — means **the key and the dump are from different points in time**. Re-capture the key from the source's running container and restore again. If the source machine is gone and the key is gone with it, the data is not recoverable; that is why the two travel together.

---

## Consistency — the rule that makes an archive restorable

An archive only restores if the key and the dump describe the **same vault state**. A [master-key rotation](key-rotation.md) re-seals every row under a new key and changes `secrets.key_id`, so the two can drift apart in exactly one way:

- **Never rotate between capturing the key and taking the dump.** Do the two steps back to back, as written above.
- **Always take a fresh backup immediately before rotating.** After a rotation the older dump is sealed under the *old* key: restoring it needs that old key, and restoring the *new* key against an old dump fails closed.
- **For a fully consistent snapshot, quiesce the gateway** — `docker compose stop app`, leaving `db` up for the dump. Nothing can then be re-sealed or refreshed underneath you. Rotation is an offline operation for the same reason.
- **Restore a key and a dump only from the same archive.** Mixing them across archives is the one mistake this whole document exists to prevent.

The decision behind this shape is [ADR 0011](../specs/decisions/0011-backup-and-key-rotation.md); the fail-closed boot that now catches a mismatch loudly is [ADR 0033](../specs/decisions/0033-vault-key-fail-closed-boot.md).

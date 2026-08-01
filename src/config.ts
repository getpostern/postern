/**
 * Read an env var, treating "" as ABSENT. docker-compose's `${VAR:-}` interpolation delivers an
 * empty string for an unset variable, which `??` would happily accept (#97) — `PCI_MASTER_KEY_ID=""`
 * would then be used verbatim as `secrets.key_id` instead of the documented 'env' default.
 *
 * Deliberately NOT applied to DATABASE_URL: normalising "" there would turn a loud connection
 * failure into a silent connection to the LIVE `pci` database — the exact 2026-06-17 finance-wipe
 * shape (ADR 0015).
 */
function envOrUndefined(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://pci:pci@localhost:5432/pci",
  // SecretStore master-key resolution (env override > key file > first-run autogen).
  masterKey: envOrUndefined("PCI_MASTER_KEY"), // base64 of exactly 32 bytes, when self-managed
  masterKeyId: envOrUndefined("PCI_MASTER_KEY_ID"), // optional label for the env-provided key
  secretsKeyPath: envOrUndefined("PCI_MASTER_KEY_PATH") ?? ".pci/master.key", // autogen/persisted key file
};

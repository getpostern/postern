// Master-key resolution + key_id labelling for the vault.
//
// Resolution order (convenient-by-default): env override > persisted key file > first-run autogen.
// The 32-byte AES-256 key is cached in-process after first resolution and is NEVER logged.
// `key_id` labels which key sealed a row so opening honours it (rotation-ready seam; V0 has one key).

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { MasterKeyError } from "./index.js";

export interface MasterKey {
  keyId: string;
  key: Buffer; // exactly 32 bytes
}

const KEY_BYTES = 32;

// In-process cache, keyed by key_id. V0 holds at most one entry.
const cache = new Map<string, MasterKey>();

/** Resolve the key used for SEALING (env > file > first-run autogen). Cached after first call. */
export function activeKey(): MasterKey {
  // 1) Env override — self-managed key.
  if (config.masterKey !== undefined && config.masterKey !== "") {
    const keyId = config.masterKeyId ?? "env";
    const cached = cache.get(keyId);
    if (cached) return cached;
    const key = decodeEnvKey(config.masterKey);
    const mk: MasterKey = { keyId, key };
    cache.set(keyId, mk);
    return mk;
  }

  // 2) Persisted key file.
  if (existsSync(config.secretsKeyPath)) {
    const cached = cache.get("file");
    if (cached) return cached;
    const key = readKeyFile(config.secretsKeyPath);
    const mk: MasterKey = { keyId: "file", key };
    cache.set("file", mk);
    return mk;
  }

  // 3) First run — generate, persist 0600, notify once.
  const cached = cache.get("auto");
  if (cached) return cached;
  const key = randomBytes(KEY_BYTES);
  writeKeyFile(config.secretsKeyPath, key);
  notifyGenerated(config.secretsKeyPath);
  const mk: MasterKey = { keyId: "auto", key };
  cache.set("auto", mk);
  return mk;
}

/**
 * Resolve the key for a given `key_id` (the seam for opening rows / lazy rotation).
 * V0 has one active key; honouring the row's key_id makes a later rotation non-breaking.
 */
export function keyById(keyId: string): MasterKey {
  const cached = cache.get(keyId);
  if (cached) return cached;

  // 'env' / a configured masterKeyId resolves from the env override.
  if (
    config.masterKey !== undefined &&
    config.masterKey !== "" &&
    keyId === (config.masterKeyId ?? "env")
  ) {
    const key = decodeEnvKey(config.masterKey);
    const mk: MasterKey = { keyId, key };
    cache.set(keyId, mk);
    return mk;
  }

  // 'file' and 'auto' both live in the persisted key file.
  if ((keyId === "file" || keyId === "auto") && existsSync(config.secretsKeyPath)) {
    const key = readKeyFile(config.secretsKeyPath);
    const mk: MasterKey = { keyId, key };
    cache.set(keyId, mk);
    return mk;
  }

  throw new MasterKeyError(`no master key available for key_id '${keyId}'`);
}

function decodeEnvKey(b64: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(b64, "base64");
  } catch {
    throw new MasterKeyError("PCI_MASTER_KEY is not valid base64");
  }
  if (key.length !== KEY_BYTES) {
    // Fail closed: a wrong-length key would silently corrupt every future open.
    throw new MasterKeyError(`PCI_MASTER_KEY must decode to exactly ${KEY_BYTES} bytes`);
  }
  return key;
}

function readKeyFile(path: string): Buffer {
  const key = readFileSync(path);
  if (key.length !== KEY_BYTES) {
    throw new MasterKeyError(`master key file ${path} must be exactly ${KEY_BYTES} bytes`);
  }
  return key;
}

/**
 * Persist `data` 0600 under a 0700 parent dir. Used for the master key itself AND for the ack marker
 * beside it — one hardening idiom, so the marker can never land world-readable in the key's directory.
 */
function writeKeyFile(path: string, data: Buffer | string): void {
  const dir = dirname(path);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // mkdir(recursive) won't re-tighten an already-existing dir
  }
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFile's mode only applies on create; enforce on a pre-existing file too
}

let notified = false;
function notifyGenerated(path: string): void {
  if (notified) return;
  notified = true;
  // One-time operator notice. No key/secret material is ever printed. The per-boot banner
  // (vaultBackupNotice) is the durable half — this line only marks the moment of generation.
  process.stderr.write(
    `Generated a vault key at ${path}. Back it up; or set PCI_MASTER_KEY to manage it yourself.\n` +
      `Under Docker this file lives in the \`pci_master_key\` volume: \`docker compose down -v\` ` +
      `deletes it and every stored credential becomes permanently unopenable.\n`,
  );
}

// ── Key custody status + the backup acknowledgement seam (#97 item 3) ────────────────────────────
//
// The Console follow-up (a GET/POST pair in src/rest/) consumes exactly these three functions
// unchanged. Nothing here touches the DB, and nothing here ever generates a key.

export type VaultKeyCustody = "env" | "file";

export interface VaultKeyStatus {
  custody: VaultKeyCustody; // 'env' = operator-managed via PCI_MASTER_KEY; 'file' = gateway-managed key file
  keyPath: string | null; // config.secretsKeyPath when custody === 'file'; null when 'env'
  keyExists: boolean; // custody 'file': does the key file exist yet? custody 'env': always true
  backupAcknowledged: boolean; // true when custody === 'env', or the ack marker file exists
}

/** The ack marker sits BESIDE the key, inside the same volume — if the volume is gone, so is both. */
function ackMarkerPath(keyPath: string): string {
  return `${keyPath}.backed-up`;
}

/**
 * Pure: reads config + fs only. NEVER generates a key, never touches the DB, never logs.
 * `config.masterKey !== undefined` is sufficient — config.ts normalises "" to undefined, so a
 * compose-delivered `PCI_MASTER_KEY=""` reads as "no self-managed key", not as an empty one.
 */
export function vaultKeyStatus(): VaultKeyStatus {
  if (config.masterKey !== undefined) {
    return { custody: "env", keyPath: null, keyExists: true, backupAcknowledged: true };
  }
  const keyPath = config.secretsKeyPath;
  return {
    custody: "file",
    keyPath,
    keyExists: existsSync(keyPath),
    backupAcknowledged: existsSync(ackMarkerPath(keyPath)),
  };
}

/**
 * Record that the operator has a copy of the gateway-managed key. Idempotent (re-acknowledging just
 * re-stamps the marker). No-op when custody === 'env' — an operator-managed key has nothing for the
 * gateway to acknowledge. Writes only a timestamp: never the key, never a fingerprint of it.
 */
export function acknowledgeVaultKey(): void {
  const status = vaultKeyStatus();
  if (status.custody === "env" || status.keyPath === null) return;
  writeKeyFile(ackMarkerPath(status.keyPath), new Date().toISOString() + "\n");
}

/**
 * The stderr banner to emit when a gateway-managed key exists and has not been acknowledged.
 * Returns null when there is nothing to say. Pure — the caller does the writing.
 *
 * It prints on EVERY boot until acknowledged, not once at generation: an un-backed-up key is a
 * standing, unbounded, unrecoverable data-loss risk, and a single line at first boot buried in
 * container logs is precisely the defect this replaces (#97).
 */
export function vaultBackupNotice(): string | null {
  const status = vaultKeyStatus();
  if (status.custody !== "file" || !status.keyExists || status.backupAcknowledged) return null;
  const keyPath = status.keyPath ?? config.secretsKeyPath;
  return [
    "",
    "  ┌─ VAULT KEY IS NOT BACKED UP ────────────────────────────────────────────",
    `  │ Every stored credential in this gateway is sealed under the key at`,
    `  │   ${keyPath}`,
    "  │ Under Docker that path lives INSIDE the `pci_master_key` volume.",
    "  │ `docker compose down -v` DELETES that volume. There is no recovery:",
    "  │ every credential becomes permanently unopenable.",
    "  │",
    "  │ Do one of these now:",
    `  │   * copy ${keyPath} somewhere safe (see docs/runbooks/backup-restore.md), or`,
    "  │   * set PCI_MASTER_KEY to a base64 32-byte key you manage yourself.",
    "  │",
    "  │ Then acknowledge in the Console once you have a copy — this banner",
    "  │ prints on every boot until you do.",
    "  └─────────────────────────────────────────────────────────────────────────",
  ].join("\n");
}

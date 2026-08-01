import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// key.ts captures process.env via config.ts at module-load and caches keys in-process. We therefore
// reset the module graph and configure env per scenario, then dynamically import a fresh key module.

const ENV_KEYS = ["PCI_MASTER_KEY", "PCI_MASTER_KEY_ID", "PCI_MASTER_KEY_PATH"] as const;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pci-key-"));
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  rmSync(tmp, { recursive: true, force: true });
});

async function freshKeyModule() {
  vi.resetModules();
  return await import("./key.js");
}

describe("activeKey: env override", () => {
  it("uses a 32-byte base64 PCI_MASTER_KEY and labels it 'env'", async () => {
    const raw = randomBytes(32);
    process.env.PCI_MASTER_KEY = raw.toString("base64");
    process.env.PCI_MASTER_KEY_PATH = join(tmp, "master.key");
    const { activeKey } = await freshKeyModule();
    const mk = activeKey();
    expect(mk.keyId).toBe("env");
    expect(mk.key.length).toBe(32);
    expect(mk.key.equals(raw)).toBe(true);
    // env key must NOT create a file
    expect(existsSync(join(tmp, "master.key"))).toBe(false);
  });

  it("honours PCI_MASTER_KEY_ID as the label", async () => {
    process.env.PCI_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.PCI_MASTER_KEY_ID = "kms-2026";
    const { activeKey } = await freshKeyModule();
    expect(activeKey().keyId).toBe("kms-2026");
  });

  it("labels a compose-delivered key 'env' when PCI_MASTER_KEY_ID arrives as an empty string", async () => {
    // docker-compose's `${PCI_MASTER_KEY_ID:-}` delivers "" — not absent — when the operator sets a
    // key but no id. Without config.ts's normalisation `config.masterKeyId ?? "env"` keeps the "",
    // and every row is sealed under key_id = '' instead of 'env' (#97).
    process.env.PCI_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.PCI_MASTER_KEY_ID = "";
    const { activeKey } = await freshKeyModule();
    expect(activeKey().keyId).toBe("env");
  });

  it("throws MasterKeyError for a short/malformed PCI_MASTER_KEY", async () => {
    process.env.PCI_MASTER_KEY = Buffer.from("too-short").toString("base64");
    const { activeKey, MasterKeyError } = await freshKeyModule().then(async (m) => ({
      ...m,
      MasterKeyError: (await import("./index.js")).MasterKeyError,
    }));
    expect(() => activeKey()).toThrow(MasterKeyError);
  });
});

describe("activeKey: first-run autogen", () => {
  it("creates secretsKeyPath (32 bytes, mode 0600) and reuses it on a second call", async () => {
    const keyPath = join(tmp, "nested", "master.key");
    process.env.PCI_MASTER_KEY_PATH = keyPath;
    const { activeKey } = await freshKeyModule();

    const first = activeKey();
    expect(first.keyId).toBe("auto");
    expect(existsSync(keyPath)).toBe(true);
    const st = statSync(keyPath);
    expect(st.size).toBe(32);
    expect(st.mode & 0o777).toBe(0o600);

    const persisted = readFileSync(keyPath);
    const second = activeKey(); // same in-process cache, no regen
    expect(second.key.equals(first.key)).toBe(true);
    expect(readFileSync(keyPath).equals(persisted)).toBe(true);
  });

  it("emits a one-time stderr notice and reads an existing file as 'file'", async () => {
    const keyPath = join(tmp, "master.key");
    process.env.PCI_MASTER_KEY_PATH = keyPath;

    // First module instance: autogen + notice.
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      errs.push(String(chunk));
      return true;
    });
    const gen = await freshKeyModule();
    const generated = gen.activeKey();
    spy.mockRestore();
    expect(errs.some((e) => e.includes("Generated a vault key"))).toBe(true);
    // Never leaks key material. The notice legitimately contains the key's file PATH, so a naive
    // /[A-Za-z0-9+/]{40,}/ false-matches long temp paths (the `/` is in the class). Assert the
    // precise thing instead: the raw key bytes (base64 or hex) never appear in the output.
    const out = errs.join("");
    expect(out).not.toContain(generated.key.toString("base64"));
    expect(out).not.toContain(generated.key.toString("hex"));

    // Fresh module instance (cache cleared) reads the now-existing file as 'file'.
    const reread = await freshKeyModule();
    const mk = reread.activeKey();
    expect(mk.keyId).toBe("file");
    expect(mk.key.equals(readFileSync(keyPath))).toBe(true);
  });
});

describe("vaultKeyStatus / acknowledgeVaultKey / vaultBackupNotice (#97)", () => {
  it("reports env custody as acknowledged with no key path", async () => {
    process.env.PCI_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.PCI_MASTER_KEY_PATH = join(tmp, "master.key");
    const { vaultKeyStatus } = await freshKeyModule();
    expect(vaultKeyStatus()).toEqual({
      custody: "env",
      keyPath: null,
      keyExists: true,
      backupAcknowledged: true,
    });
  });

  it("reports a generated key file as unacknowledged until it is acknowledged", async () => {
    const keyPath = join(tmp, "master.key");
    process.env.PCI_MASTER_KEY_PATH = keyPath;
    const mod = await freshKeyModule();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mod.activeKey(); // first-run autogen writes the key file
    vi.restoreAllMocks();

    expect(mod.vaultKeyStatus()).toEqual({
      custody: "file",
      keyPath,
      keyExists: true,
      backupAcknowledged: false,
    });

    mod.acknowledgeVaultKey();
    expect(mod.vaultKeyStatus().backupAcknowledged).toBe(true);
    // The marker sits beside the key inside the same volume, and is hardened like the key itself.
    expect(existsSync(`${keyPath}.backed-up`)).toBe(true);
    expect(statSync(`${keyPath}.backed-up`).mode & 0o777).toBe(0o600);

    // Idempotent: a second acknowledge neither throws nor un-acknowledges.
    mod.acknowledgeVaultKey();
    expect(mod.vaultKeyStatus().backupAcknowledged).toBe(true);
  });

  it("does not create a key file just to report status", async () => {
    const keyPath = join(tmp, "never-generated", "master.key");
    process.env.PCI_MASTER_KEY_PATH = keyPath;
    const { vaultKeyStatus } = await freshKeyModule();

    const status = vaultKeyStatus();
    expect(status.custody).toBe("file");
    expect(status.keyExists).toBe(false);
    expect(status.backupAcknowledged).toBe(false);
    // The whole point: reading status must NEVER call activeKey() and mint a key as a side effect.
    expect(existsSync(keyPath)).toBe(false);
  });

  it("offers a backup notice for an unacknowledged generated key and none once acknowledged", async () => {
    const keyPath = join(tmp, "master.key");
    process.env.PCI_MASTER_KEY_PATH = keyPath;
    const mod = await freshKeyModule();

    // No key yet -> nothing to warn about.
    expect(mod.vaultBackupNotice()).toBeNull();

    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mod.activeKey();
    vi.restoreAllMocks();

    const notice = mod.vaultBackupNotice();
    expect(notice).not.toBeNull();
    expect(notice).toContain(keyPath);
    expect(notice).toContain("pci_master_key");
    expect(notice).toContain("down -v");

    mod.acknowledgeVaultKey();
    expect(mod.vaultBackupNotice()).toBeNull();
  });

  it("says nothing for an env-managed key — there is nothing for the gateway to back up", async () => {
    process.env.PCI_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.PCI_MASTER_KEY_PATH = join(tmp, "master.key");
    const mod = await freshKeyModule();
    expect(mod.vaultBackupNotice()).toBeNull();
    mod.acknowledgeVaultKey(); // no-op under env custody
    expect(existsSync(join(tmp, "master.key.backed-up"))).toBe(false);
  });

  it("never puts key material in the backup notice or the generation notice", async () => {
    const keyPath = join(tmp, "master.key");
    process.env.PCI_MASTER_KEY_PATH = keyPath;
    const mod = await freshKeyModule();

    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      errs.push(String(chunk));
      return true;
    });
    const generated = mod.activeKey();
    spy.mockRestore();

    const out = errs.join("") + (mod.vaultBackupNotice() ?? "");
    // The precise assertion (key.test.ts:96-99), not a generic base64 regex: both notices
    // legitimately contain a filesystem path, and "/" lives in the base64 alphabet.
    expect(out).not.toContain(generated.key.toString("base64"));
    expect(out).not.toContain(generated.key.toString("hex"));
    // The generation line now also carries the volume name + the irreversible-loss warning.
    expect(errs.join("")).toContain("pci_master_key");
    expect(errs.join("")).toContain("down -v");
  });
});

describe("keyById", () => {
  it("resolves 'auto'/'file' from the persisted file and throws for an unknown key_id", async () => {
    const keyPath = join(tmp, "master.key");
    process.env.PCI_MASTER_KEY_PATH = keyPath;
    const mod = await freshKeyModule();
    const active = mod.activeKey(); // autogen -> 'auto'
    const { MasterKeyError } = await import("./index.js");

    expect(mod.keyById("auto").key.equals(active.key)).toBe(true);
    expect(mod.keyById("file").key.equals(active.key)).toBe(true);
    expect(() => mod.keyById("nope")).toThrow(MasterKeyError);
  });
});

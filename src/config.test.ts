// config.ts captures process.env at module LOAD, so every case resets the module graph and
// dynamically imports a fresh config (the idiom from src/secrets/key.test.ts).
//
// The subject is the empty-string normalisation forced by #97: docker-compose's `${VAR:-}`
// interpolation delivers "" — not absent — for an unset variable, and "" is not nullish, so `??`
// would accept it. Every PCI_MASTER_KEY* read must treat "" as absent; DATABASE_URL must NOT.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEYS = ["PCI_MASTER_KEY", "PCI_MASTER_KEY_ID", "PCI_MASTER_KEY_PATH", "DATABASE_URL"] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.resetModules();
});

async function freshConfig() {
  vi.resetModules();
  return (await import("./config.js")).config;
}

describe("config: empty-string env normalisation (#97)", () => {
  it("treats an empty PCI_MASTER_KEY as absent, not as a key", async () => {
    process.env.PCI_MASTER_KEY = "";
    const config = await freshConfig();
    // toBeUndefined, never toBeFalsy: "" is falsy and would pass a lax assertion forever.
    expect(config.masterKey).toBeUndefined();
  });

  it("treats an empty PCI_MASTER_KEY_ID as absent so the key id still defaults to 'env'", async () => {
    process.env.PCI_MASTER_KEY_ID = "";
    const config = await freshConfig();
    expect(config.masterKeyId).toBeUndefined();
  });

  it("treats an empty PCI_MASTER_KEY_PATH as absent and falls back to .pci/master.key", async () => {
    process.env.PCI_MASTER_KEY_PATH = "";
    const config = await freshConfig();
    expect(config.secretsKeyPath).toBe(".pci/master.key");
  });

  it("still passes a real value through untouched", async () => {
    process.env.PCI_MASTER_KEY = "a-base64-looking-value";
    process.env.PCI_MASTER_KEY_ID = "k_deadbeefdeadbeef";
    process.env.PCI_MASTER_KEY_PATH = "/custom/master.key";
    const config = await freshConfig();
    expect(config.masterKey).toBe("a-base64-looking-value");
    expect(config.masterKeyId).toBe("k_deadbeefdeadbeef");
    expect(config.secretsKeyPath).toBe("/custom/master.key");
  });

  it("leaves DATABASE_URL resolution untouched so an empty value never silently becomes the live pci URL", async () => {
    // Normalising "" here would turn a loud connection failure into a SILENT connection to the live
    // `pci` database — the exact 2026-06-17 finance-wipe shape. The default must apply ONLY to an
    // absent variable.
    process.env.DATABASE_URL = "";
    const config = await freshConfig();
    expect(config.databaseUrl).toBe("");
    expect(config.databaseUrl).not.toBe("postgres://pci:pci@localhost:5432/pci");
  });

  it("still applies the DATABASE_URL default when the variable is genuinely absent", async () => {
    delete process.env.DATABASE_URL;
    const config = await freshConfig();
    expect(config.databaseUrl).toBe("postgres://pci:pci@localhost:5432/pci");
  });
});

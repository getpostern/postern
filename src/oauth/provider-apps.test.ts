// provider-apps — DB-free unit tests (pool + vault mocked). Asserts the client-type validation
// (secret REQUIRED for confidential / REJECTED for public), that the plaintext secret is SEALED and
// only its `secret_ref` reaches the row (never the plaintext), and the get/load read shapes.

import { describe, it, expect, beforeEach, vi } from "vitest";

const query = vi.fn();
vi.mock("../db.js", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

const seal = vi.fn();
const open = vi.fn();
const deleteSecret = vi.fn();
vi.mock("../secrets/index.js", () => ({
  seal: (...a: unknown[]) => seal(...a),
  open: (...a: unknown[]) => open(...a),
  deleteSecret: (...a: unknown[]) => deleteSecret(...a),
}));

const { getProviderApp, loadProviderApp, setProviderApp } = await import("./provider-apps.js");
const { ConfigError } = await import("./providers.js");

beforeEach(() => {
  query.mockReset();
  seal.mockReset();
  open.mockReset();
  deleteSecret.mockReset();
  query.mockResolvedValue({ rows: [] });
  deleteSecret.mockResolvedValue(undefined);
});

/** The most recent INSERT ... ON CONFLICT params, if any. */
function upsertParams(): unknown[] | undefined {
  const call = query.mock.calls.find(
    ([sql]) => typeof sql === "string" && sql.includes("insert into oauth_provider_apps"),
  );
  return call ? (call[1] as unknown[]) : undefined;
}

describe("setProviderApp — client-type validation", () => {
  it("confidential provider (google) WITHOUT a secret → ConfigError, no write", async () => {
    await expect(setProviderApp("google", "client-id", null)).rejects.toBeInstanceOf(ConfigError);
    expect(seal).not.toHaveBeenCalled();
    expect(upsertParams()).toBeUndefined();
  });

  it("public provider (microsoft) WITH a secret → ConfigError, no write", async () => {
    await expect(setProviderApp("microsoft", "client-id", "a-secret")).rejects.toBeInstanceOf(
      ConfigError,
    );
    expect(seal).not.toHaveBeenCalled();
    expect(upsertParams()).toBeUndefined();
  });

  it("empty / whitespace client_id → ConfigError", async () => {
    await expect(setProviderApp("microsoft", "   ", null)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("setProviderApp — sealing (plaintext never stored)", () => {
  it("google: seals the secret and stores ONLY the secret_ref (plaintext never in the row params)", async () => {
    seal.mockResolvedValue("sec_sealed_ref");
    await setProviderApp("google", "  google-id  ", "super-secret-value");

    expect(seal).toHaveBeenCalledWith(
      { userId: expect.any(String), provider: "google", purpose: "oauth_client_secret" },
      "super-secret-value",
    );
    const params = upsertParams()!;
    expect(params[0]).toBe("google"); // provider
    expect(params[1]).toBe("google-id"); // client_id trimmed
    expect(params[2]).toBe("sec_sealed_ref"); // the REF, not the plaintext
    expect(JSON.stringify(params)).not.toContain("super-secret-value");
  });

  it("microsoft (public): stores a NULL secret_ref, never seals", async () => {
    await setProviderApp("microsoft", "ms-id", null);
    expect(seal).not.toHaveBeenCalled();
    const params = upsertParams()!;
    expect(params[1]).toBe("ms-id");
    expect(params[2]).toBeNull();
  });

  it("re-paste retires the superseded secret row (best-effort)", async () => {
    // readRow is the SELECT; first call (prior) returns an old ref, then upsert.
    query.mockImplementation((sql: unknown) => {
      if (typeof sql === "string" && sql.includes("select client_id")) {
        return Promise.resolve({ rows: [{ client_id: "old", client_secret_ref: "sec_old" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    seal.mockResolvedValue("sec_new");
    await setProviderApp("google", "google-id", "new-secret");
    expect(deleteSecret).toHaveBeenCalledWith("sec_old");
  });
});

describe("getProviderApp / loadProviderApp — reads", () => {
  it("getProviderApp: configured=false + clientId null when no row", async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getProviderApp("google")).toEqual({ configured: false, clientId: null });
  });

  it("getProviderApp: returns the public client_id only (never the secret)", async () => {
    query.mockResolvedValue({ rows: [{ client_id: "gid", client_secret_ref: "sec_x" }] });
    expect(await getProviderApp("google")).toEqual({ configured: true, clientId: "gid" });
  });

  it("loadProviderApp: opens the sealed secret when a ref is present", async () => {
    query.mockResolvedValue({ rows: [{ client_id: "gid", client_secret_ref: "sec_x" }] });
    open.mockResolvedValue(Buffer.from("opened-secret", "utf8"));
    const app = await loadProviderApp("google");
    expect(app).toEqual({ clientId: "gid", clientSecret: "opened-secret" });
    expect(open).toHaveBeenCalledWith("sec_x", {
      userId: expect.any(String),
      provider: "google",
      purpose: "oauth_client_secret",
    });
  });

  it("loadProviderApp: null when unconfigured; clientSecret null when no ref", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await loadProviderApp("microsoft")).toBeNull();
    query.mockResolvedValueOnce({ rows: [{ client_id: "mid", client_secret_ref: null }] });
    expect(await loadProviderApp("microsoft")).toEqual({ clientId: "mid", clientSecret: null });
    expect(open).not.toHaveBeenCalled();
  });
});

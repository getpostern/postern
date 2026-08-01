// plaid_app creds store DB round-trip — gated on DATABASE_URL. Proves set/get/clear seal the secret in
// the vault, NEVER return/store it in plaintext, and that re-paste supersedes + clear removes the row.

import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { lockTestResource } from "../test-support/advisory-lock.js";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("plaid app-config (DB)", () => {
  // plaid_app is a one-row singleton shared by every parallel vitest fork (#38): hold the advisory
  // lock for the whole suite so another worker's `delete from plaid_app` can't land mid-test.
  let releaseLock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    releaseLock = await lockTestResource("plaid_app");
  }, 120_000);
  beforeEach(async () => {
    const { pool } = await import("../db.js");
    await pool.query("delete from plaid_app");
  });
  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query("delete from plaid_app");
    await releaseLock?.(); // release only after our final cleanup, then close the pool
    await pool.end();
  });

  it("set → get returns clientId+env but NEVER the secret; load round-trips the sealed secret", async () => {
    const { setPlaidApp, getPlaidApp, loadPlaidApp } = await import("./app-config.js");
    await setPlaidApp("client-abc", "super-secret-xyz", "production");

    const status = await getPlaidApp();
    expect(status).toEqual({ configured: true, clientId: "client-abc", env: "production" });
    expect(JSON.stringify(status)).not.toContain("super-secret-xyz");

    const loaded = await loadPlaidApp();
    expect(loaded).toEqual({ clientId: "client-abc", clientSecret: "super-secret-xyz", env: "production" });

    // The row holds only an opaque secret_ref, never the secret bytes.
    const { pool } = await import("../db.js");
    const row = await pool.query("select client_id, client_secret_ref, env from plaid_app where id = true");
    expect(row.rows[0].client_secret_ref).toMatch(/^sec_/);
    expect(JSON.stringify(row.rows[0])).not.toContain("super-secret-xyz");
  });

  it("re-paste supersedes the secret; clear removes the row + reports unconfigured", async () => {
    const { setPlaidApp, getPlaidApp, loadPlaidApp, clearPlaidApp } = await import("./app-config.js");
    await setPlaidApp("client-1", "secret-1", "sandbox");
    await setPlaidApp("client-2", "secret-2", "sandbox");
    expect((await loadPlaidApp())?.clientSecret).toBe("secret-2");

    await clearPlaidApp();
    // #30: an unconfigured/cleared app now defaults to Production (was "sandbox").
    expect(await getPlaidApp()).toEqual({ configured: false, clientId: null, env: "production" });
    expect(await loadPlaidApp()).toBeNull();
  });

  it("rejects an empty client_id / secret (ConfigError → 400)", async () => {
    const { setPlaidApp } = await import("./app-config.js");
    const { ConfigError } = await import("../oauth/providers.js");
    await expect(setPlaidApp("", "s", "sandbox")).rejects.toBeInstanceOf(ConfigError);
    await expect(setPlaidApp("c", "", "sandbox")).rejects.toBeInstanceOf(ConfigError);
  });
});

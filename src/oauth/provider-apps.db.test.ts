// provider-apps — DB-backed round-trip (gated on DATABASE_URL; the mother runs this at merge against
// a migrated DB). Proves the real vault seal/open path: a confidential app's secret is sealed (the
// row holds a sec_ ref, never the plaintext) and loadProviderApp opens it back; a public app stores
// a NULL secret_ref; and providerConfig resolves table-first (overriding the env fallback).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { lockTestResource } from "../test-support/advisory-lock.js";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("provider-apps (DB round-trip)", () => {
  // oauth_provider_apps is one row per provider, shared by every parallel vitest fork (#38 — the
  // same singleton-flake class as plaid_app): hold the advisory lock for the whole suite so
  // admin.db.test.ts's `delete ... where provider = 'google'` can't land mid-test.
  let releaseLock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    releaseLock = await lockTestResource("oauth_provider_apps");
  }, 120_000);
  beforeEach(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from oauth_provider_apps where provider in ('google','microsoft')`);
  });
  afterAll(async () => {
    if (!HAS_DB) return;
    const { pool } = await import("../db.js");
    await pool.query(`delete from oauth_provider_apps where provider in ('google','microsoft')`);
    await releaseLock?.();
  });

  it("google: seals the secret (row holds a sec_ ref, not the plaintext) and loads it back", async () => {
    const { setProviderApp, loadProviderApp, getProviderApp } = await import("./provider-apps.js");
    const { pool } = await import("../db.js");

    await setProviderApp("google", "google-client-id", "the-confidential-secret");

    const row = await pool.query(
      `select client_id, client_secret_ref from oauth_provider_apps where provider = 'google'`,
    );
    expect(row.rows[0].client_id).toBe("google-client-id");
    expect(row.rows[0].client_secret_ref).toMatch(/^sec_/);
    expect(row.rows[0].client_secret_ref).not.toContain("the-confidential-secret");

    expect(await getProviderApp("google")).toEqual({ configured: true, clientId: "google-client-id" });
    expect(await loadProviderApp("google")).toEqual({
      clientId: "google-client-id",
      clientSecret: "the-confidential-secret",
    });
  });

  it("microsoft: public client stores a NULL secret_ref", async () => {
    const { setProviderApp } = await import("./provider-apps.js");
    const { pool } = await import("../db.js");
    await setProviderApp("microsoft", "ms-client-id", null);
    const row = await pool.query(
      `select client_secret_ref from oauth_provider_apps where provider = 'microsoft'`,
    );
    expect(row.rows[0].client_secret_ref).toBeNull();
  });

  it("providerConfig resolves table-first (overrides the env fallback)", async () => {
    const { setProviderApp } = await import("./provider-apps.js");
    const { providerConfig } = await import("./providers.js");
    process.env.GOOGLE_OAUTH_CLIENT_ID = "env-id-should-be-overridden";
    await setProviderApp("google", "table-client-id", "table-secret");
    const cfg = await providerConfig("google");
    expect(cfg.clientId).toBe("table-client-id");
    expect(cfg.clientSecret).toBe("table-secret");
  });
});

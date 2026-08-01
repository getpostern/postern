// resolveAccessToken DB round-trip — gated on DATABASE_URL so CI stays green without Postgres.
// Uses the REAL vault (seal/open/deleteSecret) and the REAL pool; only the provider token endpoint
// (global fetch) is mocked, since we obviously can't reach Whoop's servers. Proves the full
// refresh → re-seal → repoint-row → retire-old-rows path against actual Postgres + the AEAD vault:
//   - the credential row's secret_ref / refresh_ref / expires_at are repointed
//   - the new refs open to the fresh tokens at the right purposes
//   - the superseded secret rows are gone (deleteSecret retired them)

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;
const SEED_USER = "00000000-0000-0000-0000-000000000001";
// 'whoop' so we don't collide with admin.db.test.ts (which uses 'google') on unique(user_id, provider).
const PROVIDER = "whoop";

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  process.env.WHOOP_OAUTH_CLIENT_ID = "test-whoop-client-id";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(async () => {
  if (!HAS_DB) return;
  const { pool } = await import("../db.js");
  await pool.query(`delete from provider_credentials where provider = $1 and user_id = $2`, [PROVIDER, SEED_USER]);
  await pool.end();
});

describe.skipIf(!HAS_DB)("resolveAccessToken DB round-trip (real vault + pool, mocked endpoint)", () => {
  it("refreshes an expiring OAuth credential: repoints the row, re-seals, retires the old rows", async () => {
    const { pool } = await import("../db.js");
    const { seal, open, SecretNotFound } = await import("../secrets/index.js");
    const { resolveAccessToken } = await import("./refresh.js");

    // clean slate for this provider on the seeded user
    await pool.query(`delete from provider_credentials where provider = $1 and user_id = $2`, [PROVIDER, SEED_USER]);

    // seal an initial access + refresh token in the real vault
    const oldAccessRef = await seal({ userId: SEED_USER, provider: PROVIDER, purpose: "access" }, "stale-access-token");
    const oldRefreshRef = await seal({ userId: SEED_USER, provider: PROVIDER, purpose: "refresh" }, "the-stored-refresh");

    // a credential row whose access expires in 60s (within the 120s margin → must refresh)
    const expiringAt = new Date(Date.now() + 60_000);
    const ins = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, refresh_ref, expires_at, status)
         values ($1, $2, 'first_party', $3, $4, $5, 'active')
       returning id`,
      [SEED_USER, PROVIDER, oldAccessRef, oldRefreshRef, expiringAt],
    );
    const credentialId = ins.rows[0].id as string;

    // mock the token endpoint: returns a fresh access + a ROTATED refresh token
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      // assert the request actually carried the stored refresh token (proves we opened it)
      const body = new URLSearchParams(String(init?.body ?? ""));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("the-stored-refresh");
      return new Response(
        JSON.stringify({ access_token: "fresh-db-access", refresh_token: "rotated-db-refresh", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const before = Date.now();
    const resolved = await resolveAccessToken({
      credentialId,
      userId: SEED_USER,
      provider: PROVIDER,
      secretRef: oldAccessRef,
      refreshRef: oldRefreshRef,
      expiresAt: expiringAt,
    });
    const after = Date.now();

    // returned the fresh access token
    expect(resolved.token).toBe("fresh-db-access");

    // the credential row was repointed to NEW refs + an updated expiry
    const row = (
      await pool.query(`select secret_ref, refresh_ref, expires_at from provider_credentials where id = $1`, [credentialId])
    ).rows[0];
    expect(row.secret_ref).not.toBe(oldAccessRef);
    expect(row.refresh_ref).not.toBe(oldRefreshRef);
    // …and the returned secretRef IS the row's CURRENT (new) ref — the one callers must thread on.
    expect(resolved.secretRef).toBe(row.secret_ref);
    const exp = new Date(row.expires_at).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 3600_000 - 2000);
    expect(exp).toBeLessThanOrEqual(after + 3600_000 + 2000);

    // the NEW refs open to the fresh tokens at the right purposes
    const newAccess = await open(row.secret_ref, { userId: SEED_USER, provider: PROVIDER, purpose: "access" });
    const newRefresh = await open(row.refresh_ref, { userId: SEED_USER, provider: PROVIDER, purpose: "refresh" });
    expect(newAccess.toString("utf8")).toBe("fresh-db-access");
    expect(newRefresh.toString("utf8")).toBe("rotated-db-refresh");

    // the superseded rows were retired (deleteSecret) — opening them now throws SecretNotFound
    await expect(open(oldAccessRef, { userId: SEED_USER, provider: PROVIDER, purpose: "access" })).rejects.toBeInstanceOf(
      SecretNotFound,
    );
    await expect(open(oldRefreshRef, { userId: SEED_USER, provider: PROVIDER, purpose: "refresh" })).rejects.toBeInstanceOf(
      SecretNotFound,
    );
  });
});

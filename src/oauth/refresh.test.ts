// resolveAccessToken unit tests — DB-free, network-free. Mocks the vault (open/seal/deleteSecret),
// the token endpoint (refreshToken), and the pool; uses the REAL isOAuthProvider. Exercises every
// branch of the credential-resolution seam:
//   - static / non-OAuth → open access as-is, NEVER refresh (SimpleFIN/HA regression guard)
//   - OAuth but no refresh_ref → static branch (no refresh)
//   - OAuth still-valid → open only, no refresh
//   - OAuth expiring / null-expiry → re-read → refresh → re-seal → repoint row → retire old rows
//   - rotation (new refresh_token returned) vs no rotation
//   - return shape: refresh path carries the NEW secretRef; static paths the existing one
//   - single-flight: overlapping callers share ONE refresh; the slot clears after settle; a
//     stale-snapshot caller re-reads and short-circuits instead of double-refreshing
//   - refresh failure → throws (all sharers), credential row NOT mutated, no token in the error

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── mock the shared pool ──────────────────────────────────────────────────────
const query = vi.fn();
vi.mock("../db.js", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

// ── mock the vault ────────────────────────────────────────────────────────────
const open = vi.fn();
const seal = vi.fn();
const deleteSecret = vi.fn();
vi.mock("../secrets/index.js", () => ({
  open: (...a: unknown[]) => open(...a),
  seal: (...a: unknown[]) => seal(...a),
  deleteSecret: (...a: unknown[]) => deleteSecret(...a),
}));

// ── mock the token endpoint (refreshToken) ────────────────────────────────────
const refreshToken = vi.fn();
vi.mock("./exchange.js", () => ({ refreshToken: (...a: unknown[]) => refreshToken(...a) }));

// import AFTER the mocks (vi.mock is hoisted, but be explicit).
const { resolveAccessToken } = await import("./refresh.js");

const USER = "00000000-0000-0000-0000-000000000001";
const CRED = "22222222-2222-2222-2222-222222222222";
const NOW = 1_700_000_000_000; // fixed clock for deterministic expiry math

beforeEach(() => {
  query.mockReset();
  open.mockReset();
  seal.mockReset();
  deleteSecret.mockReset();
  refreshToken.mockReset();
  query.mockResolvedValue({ rows: [] });
  deleteSecret.mockResolvedValue(undefined);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** True iff a `update provider_credentials` write was issued. */
function repointed(): boolean {
  return query.mock.calls.some(
    ([sql]) => typeof sql === "string" && sql.includes("update provider_credentials"),
  );
}

/** Flush microtasks until the in-flight refresh has reached the (deferred) token endpoint. */
async function untilRefreshCalled(times = 1): Promise<void> {
  for (let i = 0; i < 50 && refreshToken.mock.calls.length < times; i++) await Promise.resolve();
  expect(refreshToken.mock.calls.length).toBe(times);
}

/**
 * Mock the pool so the critical-section RE-READ (`select secret_ref …`) returns the given row;
 * every other statement (the repoint UPDATE) resolves empty.
 */
function mockReread(row: { secret_ref: string | null; refresh_ref: string | null; expires_at: Date | null }) {
  query.mockImplementation((sql: unknown) => {
    if (typeof sql === "string" && sql.includes("select secret_ref")) {
      return Promise.resolve({ rows: [row] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe("resolveAccessToken — static / non-refreshable (regression: never refreshes)", () => {
  it("non-OAuth provider with a secret_ref → opens access, no refresh, no row read/write, existing ref returned", async () => {
    open.mockResolvedValue(Buffer.from("simplefin-access-url", "utf8"));

    const resolved = await resolveAccessToken({
      credentialId: CRED,
      userId: USER,
      provider: "simplefin",
      secretRef: "sec_access",
      refreshRef: null,
      expiresAt: null,
    });

    expect(resolved).toEqual({ token: "simplefin-access-url", secretRef: "sec_access" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("sec_access", { userId: USER, provider: "simplefin", purpose: "access" });
    expect(refreshToken).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled(); // lock-free fast path: no re-read, no write
    expect(repointed()).toBe(false);
  });

  it("non-OAuth provider with null secret_ref → { token: null, secretRef: null }, open never called", async () => {
    const resolved = await resolveAccessToken({
      credentialId: CRED,
      userId: USER,
      provider: "home_assistant",
      secretRef: null,
      refreshRef: null,
      expiresAt: null,
    });

    expect(resolved).toEqual({ token: null, secretRef: null });
    expect(open).not.toHaveBeenCalled();
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("OAuth provider but null refresh_ref → static branch (no refresh)", async () => {
    open.mockResolvedValue(Buffer.from("google-access", "utf8"));

    const resolved = await resolveAccessToken({
      credentialId: CRED,
      userId: USER,
      provider: "google",
      secretRef: "sec_access",
      refreshRef: null, // nothing to trade → treated as static
      expiresAt: new Date(NOW - 10_000), // even though "expired", no refresh token exists
    });

    expect(resolved).toEqual({ token: "google-access", secretRef: "sec_access" });
    expect(open).toHaveBeenCalledWith("sec_access", { userId: USER, provider: "google", purpose: "access" });
    expect(refreshToken).not.toHaveBeenCalled();
    expect(repointed()).toBe(false);
  });
});

describe("resolveAccessToken — OAuth still valid", () => {
  it("expires_at beyond the 120s margin → opens access only, no refresh, no re-read (lock-free)", async () => {
    open.mockResolvedValue(Buffer.from("still-valid-access", "utf8"));

    const resolved = await resolveAccessToken({
      credentialId: CRED,
      userId: USER,
      provider: "google",
      secretRef: "sec_access",
      refreshRef: "sec_refresh",
      expiresAt: new Date(NOW + 3_600_000), // 1h out
    });

    expect(resolved).toEqual({ token: "still-valid-access", secretRef: "sec_access" });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("sec_access", { userId: USER, provider: "google", purpose: "access" });
    expect(refreshToken).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(repointed()).toBe(false);
  });
});

describe("resolveAccessToken — OAuth expiring / refresh", () => {
  it("within margin → re-read, refresh, re-seal access, repoint row, retire old access; no rotation keeps refresh_ref; NEW ref returned", async () => {
    mockReread({ secret_ref: "sec_old_access", refresh_ref: "sec_refresh", expires_at: new Date(NOW + 60_000) });
    open.mockResolvedValue(Buffer.from("the-refresh-token", "utf8")); // opens the refresh secret
    seal.mockImplementation((ctx: { purpose: string }) =>
      Promise.resolve(ctx.purpose === "access" ? "sec_new_access" : "sec_new_refresh"),
    );
    refreshToken.mockResolvedValue({ accessToken: "fresh-access", expiresInSec: 3600 }); // no new refresh_token

    const resolved = await resolveAccessToken({
      credentialId: CRED,
      userId: USER,
      provider: "google",
      secretRef: "sec_old_access",
      refreshRef: "sec_refresh",
      expiresAt: new Date(NOW + 60_000), // 60s out → within margin
    });

    // returns the fresh token AND the NEW secretRef (the runner threads it into SyncContext)
    expect(resolved).toEqual({ token: "fresh-access", secretRef: "sec_new_access" });

    // re-read the row inside the critical section (never trust the snapshot)
    const reread = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("select secret_ref"),
    );
    expect(reread).toBeTruthy();
    expect((reread as unknown[])[1]).toEqual([CRED]);

    // opened the refresh token (purpose 'refresh'), then traded it
    expect(open).toHaveBeenCalledWith("sec_refresh", { userId: USER, provider: "google", purpose: "refresh" });
    expect(refreshToken).toHaveBeenCalledWith("google", "the-refresh-token");

    // sealed the new access (only) at purpose 'access'
    expect(seal).toHaveBeenCalledTimes(1);
    expect(seal).toHaveBeenCalledWith({ userId: USER, provider: "google", purpose: "access" }, "fresh-access");

    // repointed the credential row: new access ref, UNCHANGED refresh ref, computed expiry
    const upd = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("update provider_credentials"),
    );
    expect(upd).toBeTruthy();
    expect((upd as unknown[])[1]).toEqual(["sec_new_access", "sec_refresh", new Date(NOW + 3600 * 1000), CRED]);

    // retired the old access row only (refresh not rotated → not deleted)
    expect(deleteSecret).toHaveBeenCalledTimes(1);
    expect(deleteSecret).toHaveBeenCalledWith("sec_old_access");
  });

  it("rotation → response carries a new refresh_token → seal+repoint+delete the refresh ref too", async () => {
    mockReread({ secret_ref: "sec_old_access", refresh_ref: "sec_old_refresh", expires_at: new Date(NOW + 30_000) });
    open.mockResolvedValue(Buffer.from("old-refresh", "utf8"));
    seal.mockImplementation((ctx: { purpose: string }) =>
      Promise.resolve(ctx.purpose === "access" ? "sec_new_access" : "sec_new_refresh"),
    );
    refreshToken.mockResolvedValue({
      accessToken: "fresh-access",
      refreshToken: "rotated-refresh",
      expiresInSec: 3600,
    });

    const resolved = await resolveAccessToken({
      credentialId: CRED,
      userId: USER,
      provider: "whoop",
      secretRef: "sec_old_access",
      refreshRef: "sec_old_refresh",
      expiresAt: new Date(NOW + 30_000),
    });

    expect(resolved).toEqual({ token: "fresh-access", secretRef: "sec_new_access" });
    expect(seal).toHaveBeenCalledTimes(2);
    expect(seal).toHaveBeenCalledWith({ userId: USER, provider: "whoop", purpose: "refresh" }, "rotated-refresh");

    const upd = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("update provider_credentials"),
    );
    expect((upd as unknown[])[1]).toEqual(["sec_new_access", "sec_new_refresh", new Date(NOW + 3600 * 1000), CRED]);

    // both superseded rows retired
    expect(deleteSecret).toHaveBeenCalledWith("sec_old_access");
    expect(deleteSecret).toHaveBeenCalledWith("sec_old_refresh");
    expect(deleteSecret).toHaveBeenCalledTimes(2);
  });

  it("null expires_at + OAuth + refresh_ref → refreshes proactively (expires_at written as null)", async () => {
    mockReread({ secret_ref: "sec_old_access", refresh_ref: "sec_refresh", expires_at: null });
    open.mockResolvedValue(Buffer.from("the-refresh-token", "utf8"));
    seal.mockResolvedValue("sec_new_access");
    refreshToken.mockResolvedValue({ accessToken: "fresh-access" }); // no expires_in, no new refresh

    const resolved = await resolveAccessToken({
      credentialId: CRED,
      userId: USER,
      provider: "microsoft",
      secretRef: "sec_old_access",
      refreshRef: "sec_refresh",
      expiresAt: null,
    });

    expect(resolved).toEqual({ token: "fresh-access", secretRef: "sec_new_access" });
    expect(refreshToken).toHaveBeenCalledWith("microsoft", "the-refresh-token");
    const upd = query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("update provider_credentials"),
    );
    // expires_in absent → expires_at persisted as null
    expect((upd as unknown[])[1]).toEqual(["sec_new_access", "sec_refresh", null, CRED]);
  });

  it("a deleteSecret failure does NOT fail the refresh (best-effort hygiene)", async () => {
    mockReread({ secret_ref: "sec_old_access", refresh_ref: "sec_refresh", expires_at: new Date(NOW + 10_000) });
    open.mockResolvedValue(Buffer.from("rt", "utf8"));
    seal.mockResolvedValue("sec_new_access");
    refreshToken.mockResolvedValue({ accessToken: "fresh-access", expiresInSec: 3600 });
    deleteSecret.mockRejectedValue(new Error("vault delete failed"));

    const resolved = await resolveAccessToken({
      credentialId: CRED,
      userId: USER,
      provider: "google",
      secretRef: "sec_old_access",
      refreshRef: "sec_refresh",
      expiresAt: new Date(NOW + 10_000),
    });

    expect(resolved.token).toBe("fresh-access");
    expect(repointed()).toBe(true); // the row was still repointed
  });
});

describe("resolveAccessToken — single-flight + stale-snapshot re-read", () => {
  /** A still-expired snapshot of the credential (drives callers into the critical section). */
  const STALE = {
    credentialId: CRED,
    userId: USER,
    provider: "google",
    secretRef: "sec_old_access",
    refreshRef: "sec_refresh",
    expiresAt: new Date(NOW + 10_000), // within margin
  };

  it("two overlapping callers share ONE refresh; both get the fresh token + NEW ref; the slot clears after settle", async () => {
    mockReread({ secret_ref: "sec_old_access", refresh_ref: "sec_refresh", expires_at: new Date(NOW + 10_000) });
    open.mockResolvedValue(Buffer.from("the-refresh-token", "utf8"));
    seal.mockResolvedValue("sec_new_access");
    let release!: (v: unknown) => void;
    refreshToken.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    const a = resolveAccessToken(STALE);
    const b = resolveAccessToken(STALE); // arrives while A's refresh is in flight → shares it

    await untilRefreshCalled(1); // let A reach the (deferred) token endpoint
    release({ accessToken: "fresh-access", expiresInSec: 3600 });
    const [ra, rb] = await Promise.all([a, b]);

    expect(refreshToken).toHaveBeenCalledTimes(1); // ONE refresh for both callers
    expect(ra).toEqual({ token: "fresh-access", secretRef: "sec_new_access" });
    expect(rb).toEqual(ra);

    // slot cleared after settle: a later still-expired caller refreshes AGAIN (a fresh flight,
    // not the memoized old promise).
    refreshToken.mockResolvedValue({ accessToken: "fresh-access-2", expiresInSec: 3600 });
    seal.mockResolvedValue("sec_new_access_2");
    const rc = await resolveAccessToken(STALE);
    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(rc).toEqual({ token: "fresh-access-2", secretRef: "sec_new_access_2" });
  });

  it("a stale-snapshot caller arriving AFTER the refresh settled re-reads and does NOT refresh again", async () => {
    // The row was already refreshed by a sibling: re-read shows fresh refs + a far-out expiry.
    mockReread({ secret_ref: "sec_new_access", refresh_ref: "sec_new_refresh", expires_at: new Date(NOW + 3_600_000) });
    open.mockResolvedValue(Buffer.from("fresh-access", "utf8"));

    const resolved = await resolveAccessToken(STALE); // snapshot still points at the retired refs

    expect(refreshToken).not.toHaveBeenCalled(); // zero second refresh
    // opened the CURRENT access ref from the re-read — not the snapshot's retired one
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("sec_new_access", { userId: USER, provider: "google", purpose: "access" });
    expect(resolved).toEqual({ token: "fresh-access", secretRef: "sec_new_access" });
  });

  it("a caller whose re-read row is STILL expired refreshes", async () => {
    mockReread({ secret_ref: "sec_old_access", refresh_ref: "sec_refresh", expires_at: new Date(NOW + 5_000) });
    open.mockResolvedValue(Buffer.from("the-refresh-token", "utf8"));
    seal.mockResolvedValue("sec_new_access");
    refreshToken.mockResolvedValue({ accessToken: "fresh-access", expiresInSec: 3600 });

    const resolved = await resolveAccessToken(STALE);

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({ token: "fresh-access", secretRef: "sec_new_access" });
  });

  it("a failing refresh rejects ALL sharers and clears the slot (the next caller can retry)", async () => {
    mockReread({ secret_ref: "sec_old_access", refresh_ref: "sec_refresh", expires_at: new Date(NOW + 10_000) });
    open.mockResolvedValue(Buffer.from("the-refresh-token", "utf8"));
    let reject!: (e: unknown) => void;
    refreshToken.mockImplementation(() => new Promise((_resolve, rej) => { reject = rej; }));

    const a = resolveAccessToken(STALE);
    const b = resolveAccessToken(STALE);

    await untilRefreshCalled(1); // let the shared flight reach the (deferred) token endpoint
    reject(new Error("token endpoint returned 503"));
    await expect(a).rejects.toThrow(/503/);
    await expect(b).rejects.toThrow(/503/);
    expect(refreshToken).toHaveBeenCalledTimes(1);

    // slot cleared: a retry refreshes anew and succeeds
    refreshToken.mockResolvedValue({ accessToken: "fresh-after-retry", expiresInSec: 3600 });
    seal.mockResolvedValue("sec_new_access");
    const rc = await resolveAccessToken(STALE);
    expect(rc).toEqual({ token: "fresh-after-retry", secretRef: "sec_new_access" });
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });
});

describe("resolveAccessToken — refresh failure (no partial write, no token leak)", () => {
  it("refreshToken throws → resolveAccessToken throws, credential row NOT mutated, nothing sealed/deleted", async () => {
    mockReread({ secret_ref: "sec_old_access", refresh_ref: "sec_refresh", expires_at: new Date(NOW + 10_000) });
    open.mockResolvedValue(Buffer.from("super-secret-refresh-token", "utf8"));
    refreshToken.mockRejectedValue(new Error("token endpoint returned 401"));

    await expect(
      resolveAccessToken({
        credentialId: CRED,
        userId: USER,
        provider: "google",
        secretRef: "sec_old_access",
        refreshRef: "sec_refresh",
        expiresAt: new Date(NOW + 10_000),
      }),
    ).rejects.toThrow(/401/);

    // No partial write: row never repointed, no new secret sealed, no old secret deleted.
    expect(repointed()).toBe(false);
    expect(seal).not.toHaveBeenCalled();
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  it("the thrown error carries NO token material", async () => {
    mockReread({ secret_ref: "sec_old_access", refresh_ref: "sec_refresh", expires_at: new Date(NOW + 10_000) });
    open.mockResolvedValue(Buffer.from("super-secret-refresh-token", "utf8"));
    refreshToken.mockRejectedValue(new Error("token endpoint returned 400"));

    let caught: unknown;
    try {
      await resolveAccessToken({
        credentialId: CRED,
        userId: USER,
        provider: "google",
        secretRef: "sec_old_access",
        refreshRef: "sec_refresh",
        expiresAt: new Date(NOW + 10_000),
      });
    } catch (e) {
      caught = e;
    }
    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).not.toContain("super-secret-refresh-token");
  });
});

// fetch_live round-trips against a real Postgres, gated on DATABASE_URL so CI stays green.
// syncConnection is stubbed via vi.mock of ../sync/index.js (deferred promises for the timeout
// case, resolved before teardown so no query outlives the pool); the connector registry stays REAL
// so fake connectors registered here drive the push-skip and record-mode dispatch. Seeds rows
// DIRECTLY via raw SQL under a dedicated throwaway user (the established pattern). Proves:
//   * deny before any work on an ungranted sector (both modes),
//   * sync-now: two active connections sync within one bound; one failure -> synced:false + its
//     error in `errors`; a timeout -> timed_out:true with no rejection and the timer cleared;
//     a push-only sector skips syncConnection but still returns last_synced_at; an empty sector
//     -> NotFoundError,
//   * record mode: unknown/foreign ids -> NotFoundError; a bare multi-object sector with id ->
//     QueryValidationError naming both dotted keys; a hook-less provider -> QueryValidationError;
//     a fake hook returns the raw payload with NO domain-table write; the row's OWN connection is
//     used when two providers share the sector; tombstoned rows stay fetchable (ADR 0004); a
//     connector throw -> FetchLiveUnavailableError.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { Connector, SyncContext, RawRecord } from "../connectors/types.js";
import type { AuthContext } from "../auth/index.js";
import { ALL_SECTORS, AccessDenied } from "../auth/index.js";

// Stub ONLY syncConnection; registerConnector/getConnector stay real (the registry drives dispatch).
const syncConnectionMock = vi.fn();
vi.mock("../sync/index.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/index.js")>("../sync/index.js");
  return { ...actual, syncConnection: (...a: unknown[]) => syncConnectionMock(...a) };
});

import { fetchLive, NotFoundError, FetchLiveUnavailableError } from "./context.js";
import { QueryValidationError } from "./query.js";
import { registerConnector } from "../sync/index.js";

const HAS_DB = !!process.env.DATABASE_URL;
// A DEDICATED throwaway user so these round-trips can't race other db test files (run in parallel).
const TEST_USER = "00000000-0000-0000-0000-0000000071a1";
const OTHER_USER = "00000000-0000-0000-0000-0000000071a2";

const ctx: AuthContext = {
  userId: TEST_USER,
  agentId: "fetch-live-test",
  grantedSectors: new Set(ALL_SECTORS),
};
const deniedCtx: AuthContext = {
  userId: TEST_USER,
  agentId: "fetch-live-test",
  grantedSectors: new Set<string>(), // default-deny
};

/** A successful SyncResult stub (shape only — syncConnection is mocked, never the real runner). */
const okResult = (connectionId: string) => ({
  connectionId,
  provider: "fake",
  ok: true,
  upserted: 1,
  deleted: 0,
  newCursor: null,
});

/** A minimal fake connector; `hook` (when given) becomes its fetchRecordLive. */
function makeConnector(
  provider: string,
  sector: string,
  mode: "push" | "poll",
  hook?: (ctx: SyncContext, sourceObjectId: string) => Promise<unknown>,
): Connector {
  const base: Connector = {
    provider,
    sector,
    objectType: "transaction",
    policy: { mode, supportsIncremental: false },
    actions: [],
    // eslint-disable-next-line require-yield
    async *sync(): AsyncIterable<RawRecord> {
      return;
    },
    normalize: (raw) => raw.raw,
    strongKeys: () => ({}),
    execute: async () => ({ ok: false }),
  };
  if (hook) base.fetchRecordLive = hook;
  return base;
}

// Record-mode hooks: per-provider spies so the own-connection assertion is direct.
const hookA = vi.fn(async (_ctx: SyncContext, sid: string) => ({ via: "fl-poll-a", sid }));
const hookB = vi.fn(async (_ctx: SyncContext, sid: string) => ({ via: "fl-poll-b", sid }));
// An OAuth provider's hook — used to prove the drill resolves via resolveAccessToken (proactive refresh).
const hookOAuth = vi.fn(async (_ctx: SyncContext, sid: string) => ({ via: "whoop", sid }));

describe.skipIf(!HAS_DB)("fetch_live DB round-trips", () => {
  let credA: string; // finance · fl-poll-a (hook)
  let connA: string;
  let connB: string; // finance · fl-poll-b (hook)
  let connPush: string; // home · fl-push (push-mode, skipped)
  let connNoHook: string; // health · fl-nohook (no fetchRecordLive)
  let rowA: string; // finance_transactions row on connA
  let rowB: string; // finance_transactions row on connB
  let rowATombstoned: string; // tombstoned row on connA
  let rowNoHook: string; // health_samples row on connNoHook
  let rowOther: string; // OTHER_USER's finance row
  let pushSyncedAt: Date;
  let oauthCredId: string; // contacts · whoop (OAuth, near-expiry → drill must refresh)
  let connOAuth: string;
  let rowOAuth: string; // contacts row on connOAuth
  let oauthOldAccessRef: string; // the pre-refresh access ref (retired by the drill)
  let oauthOldRefreshRef: string; // the pre-refresh refresh ref (rotated by the drill)

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    for (const [uid, label] of [
      [TEST_USER, "fetch-live-db-test"],
      [OTHER_USER, "fetch-live-db-test-other"],
    ]) {
      await pool.query(`insert into users (id, label) values ($1, $2) on conflict (id) do nothing`, [
        uid,
        label,
      ]);
    }

    // One credential per provider (unique user_id+provider), one connector each.
    const cred = async (userId: string, provider: string) => {
      const r = await pool.query(
        `insert into provider_credentials (user_id, provider, custody, status)
         values ($1, $2, 'static_token', 'active') returning id`,
        [userId, provider],
      );
      return r.rows[0].id as string;
    };
    const connector = async (userId: string, credentialId: string, sector: string, provider: string) => {
      const r = await pool.query(
        `insert into connectors (user_id, credential_id, sector, provider, status)
         values ($1, $2, $3, $4, 'active') returning id`,
        [userId, credentialId, sector, provider],
      );
      return r.rows[0].id as string;
    };

    credA = await cred(TEST_USER, "fl-poll-a");
    connA = await connector(TEST_USER, credA, "finance", "fl-poll-a");
    connB = await connector(TEST_USER, await cred(TEST_USER, "fl-poll-b"), "finance", "fl-poll-b");
    connPush = await connector(TEST_USER, await cred(TEST_USER, "fl-push"), "home", "fl-push");
    connNoHook = await connector(TEST_USER, await cred(TEST_USER, "fl-nohook"), "health", "fl-nohook");
    const connOther = await connector(
      OTHER_USER,
      await cred(OTHER_USER, "fl-poll-a"),
      "finance",
      "fl-poll-a",
    );

    // The push connection carries a known freshness for the push-only assertion.
    pushSyncedAt = new Date("2026-06-09T10:00:00Z");
    await pool.query(`update connectors set last_synced_at = $2 where id = $1`, [connPush, pushSyncedAt]);

    const txn = async (connectionId: string, userId: string, sid: string) => {
      const r = await pool.query(
        `insert into finance_transactions
           (connection_id, user_id, source_object_id, posted_at, amount, currency, description)
         values ($1, $2, $3, '2026-06-01T12:00:00Z', '-10.00', 'USD', 'fetch-live seed') returning id`,
        [connectionId, userId, sid],
      );
      return r.rows[0].id as string;
    };
    rowA = await txn(connA, TEST_USER, "fl-a-1");
    rowB = await txn(connB, TEST_USER, "fl-b-1");
    rowATombstoned = await txn(connA, TEST_USER, "fl-a-gone");
    await pool.query(`update finance_transactions set deleted_at = now() where id = $1`, [rowATombstoned]);
    rowOther = await txn(connOther, OTHER_USER, "fl-other-1");

    const hs = await pool.query(
      `insert into health_samples
         (connection_id, user_id, source_object_id, metric_type, value, unit, window_start)
       values ($1, $2, 'fl-h-1', 'heart_rate', '60', 'count/min', '2026-06-01T08:00:00Z') returning id`,
      [connNoHook, TEST_USER],
    );
    rowNoHook = hs.rows[0].id as string;

    // An OAuth (whoop) credential whose access token is WITHIN the refresh margin (expires in 60s,
    // margin is 120s) — sealed with real access + refresh tokens so a record drill must proactively
    // refresh via resolveAccessToken. In a sector no other test in this file touches (contacts).
    const { seal } = await import("../secrets/index.js");
    oauthOldAccessRef = await seal({ userId: TEST_USER, provider: "whoop", purpose: "access" }, "stale-access");
    oauthOldRefreshRef = await seal({ userId: TEST_USER, provider: "whoop", purpose: "refresh" }, "stored-refresh");
    const oauthCred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, refresh_ref, expires_at, status)
         values ($1, 'whoop', 'first_party', $2, $3, $4, 'active') returning id`,
      [TEST_USER, oauthOldAccessRef, oauthOldRefreshRef, new Date(Date.now() + 60_000)],
    );
    oauthCredId = oauthCred.rows[0].id as string;
    connOAuth = await connector(TEST_USER, oauthCredId, "contacts", "whoop");
    const co = await pool.query(
      `insert into contacts (connection_id, user_id, source_object_id, display_name)
       values ($1, $2, 'oauth-contact-1', 'Live Drill') returning id`,
      [connOAuth, TEST_USER],
    );
    rowOAuth = co.rows[0].id as string;

    // The registry: two finance poll providers WITH the hook, a push home provider, a hook-less one,
    // and an OAuth (whoop) contacts provider WITH the hook (drives the refresh-on-drill assertion).
    registerConnector(makeConnector("fl-poll-a", "finance", "poll", (c, s) => hookA(c, s)));
    registerConnector(makeConnector("fl-poll-b", "finance", "poll", (c, s) => hookB(c, s)));
    registerConnector(makeConnector("fl-push", "home", "push"));
    registerConnector(makeConnector("fl-nohook", "health", "poll"));
    registerConnector(makeConnector("whoop", "contacts", "poll", (c, s) => hookOAuth(c, s)));
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: credentials -> connectors -> domain rows.
    await pool.query(`delete from provider_credentials where user_id = any($1)`, [[TEST_USER, OTHER_USER]]);
    await pool.query(`delete from users where id = any($1)`, [[TEST_USER, OTHER_USER]]);
    await pool.end();
  });

  beforeEach(() => {
    syncConnectionMock.mockReset();
    hookA.mockClear();
    hookB.mockClear();
    hookOAuth.mockClear();
  });

  describe("grant gate — deny before any work", () => {
    it("sync mode: an ungranted sector throws AccessDenied and syncConnection never runs", async () => {
      await expect(fetchLive(deniedCtx, "finance")).rejects.toBeInstanceOf(AccessDenied);
      expect(syncConnectionMock).not.toHaveBeenCalled();
    });

    it("record mode: an ungranted sector throws AccessDenied and no hook runs", async () => {
      await expect(fetchLive(deniedCtx, "finance.transaction", { id: rowA })).rejects.toBeInstanceOf(
        AccessDenied,
      );
      expect(hookA).not.toHaveBeenCalled();
    });
  });

  describe("sync-now (no id)", () => {
    it("TWO active finance connections both sync within one bound -> synced:true", async () => {
      syncConnectionMock.mockImplementation(async (id: string) => okResult(id));
      const out = await fetchLive(ctx, "finance");

      expect(out).toMatchObject({ sector: "finance", mode: "sync", synced: true, timed_out: false });
      expect(syncConnectionMock).toHaveBeenCalledTimes(2);
      const calledWith = syncConnectionMock.mock.calls.map((c) => c[0]).sort();
      expect(calledWith).toEqual([connA, connB].sort());
      expect((out as { errors?: string[] }).errors).toBeUndefined();
    });

    it("a dotted key reduces to the sector for sync mode", async () => {
      syncConnectionMock.mockImplementation(async (id: string) => okResult(id));
      const out = await fetchLive(ctx, "finance.transaction");
      expect(out).toMatchObject({ sector: "finance", mode: "sync", synced: true });
      expect(syncConnectionMock).toHaveBeenCalledTimes(2);
    });

    it("one failing connection -> synced:false with its secret-free error in `errors`", async () => {
      syncConnectionMock.mockImplementation(async (id: string) =>
        id === connB
          ? { ...okResult(id), ok: false, upserted: 0, error: "bridge returned 500" }
          : okResult(id),
      );
      const out = await fetchLive(ctx, "finance");
      expect(out).toMatchObject({ mode: "sync", synced: false, timed_out: false });
      expect((out as { errors?: string[] }).errors).toEqual(["bridge returned 500"]);
    });

    it("timeout (deferred syncs) -> timed_out:true, no rejection, timer cleared", async () => {
      const setSpy = vi.spyOn(globalThis, "setTimeout");
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      try {
        // Deferred promises: the syncs NEVER settle inside the bound; resolved before teardown.
        const deferred: Array<(v: unknown) => void> = [];
        syncConnectionMock.mockImplementation(
          () => new Promise((resolve) => deferred.push(resolve)),
        );

        const pending = fetchLive(ctx, "finance");
        // Wait until the 30s bounded-wait timer is installed, then fire it manually (no real 30s).
        await vi.waitFor(() => {
          expect(setSpy.mock.calls.some((c) => c[1] === 30_000)).toBe(true);
        });
        const idx = setSpy.mock.calls.findIndex((c) => c[1] === 30_000);
        (setSpy.mock.calls[idx][0] as () => void)();

        const out = await pending; // resolves — a bounded WAIT never rejects
        expect(out).toMatchObject({ sector: "finance", mode: "sync", synced: false, timed_out: true });
        // Hygiene: the real timer handle was cleared right after the race.
        expect(clearSpy.mock.calls.some((c) => c[0] === setSpy.mock.results[idx].value)).toBe(true);

        // Resolve the deferred syncs before teardown so nothing outlives the pool.
        for (const resolve of deferred) resolve(okResult("late"));
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
      }
    });

    it("a push-only sector skips syncConnection and still returns last_synced_at", async () => {
      const out = await fetchLive(ctx, "home");
      expect(syncConnectionMock).not.toHaveBeenCalled(); // push = already live
      expect(out).toMatchObject({ sector: "home", mode: "sync", synced: true, timed_out: false });
      expect((out as { last_synced_at: string | null }).last_synced_at).toBe(pushSyncedAt.toISOString());
    });

    it("no active connections in the sector -> NotFoundError", async () => {
      await expect(fetchLive(ctx, "calendar")).rejects.toBeInstanceOf(NotFoundError);
      expect(syncConnectionMock).not.toHaveBeenCalled();
    });
  });

  describe("record mode ({id})", () => {
    it("a fake hook returns the raw payload, scoped SyncContext, and writes NOTHING to the table", async () => {
      const { pool } = await import("../db.js");
      const before = await pool.query(
        `select count(*)::int as n from finance_transactions where user_id = $1`,
        [TEST_USER],
      );

      const out = await fetchLive(ctx, "finance.transaction", { id: rowA });
      expect(out).toEqual({
        sector: "finance.transaction",
        mode: "record",
        id: rowA,
        record: { via: "fl-poll-a", sid: "fl-a-1" },
      });
      // The hook got the row's source id and a vault-resolved (here: null-secret) SyncContext.
      expect(hookA).toHaveBeenCalledTimes(1);
      expect(hookA.mock.calls[0][1]).toBe("fl-a-1");
      expect(hookA.mock.calls[0][0]).toMatchObject({
        userId: TEST_USER,
        connectionId: connA,
        secretRef: null,
        secret: null,
      });

      // Footprint rule: the live fetch is returned, never stored — no row added or removed.
      const after = await pool.query(
        `select count(*)::int as n from finance_transactions where user_id = $1`,
        [TEST_USER],
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("uses the row's OWN connection when two providers share the sector", async () => {
      const out = await fetchLive(ctx, "finance.transaction", { id: rowB });
      expect((out as { record: unknown }).record).toEqual({ via: "fl-poll-b", sid: "fl-b-1" });
      expect(hookB).toHaveBeenCalledTimes(1);
      expect(hookB.mock.calls[0][0]).toMatchObject({ connectionId: connB });
      expect(hookA).not.toHaveBeenCalled(); // never the sector's "most recent" connection
    });

    it("a tombstoned row is still fetchable — the truthful 'is it really gone?' probe (ADR 0004)", async () => {
      const out = await fetchLive(ctx, "finance.transaction", { id: rowATombstoned });
      expect((out as { record: unknown }).record).toEqual({ via: "fl-poll-a", sid: "fl-a-gone" });
    });

    it("unknown id -> NotFoundError; another user's id -> NotFoundError (no cross-user drill)", async () => {
      await expect(
        fetchLive(ctx, "finance.transaction", { id: "11111111-2222-3333-4444-555555555555" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(fetchLive(ctx, "finance.transaction", { id: rowOther })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      // A malformed uuid is a typed NotFoundError too — never a bare pg error.
      await expect(fetchLive(ctx, "finance.transaction", { id: "not-a-uuid" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("a bare multi-object sector with id -> QueryValidationError naming both dotted keys", async () => {
      const err = await fetchLive(ctx, "finance", { id: rowA }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(QueryValidationError);
      expect((err as Error).message).toContain("finance.account");
      expect((err as Error).message).toContain("finance.transaction");
    });

    it("a provider without the hook -> QueryValidationError", async () => {
      const err = await fetchLive(ctx, "health.sample", { id: rowNoHook }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(QueryValidationError);
      expect((err as Error).message).toContain("fl-nohook");
    });

    it("a connector throw -> FetchLiveUnavailableError carrying the (secret-free) message", async () => {
      hookA.mockRejectedValueOnce(new Error("source websocket not connected"));
      const err = await fetchLive(ctx, "finance.transaction", { id: rowA }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(FetchLiveUnavailableError);
      expect((err as Error).message).toBe("source websocket not connected");
    });

    it("an OAuth near-expiry credential refreshes on drill: the hook gets the FRESH token + rotated ref, the row is repointed", async () => {
      const { pool } = await import("../db.js");
      const { open, SecretNotFound } = await import("../secrets/index.js");
      process.env.WHOOP_OAUTH_CLIENT_ID = "test-whoop-client-id";

      // Mock ONLY the provider token endpoint (the refresh POST); restore in `finally` so no other
      // test in this file inherits a stubbed fetch. The body proves we opened the STORED refresh token.
      const savedFetch = globalThis.fetch;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body ?? ""));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("stored-refresh");
        return new Response(
          JSON.stringify({
            access_token: "fresh-drill-access",
            refresh_token: "rotated-drill-refresh",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof globalThis.fetch;

      try {
        const out = await fetchLive(ctx, "contacts", { id: rowOAuth });
        expect(out).toEqual({
          sector: "contacts",
          mode: "record",
          id: rowOAuth,
          record: { via: "whoop", sid: "oauth-contact-1" },
        });

        // The row was repointed to NEW refs (mirror of the refresh.db.test assertions).
        const row = (
          await pool.query(`select secret_ref, refresh_ref from provider_credentials where id = $1`, [
            oauthCredId,
          ])
        ).rows[0];
        expect(row.secret_ref).not.toBe(oauthOldAccessRef);
        expect(row.refresh_ref).not.toBe(oauthOldRefreshRef);

        // The hook received the FRESH access token and the row's CURRENT (rotated) ref — never a dead token.
        expect(hookOAuth).toHaveBeenCalledTimes(1);
        expect(hookOAuth.mock.calls[0][0]).toMatchObject({
          userId: TEST_USER,
          connectionId: connOAuth,
          secretRef: row.secret_ref,
          secret: "fresh-drill-access",
        });

        // The new ref opens to the fresh token; the superseded refs were retired by the refresh.
        const fresh = await open(row.secret_ref, { userId: TEST_USER, provider: "whoop", purpose: "access" });
        expect(fresh.toString("utf8")).toBe("fresh-drill-access");
        await expect(
          open(oauthOldAccessRef, { userId: TEST_USER, provider: "whoop", purpose: "access" }),
        ).rejects.toBeInstanceOf(SecretNotFound);
        await expect(
          open(oauthOldRefreshRef, { userId: TEST_USER, provider: "whoop", purpose: "refresh" }),
        ).rejects.toBeInstanceOf(SecretNotFound);
      } finally {
        globalThis.fetch = savedFetch;
      }
    });
  });
});

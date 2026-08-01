// Connection lifecycle + status round-trips against a real Postgres, gated on DATABASE_URL so CI
// stays green without a DB. syncConnection is REAL (the registry + runner drive sync-now and the
// markError/last_error write-back); fake connectors register under unique providers so this file
// can't collide with another db test. Rows are seeded directly via raw SQL under dedicated throwaway
// users (the established pattern). Proves:
//   * pause: active|error → paused (push → stop()); already-paused → no-op; revoked → 409; unknown/
//     foreign → NotFoundError; the row's status really flips.
//   * resume: paused → active; not-paused → 409; unknown → NotFoundError.
//   * revoke: credential + ALL its connectors → 'revoked', vault secrets deleted, refs nulled, the
//     credential row + domain rows KEPT; unknown/foreign → NotFoundError.
//   * sync-now: poll runs syncConnection and returns its result; push → ran:false, HONEST about the
//     stream (#39: connected → ok:true + stream fields, retrying/down → ok:false + audit 'error');
//     revoked → 409.
//   * markError records a MASKED, secret-free last_error + status='error'; a later success CLEARS it.
//   * enriched status carries the new fields; detail adds per-table live counts (tombstones excluded);
//     every op is user_id-scoped (no cross-user reach).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Connector, RawRecord, SyncContext } from "../connectors/types.js";
import type { AuthContext } from "../auth/index.js";
import { ALL_SECTORS } from "../auth/index.js";

import {
  pauseConnection,
  resumeConnection,
  revokeCredential,
  syncNowConnection,
  listConnectorsEnriched,
  getConnectionDetail,
  disconnectConnection,
  setSyncWindow,
  setSyncInterval,
  MAX_SYNC_INTERVAL_SEC,
  ConflictError,
} from "./lifecycle.js";
import { NotFoundError } from "./context.js";
import { QueryValidationError } from "./query.js";
import { registerConnector, syncConnection } from "../sync/index.js";

const HAS_DB = !!process.env.DATABASE_URL;
const TEST_USER = "00000000-0000-0000-0000-00000000a10a";
const OTHER_USER = "00000000-0000-0000-0000-00000000a10b";

const ctx: AuthContext = {
  userId: TEST_USER,
  agentId: "lifecycle-test",
  grantedSectors: new Set(ALL_SECTORS),
};
const otherCtx: AuthContext = {
  userId: OTHER_USER,
  agentId: "lifecycle-test-other",
  grantedSectors: new Set(ALL_SECTORS),
};

const RANDOM_UUID = "11111111-2222-3333-4444-555555555555";

/** stop() spy so the push-pause assertion is direct. */
const stopSpy = vi.fn();

/** A fake connector. `mode`, an optional yielded record, or a sync() that throws (drives markError). */
function makeConnector(opts: {
  provider: string;
  sector: string;
  mode: "poll" | "push" | "on_demand";
  intervalSec?: number;
  /** The ADR-0025 cadence floor for user overrides (poll connectors). */
  minIntervalSec?: number;
  record?: Record<string, unknown>;
  throwMessage?: string;
  hasStop?: boolean;
  /** Adds a duck-typed start() so pushKindOf reads this connector as a push-STREAM (#39). */
  hasStart?: boolean;
  /** The DECLARED transport kind (#41) — the policy word the served push_kind prefers. */
  pushKind?: "stream" | "webhook";
}): Connector {
  const base: Connector = {
    provider: opts.provider,
    sector: opts.sector,
    objectType: "transaction",
    policy: {
      mode: opts.mode,
      pushKind: opts.pushKind,
      defaultIntervalSec: opts.intervalSec,
      minIntervalSec: opts.minIntervalSec,
      supportsIncremental: false,
    },
    actions: [],
    async *sync(): AsyncIterable<RawRecord> {
      if (opts.throwMessage) throw new Error(opts.throwMessage);
      if (opts.record) yield { externalId: String(opts.record.source_object_id), raw: { seed: true } };
    },
    normalize: () => opts.record ?? {},
    strongKeys: () => ({}),
    execute: async () => ({ ok: false }),
  };
  if (opts.hasStop) (base as { stop?: (id: string) => void }).stop = (id) => stopSpy(id);
  if (opts.hasStart) (base as { start?: () => Promise<void> }).start = async () => {};
  return base;
}

describe.skipIf(!HAS_DB)("lifecycle DB round-trips", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pool: any;

  // Seed handles, recreated fresh in beforeAll.
  let credPoll: string;
  let connPoll: string; // finance · poll (sync-now + enriched + detail + counts)
  let credPush: string;
  let connPush: string; // home · push (pause stop(); sync-now no-op)
  let credFail: string;
  let connFail: string; // finance · poll, sync throws (markError + last_error mask)
  let credRevoke: string;
  let connRevokeA: string; // calendar · on the revoke credential
  let connRevokeB: string; // contacts · on the revoke credential
  // Disconnect (#18): a SHARED credential fanning out to calendar + contacts (google-style), with a
  // sealed access secret, so we can assert the last-connector rule removes the credential + its vault.
  let credDisc: string;
  let connDiscCal: string;
  let connDiscCon: string;
  let secretDisc: string;
  let secretAccess: string;
  let secretRefresh: string;
  let secretClientApp: string;
  let connOther: string; // OTHER_USER's connection (cross-user negative)
  let credOther: string;
  let credStream: string;
  let connStream: string; // home · push-STREAM (duck-typed start) — the #39 honesty round-trips
  let credWebhook: string;
  let connWebhook: string; // health · push with a DECLARED pushKind 'webhook' — the #41 push_kind serve
  let credCad: string;
  let connCad: string; // finance · poll with a declared cadence floor — the ADR-0025 round-trips
  let credCadFloor: string;
  let connCadFloor: string; // finance · poll whose floor EXCEEDS its default — the served-default clamp

  beforeAll(async () => {
    pool = (await import("../db.js")).pool;
    const { seal } = await import("../secrets/index.js");

    for (const [uid, label] of [
      [TEST_USER, "lifecycle-db-test"],
      [OTHER_USER, "lifecycle-db-test-other"],
    ]) {
      await pool.query(`insert into users (id, label) values ($1, $2) on conflict (id) do nothing`, [
        uid,
        label,
      ]);
    }

    const cred = async (
      userId: string,
      provider: string,
      extra?: { secretRef?: string; refreshRef?: string; clientAppRef?: string; expiresAt?: Date },
    ): Promise<string> => {
      const r = await pool.query(
        `insert into provider_credentials
           (user_id, provider, custody, secret_ref, refresh_ref, client_app_ref, expires_at, status)
         values ($1, $2, 'static_token', $3, $4, $5, $6, 'active') returning id`,
        [
          userId,
          provider,
          extra?.secretRef ?? null,
          extra?.refreshRef ?? null,
          extra?.clientAppRef ?? null,
          extra?.expiresAt ?? null,
        ],
      );
      return r.rows[0].id as string;
    };
    const connector = async (
      userId: string,
      credentialId: string,
      sector: string,
      provider: string,
      scopes: string[] = [],
    ): Promise<string> => {
      const r = await pool.query(
        `insert into connectors (user_id, credential_id, sector, provider, status, scopes)
         values ($1, $2, $3, $4, 'active', $5) returning id`,
        [userId, credentialId, sector, provider, scopes],
      );
      return r.rows[0].id as string;
    };

    credPoll = await cred(TEST_USER, "w10a-poll");
    connPoll = await connector(TEST_USER, credPoll, "finance", "w10a-poll", ["read"]);
    credPush = await cred(TEST_USER, "w10a-push");
    connPush = await connector(TEST_USER, credPush, "home", "w10a-push");
    credFail = await cred(TEST_USER, "w10a-fail");
    connFail = await connector(TEST_USER, credFail, "finance", "w10a-fail");

    // Revoke credential: three sealed secrets + two connectors (one credential → many sectors).
    secretAccess = await seal({ userId: TEST_USER, provider: "w10a-revoke", purpose: "access" }, "access-tok");
    secretRefresh = await seal({ userId: TEST_USER, provider: "w10a-revoke", purpose: "refresh" }, "refresh-tok");
    secretClientApp = await seal({ userId: TEST_USER, provider: "w10a-revoke", purpose: "client_app" }, "client-app");
    credRevoke = await cred(TEST_USER, "w10a-revoke", {
      secretRef: secretAccess,
      refreshRef: secretRefresh,
      clientAppRef: secretClientApp,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    });
    connRevokeA = await connector(TEST_USER, credRevoke, "calendar", "w10a-revoke");
    connRevokeB = await connector(TEST_USER, credRevoke, "contacts", "w10a-revoke");

    // Disconnect (#18): a shared credential (sealed access secret) fanning out to calendar + contacts.
    secretDisc = await seal({ userId: TEST_USER, provider: "w11b-disc", purpose: "access" }, "disc-access-tok");
    credDisc = await cred(TEST_USER, "w11b-disc", { secretRef: secretDisc });
    connDiscCal = await connector(TEST_USER, credDisc, "calendar", "w11b-disc");
    connDiscCon = await connector(TEST_USER, credDisc, "contacts", "w11b-disc");

    // Cross-user negative: OTHER_USER owns a connection the test ctx must never touch.
    credOther = await cred(OTHER_USER, "w10a-poll");
    connOther = await connector(OTHER_USER, credOther, "finance", "w10a-poll");

    // Push-stream honesty (#39): a home push connector WITH start() (duck-typed stream kind).
    credStream = await cred(TEST_USER, "w10a-stream");
    connStream = await connector(TEST_USER, credStream, "home", "w10a-stream");

    // #41 push_kind: a push connector that DECLARES pushKind 'webhook' (the apple-health shape —
    // no start(), records arrive via ingest) so the served field's declared-policy path is pinned.
    credWebhook = await cred(TEST_USER, "w41-webhook");
    connWebhook = await connector(TEST_USER, credWebhook, "health", "w41-webhook");

    // Sync cadence (ADR 0025): a poll connector with the plaid/whoop policy shape (6h default,
    // 900s declared floor) so the override/floor/reset round-trips run against real policy data.
    credCad = await cred(TEST_USER, "cad-poll");
    connCad = await connector(TEST_USER, credCad, "finance", "cad-poll");

    // A floor ABOVE the default (a misdeclared/asymmetric policy): default_interval_sec must be
    // served FLOOR-CLAMPED so the Console's "Default (…)" label can't understate the real cadence.
    credCadFloor = await cred(TEST_USER, "cad-floor-over");
    connCadFloor = await connector(TEST_USER, credCadFloor, "finance", "cad-floor-over");

    // Domain rows: 2 live + 1 tombstoned finance_transactions on connPoll (detail counts);
    // one calendar + one contact on the revoke connectors (KEPT after revoke).
    const txn = async (connectionId: string, userId: string, sid: string): Promise<string> => {
      const r = await pool.query(
        `insert into finance_transactions
           (connection_id, user_id, source_object_id, posted_at, amount, currency, description)
         values ($1, $2, $3, '2026-06-01T12:00:00Z', '-10.00', 'USD', 'lifecycle seed') returning id`,
        [connectionId, userId, sid],
      );
      return r.rows[0].id as string;
    };
    await txn(connPoll, TEST_USER, "lc-1");
    await txn(connPoll, TEST_USER, "lc-2");
    const tomb = await txn(connPoll, TEST_USER, "lc-gone");
    await pool.query(`update finance_transactions set deleted_at = now() where id = $1`, [tomb]);

    await pool.query(
      `insert into calendar_events (connection_id, user_id, source_object_id, summary)
       values ($1, $2, 'cal-1', 'Kept event')`,
      [connRevokeA, TEST_USER],
    );
    await pool.query(
      `insert into contacts (connection_id, user_id, source_object_id, display_name)
       values ($1, $2, 'con-1', 'Kept contact')`,
      [connRevokeB, TEST_USER],
    );

    // Disconnect (#18) domain rows: one calendar event + one contact on the shared-credential pair.
    await pool.query(
      `insert into calendar_events (connection_id, user_id, source_object_id, summary)
       values ($1, $2, 'disc-cal-1', 'Disc event')`,
      [connDiscCal, TEST_USER],
    );
    await pool.query(
      `insert into contacts (connection_id, user_id, source_object_id, display_name)
       values ($1, $2, 'disc-con-1', 'Disc contact')`,
      [connDiscCon, TEST_USER],
    );

    // Register the fakes (real registry; sync-now + markError run the REAL runner).
    registerConnector(
      makeConnector({
        provider: "w10a-poll",
        sector: "finance",
        mode: "poll",
        intervalSec: 300,
        record: { source_object_id: "lc-sync", amount: "-1.00", currency: "USD" },
      }),
    );
    registerConnector(makeConnector({ provider: "w10a-push", sector: "home", mode: "push", hasStop: true }));
    registerConnector(
      makeConnector({ provider: "w10a-stream", sector: "home", mode: "push", hasStop: true, hasStart: true }),
    );
    registerConnector(
      makeConnector({ provider: "w41-webhook", sector: "health", mode: "push", pushKind: "webhook" }),
    );
    registerConnector(
      makeConnector({
        provider: "w10a-fail",
        sector: "finance",
        mode: "poll",
        throwMessage:
          "sync failed: GET https://user:sup3rsecret@bridge.example.com/accounts?access_token=abcd1234TOKEN failed",
      }),
    );
    registerConnector(
      makeConnector({ provider: "cad-poll", sector: "finance", mode: "poll", intervalSec: 21600, minIntervalSec: 900 }),
    );
    registerConnector(
      makeConnector({ provider: "cad-floor-over", sector: "finance", mode: "poll", intervalSec: 300, minIntervalSec: 7200 }),
    );
  });

  afterAll(async () => {
    // audit_log FK-references users, so drop the flushed audit rows (the #39 sync-now audit test
    // drains the queue into the table) BEFORE deleting the users.
    await pool.query(`delete from audit_log where user_id = any($1)`, [[TEST_USER, OTHER_USER]]);
    // FK cascade: credentials → connectors → domain rows. (Revoke nulls its own refs already.)
    await pool.query(`delete from provider_credentials where user_id = any($1)`, [[TEST_USER, OTHER_USER]]);
    await pool.query(`delete from secrets where user_id = any($1)`, [[TEST_USER, OTHER_USER]]);
    await pool.query(`delete from users where id = any($1)`, [[TEST_USER, OTHER_USER]]);
    await pool.end();
  });

  const statusOf = async (id: string): Promise<string | null> => {
    const r = await pool.query(`select status from connectors where id = $1`, [id]);
    return (r.rows[0]?.status ?? null) as string | null;
  };

  describe("pause", () => {
    it("flips active → paused and returns {status:'paused'}", async () => {
      const out = await pauseConnection(ctx, connPoll);
      expect(out).toEqual({ connectionId: connPoll, status: "paused" });
      expect(await statusOf(connPoll)).toBe("paused");
    });

    it("is an idempotent no-op when already paused", async () => {
      const out = await pauseConnection(ctx, connPoll);
      expect(out).toEqual({ connectionId: connPoll, status: "paused" });
      expect(await statusOf(connPoll)).toBe("paused");
    });

    it("resume restores paused → active", async () => {
      const out = await resumeConnection(ctx, connPoll);
      expect(out).toEqual({ connectionId: connPoll, status: "active" });
      expect(await statusOf(connPoll)).toBe("active");
    });

    it("calls stop() for a push connector", async () => {
      stopSpy.mockClear();
      await pauseConnection(ctx, connPush);
      expect(stopSpy).toHaveBeenCalledWith(connPush);
      expect(await statusOf(connPush)).toBe("paused");
      await resumeConnection(ctx, connPush); // restore for later
    });

    it("resume only from paused — resuming an active connection → 409", async () => {
      await expect(resumeConnection(ctx, connPoll)).rejects.toBeInstanceOf(ConflictError);
    });

    it("unknown id → NotFoundError; a foreign user's id → NotFoundError (no cross-user touch)", async () => {
      await expect(pauseConnection(ctx, RANDOM_UUID)).rejects.toBeInstanceOf(NotFoundError);
      await expect(pauseConnection(ctx, connOther)).rejects.toBeInstanceOf(NotFoundError);
      await expect(pauseConnection(ctx, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
      expect(await statusOf(connOther)).toBe("active"); // untouched
    });

    it("resume of an unknown id → NotFoundError", async () => {
      await expect(resumeConnection(ctx, RANDOM_UUID)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("markError + last_error (real runner)", () => {
    it("a failing sync records a MASKED, secret-free last_error and status='error'", async () => {
      const res = await syncConnection(connFail);
      expect(res.ok).toBe(false);
      const r = await pool.query(
        `select status, last_error, last_error_at from connectors where id = $1`,
        [connFail],
      );
      const row = r.rows[0];
      expect(row.status).toBe("error");
      expect(row.last_error).toBeTruthy();
      expect(row.last_error_at).not.toBeNull();
      // No secret material leaks into the durable column.
      expect(row.last_error).not.toContain("sup3rsecret");
      expect(row.last_error).not.toContain("abcd1234TOKEN");
      expect(row.last_error).toContain("//***@");
    });

    it("a later successful sync CLEARS last_error and flips back to active", async () => {
      // connFail is in 'error'; re-point it at a connector that succeeds, then sync.
      registerConnector(
        makeConnector({
          provider: "w10a-fail",
          sector: "finance",
          mode: "poll",
          record: { source_object_id: "lc-recover", amount: "-2.00", currency: "USD" },
        }),
      );
      const res = await syncConnection(connFail);
      expect(res.ok).toBe(true);
      const r = await pool.query(
        `select status, last_error, last_error_at from connectors where id = $1`,
        [connFail],
      );
      expect(r.rows[0].status).toBe("active");
      expect(r.rows[0].last_error).toBeNull();
      expect(r.rows[0].last_error_at).toBeNull();
    });
  });

  describe("sync-now", () => {
    it("poll connection runs syncConnection and returns its result", async () => {
      const out = await syncNowConnection(ctx, connPoll);
      expect(out).toMatchObject({
        connectionId: connPoll,
        provider: "w10a-poll",
        mode: "poll",
        ran: true,
        ok: true,
      });
      expect(out.upserted).toBeGreaterThanOrEqual(1);
      // last_synced_at advanced (the real runner wrote it back).
      const r = await pool.query(`select last_synced_at from connectors where id = $1`, [connPoll]);
      expect(r.rows[0].last_synced_at).not.toBeNull();
    });

    it("push connection is a no-op (ran:false) — no manual pull", async () => {
      const out = await syncNowConnection(ctx, connPush);
      expect(out).toMatchObject({ connectionId: connPush, mode: "push", ran: false });
      expect(out.note).toBeTruthy();
    });

    it("unknown id → NotFoundError; foreign id → NotFoundError", async () => {
      await expect(syncNowConnection(ctx, RANDOM_UUID)).rejects.toBeInstanceOf(NotFoundError);
      await expect(syncNowConnection(ctx, connOther)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("enriched status", () => {
    it("listConnectorsEnriched carries the new fields", async () => {
      const list = await listConnectorsEnriched(ctx);
      const poll = list.find((c) => c.connectionId === connPoll);
      expect(poll).toBeDefined();
      expect(poll!.policy_mode).toBe("poll");
      expect(poll!.scopes).toEqual(["read"]);
      expect(poll!.credential.status).toBe("active");
      expect(poll!.next_sync_at).not.toBeNull(); // last_synced_at + 300s (poll, synced above)
      expect("last_error" in poll!).toBe(true);
      expect("webhook_secret_set_at" in poll!).toBe(true);

      const push = list.find((c) => c.connectionId === connPush);
      expect(push!.policy_mode).toBe("push");
      expect(push!.next_sync_at).toBeNull(); // push has no cadence

      // The server-derived freshness tuple (ADR 0023) rides on every row: connPoll synced moments
      // ago within its 300s cadence → ok; connPush never heard + no cached rows → never_synced.
      expect(poll!.freshness.state).toBe("ok");
      expect(poll!.freshness.next_expected_at).toBe(poll!.next_sync_at);
      expect(push!.freshness.state).toBe("never_synced");

      // #41 push_kind rides the list rows: poll → null; a hook-less, undeclared push fake → null;
      // the duck-typed stream fake → 'stream'; a DECLARED-webhook fake → 'webhook'.
      expect(poll!.push_kind).toBeNull();
      expect(push!.push_kind).toBeNull();
      const stream = list.find((c) => c.connectionId === connStream);
      expect(stream!.push_kind).toBe("stream");
      const webhook = list.find((c) => c.connectionId === connWebhook);
      expect(webhook!.push_kind).toBe("webhook");

      // user-scoped: OTHER_USER's connection never appears.
      expect(list.some((c) => c.connectionId === connOther)).toBe(false);
    });

    it("getConnectionDetail returns per-table live counts (tombstones excluded)", async () => {
      const detail = await getConnectionDetail(ctx, connPoll);
      expect(detail.connectionId).toBe(connPoll);
      // 2 live + 1 tombstoned seeded, plus the 1 sync-now upsert above = 3 live; tombstone excluded.
      expect(detail.counts["finance.transaction"]).toBe(3);
      expect(detail.counts["finance.account"]).toBe(0);
      // #41: detail rows carry push_kind too (same toStatus derivation as the list).
      expect(detail.push_kind).toBeNull();
      expect((await getConnectionDetail(ctx, connWebhook)).push_kind).toBe("webhook");
    });

    it("detail for an unknown/foreign id → NotFoundError", async () => {
      await expect(getConnectionDetail(ctx, RANDOM_UUID)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getConnectionDetail(ctx, connOther)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("revoke", () => {
    it("revokes the credential + all its connectors, deletes the secrets, KEEPS rows", async () => {
      const before = await pool.query(`select count(*)::int as n from secrets where ref = any($1)`, [
        [secretAccess, secretRefresh, secretClientApp],
      ]);
      expect(before.rows[0].n).toBe(3);

      const out = await revokeCredential(ctx, credRevoke);
      expect(out.credentialId).toBe(credRevoke);
      expect(out.provider).toBe("w10a-revoke");
      expect(out.secretsDeleted).toBe(3);
      expect(out.revokedConnectors.sort()).toEqual([connRevokeA, connRevokeB].sort());

      // Credential row KEPT, status revoked, refs nulled.
      const cred = await pool.query(
        `select status, secret_ref, refresh_ref, client_app_ref from provider_credentials where id = $1`,
        [credRevoke],
      );
      expect(cred.rows[0].status).toBe("revoked");
      expect(cred.rows[0].secret_ref).toBeNull();
      expect(cred.rows[0].refresh_ref).toBeNull();
      expect(cred.rows[0].client_app_ref).toBeNull();

      // Both connectors revoked.
      expect(await statusOf(connRevokeA)).toBe("revoked");
      expect(await statusOf(connRevokeB)).toBe("revoked");

      // Secrets gone.
      const after = await pool.query(`select count(*)::int as n from secrets where ref = any($1)`, [
        [secretAccess, secretRefresh, secretClientApp],
      ]);
      expect(after.rows[0].n).toBe(0);

      // Domain rows KEPT (orphaned read-only cache).
      const cal = await pool.query(
        `select count(*)::int as n from calendar_events where connection_id = $1`,
        [connRevokeA],
      );
      const con = await pool.query(`select count(*)::int as n from contacts where connection_id = $1`, [
        connRevokeB,
      ]);
      expect(cal.rows[0].n).toBe(1);
      expect(con.rows[0].n).toBe(1);
    });

    it("a revoked connection can no longer be resumed (409) or synced (409)", async () => {
      await expect(resumeConnection(ctx, connRevokeA)).rejects.toBeInstanceOf(ConflictError);
      await expect(syncNowConnection(ctx, connRevokeA)).rejects.toBeInstanceOf(ConflictError);
      await expect(pauseConnection(ctx, connRevokeA)).rejects.toBeInstanceOf(ConflictError);
    });

    it("unknown credential → NotFoundError; a foreign user's credential → NotFoundError", async () => {
      await expect(revokeCredential(ctx, RANDOM_UUID)).rejects.toBeInstanceOf(NotFoundError);
      await expect(revokeCredential(ctx, credOther)).rejects.toBeInstanceOf(NotFoundError);
      // The foreign credential is untouched.
      const r = await pool.query(`select status from provider_credentials where id = $1`, [credOther]);
      expect(r.rows[0].status).toBe("active");
    });
  });

  describe("disconnect (#18)", () => {
    const countRows = async (table: string, connectionId: string): Promise<number> => {
      const r = await pool.query(`select count(*)::int as n from "${table}" where connection_id = $1`, [
        connectionId,
      ]);
      return r.rows[0].n as number;
    };
    const credExists = async (id: string): Promise<boolean> => {
      const r = await pool.query(`select 1 from provider_credentials where id = $1`, [id]);
      return r.rows.length > 0;
    };
    const secretExists = async (ref: string): Promise<boolean> => {
      const r = await pool.query(`select 1 from secrets where ref = $1`, [ref]);
      return r.rows.length > 0;
    };

    it("rejects a missing/invalid confirm token (fat-finger guard) — nothing deleted", async () => {
      await expect(disconnectConnection(ctx, connDiscCal, {})).rejects.toBeInstanceOf(QueryValidationError);
      await expect(
        disconnectConnection(ctx, connDiscCal, { confirmToken: "wrong" }),
      ).rejects.toBeInstanceOf(QueryValidationError);
      // Untouched: the connector + its row still exist.
      expect(await statusOf(connDiscCal)).toBe("active");
      expect(await countRows("calendar_events", connDiscCal)).toBe(1);
    });

    it("unknown id → NotFoundError; a foreign user's id → NotFoundError (no cross-user delete)", async () => {
      await expect(
        disconnectConnection(ctx, RANDOM_UUID, { confirmToken: RANDOM_UUID }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        disconnectConnection(ctx, connOther, { confirmToken: connOther }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        disconnectConnection(ctx, "not-a-uuid", { confirmToken: "not-a-uuid" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // The foreign connection is untouched.
      expect(await statusOf(connOther)).toBe("active");
    });

    it("shared credential: disconnecting ONE connector deletes only it + its rows; keeps the credential + sibling (credentialRemoved=false)", async () => {
      const out = await disconnectConnection(ctx, connDiscCal, { confirmToken: connDiscCal });
      expect(out.connectionId).toBe(connDiscCal);
      expect(out.credentialRemoved).toBe(false);
      expect(out.deleted["calendar_events"]).toBe(1);

      // The connector row + its domain rows are gone.
      expect(await statusOf(connDiscCal)).toBeNull();
      expect(await countRows("calendar_events", connDiscCal)).toBe(0);

      // The sibling connector, the shared credential, and its vault secret are ALL kept.
      expect(await statusOf(connDiscCon)).toBe("active");
      expect(await countRows("contacts", connDiscCon)).toBe(1);
      expect(await credExists(credDisc)).toBe(true);
      expect(await secretExists(secretDisc)).toBe(true);
    });

    it("disconnecting the LAST connector removes the credential + its vault secret (credentialRemoved=true)", async () => {
      const out = await disconnectConnection(ctx, connDiscCon, { confirmToken: connDiscCon });
      expect(out.connectionId).toBe(connDiscCon);
      expect(out.credentialRemoved).toBe(true);
      expect(out.deleted["contacts"]).toBe(1);

      // The last connector + its rows are gone, AND the now-orphaned credential + secret are removed.
      expect(await statusOf(connDiscCon)).toBeNull();
      expect(await countRows("contacts", connDiscCon)).toBe(0);
      expect(await credExists(credDisc)).toBe(false);
      expect(await secretExists(secretDisc)).toBe(false);
    });
  });

  describe("sync window (wave 12a)", () => {
    it("setSyncWindow persists the value; status (list + detail) surfaces sync_window_days", async () => {
      await setSyncWindow(ctx, connPoll, 365);
      const r = await pool.query(`select sync_window_days from connectors where id = $1`, [connPoll]);
      expect(r.rows[0].sync_window_days).toBe(365);

      const list = await listConnectorsEnriched(ctx);
      expect(list.find((c) => c.connectionId === connPoll)!.sync_window_days).toBe(365);

      const detail = await getConnectionDetail(ctx, connPoll);
      expect(detail.sync_window_days).toBe(365);
    });

    it("a window change CLEARS the delta cursor (next sync re-issues a fresh windowed delta)", async () => {
      // Seed a non-null cursor (a stored Graph deltaLink encoding the OLD narrow filter).
      await pool.query(`update connectors set cursor = $2 where id = $1`, [connPoll, "stale-deltalink"]);

      const out = await setSyncWindow(ctx, connPoll, 365);
      expect(out.sync_window_days).toBe(365);

      // Same call updates the window AND nulls the cursor — so the next sync grows/shrinks from scratch.
      const r = await pool.query(`select sync_window_days, cursor from connectors where id = $1`, [connPoll]);
      expect(r.rows[0].sync_window_days).toBe(365);
      expect(r.rows[0].cursor).toBeNull();
    });

    it("null sets all-history (clears the window)", async () => {
      await setSyncWindow(ctx, connPoll, null);
      const detail = await getConnectionDetail(ctx, connPoll);
      expect(detail.sync_window_days).toBeNull();
    });

    it("out-of-range or non-integer → QueryValidationError (400), no write", async () => {
      await setSyncWindow(ctx, connPoll, 90); // a known-good baseline
      for (const bad of [6, 36501, 0, -1, 3.5]) {
        await expect(setSyncWindow(ctx, connPoll, bad)).rejects.toBeInstanceOf(QueryValidationError);
      }
      // the baseline is intact — a rejected call writes nothing.
      const r = await pool.query(`select sync_window_days from connectors where id = $1`, [connPoll]);
      expect(r.rows[0].sync_window_days).toBe(90);
    });

    it("cached_count equals the sum of the per-table live counts (and is a number)", async () => {
      const detail = await getConnectionDetail(ctx, connPoll);
      const sum = Object.values(detail.counts).reduce((a, b) => a + b, 0);
      expect(typeof detail.cached_count).toBe("number");
      expect(detail.cached_count).toBe(sum);
    });

    it("unknown / foreign id → NotFoundError (no cross-user write)", async () => {
      await expect(setSyncWindow(ctx, RANDOM_UUID, 180)).rejects.toBeInstanceOf(NotFoundError);
      await expect(setSyncWindow(ctx, connOther, 180)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("push-stream honesty (#39/#40)", () => {
    it("a retrying stream → freshness.state='unreachable' with error.since via the connectors API; status stays 'active'", async () => {
      await pool.query(
        `update connectors
            set stream_state = 'retrying', stream_error = 'socket closed — reconnecting',
                stream_changed_at = now() - interval '5 minutes'
          where id = $1`,
        [connStream],
      );
      const list = await listConnectorsEnriched(ctx);
      const s = list.find((c) => c.connectionId === connStream)!;
      expect(s.freshness.state).toBe("unreachable");
      expect(s.freshness.stream_state).toBe("retrying");
      expect(s.freshness.error?.message).toBe("socket closed — reconnecting");
      expect(s.freshness.error?.since).not.toBeNull();
      // Stream columns never touch status (the pause/revoke resurrection guard holds).
      expect(s.status).toBe("active");
    });

    it("sync-now on a dead stream → ran:false ok:false + stream fields + masked error, and audits 'error'", async () => {
      const { startAuditWriter } = await import("../audit/index.js");
      // Big interval/batch so we flush deterministically via stop() (the export.db.test pattern).
      const stop = startAuditWriter({ pool, intervalMs: 1_000_000, batchSize: 1_000_000 });
      const out = await syncNowConnection(ctx, connStream);
      await stop();

      expect(out).toMatchObject({
        connectionId: connStream,
        provider: "w10a-stream",
        mode: "push",
        ran: false,
        ok: false,
        stream_state: "retrying",
      });
      expect(out.error).toContain("socket closed");
      expect(out.stream_since).toBeTruthy();
      expect(out.note).toContain("reconnect");

      const res = await pool.query(
        `select outcome, decision from audit_log
          where user_id = $1 and tool = 'sync_now' and args->>'connectionId' = $2
          order by id desc limit 1`,
        [TEST_USER, connStream],
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].outcome).toBe("error");
      expect(res.rows[0].decision).toBe("allow");
    });

    it("a connected stream → ran:false ok:true + stream fields (no error), freshness 'ok'", async () => {
      await pool.query(
        `update connectors set stream_state = 'connected', stream_error = null where id = $1`,
        [connStream],
      );
      const out = await syncNowConnection(ctx, connStream);
      expect(out).toMatchObject({
        connectionId: connStream,
        mode: "push",
        ran: false,
        ok: true,
        stream_state: "connected",
      });
      expect(out.error).toBeUndefined();
      expect(out.note).toBeTruthy();

      const list = await listConnectorsEnriched(ctx);
      expect(list.find((c) => c.connectionId === connStream)!.freshness.state).toBe("ok");
    });

    it("a stream-column-less push connection (webhook-like) keeps the ok no-op answer", async () => {
      const out = await syncNowConnection(ctx, connPush);
      expect(out).toMatchObject({ connectionId: connPush, mode: "push", ran: false, ok: true });
      expect(out.stream_state).toBeUndefined();
      expect(out.error).toBeUndefined();
    });
  });

  describe("sync cadence (ADR 0025)", () => {
    it("set → stored surfaces verbatim; next_sync_at + freshness move to the EFFECTIVE value; floors served", async () => {
      const lastSynced = new Date(Date.now() - 5 * 60_000); // synced 5 min ago
      await pool.query(`update connectors set last_synced_at = $2 where id = $1`, [connCad, lastSynced]);

      await setSyncInterval(ctx, connCad, 3600);

      const detail = await getConnectionDetail(ctx, connCad);
      expect(detail.sync_interval_sec).toBe(3600); // stored, verbatim
      expect(detail.min_interval_sec).toBe(900); // the connector-declared floor (Console picker input)
      expect(detail.default_interval_sec).toBe(21600); // floor ≤ default → the clamp is identity here
      expect(detail.next_sync_at).toBe(new Date(lastSynced.getTime() + 3600_000).toISOString());
      expect(detail.freshness.next_expected_at).toBe(detail.next_sync_at); // one source of truth

      const list = await listConnectorsEnriched(ctx);
      expect(list.find((c) => c.connectionId === connCad)!.sync_interval_sec).toBe(3600);
    });

    it("default_interval_sec is served FLOOR-CLAMPED (the effective default) — the Console label can never understate", async () => {
      // cad-floor-over declares default 300 / floor 7200: the scheduler actually runs 7200 with no
      // override, so serving the raw 300 would let a "Default (5m)" label understate reality.
      const d = await getConnectionDetail(ctx, connCadFloor);
      expect(d.default_interval_sec).toBe(7200);
      expect(d.min_interval_sec).toBe(7200);
      expect(d.sync_interval_sec).toBeNull(); // the stored override stays verbatim (none set)
    });

    it("null resets to the connector default — next_sync_at moves back to +default", async () => {
      const r = await pool.query(`select last_synced_at from connectors where id = $1`, [connCad]);
      const lastSynced = r.rows[0].last_synced_at as Date;

      await setSyncInterval(ctx, connCad, null);

      const detail = await getConnectionDetail(ctx, connCad);
      expect(detail.sync_interval_sec).toBeNull();
      expect(detail.next_sync_at).toBe(new Date(lastSynced.getTime() + 21600_000).toISOString());
    });

    it("below-floor explicit input → typed 400 NAMING interval_sec and the floor, nothing written (never a silent clamp)", async () => {
      await expect(setSyncInterval(ctx, connCad, 300)).rejects.toBeInstanceOf(QueryValidationError);
      await expect(setSyncInterval(ctx, connCad, 300)).rejects.toThrow(/interval_sec/);
      await expect(setSyncInterval(ctx, connCad, 300)).rejects.toThrow(/900/);
      const r = await pool.query(`select sync_interval_sec from connectors where id = $1`, [connCad]);
      expect(r.rows[0].sync_interval_sec).toBeNull(); // the reset from the previous test is intact
    });

    it("above 14 days or non-integer → typed 400 (the bound must stay far below Node's 2^31−1 ms timer overflow)", async () => {
      expect(MAX_SYNC_INTERVAL_SEC).toBe(1_209_600); // 14 days — pinned: raising it toward ~24.8d re-opens the overflow
      await expect(setSyncInterval(ctx, connCad, MAX_SYNC_INTERVAL_SEC + 1)).rejects.toBeInstanceOf(
        QueryValidationError,
      );
      await expect(setSyncInterval(ctx, connCad, MAX_SYNC_INTERVAL_SEC + 1)).rejects.toThrow(/14 days/);
      await expect(setSyncInterval(ctx, connCad, 950.5)).rejects.toBeInstanceOf(QueryValidationError);
      expect((await getConnectionDetail(ctx, connCad)).sync_interval_sec).toBeNull();
    });

    it("the 14-day bound itself is accepted (inclusive)", async () => {
      await setSyncInterval(ctx, connCad, MAX_SYNC_INTERVAL_SEC);
      expect((await getConnectionDetail(ctx, connCad)).sync_interval_sec).toBe(MAX_SYNC_INTERVAL_SEC);
      await setSyncInterval(ctx, connCad, null); // restore
    });

    it("non-poll connection → ConflictError (cadence is not ours to control there)", async () => {
      await expect(setSyncInterval(ctx, connPush, 3600)).rejects.toBeInstanceOf(ConflictError);
      // A push connector serves null cadence-policy fields (Child B renders no picker from these).
      const push = (await listConnectorsEnriched(ctx)).find((c) => c.connectionId === connPush)!;
      expect(push.sync_interval_sec).toBeNull();
      expect(push.min_interval_sec).toBeNull();
    });

    it("unknown / foreign / malformed id → NotFoundError (no cross-user write)", async () => {
      await expect(setSyncInterval(ctx, RANDOM_UUID, 3600)).rejects.toBeInstanceOf(NotFoundError);
      await expect(setSyncInterval(ctx, connOther, 3600)).rejects.toBeInstanceOf(NotFoundError);
      await expect(setSyncInterval(ctx, "not-a-uuid", 3600)).rejects.toBeInstanceOf(NotFoundError);
      const r = await pool.query(`select sync_interval_sec from connectors where id = $1`, [connOther]);
      expect(r.rows[0].sync_interval_sec).toBeNull(); // the foreign row is untouched
    });

    it("a successful set writes ONE set_sync_interval audit line (outcome ok, args carry the value)", async () => {
      const { startAuditWriter } = await import("../audit/index.js");
      const stop = startAuditWriter({ pool, intervalMs: 1_000_000, batchSize: 1_000_000 });
      await setSyncInterval(ctx, connCad, 7200);
      await stop();

      const res = await pool.query(
        `select outcome, decision, args from audit_log
          where user_id = $1 and tool = 'set_sync_interval' and args->>'connectionId' = $2
          order by id desc limit 1`,
        [TEST_USER, connCad],
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].outcome).toBe("ok");
      expect(res.rows[0].decision).toBe("allow");
      expect(res.rows[0].args.intervalSec).toBe(7200);
    });

    it("freshness threading: a 900s override makes a 40-min-old row 'stale'; the 21600s default reads 'ok' (#41 item 5, toStatus call site)", async () => {
      await pool.query(
        // 40 minutes, not 25: the near grace for a 900s cadence is max(1350s, 1500s) = EXACTLY 25 min, so the old fixture passed only by the milliseconds between the write and the derivation — and here the two clocks are different processes. This cell tests THREADING, not tuning; give it room.
      `update connectors set last_synced_at = now() - interval '40 minutes' where id = $1`,
        [connCad],
      );

      await setSyncInterval(ctx, connCad, 900);
      let s = (await listConnectorsEnriched(ctx)).find((c) => c.connectionId === connCad)!;
      expect(s.freshness.state).toBe("stale"); // 25 min > 1.5 × 900s — the override drives staleness

      await setSyncInterval(ctx, connCad, null);
      s = (await listConnectorsEnriched(ctx)).find((c) => c.connectionId === connCad)!;
      expect(s.freshness.state).toBe("ok"); // 25 min ≪ 1.5 × 21600s — the default recalibrates it
    });
  });
});

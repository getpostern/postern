// DB round-trip — gated on DATABASE_URL so CI stays green without Postgres. Proves the engine
// end to end against a real domain table: a registered fake connector yielding 3 records lands
// 3 rows, advances connectors.cursor to the last record's cursor, stamps last_synced_at, and is
// idempotent (a second run with the same source_object_ids keeps exactly 3 rows). A second suite
// proves the tombstone path (ADR 0004): stamp, no-op re-delivery, no ghost rows, resurrection.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Connector, RawRecord, SyncContext, SyncPolicy } from "../connectors/types.js";

const HAS_DB = !!process.env.DATABASE_URL;
const SEED_USER = "00000000-0000-0000-0000-000000000001";

// Both suites share the module-level pool — close it ONCE, after every describe's afterAll ran.
afterAll(async () => {
  if (!HAS_DB) return;
  const { pool } = await import("../db.js");
  await pool.end();
});

const POLL: SyncPolicy = { mode: "poll", defaultIntervalSec: 3600, freshnessToleranceSec: 3600, supportsIncremental: true };

/** Fake finance connector: yields N transactions, each carrying an incremental cursor. */
function fakeFinanceConnector(records: RawRecord[]): Connector {
  return {
    provider: "fake_finance_db",
    sector: "finance",
    objectType: "transaction",
    policy: POLL,
    actions: [],
    async *sync(_ctx: SyncContext): AsyncIterable<RawRecord> {
      for (const r of records) yield r;
    },
    normalize(raw: RawRecord): Record<string, unknown> {
      const r = raw.raw as { amount: number; description: string };
      return { source_object_id: raw.externalId, amount: r.amount, description: r.description };
    },
    strongKeys() {
      return {};
    },
    async execute() {
      return { ok: true };
    },
  };
}

describe.skipIf(!HAS_DB)("sync-runner DB round-trip", () => {
  let connectionId: string;
  let credentialId: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    // One credential (no secret_ref -> ctx.secret stays null, vault untouched) + one connector row.
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody)
       values ($1, 'fake_finance_db', 'static_token') returning id`,
      [SEED_USER],
    );
    credentialId = cred.rows[0].id as string;
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', 'fake_finance_db', 'active') returning id`,
      [SEED_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade from connectors -> finance_transactions and credential -> connectors handles cleanup.
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
  });

  it("upserts 3 rows, advances the cursor to the 3rd record, and is idempotent on re-run", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("./index.js");

    const records: RawRecord[] = [
      { externalId: "ftx-1", raw: { amount: -10, description: "coffee" }, cursor: "cur-1" },
      { externalId: "ftx-2", raw: { amount: -20, description: "lunch" }, cursor: "cur-2" },
      { externalId: "ftx-3", raw: { amount: 100, description: "refund" }, cursor: "cur-3" },
    ];
    registerConnector(fakeFinanceConnector(records));

    // First run.
    const res1 = await syncConnection(connectionId);
    expect(res1.ok).toBe(true);
    expect(res1.upserted).toBe(3);
    expect(res1.newCursor).toBe("cur-3");

    const count1 = await pool.query(
      `select count(*)::int as n from finance_transactions where connection_id = $1`,
      [connectionId],
    );
    expect(count1.rows[0].n).toBe(3);

    const conn1 = await pool.query(
      `select cursor, last_synced_at, status from connectors where id = $1`,
      [connectionId],
    );
    expect(conn1.rows[0].cursor).toBe("cur-3");
    expect(conn1.rows[0].last_synced_at).not.toBeNull();
    expect(conn1.rows[0].status).toBe("active");

    // A normalized column landed; raw is stored; no derived data.
    const sample = await pool.query(
      `select amount, description, raw from finance_transactions where connection_id = $1 and source_object_id = 'ftx-1'`,
      [connectionId],
    );
    expect(Number(sample.rows[0].amount)).toBe(-10);
    expect(sample.rows[0].description).toBe("coffee");
    expect(sample.rows[0].raw).toEqual({ amount: -10, description: "coffee" });

    // Second run with the same source_object_ids -> still exactly 3 rows (idempotent upsert).
    const res2 = await syncConnection(connectionId);
    expect(res2.ok).toBe(true);
    expect(res2.upserted).toBe(3);
    expect(res2.deleted).toBe(0); // live-only stream: nothing tombstoned

    const count2 = await pool.query(
      `select count(*)::int as n from finance_transactions where connection_id = $1`,
      [connectionId],
    );
    expect(count2.rows[0].n).toBe(3);
  });
});

describe.skipIf(!HAS_DB)("sync-runner tombstones (DB round-trip)", () => {
  let connectionId: string;
  let credentialId: string;
  // The connector iterates this array at sync() time, so each phase swaps its contents in place.
  const records: RawRecord[] = [];

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { registerConnector } = await import("./index.js");
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody)
       values ($1, 'fake_finance_tomb', 'static_token') returning id`,
      [SEED_USER],
    );
    credentialId = cred.rows[0].id as string;
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', 'fake_finance_tomb', 'active') returning id`,
      [SEED_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;
    registerConnector({ ...fakeFinanceConnector(records), provider: "fake_finance_tomb" });
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
  });

  it("tombstones, preserves the row + timestamp, never ghosts, and resurrects on a live re-sighting", async () => {
    const { pool } = await import("../db.js");
    const { syncConnection } = await import("./index.js");

    // Phase 1 — seed two LIVE rows; both land with deleted_at null.
    records.splice(0, records.length,
      { externalId: "tomb-1", raw: { amount: -10, description: "coffee" }, cursor: "tcur-1" },
      { externalId: "tomb-2", raw: { amount: -20, description: "lunch" }, cursor: "tcur-2" },
    );
    const seed = await syncConnection(connectionId);
    expect(seed.ok).toBe(true);
    expect(seed.upserted).toBe(2);
    expect(seed.deleted).toBe(0);
    const live = await pool.query(
      `select count(*)::int as n from finance_transactions where connection_id = $1 and deleted_at is null`,
      [connectionId],
    );
    expect(live.rows[0].n).toBe(2);

    const before = await pool.query(
      `select amount, description, raw from finance_transactions where connection_id = $1 and source_object_id = 'tomb-1'`,
      [connectionId],
    );

    // Phase 2 — a deletion record stamps deleted_at; normalized columns AND raw are untouched;
    // the cursor advances even though ONLY the deletion record carried it.
    records.splice(0, records.length, { externalId: "tomb-1", raw: { transaction_id: "tomb-1" }, deleted: true, cursor: "tcur-3" });
    const del = await syncConnection(connectionId);
    expect(del.ok).toBe(true);
    expect(del.upserted).toBe(0);
    expect(del.deleted).toBe(1);
    expect(del.newCursor).toBe("tcur-3");

    const after = await pool.query(
      `select amount, description, raw, deleted_at from finance_transactions where connection_id = $1 and source_object_id = 'tomb-1'`,
      [connectionId],
    );
    expect(after.rows[0].deleted_at).not.toBeNull();
    expect(after.rows[0].amount).toEqual(before.rows[0].amount); // byte-for-byte: the tombstone
    expect(after.rows[0].description).toEqual(before.rows[0].description); // is a stamp, not a write
    expect(after.rows[0].raw).toEqual(before.rows[0].raw);
    const cur = await pool.query(`select cursor from connectors where id = $1`, [connectionId]);
    expect(cur.rows[0].cursor).toBe("tcur-3");

    // The sibling live row is untouched.
    const sibling = await pool.query(
      `select deleted_at from finance_transactions where connection_id = $1 and source_object_id = 'tomb-2'`,
      [connectionId],
    );
    expect(sibling.rows[0].deleted_at).toBeNull();

    // Phase 3 — re-delivered deletion: no-op (not counted), ORIGINAL timestamp preserved.
    const stamped = after.rows[0].deleted_at as Date;
    const redel = await syncConnection(connectionId);
    expect(redel.ok).toBe(true);
    expect(redel.deleted).toBe(0);
    const still = await pool.query(
      `select deleted_at from finance_transactions where connection_id = $1 and source_object_id = 'tomb-1'`,
      [connectionId],
    );
    expect((still.rows[0].deleted_at as Date).getTime()).toBe(stamped.getTime());

    // Phase 4 — a deletion record for a NEVER-synced id: no ghost row, not counted.
    records.splice(0, records.length, { externalId: "tomb-ghost", raw: {}, deleted: true });
    const ghost = await syncConnection(connectionId);
    expect(ghost.ok).toBe(true);
    expect(ghost.deleted).toBe(0);
    const ghostCount = await pool.query(
      `select count(*)::int as n from finance_transactions where connection_id = $1 and source_object_id = 'tomb-ghost'`,
      [connectionId],
    );
    expect(ghostCount.rows[0].n).toBe(0);

    // Phase 5 — the source re-presents tomb-1 LIVE: the upsert clears deleted_at (resurrection).
    records.splice(0, records.length, { externalId: "tomb-1", raw: { amount: -10, description: "coffee" }, cursor: "tcur-4" });
    const back = await syncConnection(connectionId);
    expect(back.ok).toBe(true);
    expect(back.upserted).toBe(1);
    const revived = await pool.query(
      `select deleted_at from finance_transactions where connection_id = $1 and source_object_id = 'tomb-1'`,
      [connectionId],
    );
    expect(revived.rows[0].deleted_at).toBeNull();
  });
});

// ── #41 item 2: the status-guard class. Every runner status writer carries markError's
// `status not in ('paused','revoked')` guard — a slow sync/batch landing AFTER an operator
// pause/revoke must never resurrect the row (the operator verb wins). One db status-precedence
// test per writer, mirroring the existing markError guard test (bootstrap.test.ts). ──────────────
describe.skipIf(!HAS_DB)("status-guard class (#41): sync writers never flip a paused/revoked row", () => {
  const seededCreds: string[] = [];

  /** One credential (no secret_ref — vault untouched) + one active finance connector row. */
  async function seedConn(provider: string): Promise<string> {
    const { pool } = await import("../db.js");
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody)
       values ($1, $2, 'static_token') returning id`,
      [SEED_USER, provider],
    );
    seededCreds.push(cred.rows[0].id as string);
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', $3, 'active') returning id`,
      [SEED_USER, cred.rows[0].id, provider],
    );
    return conn.rows[0].id as string;
  }

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = any($1)`, [seededCreds]);
  });

  const rowOf = async (id: string) => {
    const { pool } = await import("../db.js");
    const r = await pool.query(
      `select status, last_error, last_synced_at from connectors where id = $1`,
      [id],
    );
    return r.rows[0] as { status: string; last_error: string | null; last_synced_at: Date | null };
  };

  /** Flip the row's status mid-flight — the operator verb landing during a slow sync/batch. */
  async function operatorFlip(connectionId: string, to: "paused" | "revoked"): Promise<void> {
    const { pool } = await import("../db.js");
    await pool.query(`update connectors set status = $2 where id = $1`, [connectionId, to]);
  }

  const normalize = (raw: RawRecord): Record<string, unknown> => {
    const r = raw.raw as { amount: number; description: string };
    return { source_object_id: raw.externalId, amount: r.amount, description: r.description };
  };

  it("syncConnection's success write-back cannot resurrect a pause/revoke that landed mid-sync", async () => {
    const { registerConnector, syncConnection } = await import("./index.js");
    for (const flipTo of ["paused", "revoked"] as const) {
      const provider = `sg-sync-${flipTo}`;
      const connector: Connector = {
        provider,
        sector: "finance",
        objectType: "transaction",
        policy: POLL,
        actions: [],
        async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
          await operatorFlip(ctx.connectionId, flipTo); // lands while the sync is still streaming
          yield { externalId: `${provider}-1`, raw: { amount: -1, description: "mid-race" } };
        },
        normalize,
        strongKeys: () => ({}),
        execute: async () => ({ ok: true }),
      };
      registerConnector(connector);
      const connectionId = await seedConn(provider);
      const res = await syncConnection(connectionId);
      expect(res.ok).toBe(true); // the sync itself succeeded — only the status write-back is guarded
      const row = await rowOf(connectionId);
      expect(row.status).toBe(flipTo); // the operator verb wins
      expect(row.last_synced_at).toBeNull(); // the whole guarded write was skipped, not half-applied
    }
  });

  it("a RetryableError's markSyncing flips an active row to 'syncing' but never a paused/revoked one", async () => {
    const { registerConnector, syncConnection } = await import("./index.js");
    const { RetryableError } = await import("./errors.js");
    const mk = (provider: string, flipTo?: "paused" | "revoked"): Connector => ({
      provider,
      sector: "finance",
      objectType: "transaction",
      policy: POLL,
      actions: [],
      // eslint-disable-next-line require-yield
      async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
        if (flipTo) await operatorFlip(ctx.connectionId, flipTo);
        throw new RetryableError("transient 503");
      },
      normalize,
      strongKeys: () => ({}),
      execute: async () => ({ ok: true }),
    });

    // Positive control: the guard must not mask the legitimate active → syncing transition.
    // `sleep` is injected (#99): a RetryableError is TRANSIENT, so the runner now retries it inside
    // the run — with the real timer that is ~5s of wall clock, past vitest's default budget. The
    // behaviour under test (which status the write-back lands) is unchanged.
    registerConnector(mk("sg-retry-active"));
    const active = await seedConn("sg-retry-active");
    const res0 = await syncConnection(active, { sleep: async () => {} });
    expect(res0.ok).toBe(false);
    let row = await rowOf(active);
    expect(row.status).toBe("syncing");
    expect(row.last_error).toContain("transient 503");

    for (const flipTo of ["paused", "revoked"] as const) {
      const provider = `sg-retry-${flipTo}`;
      registerConnector(mk(provider, flipTo));
      const connectionId = await seedConn(provider);
      const res = await syncConnection(connectionId, { sleep: async () => {} });
      expect(res.ok).toBe(false);
      row = await rowOf(connectionId);
      expect(row.status).toBe(flipTo); // the operator verb wins over 'syncing'
      expect(row.last_error).toBeNull(); // the guarded UPDATE skipped entirely
    }
  });

  it("ingestRecords' write-back cannot resurrect a pause/revoke that landed mid-batch", async () => {
    const { registerConnector, ingestRecords } = await import("./index.js");
    for (const flipTo of ["paused", "revoked"] as const) {
      const provider = `sg-ingest-${flipTo}`;
      const connector: Connector = {
        provider,
        sector: "finance",
        objectType: "transaction",
        policy: POLL,
        actions: [],
        // eslint-disable-next-line require-yield
        async *sync(): AsyncIterable<RawRecord> {
          return;
        },
        normalize,
        strongKeys: () => ({}),
        execute: async () => ({ ok: true }),
      };
      registerConnector(connector);
      const connectionId = await seedConn(provider);
      // The LIGHT load checks status='active' up front; the operator verb lands while the batch is
      // still streaming (applyRecords for-awaits, so an async iterable is a faithful runtime race).
      async function* batch(): AsyncIterable<RawRecord> {
        yield { externalId: `${provider}-1`, raw: { amount: -2, description: "mid-batch" } };
        await operatorFlip(connectionId, flipTo);
      }
      const res = await ingestRecords(connectionId, batch() as unknown as RawRecord[]);
      expect(res.ok).toBe(true); // the batch itself landed — only the status write-back is guarded
      const row = await rowOf(connectionId);
      expect(row.status).toBe(flipTo); // the operator verb wins
      expect(row.last_synced_at).toBeNull(); // the whole guarded write was skipped
    }
  });
});

// ── #99: a flaky network and a dead credential must be DISTINGUISHABLE in the connector row. ─────
// Before this, both landed status='error' → deriveFreshness 'error' → the Console said "needs you /
// Reconnect", so a single 503 from a healthy source read as a broken connection for a whole cadence.
// Real rows, real status writes; `sleep` is injected so the retry budget runs without elapsed time.
describe.skipIf(!HAS_DB)("sync error classification against real rows (#99)", () => {
  const seededCreds: string[] = [];

  async function seedConn(provider: string): Promise<string> {
    const { pool } = await import("../db.js");
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody)
       values ($1, $2, 'static_token') returning id`,
      [SEED_USER, provider],
    );
    seededCreds.push(cred.rows[0].id as string);
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', $3, 'active') returning id`,
      [SEED_USER, cred.rows[0].id, provider],
    );
    return conn.rows[0].id as string;
  }

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where id = any($1)`, [seededCreds]);
  });

  const rowOf = async (id: string) => {
    const { pool } = await import("../db.js");
    const r = await pool.query(
      `select status, last_error, last_error_at, last_synced_at from connectors where id = $1`,
      [id],
    );
    return r.rows[0] as {
      status: string;
      last_error: string | null;
      last_error_at: Date | null;
      last_synced_at: Date | null;
    };
  };

  /** A finance connector whose sync always throws `err`. */
  function throwingConnector(provider: string, err: () => unknown): Connector {
    return {
      provider,
      sector: "finance",
      objectType: "transaction",
      policy: POLL,
      actions: [],
      // eslint-disable-next-line require-yield
      async *sync(): AsyncIterable<RawRecord> {
        throw err();
      },
      normalize: (raw: RawRecord) => ({ source_object_id: raw.externalId }),
      strongKeys: () => ({}),
      execute: async () => ({ ok: true }),
    };
  }

  it("a transient upstream failure leaves the row syncing with the masked reason, never error", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("./index.js");
    const provider = "cls-transient";
    registerConnector(
      // The verbatim whoop status shape (whoop.ts:265). No RetryableError anywhere — this is a
      // connector that only ever threw plain Errors, i.e. exactly the case that used to say "needs you".
      throwingConnector(provider, () => new Error("whoop: /v1/cycle returned 503")),
    );
    const connectionId = await seedConn(provider);

    // Pin a known freshness stamp so "unchanged" is an assertion about a VALUE, not about null.
    const stamped = new Date("2026-07-20T09:00:00.000Z");
    await pool.query(`update connectors set last_synced_at = $2 where id = $1`, [connectionId, stamped]);

    const res = await syncConnection(connectionId, { sleep: async () => {} });
    expect(res.ok).toBe(false);
    expect(res.errorClass).toBe("transient");

    const row = await rowOf(connectionId);
    expect(row.status).toBe("syncing"); // the quiet, resumable state — NEVER 'error'
    expect(row.last_error).toContain("503"); // the reason stays inspectable
    expect(row.last_error_at).not.toBeNull();
    expect(row.last_synced_at?.toISOString()).toBe(stamped.toISOString()); // a failed run never re-stamps
  });

  it("a dead credential leaves the row in error so the Console offers Reconnect", async () => {
    const { registerConnector, syncConnection } = await import("./index.js");
    const { SecretAuthError } = await import("../secrets/index.js");
    const provider = "cls-terminal";
    registerConnector(
      throwingConnector(provider, () => new SecretAuthError("secret failed authentication (tag/AAD verification)")),
    );
    const connectionId = await seedConn(provider);

    const res = await syncConnection(connectionId, { sleep: async () => {} });
    expect(res.ok).toBe(false);
    expect(res.errorClass).toBe("terminal");

    const row = await rowOf(connectionId);
    expect(row.status).toBe("error"); // Reconnect stays on offer
    expect(row.last_error_at).not.toBeNull();
    expect(row.last_error).toContain("authentication");
  });

  it("a 4xx credential death is terminal even though it carries an HTTP status", async () => {
    const { registerConnector, syncConnection } = await import("./index.js");
    const provider = "cls-item-login";
    registerConnector(
      // Verbatim plaid shape (plaid.ts:249). The inversion this guards: reading it as transient
      // would park a genuinely dead bank link in "Syncing…" forever.
      throwingConnector(provider, () => new Error("plaid transactions_sync failed: 400 ITEM_LOGIN_REQUIRED")),
    );
    const connectionId = await seedConn(provider);

    const res = await syncConnection(connectionId, { sleep: async () => {} });
    expect(res.errorClass).toBe("terminal");
    expect((await rowOf(connectionId)).status).toBe("error");
  });

  it("the masked reason still reaches last_error on the transient path (no secret leaks)", async () => {
    const { registerConnector, syncConnection } = await import("./index.js");
    const provider = "cls-mask";
    registerConnector(
      throwingConnector(
        provider,
        () => new Error("simplefin: https://user:sup3rsecret@bridge.example/accounts returned 503"),
      ),
    );
    const connectionId = await seedConn(provider);

    await syncConnection(connectionId, { sleep: async () => {} });
    const row = await rowOf(connectionId);
    expect(row.status).toBe("syncing");
    expect(row.last_error).toContain("//***@"); // userinfo masked, exactly like the error path
    expect(row.last_error).not.toContain("sup3rsecret");
  });
});

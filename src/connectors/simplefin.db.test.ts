// SimpleFIN round-trips, gated on env so CI stays green:
//   * DATABASE_URL: a real syncConnection end-to-end against finance_accounts + finance_transactions
//     (HTTP mocked with the captured fixture). Proves per-record routing lands rows in BOTH tables,
//     decimals are exact, sign is preserved, the cursor advances, and a re-run is idempotent.
//   * SIMPLEFIN_LIVE: an opt-in smoke against the public demo bridge (real network) — parse +
//     normalize ≥1 account and ≥1 transaction, assert negative = out on a real spend.
// Both skip cleanly when their env is absent (the headline behaviors are covered network-free elsewhere).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { SyncContext } from "./types.js";
import { SimpleFinConnector, type AccountRow, type TransactionRow } from "./simplefin.js";
import { ACCOUNTS_FIXTURE } from "./simplefin.fixtures.js";

const HAS_DB = !!process.env.DATABASE_URL;
const HAS_LIVE = !!process.env.SIMPLEFIN_LIVE;
const SEED_USER = "00000000-0000-0000-0000-000000000001";
// A DEDICATED throwaway user so this round-trip can't race admin.db.test.ts's simplefin credential
// (test files run in parallel; both would otherwise contend the unique(user_id, provider) row).
const TEST_USER = "00000000-0000-0000-0000-0000000005f1";
const DEMO_ACCESS_URL = "https://demo:demo@beta-bridge.simplefin.org/simplefin";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe.skipIf(!HAS_DB)("SimpleFIN DB round-trip (HTTP mocked)", () => {
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    await pool.query(`insert into users (id, label) values ($1, 'simplefin-db-test') on conflict (id) do nothing`, [TEST_USER]);

    // Seal a (dummy) access URL so the runner's open(purpose:'access') resolves it; HTTP is mocked.
    secretRef = await seal({ userId: TEST_USER, provider: "simplefin", purpose: "access" }, DEMO_ACCESS_URL);

    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, status)
       values ($1, 'simplefin', 'static_token', $2, 'active') returning id`,
      [TEST_USER, secretRef],
    );
    credentialId = cred.rows[0].id as string;

    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', 'simplefin', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;

    // Preset a recent cursor -> incremental (single window, single fetch) for determinism.
    await pool.query(`update connectors set cursor = $2 where id = $1`, [
      connectionId,
      String(Math.floor(Date.now() / 1000) - 3600),
    ]);
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: credential -> connectors -> finance_accounts/finance_transactions.
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("lands accounts + transactions in BOTH tables, exact decimals, sign preserved, cursor advances, idempotent", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(ACCOUNTS_FIXTURE), { status: 200 })) as unknown as typeof globalThis.fetch;
    registerConnector(new SimpleFinConnector());

    const res1 = await syncConnection(connectionId);
    expect(res1.ok).toBe(true);
    expect(res1.upserted).toBe(5); // 2 accounts + 3 transactions
    expect(res1.newCursor).toMatch(/^\d+$/);

    const acctCount = await pool.query(
      `select count(*)::int as n from finance_accounts where connection_id = $1`,
      [connectionId],
    );
    expect(acctCount.rows[0].n).toBe(2);
    const txnCount = await pool.query(
      `select count(*)::int as n from finance_transactions where connection_id = $1`,
      [connectionId],
    );
    expect(txnCount.rows[0].n).toBe(3);

    // Exact decimal balance (no float drift) + institution + raw stored.
    const acct = await pool.query(
      `select current_balance, available_balance, institution_name, raw
         from finance_accounts where connection_id = $1 and source_object_id = 'ACT-checking-001'`,
      [connectionId],
    );
    expect(acct.rows[0].current_balance).toBe("114545.51");
    expect(acct.rows[0].available_balance).toBe("114000.00");
    expect(acct.rows[0].institution_name).toBe("My Bank");
    // raw is the account minus its embedded transactions.
    expect(acct.rows[0].raw.transactions).toBeUndefined();
    expect(acct.rows[0].raw.org.name).toBe("My Bank");

    // Sign preserved: paycheck positive, spend negative; currency inherited; parent linkage.
    const pay = await pool.query(
      `select amount, currency, account_source_id from finance_transactions
         where connection_id = $1 and source_object_id = 'TXN-paycheck-001'`,
      [connectionId],
    );
    expect(pay.rows[0].amount).toBe("1960.00");
    expect(pay.rows[0].currency).toBe("USD");
    expect(pay.rows[0].account_source_id).toBe("ACT-checking-001");

    const spend = await pool.query(
      `select amount from finance_transactions
         where connection_id = $1 and source_object_id = 'TXN-coffee-002'`,
      [connectionId],
    );
    expect(Number(spend.rows[0].amount)).toBeLessThan(0);
    expect(spend.rows[0].amount).toBe("-20.00");

    // Cursor advanced + connection marked active.
    const c1 = await pool.query(`select cursor, status, last_synced_at from connectors where id = $1`, [connectionId]);
    expect(c1.rows[0].cursor).toMatch(/^\d+$/);
    expect(c1.rows[0].status).toBe("active");
    expect(c1.rows[0].last_synced_at).not.toBeNull();

    // Re-run over the same window -> still exactly 2 + 3 rows (idempotent upsert absorbs the overlap).
    const res2 = await syncConnection(connectionId);
    expect(res2.ok).toBe(true);
    const acctCount2 = await pool.query(
      `select count(*)::int as n from finance_accounts where connection_id = $1`,
      [connectionId],
    );
    const txnCount2 = await pool.query(
      `select count(*)::int as n from finance_transactions where connection_id = $1`,
      [connectionId],
    );
    expect(acctCount2.rows[0].n).toBe(2);
    expect(txnCount2.rows[0].n).toBe(3);
  });
});

describe.skipIf(!HAS_LIVE)("SimpleFIN live demo-bridge smoke (opt-in)", () => {
  it("fetches /accounts from the demo bridge and normalizes ≥1 account + ≥1 transaction (negative = out)", async () => {
    const c = new SimpleFinConnector();
    const ctx: SyncContext = {
      userId: SEED_USER,
      connectionId: "00000000-0000-0000-0000-0000000000aa",
      secretRef: null,
      secret: DEMO_ACCESS_URL,
      // First sync (no cursor) — the demo bridge returns its sample accounts + transactions.
    };

    const recs: Array<{ object?: string }> = [];
    for await (const r of c.sync(ctx)) recs.push(r);

    const accounts = recs.filter((r) => r.object === "account");
    const txns = recs.filter((r) => r.object === "transaction");
    expect(accounts.length).toBeGreaterThanOrEqual(1);
    expect(txns.length).toBeGreaterThanOrEqual(1);

    const acctRows = accounts.map((r) => c.normalize(r as never) as AccountRow);
    expect(acctRows.every((a) => typeof a.source_object_id === "string")).toBe(true);

    const txnRows = txns.map((r) => c.normalize(r as never) as TransactionRow);
    // The demo data includes spends — at least one normalized amount is negative (money out).
    expect(txnRows.some((t) => t.amount != null && Number(t.amount) < 0)).toBe(true);
  }, 30_000);
});

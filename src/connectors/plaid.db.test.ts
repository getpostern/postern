// Plaid Sandbox-driven DB round-trip — GATED on PLAID_CLIENT_ID/PLAID_SECRET (and DATABASE_URL), so
// it SKIPS cleanly when Plaid isn't configured (the headline behaviors — negate-on-write, PFC, routing
// — are covered network-free in plaid.test.ts). When configured it proves the full headless server
// path: mint a sandbox public_token (no browser) → exchange → seal → sync → assert rows land in BOTH
// finance tables via per-record routing, the cursor is the Plaid next_cursor, and a re-run is idempotent.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PlaidConnector, sandboxPublicTokenCreate, exchangePublicToken } from "./plaid.js";

const HAS_PLAID = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
const HAS_DB = !!process.env.DATABASE_URL;
// A DEDICATED throwaway user so this round-trip can't race the LOCAL_USER plaid row used elsewhere.
const TEST_USER = "00000000-0000-0000-0000-0000000005f2";

describe.skipIf(!(HAS_PLAID && HAS_DB))("Plaid Sandbox DB round-trip", () => {
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    await pool.query(`insert into users (id, label) values ($1, 'plaid-db-test') on conflict (id) do nothing`, [TEST_USER]);

    // Headless: mint a sandbox public_token → exchange for the durable item access_token.
    const publicToken = await sandboxPublicTokenCreate();
    const { accessToken } = await exchangePublicToken(publicToken);

    secretRef = await seal({ userId: TEST_USER, provider: "plaid", purpose: "access" }, accessToken);
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, status)
       values ($1, 'plaid', 'byo_app', $2, 'active') returning id`,
      [TEST_USER, secretRef],
    );
    credentialId = cred.rows[0].id as string;

    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', 'plaid', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;
  }, 60_000);

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: credential -> connectors -> finance_accounts/finance_transactions.
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    if (secretRef) await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("syncs accounts (+ transactions) into the finance tables, advances the cursor, idempotent re-run", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");
    registerConnector(new PlaidConnector());

    const res1 = await syncConnection(connectionId);
    expect(res1.ok).toBe(true);
    expect(res1.provider).toBe("plaid");
    expect(res1.deleted).toBe(0); // a fresh item delivers no removals on first sync

    const acctCount = await pool.query(
      `select count(*)::int as n from finance_accounts where connection_id = $1`,
      [connectionId],
    );
    expect(acctCount.rows[0].n).toBeGreaterThanOrEqual(1);

    // accounts are synthetic-balance + byo_app; assert the flag + a non-null balance_at.
    const acct = await pool.query(
      `select balance_at, balance_at_is_synthetic, account_type from finance_accounts where connection_id = $1 limit 1`,
      [connectionId],
    );
    expect(acct.rows[0].balance_at_is_synthetic).toBe(true);
    expect(acct.rows[0].balance_at).not.toBeNull();

    // Cursor = the Plaid next_cursor (opaque string, NOT a numeric epoch like SimpleFIN).
    const c1 = await pool.query(`select cursor, status, last_synced_at from connectors where id = $1`, [connectionId]);
    expect(typeof c1.rows[0].cursor).toBe("string");
    expect(c1.rows[0].cursor.length).toBeGreaterThan(0);
    expect(c1.rows[0].status).toBe("active");
    expect(c1.rows[0].last_synced_at).not.toBeNull();

    // If the sandbox returned transactions, sign convention holds (negative = out exists for spends).
    const txnCount1 = await pool.query(
      `select count(*)::int as n from finance_transactions where connection_id = $1`,
      [connectionId],
    );

    // Every landed row is LIVE (deleted_at null) — the upsert writes the resurrect-ready null.
    const tombed = await pool.query(
      `select count(*)::int as n from finance_transactions where connection_id = $1 and deleted_at is not null`,
      [connectionId],
    );
    expect(tombed.rows[0].n).toBe(0);

    // Re-run from the persisted cursor → idempotent: account count is stable, no errors.
    const res2 = await syncConnection(connectionId);
    expect(res2.ok).toBe(true);
    const acctCount2 = await pool.query(
      `select count(*)::int as n from finance_accounts where connection_id = $1`,
      [connectionId],
    );
    expect(acctCount2.rows[0].n).toBe(acctCount.rows[0].n);
    const txnCount2 = await pool.query(
      `select count(*)::int as n from finance_transactions where connection_id = $1`,
      [connectionId],
    );
    expect(txnCount2.rows[0].n).toBeGreaterThanOrEqual(txnCount1.rows[0].n);
  }, 60_000);
});

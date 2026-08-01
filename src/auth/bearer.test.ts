import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";

// DB round-trip is gated: skipped when DATABASE_URL is unset so CI stays green without Postgres.
const HAS_DB = !!process.env.DATABASE_URL;

// Seeded self-host user (db/schema.sql) satisfies the FK on agent_grants/domain rows.
const SEED_USER = "00000000-0000-0000-0000-000000000001";
const OTHER_USER = "00000000-0000-0000-0000-0000000000ff";

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!HAS_DB)("resolveBearer + cross-user scoping (DB)", () => {
  const FINANCE_KEY = "test-bearer-finance";
  const WILDCARD_KEY = "test-bearer-wildcard";
  const REVOKED_KEY = "test-bearer-revoked";

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    // A second user so cross-user scoping is testable.
    await pool.query(
      `insert into users (id) values ($1) on conflict (id) do nothing`,
      [OTHER_USER],
    );
    await pool.query(`delete from agent_grants where agent_id like 'test-%'`);
    await pool.query(
      `insert into agent_grants (user_id, agent_id, key_hash, sectors) values
         ($1, 'test-finance', $2, '{finance}'),
         ($1, 'test-wildcard', $3, '{*}'),
         ($1, 'test-revoked', $4, '{finance}')`,
      [SEED_USER, sha256Hex(FINANCE_KEY), sha256Hex(WILDCARD_KEY), sha256Hex(REVOKED_KEY)],
    );
    await pool.query(
      `update agent_grants set revoked_at = now() where agent_id = 'test-revoked'`,
    );
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from agent_grants where agent_id like 'test-%'`);
    await pool.end();
  });

  it("unknown hash throws AccessDenied", async () => {
    const { resolveBearer, AccessDenied } = await import("./index.js");
    await expect(resolveBearer("no-such-key")).rejects.toBeInstanceOf(AccessDenied);
  });

  it("revoked row throws AccessDenied", async () => {
    const { resolveBearer, AccessDenied } = await import("./index.js");
    await expect(resolveBearer(REVOKED_KEY)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("['finance'] grant → grantedSectors === {finance}", async () => {
    const { resolveBearer } = await import("./index.js");
    const ctx = await resolveBearer(FINANCE_KEY);
    expect([...ctx.grantedSectors]).toEqual(["finance"]);
    expect(ctx.userId).toBe(SEED_USER);
  });

  it("['*'] grant → grantedSectors === ALL_SECTORS", async () => {
    const { resolveBearer, ALL_SECTORS } = await import("./index.js");
    const ctx = await resolveBearer(WILDCARD_KEY);
    expect([...ctx.grantedSectors].sort()).toEqual([...ALL_SECTORS].sort());
  });

  it("getRecord for another user's row returns null, not the row", async () => {
    const { resolveBearer } = await import("./index.js");
    const { getRecord } = await import("../core/context.js");
    const { pool } = await import("../db.js");

    // Seed a finance_accounts row owned by OTHER_USER (needs a connector for the FK).
    const conn = await pool.query(
      `insert into provider_credentials (user_id, provider, custody) values ($1, 'simplefin', 'static_token')
       returning id`,
      [OTHER_USER],
    ).then((r) => r.rows[0].id);
    const connectionId = await pool.query(
      `insert into connectors (user_id, credential_id, provider, sector, status)
       values ($1, $2, 'simplefin', 'finance', 'active') returning id`,
      [OTHER_USER, conn],
    ).then((r) => r.rows[0].id);
    const rowId = await pool.query(
      `insert into finance_accounts (connection_id, user_id, source_object_id, name)
       values ($1, $2, 'acct-x', 'Other User Checking') returning id`,
      [connectionId, OTHER_USER],
    ).then((r) => r.rows[0].id);

    try {
      // The finance-granted agent belongs to SEED_USER; OTHER_USER's row must not be reachable.
      const ctx = await resolveBearer(FINANCE_KEY);
      const got = await getRecord(ctx, "finance.account", rowId);
      expect(got).toBeNull();
    } finally {
      await pool.query(`delete from finance_accounts where id = $1`, [rowId]);
      await pool.query(`delete from connectors where id = $1`, [connectionId]);
      await pool.query(`delete from provider_credentials where id = $1`, [conn]);
    }
  });
});

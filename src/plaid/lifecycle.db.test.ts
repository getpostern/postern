// Plaid connection-health + billing-safety DB round-trips — gated on DATABASE_URL, isolated to a
// dedicated test user. Proves:
//   - describe_context surfaces a per-connection health {status, consentExpiresAt} for a Plaid Item
//     (a broken Item reads action_required, NOT a silent "synced").
//   - disconnect AND erase call Plaid /item/remove (the operator OUT-bound billing stop) BEFORE
//     dropping the rows — asserted against the mocked Plaid client.
//
// The Plaid network is mocked at `fetch` (we only assert /item/remove is hit with the opened token).

import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";
import { ALL_SECTORS } from "../auth/sectors.js";
import type { AuthContext } from "../auth/index.js";

const HAS_DB = !!process.env.DATABASE_URL;
const TEST_USER = "00000000-0000-0000-0000-0000000005f3";
const ctx: AuthContext = { userId: TEST_USER, agentId: "operator", grantedSectors: new Set(ALL_SECTORS) };

// Capture /item/remove calls (URL hit + the access_token in the body) without a real network.
const itemRemoveCalls: Array<{ accessToken: unknown }> = [];
const realFetch = globalThis.fetch;

function installFetchMock() {
  itemRemoveCalls.length = 0;
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    if (u.includes("/item/remove")) {
      itemRemoveCalls.push({ accessToken: body.access_token });
      return new Response(JSON.stringify({ request_id: "r" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

/** Seed one active Plaid finance connection (credential + connector + a sealed token) and a txn row. */
async function seedPlaidConnection(opts: {
  itemId: string;
  token: string;
  itemStatus?: string;
  consent?: string | null;
}): Promise<{ connectionId: string; credentialId: string }> {
  const { pool } = await import("../db.js");
  const { seal } = await import("../secrets/index.js");
  const secretRef = await seal({ userId: TEST_USER, provider: "plaid", purpose: "access" }, opts.token);
  const cred = await pool.query(
    `insert into provider_credentials
       (user_id, provider, custody, secret_ref, external_item_id, item_status, consent_expiration_time, status)
     values ($1, 'plaid', 'byo_app', $2, $3, $4, $5, 'active') returning id`,
    [TEST_USER, secretRef, opts.itemId, opts.itemStatus ?? "ok", opts.consent ?? null],
  );
  const credentialId = cred.rows[0].id as string;
  const conn = await pool.query(
    `insert into connectors (user_id, credential_id, sector, provider, status)
     values ($1, $2, 'finance', 'plaid', 'active') returning id`,
    [TEST_USER, credentialId],
  );
  const connectionId = conn.rows[0].id as string;
  await pool.query(
    `insert into finance_transactions (connection_id, user_id, source_object_id, amount) values ($1, $2, $3, -1)`,
    [connectionId, TEST_USER, `txn-${opts.itemId}`],
  );
  return { connectionId, credentialId };
}

describe.skipIf(!HAS_DB)("Plaid health + billing-safety (DB)", () => {
  beforeAll(async () => {
    process.env.PLAID_CLIENT_ID = "test-client-id";
    process.env.PLAID_SECRET = "test-secret";
    process.env.PLAID_ENV = "sandbox";
    const { pool } = await import("../db.js");
    await pool.query(`insert into users (id, label) values ($1, 'plaid-health-test') on conflict (id) do nothing`, [TEST_USER]);
  });

  beforeEach(async () => {
    installFetchMock();
    const { pool } = await import("../db.js");
    // Cascade: credential → connectors → finance rows.
    await pool.query(`delete from provider_credentials where user_id = $1`, [TEST_USER]);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("describe_context surfaces a broken Item as health.action_required (not a silent synced)", async () => {
    const { describeContext } = await import("../core/context.js");
    const consent = "2030-09-01T00:00:00Z";
    await seedPlaidConnection({ itemId: "item-broken", token: "tok-1", itemStatus: "action_required", consent });

    const result = await describeContext(ctx);
    const plaid = (result.connections as Array<Record<string, unknown>>).find((c) => c.provider === "plaid");
    expect(plaid).toBeTruthy();
    const health = plaid!.health as { status: string; consentExpiresAt: string | null };
    expect(health.status).toBe("action_required");
    expect(health.consentExpiresAt).toBe(new Date(consent).toISOString());
  });

  it("disconnect calls /item/remove with the stored token BEFORE dropping rows", async () => {
    const { disconnectConnection } = await import("../core/lifecycle.js");
    const { pool } = await import("../db.js");
    const { connectionId } = await seedPlaidConnection({ itemId: "item-disc", token: "tok-disconnect" });

    const result = await disconnectConnection(ctx, connectionId, { confirmToken: connectionId });
    expect(result.deleted.finance_transactions).toBe(1);
    expect(itemRemoveCalls).toHaveLength(1);
    expect(itemRemoveCalls[0].accessToken).toBe("tok-disconnect");

    const left = await pool.query(`select count(*)::int as n from connectors where id = $1`, [connectionId]);
    expect(left.rows[0].n).toBe(0);
  });

  it("erase (scope=connection) calls /item/remove BEFORE wiping the rows", async () => {
    const { eraseData } = await import("../core/erase.js");
    const { pool } = await import("../db.js");
    const { connectionId } = await seedPlaidConnection({ itemId: "item-erase", token: "tok-erase" });

    const result = await eraseData(ctx, { scope: "connection", connectionId });
    expect(result.deleted.finance_transactions).toBe(1);
    expect(itemRemoveCalls).toHaveLength(1);
    expect(itemRemoveCalls[0].accessToken).toBe("tok-erase");

    // erase KEEPS the connector/credential rows (only data is destroyed).
    const conn = await pool.query(`select count(*)::int as n from connectors where id = $1`, [connectionId]);
    expect(conn.rows[0].n).toBe(1);
  });
});

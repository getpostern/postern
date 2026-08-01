// `reconnect_kind` ON THE WIRE (#89 item 1) — the round-trip the pure test cannot cover: that the
// status SELECT actually reads `provider_credentials.custody` + `external_item_id` and that both the
// LIST and the DETAIL wire carry the derived field. Gated on DATABASE_URL; its own throwaway user.
//
// The fixtures are the four custody shapes as they are REALLY stored, which is what makes this test
// able to fail: drop `pc.custody` from STATUS_SELECT and the SimpleFIN row silently becomes 'none'
// (undefined custody -> the unknown branch) while every pure-function test still passes.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import type { AuthContext } from "../auth/index.js";
import { ALL_SECTORS } from "../auth/index.js";
import type { Connector, RawRecord, ActionResult } from "../connectors/types.js";
import { listConnectorsEnriched, getConnectionDetail } from "./lifecycle.js";
import { registerConnector } from "../sync/index.js";

const HAS_DB = !!process.env.DATABASE_URL;
const TEST_USER = "00000000-0000-0000-0000-0000000ec001";

const ctx: AuthContext = {
  userId: TEST_USER,
  agentId: "reconnect-kind-test",
  grantedSectors: new Set(ALL_SECTORS),
};

/** A minimal registered connector, so the DECLARED transport is real code truth in this round-trip. */
function fakeConnector(
  provider: string,
  sector: string,
  mode: "poll" | "push",
  pushKind?: "stream" | "webhook",
): Connector {
  return {
    provider,
    sector,
    objectType: "transaction",
    policy: { mode, pushKind, supportsIncremental: false },
    actions: [],
    async *sync(): AsyncIterable<RawRecord> {},
    normalize() {
      return {};
    },
    strongKeys() {
      return {};
    },
    async execute(): Promise<ActionResult> {
      return { ok: true };
    },
  };
}

describe.skipIf(!HAS_DB)("reconnect_kind on the connector wire", () => {
  let pool: Pool;
  /** sector -> connectionId, for the assertions below. */
  const conn: Record<string, string> = {};

  beforeAll(async () => {
    pool = (await import("../db.js")).pool;
    await pool.query(`insert into users (id, label) values ($1, $2) on conflict (id) do nothing`, [
      TEST_USER,
      "reconnect-kind-db-test",
    ]);

    const seed = async (
      provider: string,
      sector: string,
      custody: string,
      externalItemId: string | null,
    ): Promise<string> => {
      const cr = await pool.query(
        `insert into provider_credentials (user_id, provider, custody, external_item_id, status)
         values ($1, $2, $3, $4, 'active') returning id`,
        [TEST_USER, provider, custody, externalItemId],
      );
      const r = await pool.query(
        `insert into connectors (user_id, credential_id, sector, provider, status)
         values ($1, $2, $3, $4, 'active') returning id`,
        [TEST_USER, cr.rows[0].id, sector, provider],
      );
      return r.rows[0].id as string;
    };

    // A pasted secret, poll: SimpleFIN's real shape.
    registerConnector(fakeConnector("rk-simplefin", "finance", "poll"));
    conn.finance = await seed("rk-simplefin", "finance", "static_token", null);

    // Device push: custody 'static_token' (what POST /api/credentials really stamps) + push/webhook.
    registerConnector(fakeConnector("rk-device", "health", "push", "webhook"));
    conn.health = await seed("rk-device", "health", "static_token", null);

    // Push STREAM on the same custody — must NOT be mistaken for a device.
    registerConnector(fakeConnector("rk-stream", "home", "push", "stream"));
    conn.home = await seed("rk-stream", "home", "static_token", null);

    // OAuth: the value every callback stamps.
    registerConnector(fakeConnector("rk-oauth", "calendar", "poll"));
    conn.calendar = await seed("rk-oauth", "calendar", "first_party", null);

    // Plaid: custody byo_app + a per-Item id.
    registerConnector(fakeConnector("rk-plaid", "mail", "poll"));
    conn.mail = await seed("rk-plaid", "mail", "byo_app", "item-rk-1");
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    await pool.query(`delete from connectors where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from provider_credentials where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
  });

  it("the LIST wire carries a reconnect_kind for every row, derived from the STORED custody", async () => {
    const rows = await listConnectorsEnriched(ctx);
    const kindOf = (sector: string): string | undefined =>
      rows.find((r) => r.sector === sector)?.reconnect_kind;

    // Every one of these is a different answer, so a missing SELECT column, a wrong branch order, or a
    // custody-only rule each breaks at least one of them.
    expect(kindOf("finance")).toBe("repaste_token");
    expect(kindOf("health")).toBe("device_push"); // static_token in the DB — the transport decides
    expect(kindOf("home")).toBe("repaste_token"); // push, but STREAM
    expect(kindOf("calendar")).toBe("reauth_oauth");
    expect(kindOf("mail")).toBe("plaid_update_link"); // byo_app + an Item id, not reauth_oauth
    // It is served on EVERY row, healthy or not: the field is a property of custody, not of state.
    expect(rows.every((r) => typeof r.reconnect_kind === "string")).toBe(true);
  });

  it("the DETAIL wire carries the same value as the LIST wire (one derivation, two reads)", async () => {
    const rows = await listConnectorsEnriched(ctx);
    for (const row of rows) {
      const detail = await getConnectionDetail(ctx, row.connectionId);
      expect(detail.reconnect_kind).toBe(row.reconnect_kind);
    }
  });

  it("push_kind and reconnect_kind agree about the transport (one resolved value, not two)", async () => {
    const rows = await listConnectorsEnriched(ctx);
    for (const row of rows) {
      if (row.push_kind === "webhook") expect(row.reconnect_kind).toBe("device_push");
      if (row.push_kind === "stream") expect(row.reconnect_kind).not.toBe("device_push");
    }
  });
});

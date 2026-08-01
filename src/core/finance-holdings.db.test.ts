// finance_holdings store + the generic snapshot-tombstone helper (#36, spec finance-holding) — DB
// round-trips against a real Postgres (gated on DATABASE_URL, which the ADR-0015 guard forces to a
// *_test DB). Proves reconcileObjectSnapshot's fence semantics (HA's proven rules, generalized):
// absent → tombstoned; in liveSourceIds / ingested during the sync (>= startedAt) / already-tombstoned
// → untouched; connection-scoped; resurrect-on-upsert still works (the runner's upsert writes
// deleted_at = null). Plus the finance.holding read surface: query() serves only live rows,
// filters/sorts/aggregates on the declared columns, getRecord drills tombstones truthfully, and the
// table resolution is REGISTRY-only (unknown object → fail-closed throw).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { reconcileObjectSnapshot, buildUpsert } from "../sync/runner.js";
import { query } from "./query.js";
import { getRecord } from "./context.js";
import { getSchema } from "./schema.js";
import { ALL_SECTORS, type AuthContext } from "../auth/index.js";

const HAS_DB = !!process.env.DATABASE_URL;
const TEST_USER = "00000000-0000-0000-0000-000000000360";

const ctx: AuthContext = {
  userId: TEST_USER,
  agentId: "finance-holdings-test",
  grantedSectors: new Set(ALL_SECTORS),
};

// Lazily imported pool (so the file loads even when the DB suite is skipped).
let pool: typeof import("../db.js").pool;

/** Insert a finance connector (fresh credential); returns its connection_id. */
async function makeConn(provider: string, itemId?: string): Promise<string> {
  const cred = await pool.query(
    `insert into provider_credentials (user_id, provider, custody, status, external_item_id)
     values ($1, $2, 'static_token', 'active', $3) returning id`,
    [TEST_USER, provider, itemId ?? null],
  );
  const conn = await pool.query(
    `insert into connectors (user_id, credential_id, sector, provider, status)
     values ($1, $2, 'finance', $3, 'active') returning id`,
    [TEST_USER, cred.rows[0].id, provider],
  );
  return conn.rows[0].id as string;
}

interface HoldingInput {
  sid: string;
  account_source_id?: string | null;
  symbol?: string | null;
  name?: string | null;
  security_type?: string | null;
  quantity?: string | null;
  market_value?: string | null;
  cost_basis?: string | null;
  currency?: string | null;
  as_of?: string | null;
  ingested_at?: Date;
  deleted_at?: string | null;
}

async function insHolding(connId: string, h: HoldingInput): Promise<string> {
  const r = await pool.query(
    `insert into finance_holdings
       (connection_id, user_id, source_object_id, account_source_id, symbol, name, security_type,
        quantity, market_value, cost_basis, currency, as_of, raw, ingested_at, deleted_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, coalesce($14, now()), $15) returning id`,
    [
      connId,
      TEST_USER,
      h.sid,
      h.account_source_id ?? null,
      h.symbol ?? null,
      h.name ?? null,
      h.security_type ?? null,
      h.quantity ?? null,
      h.market_value ?? null,
      h.cost_basis ?? null,
      h.currency ?? null,
      h.as_of ?? "2026-06-20T00:00:00Z",
      JSON.stringify({ sid: h.sid }),
      h.ingested_at ?? null,
      h.deleted_at ?? null,
    ],
  );
  return r.rows[0].id as string;
}

async function holdingRow(id: string): Promise<Record<string, unknown>> {
  const r = await pool.query(`select * from finance_holdings where id = $1`, [id]);
  return r.rows[0];
}

describe.skipIf(!HAS_DB)("finance_holdings store + reconcileObjectSnapshot (#36)", () => {
  beforeAll(async () => {
    pool = (await import("../db.js")).pool;
    await pool.query(`insert into users (id, label) values ($1, 'holdings-36-test') on conflict (id) do nothing`, [
      TEST_USER,
    ]);
  });

  afterAll(async () => {
    await pool.query(`delete from finance_holdings where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from connectors where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from provider_credentials where user_id = $1`, [TEST_USER]);
  });

  beforeEach(async () => {
    await pool.query(`delete from finance_holdings where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from connectors where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from provider_credentials where user_id = $1`, [TEST_USER]);
  });

  // ── REGISTRY surface ────────────────────────────────────────────────────────
  it("finance.holding is visible via get_schema('finance') (prefix-match returns all three objects)", () => {
    expect(Object.keys(getSchema("finance")).sort()).toEqual([
      "finance.account",
      "finance.holding",
      "finance.transaction",
    ]);
    const h = getSchema("finance.holding")["finance.holding"];
    expect(h.table).toBe("finance_holdings");
    expect(h.primaryTime).toBe("as_of");
    expect(h.serveDeduped).toBe(true);
  });

  // ── The fence semantics ─────────────────────────────────────────────────────
  it("fence: absent → tombstoned; in liveSourceIds / ingested during the sync / already-tombstoned → untouched", async () => {
    const conn = await makeConn("simplefin");
    const startedAt = new Date();
    const before = new Date(startedAt.getTime() - 60_000);
    const during = new Date(startedAt.getTime() + 1_000);

    const gone = await insHolding(conn, { sid: "HOL-gone", symbol: "CTSO", ingested_at: before });
    const live = await insHolding(conn, { sid: "HOL-live", symbol: "VTI", ingested_at: before });
    const fresh = await insHolding(conn, { sid: "HOL-fresh", symbol: "NVDA", ingested_at: during }); // upserted DURING this sync
    const dead = await insHolding(conn, { sid: "HOL-dead", symbol: "OLD", ingested_at: before, deleted_at: "2026-06-01T00:00:00Z" });

    const n = await reconcileObjectSnapshot(conn, "finance", "holding", new Set(["HOL-live"]), startedAt);
    expect(n).toBe(1); // ONLY the absent, pre-fence, live row

    expect((await holdingRow(gone)).deleted_at).not.toBeNull(); // absent → tombstoned
    expect((await holdingRow(live)).deleted_at).toBeNull(); // in liveSourceIds → untouched
    expect((await holdingRow(fresh)).deleted_at).toBeNull(); // behind the fence → never tombstoned by its own sync
    // Already-tombstoned keeps its ORIGINAL deleted_at (not re-stamped, not re-counted).
    expect(new Date((await holdingRow(dead)).deleted_at as string).toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("fence is connection-scoped: another connection's rows are never touched", async () => {
    const a = await makeConn("simplefin");
    const b = await makeConn("plaid");
    const before = new Date(Date.now() - 60_000);
    const mine = await insHolding(a, { sid: "HOL-a", symbol: "CTSO", ingested_at: before });
    const theirs = await insHolding(b, { sid: "HOL-b", symbol: "CTSO", ingested_at: before });

    const n = await reconcileObjectSnapshot(a, "finance", "holding", new Set<string>(), new Date());
    expect(n).toBe(1);
    expect((await holdingRow(mine)).deleted_at).not.toBeNull();
    expect((await holdingRow(theirs)).deleted_at).toBeNull(); // connection b untouched
  });

  it("resurrect-on-upsert: a tombstoned position reappearing in a later sync goes live again", async () => {
    const conn = await makeConn("simplefin");
    const id = await insHolding(conn, { sid: "HOL-r", symbol: "CTSO", ingested_at: new Date(Date.now() - 60_000) });
    await reconcileObjectSnapshot(conn, "finance", "holding", new Set<string>(), new Date());
    expect((await holdingRow(id)).deleted_at).not.toBeNull();

    // The runner's exact live-write path: buildUpsert always writes deleted_at = null (ADR 0004 #3).
    const { sql, values } = buildUpsert("finance_holdings", {
      connection_id: conn,
      user_id: TEST_USER,
      source_object_id: "HOL-r",
      symbol: "CTSO",
      market_value: "2100",
      as_of: "2026-06-27T00:00:00Z",
      raw: JSON.stringify({ sid: "HOL-r" }),
      ingested_at: new Date(),
      deleted_at: null,
    });
    await pool.query(sql, values);

    const row = await holdingRow(id);
    expect(row.deleted_at).toBeNull(); // resurrected — same row (same id), live again
    expect(Number(row.market_value)).toBeCloseTo(2100, 2);
  });

  it("resolves the table via the REGISTRY only: an unknown (sector, object) throws (fail-closed)", async () => {
    const conn = await makeConn("simplefin");
    await expect(reconcileObjectSnapshot(conn, "finance", "nope", new Set<string>(), new Date())).rejects.toThrow(
      /no REGISTRY table/,
    );
  });

  // ── The read surface over the store ─────────────────────────────────────────
  it("query() serves only live rows; getRecord drills a tombstone truthfully", async () => {
    const conn = await makeConn("simplefin");
    const before = new Date(Date.now() - 60_000);
    await insHolding(conn, { sid: "HOL-1", symbol: "CTSO", market_value: "2000", ingested_at: before });
    const goneId = await insHolding(conn, { sid: "HOL-2", symbol: "GONE", market_value: "500", ingested_at: before });
    await reconcileObjectSnapshot(conn, "finance", "holding", new Set(["HOL-1"]), new Date());

    const served = await query(ctx, { sector: "finance.holding" });
    expect(served.count).toBe(1);
    expect((served.rows as Array<Record<string, unknown>>)[0].symbol).toBe("CTSO");

    const drilled = (await getRecord(ctx, "finance.holding", goneId)) as Record<string, unknown>;
    expect(drilled.symbol).toBe("GONE"); // truthful drill, deleted_at visible
    expect(drilled.deleted_at).not.toBeNull();
  });

  it("query() filters/sorts/aggregates on the declared columns (sum(market_value) groupBy security_type)", async () => {
    const conn = await makeConn("plaid");
    await insHolding(conn, { sid: "h-1", symbol: "CTSO", security_type: "equity", market_value: "2000", quantity: "10", as_of: "2026-06-25T00:00:00Z" });
    await insHolding(conn, { sid: "h-2", symbol: "NVDA", security_type: "equity", market_value: "1000", quantity: "5", as_of: "2026-06-26T00:00:00Z" });
    await insHolding(conn, { sid: "h-3", symbol: "VMFXX", security_type: "cash", market_value: "300", quantity: "300", as_of: "2026-06-24T00:00:00Z" });

    // Filter on a declared column.
    const eq = await query(ctx, { sector: "finance.holding", where: { security_type: { eq: "equity" } } });
    expect(eq.count).toBe(2);

    // Default sort = primaryTime (as_of) desc.
    const sorted = await query(ctx, { sector: "finance.holding" });
    expect((sorted.rows as Array<Record<string, unknown>>).map((r) => r.symbol)).toEqual(["NVDA", "CTSO", "VMFXX"]);

    // Server-side aggregation with groupBy.
    const agg = (await query(ctx, {
      sector: "finance.holding",
      aggregate: { fn: "sum", field: "market_value", groupBy: ["security_type"] },
    })) as { groups: Array<{ group: Record<string, unknown>; value: unknown }> };
    const byType = new Map(agg.groups.map((g) => [g.group.security_type, Number(g.value)]));
    expect(byType.get("equity")).toBeCloseTo(3000, 2);
    expect(byType.get("cash")).toBeCloseTo(300, 2);
  });
});

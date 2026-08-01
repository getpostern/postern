// Wave 11e — the primary-time partial index proves out against a real Postgres (gated on DATABASE_URL).
// Seeds a representative domain table (finance_transactions) with ~5k live rows via raw SQL under a
// dedicated throwaway user (so parallel db-test files can't contend), then EXPLAINs the SHAPE of the
// default sector query that query() emits — `where user_id=$1 and deleted_at is null order by
// <primaryTime> desc, id asc limit 100`. Proves:
//   * the planner serves it from the new (user_id, <primaryTime> desc, id) where deleted_at is null
//     partial index — an Index/Index-Only Scan — with NO `Sort` node (the trailing id covers the
//     within-ties tiebreak, so even the residual sort is gone). enable_seqscan is forced off so the
//     assertion is deterministic on a small table, not at the mercy of the cost model.
//   * the existing (user_id, connection_id, <primaryTime>) "scope" index is RETAINED (the per-connection
//     drill still needs it) — both indexes coexist in pg_indexes.

import { describe, it, expect, beforeAll, afterAll } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;
// A DEDICATED throwaway user so this round-trip can't race other db test files (run in parallel).
const TEST_USER = "00000000-0000-0000-0000-0000000042e5";
const SEED_ROWS = 5000;

/** A plan node from EXPLAIN (FORMAT JSON). Children hang off `Plans`. */
interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

/** Pre-order walk of the plan tree, applying `fn` to every node. */
function walkPlan(node: PlanNode, fn: (n: PlanNode) => void): void {
  fn(node);
  for (const child of node.Plans ?? []) walkPlan(child, fn);
}

describe.skipIf(!HAS_DB)("primary-time partial index — default query plan", () => {
  let credentialId: string;
  let connId: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(
      `insert into users (id, label) values ($1, 'query-perf-db-test') on conflict (id) do nothing`,
      [TEST_USER],
    );
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status)
       values ($1, 'simplefin', 'static_token', 'active') returning id`,
      [TEST_USER],
    );
    credentialId = cred.rows[0].id as string;
    const fin = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', 'simplefin', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    connId = fin.rows[0].id as string;

    // ~5k LIVE transactions in one set-based insert (deleted_at stays null = matches the partial predicate).
    // Distinct posted_at per row so the ORDER BY has a meaningful sort to serve from the index.
    await pool.query(
      `insert into finance_transactions
         (connection_id, user_id, source_object_id, posted_at, amount, currency, description)
       select $1, $2, 'perf-' || g,
              timestamptz '2026-01-01T00:00:00Z' + (g || ' minutes')::interval,
              (g % 100)::numeric, 'USD', 'perf seed ' || g
       from generate_series(1, $3) g`,
      [connId, TEST_USER, SEED_ROWS],
    );
    // Refresh planner stats so the cost model sees the real row count + distribution.
    await pool.query(`analyze finance_transactions`);
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: credential -> connectors -> domain rows.
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("the default sector query uses the partial index and has NO Sort node", async () => {
    const { pool } = await import("../db.js");
    // A dedicated connection: enable_seqscan is session-scoped, so force it OFF here (deterministic on
    // a small table) and RESET before releasing the connection back to the pool.
    const client = await pool.connect();
    try {
      await client.query(`set enable_seqscan = off`);
      // The EXACT shape query() emits for finance.transaction (primaryTime = posted_at, id-asc tiebreak).
      // #34b: finance is a serveDeduped sector, so query() ALSO appends `shadowed_by_id is null` — which
      // is exactly the partial predicate the recreated index now carries (migration 0009), so the planner
      // can still prove the partial index covers the query and serve it sort-free.
      const explain = await client.query(
        `explain (format json)
         select * from finance_transactions
         where user_id = $1 and deleted_at is null and shadowed_by_id is null
         order by posted_at desc, id asc
         limit 100`,
        [TEST_USER],
      );
      const root = (explain.rows[0]["QUERY PLAN"] as [{ Plan: PlanNode }])[0].Plan;

      const nodeTypes: string[] = [];
      const indexNames: string[] = [];
      walkPlan(root, (n) => {
        nodeTypes.push(n["Node Type"]);
        if (n["Index Name"]) indexNames.push(n["Index Name"]);
      });

      // An Index / Index-Only Scan serves the query...
      expect(nodeTypes.some((t) => t === "Index Scan" || t === "Index Only Scan")).toBe(true);
      // ...specifically the new partial index...
      expect(indexNames).toContain("finance_transactions_user_primarytime");
      // ...and the plan is sort-free (the index supplies the full ORDER BY).
      expect(nodeTypes).not.toContain("Sort");
      expect(nodeTypes).not.toContain("Incremental Sort");
    } finally {
      await client.query(`reset enable_seqscan`);
      client.release();
    }
  });

  it("the per-connection-drill scope index is retained alongside the new partial index", async () => {
    const { pool } = await import("../db.js");
    const res = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'finance_transactions'`,
    );
    const names = res.rows.map((r) => r.indexname);
    expect(names).toContain("finance_transactions_scope"); // (user_id, connection_id, posted_at) — kept
    expect(names).toContain("finance_transactions_user_primarytime"); // the new partial index
  });
});

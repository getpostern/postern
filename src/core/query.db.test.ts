// query v2 round-trips against a real Postgres, gated on DATABASE_URL so CI stays green.
// Seeds rows DIRECTLY via raw SQL (the established direct-insert test pattern — no connector code),
// under a dedicated throwaway user so concurrent test files can't contend. Proves:
//   * the per-sector smoke: query() runs for EVERY REGISTRY key (a missed deleted_at column anywhere
//     in the schema would fail here),
//   * tombstones (ADR 0004): a deleted_at row is invisible to rows AND aggregates, but getRecord
//     still returns it truthfully with deleted_at set,
//   * neq is null-INCLUSIVE (`is distinct from`), contains matches escaped wildcards literally,
//   * aggregation: count -> JSON number, sum -> decimal string; the health.sample `value` column
//     does not collide with the output's `value` (the __pci_agg alias case);
//   * default ordering (primaryTime desc) and offset paging.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "./query.js";
import { getRecord } from "./context.js";
import { REGISTRY } from "./schema.js";
import { ALL_SECTORS, type AuthContext } from "../auth/index.js";

const HAS_DB = !!process.env.DATABASE_URL;
// A DEDICATED throwaway user so these round-trips can't race other db test files (run in parallel).
const TEST_USER = "00000000-0000-0000-0000-0000000042a1";

const ctx: AuthContext = {
  userId: TEST_USER,
  agentId: "query-v2-test",
  grantedSectors: new Set(ALL_SECTORS),
};

describe.skipIf(!HAS_DB)("query v2 DB round-trips", () => {
  let credentialId: string;
  let financeConnId: string;
  let healthConnId: string;
  let tombstonedId: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(
      `insert into users (id, label) values ($1, 'query-v2-db-test') on conflict (id) do nothing`,
      [TEST_USER],
    );
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status)
       values ($1, 'simplefin', 'static_token', 'active') returning id`,
      [TEST_USER],
    );
    credentialId = cred.rows[0].id as string;

    // One credential, two sector connectors — connection_id anchors for the seeded domain rows.
    const fin = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', 'simplefin', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    financeConnId = fin.rows[0].id as string;
    const hea = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'health', 'whoop', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    healthConnId = hea.rows[0].id as string;

    // Three live transactions + one to tombstone. Amounts as strings -> exact pg numeric scale.
    const txn = async (sid: string, posted: string, amount: string, desc: string, category: string | null) => {
      // A deterministic `raw` payload per row so the jsonb-projection round-trip can assert the
      // returned object exactly (the find-then-detail path collapses query→get_record).
      const r = await pool.query(
        `insert into finance_transactions
           (connection_id, user_id, source_object_id, posted_at, amount, currency, description, category, raw)
         values ($1, $2, $3, $4, $5, 'USD', $6, $7, $8) returning id`,
        [financeConnId, TEST_USER, sid, posted, amount, desc, category, JSON.stringify({ memo: desc, sid })],
      );
      return r.rows[0].id as string;
    };
    await txn("qv2-t1", "2026-06-01T12:00:00Z", "-20.00", "Blue Bottle Coffee", "FOOD_AND_DRINK");
    await txn("qv2-t2", "2026-06-02T12:00:00Z", "-300.00", "Rent 100%_June", null);
    await txn("qv2-t3", "2026-06-03T12:00:00Z", "1500.00", "Paycheck", "INCOME");
    tombstonedId = await txn("qv2-t4", "2026-06-04T12:00:00Z", "-50.00", "Train ticket", "TRAVEL");
    // Tombstone via the dedicated UPDATE path's effect (ADR 0004): raw SQL, no connector involved.
    await pool.query(`update finance_transactions set deleted_at = now() where id = $1`, [tombstonedId]);

    // health.sample rows for the alias-collision case (a REAL column named `value`).
    const sample = async (sid: string, value: string) => {
      await pool.query(
        `insert into health_samples
           (connection_id, user_id, source_object_id, metric_type, value, unit, window_start)
         values ($1, $2, $3, 'heart_rate', $4, 'count/min', '2026-06-01T08:00:00Z')`,
        [healthConnId, TEST_USER, sid, value],
      );
    };
    await sample("qv2-s1", "10");
    await sample("qv2-s2", "10");
    await sample("qv2-s3", "20");
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: credential -> connectors -> domain rows.
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("smoke: query() with limit 1 succeeds for EVERY REGISTRY key (all nine tables)", async () => {
    for (const sector of Object.keys(REGISTRY)) {
      const out = await query(ctx, { sector, limit: 1 });
      expect(out.object).toBe(REGISTRY[sector].object);
    }
  });

  it("rows are deterministically ordered primaryTime desc by default; the tombstone is invisible", async () => {
    const out = await query(ctx, { sector: "finance.transaction", select: ["source_object_id"] });
    expect(out.count).toBe(3); // qv2-t4 is tombstoned
    expect((out as { rows: Array<{ source_object_id: string }> }).rows.map((r) => r.source_object_id))
      .toEqual(["qv2-t3", "qv2-t2", "qv2-t1"]);
  });

  it("the tombstoned row is excluded from aggregates too, but getRecord drills it truthfully", async () => {
    const agg = await query(ctx, { sector: "finance.transaction", aggregate: { fn: "count" } });
    // groupBy absent -> groups is EXACTLY [{ group: {}, value }]; count is a JSON number.
    expect((agg as { groups: unknown[] }).groups).toEqual([{ group: {}, value: 3 }]);

    const row = await getRecord(ctx, "finance.transaction", tombstonedId);
    expect(row).not.toBeNull();
    expect(row!.source_object_id).toBe("qv2-t4");
    expect(row!.deleted_at).not.toBeNull(); // the truthful drill: deleted_at VISIBLE (ADR 0004 #5)
  });

  it("neq INCLUDES null rows (is distinct from) — SimpleFIN's null categories don't vanish", async () => {
    const out = await query(ctx, {
      sector: "finance.transaction",
      where: { category: { neq: "FOOD_AND_DRINK" } },
      select: ["source_object_id", "category"],
    });
    const rows = (out as { rows: Array<{ source_object_id: string; category: string | null }> }).rows;
    expect(rows.map((r) => r.source_object_id).sort()).toEqual(["qv2-t2", "qv2-t3"]);
    expect(rows.some((r) => r.category === null)).toBe(true);
  });

  it("in matches against the array; contains matches escaped wildcards literally", async () => {
    const inOut = await query(ctx, {
      sector: "finance.transaction",
      where: { category: { in: ["INCOME", "TRAVEL"] } },
      select: ["source_object_id"],
    });
    expect(inOut.count).toBe(1); // TRAVEL row is tombstoned

    // "0%_J" appears literally in 'Rent 100%_June'; with unescaped wildcards "0%J" would also match.
    const literal = await query(ctx, {
      sector: "finance.transaction",
      where: { description: { contains: "0%_J" } },
    });
    expect(literal.count).toBe(1);
    const wildcard = await query(ctx, {
      sector: "finance.transaction",
      where: { description: { contains: "0%J" } },
    });
    expect(wildcard.count).toBe(0); // % is literal, not "anything"
  });

  it("sum-by-category returns decimal STRINGS, grouped/ordered by the aggregate desc", async () => {
    const out = await query(ctx, {
      sector: "finance.transaction",
      aggregate: { fn: "sum", field: "amount", groupBy: ["category"] },
    });
    const groups = (out as unknown as { groups: Array<{ group: { category: string | null }; value: unknown }> }).groups;
    expect(out.count).toBe(3);
    // Ordered by the summed value desc; values are precision-safe pg decimal strings.
    expect(groups.map((g) => g.value)).toEqual(["1500.00", "-20.00", "-300.00"]);
    expect(groups.map((g) => g.group.category)).toEqual(["INCOME", "FOOD_AND_DRINK", null]);
    expect((out as { aggregate: unknown }).aggregate).toEqual({ fn: "sum", field: "amount" });
  });

  it("count groupBy ['value'] on health.sample works (the __pci_agg alias-collision case)", async () => {
    const out = await query(ctx, {
      sector: "health.sample",
      aggregate: { fn: "count", groupBy: ["value"] },
    });
    const groups = (out as unknown as { groups: Array<{ group: { value: string }; value: number }> }).groups;
    // The REAL `value` column nests under group; the aggregate is the output `value`, a JSON number.
    expect(groups).toEqual([
      { group: { value: "10" }, value: 2 },
      { group: { value: "20" }, value: 1 },
    ]);
  });

  it("offset pages the ordered rows", async () => {
    const out = await query(ctx, {
      sector: "finance.transaction",
      select: ["source_object_id"],
      orderBy: [{ field: "posted_at", dir: "desc" }],
      limit: 1,
      offset: 1,
    });
    expect((out as { rows: Array<{ source_object_id: string }> }).rows).toEqual([
      { source_object_id: "qv2-t2" },
    ]);
  });

  it("select can project the `raw` jsonb — row includes the parsed object (collapses query→get_record)", async () => {
    const out = await query(ctx, {
      sector: "finance.transaction",
      where: { source_object_id: "qv2-t1" },
      select: ["source_object_id", "raw"],
    });
    const rows = (out as { rows: Array<{ source_object_id: string; raw: unknown }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].source_object_id).toBe("qv2-t1");
    expect(rows[0].raw).toEqual({ memo: "Blue Bottle Coffee", sid: "qv2-t1" });
  });

  it("select: ['raw'] projects ONLY raw (no flat columns)", async () => {
    const out = await query(ctx, {
      sector: "finance.transaction",
      where: { source_object_id: "qv2-t1" },
      select: ["raw"],
    });
    const rows = (out as { rows: Array<Record<string, unknown>> }).rows;
    expect(Object.keys(rows[0])).toEqual(["raw"]);
    expect(rows[0].raw).toEqual({ memo: "Blue Bottle Coffee", sid: "qv2-t1" });
  });

  it("default select (omitted) returns flat fields only — `raw` is NOT present (no payload regression)", async () => {
    const out = await query(ctx, {
      sector: "finance.transaction",
      where: { source_object_id: "qv2-t1" },
    });
    const rows = (out as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows[0]).not.toHaveProperty("raw");
    expect(rows[0]).toHaveProperty("source_object_id", "qv2-t1");
  });

  // ── #34b: the serveDeduped predicate (rows + aggregate) on a finance sector; non-dedup sectors unchanged ──
  it("serveDeduped (#34b): a shadowed finance row is hidden from rows AND aggregates; getRecord still drills it", async () => {
    const { pool } = await import("../db.js");
    // Seed ONE synthetic winner + ONE shadowed real on the finance.account table. The shadow has a
    // shadowed_by_id (→ the winner) so the new `shadowed_by_id is null` predicate must hide it everywhere.
    const winner = await pool.query(
      `insert into finance_accounts
         (connection_id, user_id, source_object_id, current_balance, balance_at, dedup_status)
       values ($1, $2, 'union:test:9000', '-100.00', '2026-06-01T00:00:00Z', 'winner') returning id`,
      [financeConnId, TEST_USER],
    );
    const winnerId = winner.rows[0].id as string;
    const shadow = await pool.query(
      `insert into finance_accounts
         (connection_id, user_id, source_object_id, current_balance, balance_at, dedup_status, shadowed_by_id)
       values ($1, $2, 'qv2-shadow', '-100.00', '2026-06-01T00:00:00Z', 'shadow', $3) returning id`,
      [financeConnId, TEST_USER, winnerId],
    );
    const shadowId = shadow.rows[0].id as string;
    try {
      // rows: only the winner is served (the shadow is hidden by the predicate).
      const rows = await query(ctx, { sector: "finance.account", select: ["source_object_id"] });
      const sids = (rows as { rows: Array<{ source_object_id: string }> }).rows.map((r) => r.source_object_id);
      expect(sids).toContain("union:test:9000");
      expect(sids).not.toContain("qv2-shadow");
      // aggregate: sum(current_balance) counts the −100 ONCE (the shadow is excluded before GROUP BY).
      const agg = await query(ctx, { sector: "finance.account", aggregate: { fn: "sum", field: "current_balance" } });
      expect(Number((agg as { groups: Array<{ value: unknown }> }).groups[0].value)).toBeCloseTo(-100, 2);
      // getRecord stays UNFILTERED — the shadowed real drills truthfully with its markers visible.
      const drilled = await getRecord(ctx, "finance.account", shadowId);
      expect(drilled).not.toBeNull();
      expect(drilled!.dedup_status).toBe("shadow");
      expect(drilled!.shadowed_by_id).toBe(winnerId);
    } finally {
      await pool.query(`delete from finance_accounts where id = any($1)`, [[shadowId, winnerId]]);
    }
  });

  // ── includeShadowed drill-through (finance-dedup-trust-batch): winner + shadows served together,
  //    linkage columns populated per row; txn rows carry only shadowed_by_id; aggregates opt in too ──
  it("includeShadowed: accounts drill returns winner + shadows with shadowed_by_id AND dedup_group_id populated", async () => {
    const { pool } = await import("../db.js");
    const groupId = "00000000-0000-0000-0000-0000000042d1";
    const winner = await pool.query(
      `insert into finance_accounts
         (connection_id, user_id, source_object_id, current_balance, balance_at, dedup_status, dedup_group_id)
       values ($1, $2, 'union:drill:1234', '-100.00', '2026-06-01T00:00:00Z', 'winner', $3) returning id`,
      [financeConnId, TEST_USER, groupId],
    );
    const winnerId = winner.rows[0].id as string;
    const shadow = await pool.query(
      `insert into finance_accounts
         (connection_id, user_id, source_object_id, current_balance, balance_at, dedup_status, shadowed_by_id, dedup_group_id)
       values ($1, $2, 'qv2-drill-shadow', '-100.00', '2026-06-01T00:00:00Z', 'shadow', $3, $4) returning id`,
      [financeConnId, TEST_USER, winnerId, groupId],
    );
    const shadowId = shadow.rows[0].id as string;
    try {
      // Default query: winner only (regression — the drill param absent changes nothing).
      const folded = await query(ctx, { sector: "finance.account", select: ["source_object_id"] });
      const foldedSids = (folded as { rows: Array<{ source_object_id: string }> }).rows.map((r) => r.source_object_id);
      expect(foldedSids).toContain("union:drill:1234");
      expect(foldedSids).not.toContain("qv2-drill-shadow");
      expect((folded as { rows: Array<Record<string, unknown>> }).rows[0]).not.toHaveProperty("shadowed_by_id");

      // Drill: BOTH rows served, each carrying the read-only linkage columns.
      const out = await query(ctx, { sector: "finance.account", includeShadowed: true });
      const rows = (out as { rows: Array<Record<string, unknown>> }).rows;
      const bySid = new Map(rows.map((r) => [r.source_object_id as string, r]));
      const w = bySid.get("union:drill:1234");
      const s = bySid.get("qv2-drill-shadow");
      expect(w).toBeDefined();
      expect(s).toBeDefined();
      expect(w!.shadowed_by_id).toBeNull(); // the served winner is not shadowed
      expect(w!.dedup_group_id).toBe(groupId);
      expect(s!.shadowed_by_id).toBe(winnerId); // linkage: shadow → its winner
      expect(s!.dedup_group_id).toBe(groupId); // linkage: both sides share the group anchor

      // Aggregate with includeShadowed INCLUDES the shadow (opt-in double-count by design): the
      // −100 pair sums to −200 where the default folded sum stays −100.
      const drillAgg = await query(ctx, {
        sector: "finance.account",
        where: { dedup_status: { in: ["winner", "shadow"] } },
        aggregate: { fn: "sum", field: "current_balance" },
        includeShadowed: true,
      });
      expect(Number((drillAgg as { groups: Array<{ value: unknown }> }).groups[0].value)).toBeCloseTo(-200, 2);
      const foldedAgg = await query(ctx, {
        sector: "finance.account",
        where: { dedup_status: { in: ["winner", "shadow"] } },
        aggregate: { fn: "sum", field: "current_balance" },
      });
      expect(Number((foldedAgg as { groups: Array<{ value: unknown }> }).groups[0].value)).toBeCloseTo(-100, 2);
    } finally {
      await pool.query(`delete from finance_accounts where id = any($1)`, [[shadowId, winnerId]]);
    }
  });

  it("includeShadowed: transaction rows carry ONLY shadowed_by_id (the table has no dedup_group_id)", async () => {
    const { pool } = await import("../db.js");
    const winner = await pool.query(
      `insert into finance_transactions
         (connection_id, user_id, source_object_id, posted_at, amount, currency, description, dedup_status)
       values ($1, $2, 'union:drill:txn', '2026-06-05T12:00:00Z', '-42.00', 'USD', 'drill winner', 'winner') returning id`,
      [financeConnId, TEST_USER],
    );
    const winnerId = winner.rows[0].id as string;
    const shadow = await pool.query(
      `insert into finance_transactions
         (connection_id, user_id, source_object_id, posted_at, amount, currency, description, dedup_status, shadowed_by_id)
       values ($1, $2, 'qv2-drill-txn-shadow', '2026-06-05T12:00:00Z', '-42.00', 'USD', 'drill shadow', 'shadow', $3) returning id`,
      [financeConnId, TEST_USER, winnerId],
    );
    const shadowId = shadow.rows[0].id as string;
    try {
      const out = await query(ctx, {
        sector: "finance.transaction",
        where: { description: { contains: "drill" } },
        includeShadowed: true,
      });
      const rows = (out as { rows: Array<Record<string, unknown>> }).rows;
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r).toHaveProperty("shadowed_by_id");
        expect(r).not.toHaveProperty("dedup_group_id"); // the column does not exist on this table
      }
      const s = rows.find((r) => r.source_object_id === "qv2-drill-txn-shadow");
      expect(s!.shadowed_by_id).toBe(winnerId);
    } finally {
      await pool.query(`delete from finance_transactions where id = any($1)`, [[shadowId, winnerId]]);
    }
  });

  it("includeShadowed on a non-dedup sector -> QueryValidationError naming the field (end-to-end via query())", async () => {
    const { QueryValidationError } = await import("./query.js");
    const err = await query(ctx, { sector: "health.sample", includeShadowed: true }).catch((e) => e);
    expect(err).toBeInstanceOf(QueryValidationError);
    expect(String(err.message)).toContain("includeShadowed");
  });

  it("non-dedup sector (#34b): a query() against `health.sample` emits NO shadowed_by_id clause (unchanged)", async () => {
    // The Approach-1 trap: a non-finance table has no shadowed_by_id column, so the predicate must NOT be
    // emitted there. If it were, this query would throw `column "shadowed_by_id" does not exist`.
    const out = await query(ctx, { sector: "health.sample", aggregate: { fn: "sum", field: "value" } });
    expect(Number((out as { groups: Array<{ value: unknown }> }).groups[0].value)).toBeCloseTo(40, 2); // 10+10+20
    const { buildSelect } = await import("./query.js");
    const built = buildSelect(ctx, { sector: "health.sample" });
    expect(built.sql).not.toContain("shadowed_by_id");
    const finBuilt = buildSelect(ctx, { sector: "finance.account" });
    expect(finBuilt.sql).toContain("shadowed_by_id");
  });

  // ── includeProvenance (#65/#122): "which source produced this row", served for EVERY sector.
  //    A real gate has several providers feeding contacts and calendar and neither sector is deduped,
  //    so the list is where identical rows become indistinguishable. Everything here is resolved
  //    server-side from the row's own connection_id — the column stays out of the REGISTRY (and so out
  //    of the ingest write allow-list), which is the constraint the whole shape is built around ──
  describe("includeProvenance", () => {
    const PROV = "qv2-prov-";
    let googleConn: string;
    let msConn: string;
    let appleConn: string;
    let calendarConn: string; // same google credential, DIFFERENT sector — the fail-closed case
    let otherUserId: string;
    let otherUserCredId: string;
    let otherUserConn: string;
    const provCreds: string[] = [];

    /** Insert one contacts row; returns its uuid. */
    async function insertContact(connectionId: string, userId: string, soid: string): Promise<string> {
      const { pool } = await import("../db.js");
      const r = await pool.query(
        `insert into contacts (connection_id, user_id, source_object_id, display_name, updated_at)
         values ($1, $2, $3, $4, '2026-07-01T00:00:00Z') returning id`,
        [connectionId, userId, soid, `Ada ${soid}`],
      );
      return r.rows[0].id as string;
    }

    /** One credential + one connector in `sector`, for TEST_USER. */
    async function connectorFor(provider: string, sector: string): Promise<string> {
      const { pool } = await import("../db.js");
      const cred = await pool.query(
        `insert into provider_credentials (user_id, provider, custody, status)
         values ($1, $2, 'first_party', 'active') returning id`,
        [TEST_USER, provider],
      );
      const credId = cred.rows[0].id as string;
      provCreds.push(credId);
      const conn = await pool.query(
        `insert into connectors (user_id, credential_id, sector, provider, status)
         values ($1, $2, $3, $4, 'active') returning id`,
        [TEST_USER, credId, sector, provider],
      );
      return conn.rows[0].id as string;
    }

    beforeAll(async () => {
      const { pool } = await import("../db.js");
      // The shape that produced the defect: THREE providers feeding one non-deduped sector.
      googleConn = await connectorFor("google", "contacts");
      msConn = await connectorFor("microsoft", "contacts");
      appleConn = await connectorFor("apple", "contacts");
      await insertContact(googleConn, TEST_USER, `${PROV}google`);
      await insertContact(msConn, TEST_USER, `${PROV}microsoft`);
      await insertContact(appleConn, TEST_USER, `${PROV}apple`);

      // A CALENDAR connector (on the google credential — unique(credential_id, sector) allows it) with a
      // CONTACTS row planted on it. Only reachable by corruption, which is the point: provenance must
      // not answer with a provider fact from a sector this read was not scoped to.
      const calCred = (
        await pool.query(
          `insert into provider_credentials (user_id, provider, custody, status)
           values ($1, 'google_cal_probe', 'first_party', 'active') returning id`,
          [TEST_USER],
        )
      ).rows[0].id as string;
      provCreds.push(calCred);
      calendarConn = (
        await pool.query(
          `insert into connectors (user_id, credential_id, sector, provider, status)
           values ($1, $2, 'calendar', 'google', 'active') returning id`,
          [TEST_USER, calCred],
        )
      ).rows[0].id as string;
      await insertContact(calendarConn, TEST_USER, `${PROV}crosssector`);

      // A SECOND user's contacts connection, with one of OUR rows planted on it (no composite FK
      // forbids it). Provenance must never resolve another user's connector.
      otherUserId = (
        await pool.query(`insert into users (label) values ('qv2-prov-other') returning id`)
      ).rows[0].id as string;
      otherUserCredId = (
        await pool.query(
          `insert into provider_credentials (user_id, provider, custody, status)
           values ($1, 'microsoft', 'first_party', 'active') returning id`,
          [otherUserId],
        )
      ).rows[0].id as string;
      otherUserConn = (
        await pool.query(
          `insert into connectors (user_id, credential_id, sector, provider, status)
           values ($1, $2, 'contacts', 'microsoft', 'active') returning id`,
          [otherUserId, otherUserCredId],
        )
      ).rows[0].id as string;
      await insertContact(otherUserConn, TEST_USER, `${PROV}crossuser`);
    });

    afterAll(async () => {
      const { pool } = await import("../db.js");
      // FK cascade: credential -> connectors -> contacts rows (including the planted ones).
      await pool.query(`delete from provider_credentials where id = any($1)`, [[...provCreds, otherUserCredId]]);
      await pool.query(`delete from users where id = $1`, [otherUserId]);
    });

    /** The provenance-bearing rows of the contacts fixture, keyed by source_object_id. */
    async function contactRows(
      params: { includeProvenance?: boolean; limit?: number } = {},
    ): Promise<{ out: Awaited<ReturnType<typeof query>>; bySoid: Map<string, Record<string, unknown>> }> {
      const out = await query(ctx, {
        sector: "contacts",
        where: { source_object_id: { contains: PROV } },
        orderBy: [{ field: "source_object_id", dir: "asc" }],
        ...params,
      });
      const rows = (out as { rows: Array<Record<string, unknown>> }).rows;
      return { out, bySoid: new Map(rows.map((r) => [r.source_object_id as string, r])) };
    }

    it("three providers feed contacts and EVERY row names its own connection + provider", async () => {
      const { bySoid } = await contactRows({ includeProvenance: true });
      expect(bySoid.get(`${PROV}google`)!.__provenance).toEqual({
        connection_id: googleConn,
        provider: "google",
        merged: false,
      });
      expect(bySoid.get(`${PROV}microsoft`)!.__provenance).toEqual({
        connection_id: msConn,
        provider: "microsoft",
        merged: false,
      });
      expect(bySoid.get(`${PROV}apple`)!.__provenance).toEqual({
        connection_id: appleConn,
        provider: "apple",
        merged: false,
      });
      // The defect this closes: three rows that were previously indistinguishable now differ.
      const providers = [`${PROV}google`, `${PROV}microsoft`, `${PROV}apple`].map(
        (s) => (bySoid.get(s)!.__provenance as { provider: string }).provider,
      );
      expect(new Set(providers).size).toBe(3);
    });

    it("the internal aliases never reach the caller (the served key is the synthetic one only)", async () => {
      const { bySoid } = await contactRows({ includeProvenance: true });
      const keys = Object.keys(bySoid.get(`${PROV}google`)!);
      expect(keys).toContain("__provenance");
      expect(keys).not.toContain("__pci_conn");
      expect(keys).not.toContain("__pci_soid");
      expect(keys).not.toContain("connection_id"); // never as a bare, REGISTRY-looking column
    });

    it("OFF by default: no row carries the key at all (absent means 'not asked', never 'unknown')", async () => {
      const { bySoid } = await contactRows();
      for (const row of bySoid.values()) expect(row).not.toHaveProperty("__provenance");
      const off = await contactRows({ includeProvenance: false });
      for (const row of off.bySoid.values()) expect(row).not.toHaveProperty("__provenance");
    });

    it("a REVOKED connection still names its provider — the row DID come from it", async () => {
      const { pool } = await import("../db.js");
      await pool.query(`update connectors set status = 'revoked' where id = $1`, [appleConn]);
      try {
        const { bySoid } = await contactRows({ includeProvenance: true });
        // describe_context hides revoked connections, so a client-side id→provider join would blank
        // this row. Resolved server-side it stays true.
        expect(bySoid.get(`${PROV}apple`)!.__provenance).toEqual({
          connection_id: appleConn,
          provider: "apple",
          merged: false,
        });
      } finally {
        await pool.query(`update connectors set status = 'active' where id = $1`, [appleConn]);
      }
    });

    it("a connection outside THIS sector resolves to null — never another sector's provider", async () => {
      const { bySoid } = await contactRows({ includeProvenance: true });
      // The planted row's connector is a real, active 'google' CALENDAR connection. Without the sector
      // clause this would answer "google" and leak a fact about a sector the read was not scoped to.
      expect(bySoid.get(`${PROV}crosssector`)!.__provenance).toEqual({
        connection_id: calendarConn,
        provider: null,
        merged: false,
      });
    });

    it("a connection owned by ANOTHER USER resolves to null — never that user's provider", async () => {
      const { bySoid } = await contactRows({ includeProvenance: true });
      expect(bySoid.get(`${PROV}crossuser`)!.__provenance).toEqual({
        connection_id: otherUserConn,
        provider: null,
        merged: false,
      });
    });

    it("a capped page resolves the SERVED rows only, and the probe row is still dropped", async () => {
      const { out, bySoid } = await contactRows({ includeProvenance: true, limit: 2 });
      expect(out.count).toBe(2);
      expect(out.has_more).toBe(true);
      expect(bySoid.size).toBe(2);
      for (const row of bySoid.values()) expect(row.__provenance).toBeDefined();
    });

    it("smoke: includeProvenance runs for EVERY REGISTRY key (every domain table has connection_id)", async () => {
      // The projected column is a hardcoded table fact. A future sector table without it would fail
      // HERE with `column "connection_id" does not exist`, not silently in front of a user.
      for (const sector of Object.keys(REGISTRY)) {
        const out = await query(ctx, { sector, limit: 1, includeProvenance: true });
        expect(out.object).toBe(REGISTRY[sector].object);
        for (const row of (out as { rows: Array<Record<string, unknown>> }).rows) {
          expect(row).toHaveProperty("__provenance");
        }
      }
    });

    it("a dedup SYNTHETIC winner says merged with no single connection; the real row names its provider", async () => {
      const { pool } = await import("../db.js");
      const synth = await pool.query(
        `insert into finance_accounts
           (connection_id, user_id, source_object_id, current_balance, balance_at, dedup_status)
         values ($1, $2, $3, '-100.00', '2026-06-01T00:00:00Z', 'winner') returning id`,
        [financeConnId, TEST_USER, `union:${PROV}merged`],
      );
      const real = await pool.query(
        `insert into finance_accounts
           (connection_id, user_id, source_object_id, current_balance, balance_at, dedup_status)
         values ($1, $2, $3, '-7.00', '2026-06-01T00:00:00Z', 'unique') returning id`,
        [financeConnId, TEST_USER, `${PROV}real`],
      );
      const ids = [synth.rows[0].id as string, real.rows[0].id as string];
      try {
        const out = await query(ctx, {
          sector: "finance.account",
          where: { source_object_id: { contains: PROV } },
          includeProvenance: true,
        });
        const rows = (out as { rows: Array<Record<string, unknown>> }).rows;
        const bySoid = new Map(rows.map((r) => [r.source_object_id as string, r]));
        // A synthetic stands for TWO providers' copies and stores the winning member's connection_id.
        // Serving that id would name one provider as THE source of a merged row — a half-truth.
        expect(bySoid.get(`union:${PROV}merged`)!.__provenance).toEqual({
          connection_id: null,
          provider: null,
          merged: true,
        });
        expect(bySoid.get(`${PROV}real`)!.__provenance).toEqual({
          connection_id: financeConnId,
          provider: "simplefin",
          merged: false,
        });
      } finally {
        await pool.query(`delete from finance_accounts where id = any($1)`, [ids]);
      }
    });

    it("a provider-written dedup_status 'winner' does NOT read as merged (the marker is unforgeable)", async () => {
      const { pool } = await import("../db.js");
      // dedup_status IS a REGISTRY field, so it is inside the ingest write allow-list: a connector can
      // legitimately write 'winner' onto its own row. If merged-ness were read off that column, this row
      // would report "merged, no single source" and ERASE its own provenance. The reserved `union:` soid
      // namespace is read instead — and applyRecords refuses a provider record that plants one.
      const forged = await pool.query(
        `insert into finance_accounts
           (connection_id, user_id, source_object_id, current_balance, balance_at, dedup_status)
         values ($1, $2, $3, '-3.00', '2026-06-01T00:00:00Z', 'winner') returning id`,
        [financeConnId, TEST_USER, `${PROV}forged-winner`],
      );
      const forgedId = forged.rows[0].id as string;
      try {
        const out = await query(ctx, {
          sector: "finance.account",
          where: { source_object_id: `${PROV}forged-winner` },
          includeProvenance: true,
        });
        const row = (out as { rows: Array<Record<string, unknown>> }).rows[0];
        expect(row.dedup_status).toBe("winner"); // the row really does claim it
        expect(row.__provenance).toEqual({
          connection_id: financeConnId,
          provider: "simplefin",
          merged: false,
        });
      } finally {
        await pool.query(`delete from finance_accounts where id = $1`, [forgedId]);
      }
    });

    it("aggregate + includeProvenance -> QueryValidationError naming the field (end-to-end via query())", async () => {
      const { QueryValidationError } = await import("./query.js");
      const err = await query(ctx, {
        sector: "contacts",
        aggregate: { fn: "count" },
        includeProvenance: true,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(QueryValidationError);
      expect(String(err.message)).toContain("includeProvenance");
    });
  });

  // ── agent-surface-semantics (#98 item 4): a capped page says so. The two boundary tests below
  //    must BOTH exist — either alone passes the broken `has_more = count === limit` shortcut ──
  describe("has_more", () => {
    /** Seven ordered rows under their own description prefix so the pages are deterministic. */
    async function seedSeven(): Promise<string[]> {
      const { pool } = await import("../db.js");
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) {
        const r = await pool.query(
          `insert into finance_transactions
             (connection_id, user_id, source_object_id, posted_at, amount, currency, description, merchant)
           values ($1, $2, $3, $4, '-1.00', 'USD', 'hasmore page row', $5) returning id`,
          [
            financeConnId,
            TEST_USER,
            `qv2-hm-${i}`,
            `2026-07-0${i + 1}T12:00:00Z`,
            `merchant-${i % 4}`, // 4 distinct merchants for the aggregate case
          ],
        );
        ids.push(r.rows[0].id as string);
      }
      return ids;
    }
    const WHERE = { description: "hasmore page row" } as const;

    it("a page that hits the cap reports has_more true and count equal to the page size", async () => {
      const { pool } = await import("../db.js");
      await seedSeven();
      try {
        const out = await query(ctx, { sector: "finance.transaction", where: WHERE, limit: 3 });
        expect(out.count).toBe(3);
        expect((out as { rows: unknown[] }).rows).toHaveLength(3);
        expect(out.has_more).toBe(true);
      } finally {
        await pool.query(`delete from finance_transactions where user_id = $1 and description = $2`, [
          TEST_USER,
          WHERE.description,
        ]);
      }
    });

    it("an exactly-full final page reports has_more false", async () => {
      const { pool } = await import("../db.js");
      const ids = await seedSeven();
      await pool.query(`delete from finance_transactions where id = any($1)`, [ids.slice(3)]); // keep 3
      try {
        const out = await query(ctx, { sector: "finance.transaction", where: WHERE, limit: 3 });
        expect(out.count).toBe(3);
        expect(out.has_more).toBe(false); // `count === limit` would wrongly say true here
      } finally {
        await pool.query(`delete from finance_transactions where user_id = $1 and description = $2`, [
          TEST_USER,
          WHERE.description,
        ]);
      }
    });

    it("the probe row is never returned to the caller", async () => {
      const { pool } = await import("../db.js");
      await seedSeven();
      try {
        const out = await query(ctx, {
          sector: "finance.transaction",
          where: WHERE,
          select: ["source_object_id"],
          orderBy: [{ field: "source_object_id", dir: "asc" }],
          limit: 3,
        });
        const sids = (out as { rows: Array<{ source_object_id: string }> }).rows.map(
          (r) => r.source_object_id,
        );
        expect(sids).toEqual(["qv2-hm-0", "qv2-hm-1", "qv2-hm-2"]);
        expect(sids).not.toContain("qv2-hm-3"); // the 4th row was fetched as the probe and dropped
      } finally {
        await pool.query(`delete from finance_transactions where user_id = $1 and description = $2`, [
          TEST_USER,
          WHERE.description,
        ]);
      }
    });

    it("aggregate groups are trimmed to the cap and flagged", async () => {
      const { pool } = await import("../db.js");
      await seedSeven(); // 4 distinct merchants
      try {
        const out = await query(ctx, {
          sector: "finance.transaction",
          where: WHERE,
          aggregate: { fn: "count", groupBy: ["merchant"] },
          limit: 2,
        });
        expect((out as { groups: unknown[] }).groups).toHaveLength(2);
        expect(out.count).toBe(2);
        expect(out.has_more).toBe(true);

        const all = await query(ctx, {
          sector: "finance.transaction",
          where: WHERE,
          aggregate: { fn: "count", groupBy: ["merchant"] },
        });
        expect(all.count).toBe(4);
        expect(all.has_more).toBe(false);
      } finally {
        await pool.query(`delete from finance_transactions where user_id = $1 and description = $2`, [
          TEST_USER,
          WHERE.description,
        ]);
      }
    });

    it("an empty result is has_more false, not undefined", async () => {
      const rows = await query(ctx, {
        sector: "finance.transaction",
        where: { description: "no such description anywhere" },
      });
      expect(rows.count).toBe(0);
      expect(rows.has_more).toBe(false);

      const agg = await query(ctx, {
        sector: "finance.transaction",
        where: { description: "no such description anywhere" },
        aggregate: { fn: "count", groupBy: ["merchant"] },
      });
      expect(agg.count).toBe(0);
      expect(agg.has_more).toBe(false);
    });
  });
});

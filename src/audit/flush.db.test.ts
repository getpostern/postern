// DB round-trip — gated on DATABASE_URL so CI stays green without Postgres. Starts the writer
// against the SHARED pool, audits a mix of allow + deny entries (one carrying a secret-bearing arg),
// flushes via stop(), and asserts the rows land in audit_log with the right tool/decision and a
// REDACTED arg. Also asserts at most one insert was in flight during the flush.

import { describe, it, expect, beforeAll, afterAll } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;
const SEED_USER = "00000000-0000-0000-0000-000000000001";

describe.skipIf(!HAS_DB)("audit-writer DB round-trip", () => {
  const requestId = `audit-test-${Date.now()}`;

  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from audit_log where request_id = $1`, [requestId]);
    await pool.end();
  });

  it("flushes allow + deny entries into audit_log with redacted args, ≤1 insert in flight", async () => {
    const { pool } = await import("../db.js");
    const { audit, startAuditWriter } = await import("./index.js");
    const { queue } = await import("./queue.js");

    // Wrap the shared pool so we can observe concurrency without changing behavior.
    let inFlight = 0;
    let maxInFlight = 0;
    const observing = {
      async query(sql: string, values: unknown[]) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await pool.query(sql, values);
        } finally {
          inFlight--;
        }
      },
    };

    // Big batchSize so the size trigger does NOT fire; we flush deterministically via stop().
    const stop = startAuditWriter({ pool: observing, intervalMs: 1_000_000, batchSize: 1_000_000 });

    audit({ userId: SEED_USER, agentId: "claude", tool: "query", sector: "finance", decision: "allow", resultCount: 7, requestId, args: { table: "finance.transaction", token: "should-be-hidden" } });
    audit({ userId: SEED_USER, agentId: "claude", tool: "invoke_action", sector: "home", decision: "deny", denyReason: "access denied: home", requestId });
    audit({ userId: SEED_USER, agentId: "claude", tool: "invoke_action", sector: "home", decision: "allow", outcome: "ok", requestId });

    expect(queue.size()).toBe(3);

    await stop(); // drain-flush best-effort
    expect(queue.size()).toBe(0);
    expect(maxInFlight).toBeLessThanOrEqual(1);

    const res = await pool.query(
      `select tool, decision, deny_reason, outcome, result_count, args
         from audit_log where request_id = $1 order by id asc`,
      [requestId],
    );
    expect(res.rows.length).toBe(3);

    const [allowQuery, denyAction, okAction] = res.rows;
    expect(allowQuery.tool).toBe("query");
    expect(allowQuery.decision).toBe("allow");
    expect(allowQuery.result_count).toBe(7);
    // args landed as jsonb with the secret-bearing key redacted.
    expect(allowQuery.args.table).toBe("finance.transaction");
    expect(allowQuery.args.token).toBe("[redacted]");

    expect(denyAction.tool).toBe("invoke_action");
    expect(denyAction.decision).toBe("deny");
    expect(denyAction.deny_reason).toBe("access denied: home");

    expect(okAction.decision).toBe("allow");
    expect(okAction.outcome).toBe("ok");
  });
});

// buildInsert — N entries → ONE parameterized multi-row insert, fixed column order, args bound as
// jsonb, values.length === N * 10. Pure + DB-free.

import { describe, it, expect } from "vitest";
import { buildInsert, COLS_PER_ROW } from "./insert.js";
import type { AuditEntry } from "./index.js";

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    userId: "u1",
    agentId: "claude",
    tool: "query",
    sector: "finance",
    decision: "allow",
    denyReason: null,
    args: { table: "finance.transaction" },
    resultCount: 3,
    outcome: null,
    requestId: "req-1",
    ...over,
  };
}

describe("buildInsert", () => {
  it("builds ONE insert into audit_log with the correct column order", () => {
    const { sql } = buildInsert([entry()]);
    expect(sql).toContain("insert into audit_log");
    expect(sql).toContain(
      "(user_id, agent_id, tool, sector, decision, deny_reason, args, result_count, outcome, request_id)",
    );
    // Exactly one INSERT statement.
    expect(sql.match(/insert into/gi)?.length).toBe(1);
  });

  it("binds args as jsonb (placeholder carries the ::jsonb cast)", () => {
    const { sql, values } = buildInsert([entry()]);
    expect(sql).toContain("$7::jsonb");
    // args is serialized to a JSON string for the jsonb bind.
    expect(values[6]).toBe(JSON.stringify({ table: "finance.transaction" }));
  });

  it("emits N rows and values.length === N * 10", () => {
    const entries = [entry(), entry({ tool: "invoke_action", decision: "deny", denyReason: "no grant", args: undefined }), entry()];
    const { sql, values } = buildInsert(entries);
    expect(values.length).toBe(entries.length * COLS_PER_ROW);
    expect(COLS_PER_ROW).toBe(10);

    // Three value tuples, each a 10-placeholder group, with monotonically increasing parameter indexes.
    expect(sql).toContain("$1");
    expect(sql).toContain(`$${entries.length * COLS_PER_ROW}`);
    // Three value tuples → two row separators between them.
    const tupleCount = sql.split("), (").length;
    expect(tupleCount).toBe(3);
  });

  it("maps fields to the right value positions, with null defaults", () => {
    const { values } = buildInsert([
      entry({ userId: null, agentId: null, sector: null, denyReason: null, args: undefined, resultCount: null, outcome: "error", requestId: null, decision: "allow", tool: "invoke_action" }),
    ]);
    expect(values[0]).toBeNull(); // user_id
    expect(values[1]).toBeNull(); // agent_id
    expect(values[2]).toBe("invoke_action"); // tool
    expect(values[3]).toBeNull(); // sector
    expect(values[4]).toBe("allow"); // decision
    expect(values[5]).toBeNull(); // deny_reason
    expect(values[6]).toBeNull(); // args (undefined → null)
    expect(values[7]).toBeNull(); // result_count
    expect(values[8]).toBe("error"); // outcome
    expect(values[9]).toBeNull(); // request_id
  });

  it("throws on an empty batch (the flusher only builds from a non-empty drain)", () => {
    expect(() => buildInsert([])).toThrow();
  });
});

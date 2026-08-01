// Pure-seam tests — DB-free, no connector registration side effects. Exercises the three
// deterministic seams the runner is built from: tableForObject, buildUpsert, isStale.

import { describe, it, expect } from "vitest";
import { tableForObject, buildUpsert } from "./runner.js";
import { isStale } from "./scheduler.js";

describe("tableForObject", () => {
  it("maps finance/transaction -> finance_transactions, key finance.transaction", () => {
    const out = tableForObject("finance", "transaction");
    expect(out.table).toBe("finance_transactions");
    expect(out.key).toBe("finance.transaction");
    expect(out.fields).toContain("source_object_id");
    expect(out.fields).toContain("amount");
  });

  it("maps finance/account -> finance_accounts, key finance.account", () => {
    const out = tableForObject("finance", "account");
    expect(out.table).toBe("finance_accounts");
    expect(out.key).toBe("finance.account");
    expect(out.fields).toContain("current_balance");
  });

  it("maps home/home_entity -> home_entities, bare key home", () => {
    const out = tableForObject("home", "home_entity");
    expect(out.table).toBe("home_entities");
    expect(out.key).toBe("home");
    expect(out.fields).toContain("entity_id");
  });

  it("throws (fail-closed) for an unmatched (sector, object)", () => {
    expect(() => tableForObject("nope", "nothing")).toThrow();
    // right object, wrong sector must also fail-closed (never guess a table)
    expect(() => tableForObject("home", "transaction")).toThrow();
  });
});

describe("buildUpsert", () => {
  it("emits a parameterized insert ... on conflict (connection_id, source_object_id) do update set ...", () => {
    const row = {
      connection_id: "conn-1",
      user_id: "user-1",
      source_object_id: "txn-1",
      amount: -12.5,
      description: "coffee",
      raw: { foo: "bar" },
      ingested_at: new Date("2026-01-01T00:00:00Z"),
    };
    const { sql, values } = buildUpsert("finance_transactions", row);

    // identifiers quoted, table quoted
    expect(sql).toContain('insert into "finance_transactions"');
    expect(sql).toContain("on conflict (\"connection_id\", \"source_object_id\") do update set");

    // every value parameterized; one placeholder per column
    expect(values.length).toBe(Object.keys(row).length);
    expect(sql).toContain("$" + values.length);
    // no literal value leaks into the SQL text
    expect(sql).not.toContain("coffee");
    expect(sql).not.toContain("-12.5");

    // update set excludes the two conflict keys, includes raw + ingested_at
    expect(sql).not.toMatch(/do update set[^]*"connection_id" = excluded/);
    expect(sql).not.toMatch(/do update set[^]*"source_object_id" = excluded/);
    expect(sql).toContain('"raw" = excluded."raw"');
    expect(sql).toContain('"ingested_at" = excluded."ingested_at"');
    expect(sql).toContain('"amount" = excluded."amount"');
  });

  it("throws when source_object_id is absent", () => {
    expect(() => buildUpsert("finance_transactions", { connection_id: "c", amount: 1 })).toThrow();
  });
});

describe("isStale", () => {
  it("null last-synced -> always stale", () => {
    expect(isStale(null, 3600)).toBe(true);
  });

  it("just-now date within tolerance -> not stale", () => {
    expect(isStale(new Date(), 3600)).toBe(false);
  });

  it("2h-old date beyond a 1h tolerance -> stale", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    expect(isStale(twoHoursAgo, 3600)).toBe(true);
  });

  it("undefined tolerance -> stale unless synced exactly now", () => {
    expect(isStale(new Date(Date.now() - 1), undefined)).toBe(true);
  });
});

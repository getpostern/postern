import { describe, it, expect } from "vitest";
import { REGISTRY, getSchema } from "./core/schema.js";

// Smoke test: proves the runner works AND that vitest resolves our NodeNext ".js" → ".ts" imports.
describe("smoke", () => {
  it("REGISTRY exposes finance.transaction backed by the right table", () => {
    expect(REGISTRY["finance.transaction"]?.table).toBe("finance_transactions");
  });

  it("getSchema prefix-matches a sector to all its objects", () => {
    expect(Object.keys(getSchema("finance")).sort()).toEqual([
      "finance.account",
      "finance.holding",
      "finance.transaction",
    ]);
  });
});

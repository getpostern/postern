// buildSelect (query v2) — DB-free. buildSelect is pure (the pool is never touched), so every
// operator's SQL shape + param positions, the null semantics, the runtime dir/fn whitelists, the
// ordering/offset/aggregate contracts, and the two NON-NEGOTIABLE clauses (user_id scope +
// "deleted_at" is null — in EVERY generated statement, rows and aggregate) are pinned here.

import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { buildSelect, DEDUP_LINKAGE_COLS, QueryValidationError, type QueryParams } from "./query.js";
import { REGISTRY } from "./schema.js";
import type { AuthContext } from "../auth/index.js";

const ctx: AuthContext = {
  userId: "u-1",
  agentId: "agent-x",
  grantedSectors: new Set(["finance", "health"]),
};

const TXN = "finance.transaction";

/** A stable row uuid for the `id` (uuid-typed) field assertions. */
const SOME_UUID = "11111111-2222-4333-8444-555555555555";

function build(params: Omit<QueryParams, "sector"> & { sector?: string }) {
  return buildSelect(ctx, { sector: TXN, ...params });
}

describe("where operators — SQL shape + param positions", () => {
  it("bare scalar value builds equality with the value as $1", () => {
    const { sql, values } = build({ where: { merchant: "Blue Bottle" } });
    expect(sql).toContain(`"merchant" = $1`);
    expect(values[0]).toBe("Blue Bottle");
  });

  it("eq builds = with the value parameterized", () => {
    const { sql, values } = build({ where: { category: { eq: "FOOD_AND_DRINK" } } });
    expect(sql).toContain(`"category" = $1`);
    expect(values[0]).toBe("FOOD_AND_DRINK");
  });

  it("gt/gte/lt/lte build comparisons in declaration order ($1..$4)", () => {
    const { sql, values } = build({
      where: { amount: { gt: -100, gte: -90, lt: 100, lte: 90 } },
    });
    expect(sql).toContain(`"amount" > $1`);
    expect(sql).toContain(`"amount" >= $2`);
    expect(sql).toContain(`"amount" < $3`);
    expect(sql).toContain(`"amount" <= $4`);
    expect(values.slice(0, 4)).toEqual([-100, -90, 100, 90]);
  });

  it("neq builds `is distinct from` (null-INCLUSIVE inequality)", () => {
    const { sql, values } = build({ where: { category: { neq: "FOOD_AND_DRINK" } } });
    expect(sql).toContain(`"category" is distinct from $1`);
    expect(values[0]).toBe("FOOD_AND_DRINK");
  });

  it("in builds `= any($n)` with the WHOLE array as ONE parameter", () => {
    const { sql, values } = build({ where: { category: { in: ["INCOME", "TRAVEL"] } } });
    expect(sql).toContain(`"category" = any($1)`);
    expect(values[0]).toEqual(["INCOME", "TRAVEL"]);
  });

  it("contains builds ilike with the escaped value wrapped in %...%", () => {
    const { sql, values } = build({ where: { description: { contains: "coffee" } } });
    expect(sql).toContain(`"description" ilike $1`);
    expect(values[0]).toBe("%coffee%");
  });

  it("an unsupported operator throws QueryValidationError naming the allowed set", () => {
    expect(() => build({ where: { amount: { like: "x" } } })).toThrow(QueryValidationError);
    expect(() => build({ where: { amount: { like: "x" } } })).toThrow(/eq, neq, gt, gte, lt, lte, in, contains/);
  });

  it("an unknown where field throws QueryValidationError", () => {
    expect(() => build({ where: { nope: 1 } })).toThrow(QueryValidationError);
    expect(() => build({ where: { nope: 1 } })).toThrow(/unknown field in where: nope/);
  });

  it("an empty operator object throws (never a silently dropped condition)", () => {
    expect(() => build({ where: { category: {} } })).toThrow(QueryValidationError);
  });

  it("a bare array value throws with a pointer to {in: [...]}", () => {
    expect(() => build({ where: { category: ["A", "B"] } })).toThrow(QueryValidationError);
    expect(() => build({ where: { category: ["A", "B"] } })).toThrow(/in:/);
  });
});

describe("null semantics", () => {
  it("bare null builds `is null` with NO parameter (the silent-match-nothing bug is dead)", () => {
    const { sql, values } = build({ where: { category: null } });
    expect(sql).toContain(`"category" is null`);
    // No agent value was parameterized — only the scope + limit params remain (limit = cap + the
    // one-row has_more probe, so 100 becomes 101 on the wire).
    expect(values).toEqual([ctx.userId, 101]);
  });

  it("{eq: null} builds `is null`", () => {
    const { sql } = build({ where: { category: { eq: null } } });
    expect(sql).toContain(`"category" is null`);
  });

  it("{neq: null} builds `is not null`", () => {
    const { sql, values } = build({ where: { category: { neq: null } } });
    expect(sql).toContain(`"category" is not null`);
    expect(values).toEqual([ctx.userId, 101]);
  });

  it("null with gt/gte/lt/lte/contains throws QueryValidationError", () => {
    for (const op of ["gt", "gte", "lt", "lte"]) {
      expect(() => build({ where: { amount: { [op]: null } } })).toThrow(QueryValidationError);
    }
    expect(() => build({ where: { description: { contains: null } } })).toThrow(QueryValidationError);
  });
});

describe("in — bounds and element validation", () => {
  it("an empty array is legal (matches nothing)", () => {
    const { sql, values } = build({ where: { category: { in: [] } } });
    expect(sql).toContain(`"category" = any($1)`);
    expect(values[0]).toEqual([]);
  });

  it("more than 200 elements throws", () => {
    const big = Array.from({ length: 201 }, (_, i) => `c${i}`);
    expect(() => build({ where: { category: { in: big } } })).toThrow(QueryValidationError);
    expect(() => build({ where: { category: { in: big } } })).toThrow(/200/);
  });

  it("a null element throws", () => {
    expect(() => build({ where: { category: { in: ["A", null] } } })).toThrow(QueryValidationError);
  });

  it("non-scalar elements (object/array) throw", () => {
    expect(() => build({ where: { category: { in: [{ a: 1 }] } } })).toThrow(QueryValidationError);
    expect(() => build({ where: { category: { in: [["nested"]] } } })).toThrow(QueryValidationError);
  });

  it("a non-array value for in throws", () => {
    expect(() => build({ where: { category: { in: "INCOME" } } })).toThrow(QueryValidationError);
  });
});

describe("contains — escaping and type rule", () => {
  it("escapes %, _ and \\ so they match literally (backslash = Postgres default ESCAPE)", () => {
    const { values } = build({ where: { description: { contains: "50%_off\\now" } } });
    expect(values[0]).toBe("%50\\%\\_off\\\\now%");
  });

  it("is only valid on text fields", () => {
    expect(() => build({ where: { amount: { contains: "5" } } })).toThrow(QueryValidationError);
    expect(() => build({ where: { pending: { contains: "t" } } })).toThrow(QueryValidationError);
    expect(() => build({ where: { posted_at: { contains: "2026" } } })).toThrow(QueryValidationError);
  });

  it("requires a string value", () => {
    expect(() => build({ where: { description: { contains: 42 } } })).toThrow(QueryValidationError);
  });
});

describe("operator/type rules", () => {
  it("range operators are invalid on bool fields", () => {
    for (const op of ["gt", "gte", "lt", "lte"]) {
      expect(() => build({ where: { pending: { [op]: true } } })).toThrow(QueryValidationError);
    }
  });

  it("eq/neq/in are valid on any type (bool shown)", () => {
    expect(() => build({ where: { pending: { eq: true } } })).not.toThrow();
    expect(() => build({ where: { pending: { neq: true } } })).not.toThrow();
    expect(() => build({ where: { pending: { in: [true, false] } } })).not.toThrow();
  });
});

describe("ordering (rows mode)", () => {
  it("defaults to primaryTime desc with the id asc tiebreak", () => {
    const { sql } = build({});
    expect(sql).toContain(`order by "posted_at" desc, "id" asc`);
  });

  it("explicit orderBy is honored (dir defaults to asc) and STILL gets the id tiebreak", () => {
    const { sql } = build({ orderBy: [{ field: "amount" }, { field: "posted_at", dir: "desc" }] });
    expect(sql).toContain(`order by "amount" asc, "posted_at" desc, "id" asc`);
  });

  it("an unknown orderBy field throws", () => {
    expect(() => build({ orderBy: [{ field: "nope" }] })).toThrow(QueryValidationError);
  });

  it("the id tiebreak is skipped when orderBy already names id (no doubled id)", () => {
    const { sql } = build({ orderBy: [{ field: "id", dir: "desc" }] });
    expect(sql).toMatch(/order by "id" desc limit/);
    expect(sql).not.toContain(`"id" desc, "id" asc`);

    const mixed = build({ orderBy: [{ field: "amount" }, { field: "id" }] });
    expect(mixed.sql).toMatch(/order by "amount" asc, "id" asc limit/);
  });
});

describe("limit / offset", () => {
  it("limit defaults to 100 and caps at 500, parameterized (the SQL asks for cap + 1 — the probe)", () => {
    expect(build({}).rowLimit).toBe(100);
    expect(build({}).values).toContain(101);
    expect(build({ limit: 9999 }).rowLimit).toBe(500);
    expect(build({ limit: 9999 }).values).toContain(501);
  });

  it("a non-integer or < 1 limit throws", () => {
    expect(() => build({ limit: 0 })).toThrow(QueryValidationError);
    expect(() => build({ limit: -5 })).toThrow(QueryValidationError);
    expect(() => build({ limit: 1.5 })).toThrow(QueryValidationError);
  });

  it("offset is parameterized and caps at 5000", () => {
    const { sql, values } = build({ offset: 40 });
    expect(sql).toMatch(/offset \$\d+$/);
    expect(values).toContain(40);
    expect(build({ offset: 99999 }).values).toContain(5000);
  });

  it("a negative or non-integer offset throws", () => {
    expect(() => build({ offset: -1 })).toThrow(QueryValidationError);
    expect(() => build({ offset: 2.5 })).toThrow(QueryValidationError);
  });
});

describe("select projection", () => {
  it("projects only validated columns; an unknown field throws", () => {
    const { sql } = build({ select: ["id", "amount"] });
    expect(sql).toContain(`select "id", "amount" from "finance_transactions"`);
    expect(() => build({ select: ["nope"] })).toThrow(QueryValidationError);
    expect(() => build({ select: ["nope"] })).toThrow(/unknown field in select: nope/);
  });

  it("projects a sector's jsonb columns (raw) for one-call detail — collapses query→get_record", () => {
    const both = build({ select: ["amount", "raw"] });
    expect(both.sql).toContain(`select "amount", "raw" from "finance_transactions"`);
    const onlyRaw = build({ select: ["raw"] });
    expect(onlyRaw.sql).toContain(`select "raw" from "finance_transactions"`);
  });

  it("a jsonb name the table LACKS throws (finance has only raw, not attendees/attributes)", () => {
    expect(() => build({ select: ["attendees"] })).toThrow(/unknown field in select: attendees/);
    expect(() => build({ select: ["attributes"] })).toThrow(/unknown field in select: attributes/);
  });

  it("default select (omitted) stays flat fields only — raw is NOT projected (no payload regression)", () => {
    const { sql } = build({});
    expect(sql).not.toContain(`"raw"`);
    expect(sql).toContain(`"source_object_id"`);
  });
});

describe("jsonb is PROJECTABLE but NOT filterable / sortable / aggregatable", () => {
  it("raw in where throws (bare and operator forms)", () => {
    expect(() => build({ where: { raw: "x" } })).toThrow(/unknown field in where: raw/);
    expect(() => build({ where: { raw: { eq: "x" } } })).toThrow(/unknown field in where: raw/);
  });

  it("raw in orderBy throws", () => {
    expect(() => build({ orderBy: [{ field: "raw" }] })).toThrow(/unknown field in orderBy: raw/);
  });

  it("raw in groupBy throws", () => {
    expect(() => build({ aggregate: { fn: "count", groupBy: ["raw"] } })).toThrow(
      /unknown field in groupBy: raw/,
    );
  });

  it("raw as the aggregate field throws", () => {
    expect(() => build({ aggregate: { fn: "sum", field: "raw" } })).toThrow(
      /unknown field in aggregate: raw/,
    );
  });

  it("calendar/home extra jsonb (attendees/attributes) are equally non-filterable", () => {
    expect(() => buildSelect(ctx, { sector: "calendar", where: { attendees: "x" } })).toThrow(
      /unknown field in where: attendees/,
    );
    expect(() => buildSelect(ctx, { sector: "home", orderBy: [{ field: "attributes" }] })).toThrow(
      /unknown field in orderBy: attributes/,
    );
  });
});

describe("jsonb projection — SQL-safety (REGISTRY-declared identifiers only)", () => {
  it("every REGISTRY jsonb column projects as a double-quoted, REGISTRY-sourced identifier", () => {
    for (const [sector, schema] of Object.entries(REGISTRY)) {
      for (const col of schema.jsonb ?? []) {
        const { sql } = buildSelect(ctx, { sector, select: [col] });
        expect(sql).toContain(`select "${col}" from "${schema.table}"`);
      }
    }
  });

  it("a prototype key is NEVER treated as a projectable jsonb column (value-match, not property lookup)", () => {
    // schema.jsonb.includes() compares VALUES, so "constructor"/"__proto__"/… are not members and throw.
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(() => buildSelect(ctx, { sector: "calendar", select: [key] })).toThrow(QueryValidationError);
      expect(() => buildSelect(ctx, { sector: "home", select: [key] })).toThrow(QueryValidationError);
    }
  });
});

describe("aggregate mode", () => {
  it("count is fieldless count(*) under the __pci_agg alias, ordered by its ordinal desc", () => {
    const { sql } = build({ aggregate: { fn: "count" } });
    expect(sql).toContain(`count(*) as "__pci_agg"`);
    expect(sql).not.toContain("group by");
    expect(sql).toContain(`order by 1 desc`);
  });

  it("sum-by-category groups/orders by ORDINALS (aggregate desc, then group asc)", () => {
    const { sql, values } = build({
      aggregate: { fn: "sum", field: "amount", groupBy: ["category"] },
    });
    expect(sql).toContain(`select "category", sum("amount") as "__pci_agg" from "finance_transactions"`);
    expect(sql).toContain(`group by 1`);
    expect(sql).toContain(`order by 2 desc, 1 asc`);
    expect(sql).toMatch(/limit \$\d+$/);
    expect(values).toContain(101); // group-count cap default (100) + the has_more probe
  });

  it("two group columns order by 3 desc, 1 asc, 2 asc", () => {
    const { sql } = build({
      aggregate: { fn: "count", groupBy: ["category", "currency"] },
    });
    expect(sql).toContain(`group by 1, 2`);
    expect(sql).toContain(`order by 3 desc, 1 asc, 2 asc`);
  });

  it("count with a field throws; sum/avg/min/max without a field throw", () => {
    expect(() => build({ aggregate: { fn: "count", field: "amount" } })).toThrow(QueryValidationError);
    for (const fn of ["sum", "avg", "min", "max"] as const) {
      expect(() => build({ aggregate: { fn } })).toThrow(QueryValidationError);
    }
  });

  it("sum/avg/min/max require a NUMERIC field (numeric-only V0)", () => {
    expect(() => build({ aggregate: { fn: "sum", field: "category" } })).toThrow(QueryValidationError);
    expect(() => build({ aggregate: { fn: "min", field: "posted_at" } })).toThrow(QueryValidationError);
  });

  it("an unknown aggregate/groupBy field throws", () => {
    expect(() => build({ aggregate: { fn: "sum", field: "nope" } })).toThrow(QueryValidationError);
    expect(() => build({ aggregate: { fn: "count", groupBy: ["nope"] } })).toThrow(QueryValidationError);
  });

  it("select/orderBy/offset alongside aggregate throw (cross-field rules live in core)", () => {
    const aggregate = { fn: "count" as const };
    expect(() => build({ aggregate, select: ["id"] })).toThrow(QueryValidationError);
    expect(() => build({ aggregate, orderBy: [{ field: "amount" }] })).toThrow(QueryValidationError);
    expect(() => build({ aggregate, offset: 10 })).toThrow(QueryValidationError);
  });

  it("where-filters apply BEFORE grouping (in the where clause, params first)", () => {
    const { sql, values } = build({
      where: { amount: { lt: 0 } },
      aggregate: { fn: "sum", field: "amount", groupBy: ["category"] },
    });
    expect(sql).toContain(`"amount" < $1`);
    expect(sql.indexOf("where")).toBeLessThan(sql.indexOf("group by"));
    expect(values[0]).toBe(0);
  });
});

describe("unknown sector", () => {
  it("buildSelect throws QueryValidationError for an unknown sector", () => {
    expect(() => buildSelect(ctx, { sector: "bogus" })).toThrow(QueryValidationError);
  });
});

describe("prototype-key whitelist bypass (every membership check is own-property-guarded)", () => {
  // Plain-object whitelists resolve JS prototype members as TRUTHY under an unguarded bracket read
  // (REGISTRY["constructor"] is the Function constructor, schema.fields["toString"] is a method, ...)
  // — each input position below must throw QueryValidationError, never validate or interpolate.
  const PROTO_KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"];

  for (const key of PROTO_KEYS) {
    it(`sector "${key}" throws`, () => {
      expect(() => buildSelect(ctx, { sector: key })).toThrow(QueryValidationError);
    });

    it(`where field "${key}" throws`, () => {
      // Computed key: a literal __proto__ key would set the prototype instead of an own property.
      expect(() => build({ where: { [key]: { eq: "x" } } })).toThrow(QueryValidationError);
    });

    it(`where operator "${key}" throws`, () => {
      expect(() => build({ where: { category: { [key]: "x" } } })).toThrow(QueryValidationError);
    });

    it(`select field "${key}" throws`, () => {
      expect(() => build({ select: [key] })).toThrow(QueryValidationError);
    });

    it(`orderBy field "${key}" throws`, () => {
      expect(() => build({ orderBy: [{ field: key }] })).toThrow(QueryValidationError);
    });

    it(`orderBy dir "${key}" throws`, () => {
      const params = {
        sector: TXN,
        orderBy: [{ field: "amount", dir: key }],
      } as unknown as QueryParams;
      expect(() => buildSelect(ctx, params)).toThrow(QueryValidationError);
    });

    it(`aggregate fn "${key}" throws`, () => {
      const params = { sector: TXN, aggregate: { fn: key } } as unknown as QueryParams;
      expect(() => buildSelect(ctx, params)).toThrow(QueryValidationError);
    });

    it(`aggregate field "${key}" throws`, () => {
      const params = { sector: TXN, aggregate: { fn: "sum", field: key } } as unknown as QueryParams;
      expect(() => buildSelect(ctx, params)).toThrow(QueryValidationError);
    });

    it(`groupBy element "${key}" throws`, () => {
      const params = { sector: TXN, aggregate: { fn: "count", groupBy: [key] } } as unknown as QueryParams;
      expect(() => buildSelect(ctx, params)).toThrow(QueryValidationError);
    });
  }

  it("a malicious dir fed through raw QueryParams (TS erased) throws, never interpolates", () => {
    const params = {
      sector: TXN,
      orderBy: [{ field: "amount", dir: "asc; drop table users--" }],
    } as unknown as QueryParams;
    expect(() => buildSelect(ctx, params)).toThrow(QueryValidationError);
  });

  it("a malicious fn fed through raw QueryParams (TS erased) throws, never interpolates", () => {
    const params = {
      sector: TXN,
      aggregate: { fn: "sum(amount)); drop table users--" },
    } as unknown as QueryParams;
    expect(() => buildSelect(ctx, params)).toThrow(QueryValidationError);
  });
});

describe("select / orderBy / groupBy hardening — caps and duplicates", () => {
  it("select allows at most 50 fields", () => {
    const big = Array.from({ length: 51 }, () => "id");
    expect(() => build({ select: big })).toThrow(QueryValidationError);
    expect(() => build({ select: big })).toThrow(/at most 50/);
  });

  it("orderBy allows at most 50 entries", () => {
    const big = Array.from({ length: 51 }, () => ({ field: "amount" }));
    expect(() => build({ orderBy: big })).toThrow(QueryValidationError);
    expect(() => build({ orderBy: big })).toThrow(/at most 50/);
  });

  it("a duplicate orderBy field throws", () => {
    const dup = [{ field: "amount" }, { field: "amount", dir: "desc" as const }];
    expect(() => build({ orderBy: dup })).toThrow(QueryValidationError);
    expect(() => build({ orderBy: dup })).toThrow(/duplicate field in orderBy: amount/);
  });

  it("groupBy allows at most 50 fields", () => {
    const big = Array.from({ length: 51 }, () => "category");
    expect(() => build({ aggregate: { fn: "count", groupBy: big } })).toThrow(QueryValidationError);
    expect(() => build({ aggregate: { fn: "count", groupBy: big } })).toThrow(/at most 50/);
  });

  it("a duplicate groupBy field throws", () => {
    const agg = { fn: "count" as const, groupBy: ["category", "category"] };
    expect(() => build({ aggregate: agg })).toThrow(QueryValidationError);
    expect(() => build({ aggregate: agg })).toThrow(/duplicate field in groupBy: category/);
  });
});

describe("user_id scope + tombstone filter in EVERY statement (exhaustive)", () => {
  // The two non-negotiable clauses, asserted over all nine REGISTRY keys x both modes.
  const variants: Array<(sector: string) => QueryParams> = [
    (sector) => ({ sector }), // rows, defaults
    // `id` is a uuid field, so the dressed variant must carry a uuid-shaped value.
    (sector) => ({ sector, where: { id: { neq: SOME_UUID } }, limit: 5, offset: 5 }), // rows, dressed
    (sector) => ({ sector, aggregate: { fn: "count" } }), // aggregate, ungrouped
    (sector) => ({ sector, aggregate: { fn: "count", groupBy: ["source_object_id"] } }), // aggregate, grouped
  ];

  for (const sector of Object.keys(REGISTRY)) {
    it(`${sector}: every variant carries the scope clause AND "deleted_at" is null`, () => {
      for (const make of variants) {
        const { sql, values } = buildSelect(ctx, make(sector));
        expect(sql).toContain(`"user_id" = $`);
        expect(sql).toContain(`"deleted_at" is null`);
        expect(values).toContain(ctx.userId);
      }
    });
  }
});

describe("includeShadowed — dedup drill-through (finance-dedup-trust-batch)", () => {
  // The default path must stay BYTE-IDENTICAL to before the param existed: exact-SQL pins, not
  // substring checks, so any accidental reshuffle of the generated statement fails loudly.
  it("default path (param absent) is byte-identical: exact SQL pin per dedup sector", () => {
    expect(buildSelect(ctx, { sector: "finance.account", select: ["id"] }).sql).toBe(
      `select "id" from "finance_accounts" where "user_id" = $1 and "deleted_at" is null and "shadowed_by_id" is null order by "balance_at" desc, "id" asc limit $2`,
    );
    expect(buildSelect(ctx, { sector: "finance.transaction", select: ["id"] }).sql).toBe(
      `select "id" from "finance_transactions" where "user_id" = $1 and "deleted_at" is null and "shadowed_by_id" is null order by "posted_at" desc, "id" asc limit $2`,
    );
    expect(buildSelect(ctx, { sector: "finance.holding", select: ["id"] }).sql).toBe(
      `select "id" from "finance_holdings" where "user_id" = $1 and "deleted_at" is null and "shadowed_by_id" is null order by "as_of" desc, "id" asc limit $2`,
    );
  });

  it("explicit includeShadowed: false === absent (identical SQL AND values)", () => {
    const absent = buildSelect(ctx, { sector: "finance.account", select: ["id"] });
    const explicit = buildSelect(ctx, { sector: "finance.account", select: ["id"], includeShadowed: false });
    expect(explicit.sql).toBe(absent.sql);
    expect(explicit.values).toEqual(absent.values);
  });

  it("true on accounts/holdings: predicate omitted + BOTH linkage columns appended after the select", () => {
    expect(buildSelect(ctx, { sector: "finance.account", select: ["id"], includeShadowed: true }).sql).toBe(
      `select "id", "shadowed_by_id", "dedup_group_id" from "finance_accounts" where "user_id" = $1 and "deleted_at" is null order by "balance_at" desc, "id" asc limit $2`,
    );
    expect(buildSelect(ctx, { sector: "finance.holding", select: ["id"], includeShadowed: true }).sql).toBe(
      `select "id", "shadowed_by_id", "dedup_group_id" from "finance_holdings" where "user_id" = $1 and "deleted_at" is null order by "as_of" desc, "id" asc limit $2`,
    );
  });

  it("true on transactions: ONLY shadowed_by_id is appended (the table has no dedup_group_id column)", () => {
    expect(buildSelect(ctx, { sector: "finance.transaction", select: ["id"], includeShadowed: true }).sql).toBe(
      `select "id", "shadowed_by_id" from "finance_transactions" where "user_id" = $1 and "deleted_at" is null order by "posted_at" desc, "id" asc limit $2`,
    );
  });

  it("default (omitted) select still appends the linkage columns at the end", () => {
    const { sql } = buildSelect(ctx, { sector: "finance.account", includeShadowed: true });
    expect(sql).toMatch(/"dedup_status", "shadowed_by_id", "dedup_group_id" from "finance_accounts"/);
  });

  it("aggregate mode with includeShadowed omits the shadow predicate (opt-in: shadow rows counted) but appends NO columns", () => {
    const on = buildSelect(ctx, { sector: "finance.account", aggregate: { fn: "count" }, includeShadowed: true });
    expect(on.sql).not.toContain("shadowed_by_id");
    // ... while the default aggregate keeps the fold (never double-counts).
    const off = buildSelect(ctx, { sector: "finance.account", aggregate: { fn: "count" } });
    expect(off.sql).toContain(`"shadowed_by_id" is null`);
  });

  it("a non-serveDeduped sector rejects the param (even false) with a typed 400 NAMING the field", () => {
    for (const params of [
      { sector: "health.sample", includeShadowed: true },
      { sector: "health.sample", includeShadowed: false },
      { sector: "mail", includeShadowed: true },
    ] satisfies QueryParams[]) {
      expect(() => buildSelect(ctx, params)).toThrow(QueryValidationError);
      expect(() => buildSelect(ctx, params)).toThrow(/includeShadowed/);
    }
  });

  it("every serveDeduped REGISTRY table has a DEDUP_LINKAGE_COLS entry (drift guard — review fold)", () => {
    // A future serveDeduped sector missing from the map would get predicate omission but silently
    // project no linkage columns; this pins the two declarations together.
    for (const [key, schema] of Object.entries(REGISTRY)) {
      if (schema.serveDeduped) {
        expect(Object.hasOwn(DEDUP_LINKAGE_COLS, schema.table), `REGISTRY '${key}' (${schema.table}) is serveDeduped but missing from DEDUP_LINKAGE_COLS`).toBe(true);
      }
    }
  });

  it("the linkage columns stay OUT of the query vocabulary: where/orderBy/groupBy/select reject them", () => {
    expect(() => build({ where: { shadowed_by_id: null } })).toThrow(/unknown field in where: shadowed_by_id/);
    expect(() => build({ orderBy: [{ field: "shadowed_by_id" }] })).toThrow(/unknown field in orderBy/);
    expect(() => build({ aggregate: { fn: "count", groupBy: ["shadowed_by_id"] } })).toThrow(/unknown field in groupBy/);
    expect(() => build({ select: ["shadowed_by_id"] })).toThrow(/unknown field in select/);
    expect(() =>
      buildSelect(ctx, { sector: "finance.account", select: ["dedup_group_id"] }),
    ).toThrow(/unknown field in select/);
  });

  it("the REGISTRY fields list (the ingest allow-list) never contains the linkage columns", () => {
    for (const key of ["finance.account", "finance.transaction", "finance.holding"]) {
      const fields = Object.keys(REGISTRY[key].fields);
      expect(fields).not.toContain("shadowed_by_id");
      expect(fields).not.toContain("dedup_group_id");
    }
  });
});

describe("includeProvenance — per-row provenance WITHOUT widening the write allow-list (#65/#122)", () => {
  it("default path (param absent) is byte-identical: exact SQL pin on a plain and a dedup sector", () => {
    expect(buildSelect(ctx, { sector: "contacts", select: ["id"] }).sql).toBe(
      `select "id" from "contacts" where "user_id" = $1 and "deleted_at" is null order by "updated_at" desc, "id" asc limit $2`,
    );
    expect(buildSelect(ctx, { sector: "finance.account", select: ["id"] }).sql).toBe(
      `select "id" from "finance_accounts" where "user_id" = $1 and "deleted_at" is null and "shadowed_by_id" is null order by "balance_at" desc, "id" asc limit $2`,
    );
  });

  it("explicit includeProvenance: false === absent (identical SQL AND values, every REGISTRY key)", () => {
    for (const sector of Object.keys(REGISTRY)) {
      const absent = buildSelect(ctx, { sector });
      const off = buildSelect(ctx, { sector, includeProvenance: false });
      expect(off.sql, sector).toBe(absent.sql);
      expect(off.values, sector).toEqual(absent.values);
      expect(off.sql, sector).not.toContain("connection_id");
    }
  });

  it("true on a non-dedup sector projects ONLY the aliased connection_id", () => {
    expect(buildSelect(ctx, { sector: "contacts", select: ["id"], includeProvenance: true }).sql).toBe(
      `select "id", "connection_id" as "__pci_conn" from "contacts" where "user_id" = $1 and "deleted_at" is null order by "updated_at" desc, "id" asc limit $2`,
    );
  });

  it("true on a serveDeduped sector ALSO projects the aliased soid (the merged marker)", () => {
    expect(buildSelect(ctx, { sector: "finance.account", select: ["id"], includeProvenance: true }).sql).toBe(
      `select "id", "connection_id" as "__pci_conn", "source_object_id" as "__pci_soid" from "finance_accounts" where "user_id" = $1 and "deleted_at" is null and "shadowed_by_id" is null order by "balance_at" desc, "id" asc limit $2`,
    );
  });

  it("composes with includeShadowed: linkage columns first, then the provenance aliases", () => {
    expect(
      buildSelect(ctx, {
        sector: "finance.account",
        select: ["id"],
        includeShadowed: true,
        includeProvenance: true,
      }).sql,
    ).toBe(
      `select "id", "shadowed_by_id", "dedup_group_id", "connection_id" as "__pci_conn", "source_object_id" as "__pci_soid" from "finance_accounts" where "user_id" = $1 and "deleted_at" is null order by "balance_at" desc, "id" asc limit $2`,
    );
  });

  it("every REGISTRY key projects the aliased connection_id, and never a bare one", () => {
    // The projected name is a HARDCODED table fact, so it must be right for all nine tables. A bare
    // `connection_id` on the wire would read as a REGISTRY field and invite exactly the widening this
    // design refuses; the alias is what keeps the served key synthetic.
    for (const sector of Object.keys(REGISTRY)) {
      const { sql } = buildSelect(ctx, { sector, select: ["id"], includeProvenance: true });
      expect(sql, sector).toContain(`"connection_id" as "__pci_conn"`);
      expect(sql, sector).not.toMatch(/select "id", "connection_id",/);
    }
  });

  it("aggregate mode rejects the param (even false) with a typed 400 NAMING the field", () => {
    for (const params of [
      { sector: TXN, aggregate: { fn: "count" as const }, includeProvenance: true },
      { sector: TXN, aggregate: { fn: "count" as const }, includeProvenance: false },
      { sector: "contacts", aggregate: { fn: "count" as const, groupBy: ["company"] }, includeProvenance: true },
    ] satisfies QueryParams[]) {
      expect(() => buildSelect(ctx, params)).toThrow(QueryValidationError);
      expect(() => buildSelect(ctx, params)).toThrow(/includeProvenance/);
    }
  });

  it("connection_id stays OUT of the query vocabulary on EVERY sector — even with provenance ON", () => {
    // The whole point: serving the column must not make it filterable, sortable, groupable or
    // selectable. Those four validators read `schema.fields`, which is ALSO the ingest write
    // allow-list, so a pass here is what keeps a provider from claiming its own connection.
    for (const sector of Object.keys(REGISTRY)) {
      const on = { includeProvenance: true } as const;
      expect(() => buildSelect(ctx, { sector, ...on, where: { connection_id: SOME_UUID } })).toThrow(
        /unknown field in where: connection_id/,
      );
      expect(() => buildSelect(ctx, { sector, ...on, select: ["connection_id"] })).toThrow(
        /unknown field in select: connection_id/,
      );
      expect(() => buildSelect(ctx, { sector, ...on, orderBy: [{ field: "connection_id" }] })).toThrow(
        /unknown field in orderBy: connection_id/,
      );
      expect(() =>
        buildSelect(ctx, { sector, aggregate: { fn: "count", groupBy: ["connection_id"] } }),
      ).toThrow(/unknown field in groupBy: connection_id/);
    }
  });

  it("the synthetic output key and the internal aliases are not addressable either", () => {
    for (const name of ["__provenance", "__pci_conn", "__pci_soid"]) {
      expect(() => build({ where: { [name]: "x" }, includeProvenance: true })).toThrow(QueryValidationError);
      expect(() => build({ select: [name], includeProvenance: true })).toThrow(QueryValidationError);
      expect(() => build({ orderBy: [{ field: name }], includeProvenance: true })).toThrow(QueryValidationError);
    }
  });
});

// ── agent-surface-semantics (#98): the docs map is NOT an allow-list, uuid values are typed, the
//    limit carries a has_more probe, and a bare multi-object sector TEACHES instead of refusing ──

describe("fieldDocs never widens the query vocabulary", () => {
  it("a name that exists only in fieldDocs is not queryable", () => {
    // The regression this unit must not cause: a future "helpful" `fields[f] ?? fieldDocs[f]` lookup
    // would make a documented-but-absent name reach SQL as a column.
    const docs = REGISTRY[TXN].fieldDocs as Record<string, string>;
    docs.__phantom = "documented but not a column";
    try {
      expect(() => build({ where: { __phantom: 1 } })).toThrow(QueryValidationError);
      expect(() => build({ select: ["__phantom"] })).toThrow(QueryValidationError);
      expect(() => build({ orderBy: [{ field: "__phantom" }] })).toThrow(QueryValidationError);
      expect(() => build({ aggregate: { fn: "sum", field: "__phantom" } })).toThrow(QueryValidationError);
      expect(() => build({ aggregate: { fn: "count", groupBy: ["__phantom"] } })).toThrow(
        QueryValidationError,
      );
    } finally {
      delete docs.__phantom;
    }
  });
});

describe("uuid field type — a typed 400 instead of a Postgres 22P02", () => {
  it("contains on the uuid id field is a typed error naming the type", () => {
    expect(() => build({ where: { id: { contains: "abc" } } })).toThrow(QueryValidationError);
    expect(() => build({ where: { id: { contains: "abc" } } })).toThrow(/uuid/);
  });

  it("eq on id requires a uuid-shaped value", () => {
    expect(() => build({ where: { id: "not-a-uuid" } })).toThrow(QueryValidationError);
    expect(() => build({ where: { id: { eq: "not-a-uuid" } } })).toThrow(/takes a uuid/);
    expect(() => build({ where: { id: { in: [randomUUID(), "nope"] } } })).toThrow(QueryValidationError);
    expect(() => build({ where: { id: { neq: "nope" } } })).toThrow(QueryValidationError);

    const good = randomUUID();
    const { sql, values } = build({ where: { id: good } });
    expect(sql).toContain(`"id" = $1`);
    expect(values[0]).toBe(good);
  });

  it("null on a uuid field still means IS NULL / IS NOT NULL (no value to validate)", () => {
    expect(build({ where: { id: null } }).sql).toContain(`"id" is null`);
    expect(build({ where: { id: { neq: null } } }).sql).toContain(`"id" is not null`);
  });

  it("a text id column (source_object_id) still takes arbitrary provider strings", () => {
    const { values } = build({ where: { source_object_id: "qv2-t1" } });
    expect(values[0]).toBe("qv2-t1");
  });
});

describe("has_more probe — the SQL asks for one row beyond the cap", () => {
  it("rows mode asks the database for limit + 1 and reports the requested cap", () => {
    const def = build({});
    expect(def.values[def.values.length - 1]).toBe(101);
    expect(def.rowLimit).toBe(100);

    const five = build({ limit: 5 });
    expect(five.values[five.values.length - 1]).toBe(6);
    expect(five.rowLimit).toBe(5);

    const capped = build({ limit: 9999 });
    expect(capped.values[capped.values.length - 1]).toBe(501);
    expect(capped.rowLimit).toBe(500);
  });

  it("aggregate mode also asks for one group beyond the cap", () => {
    const agg = build({ aggregate: { fn: "count", groupBy: ["merchant"] } });
    expect(agg.values[agg.values.length - 1]).toBe(101);
    expect(agg.rowLimit).toBe(100);
  });

  it("offset still lands after the limit parameter with the probe applied", () => {
    const { sql, values } = build({ limit: 10, offset: 20 });
    expect(sql).toMatch(/limit \$\d+ offset \$\d+$/);
    expect(values.slice(-2)).toEqual([11, 20]);
  });
});

describe("teaching errors for a bare multi-object sector", () => {
  /** Capture the thrown error so the MESSAGE can be asserted positively AND negatively. */
  function thrownBy(params: QueryParams): Error {
    try {
      buildSelect(ctx, params);
    } catch (e) {
      return e as Error;
    }
    throw new Error("buildSelect did not throw");
  }

  it("a bare multi-object sector names the dotted keys instead of 'unknown sector'", () => {
    const err = thrownBy({ sector: "finance" });
    expect(err).toBeInstanceOf(QueryValidationError);
    expect(err.message).toContain("finance.account");
    expect(err.message).toContain("finance.transaction");
    expect(err.message).toContain("finance.holding");
    expect(err.message).not.toMatch(/^unknown sector/);
  });

  it("a genuinely unknown sector lists the known keys", () => {
    const err = thrownBy({ sector: "banana" });
    expect(err).toBeInstanceOf(QueryValidationError);
    expect(err.message).toContain("unknown sector: banana");
    expect(err.message).toContain("mail");
    expect(err.message).toContain("finance.transaction");
  });
});

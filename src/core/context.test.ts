// getRecord's guards — DB-free, with `../db.js` mocked (the actions.test.ts pattern) so "no SQL was
// issued" is an assertion rather than a hope. Each guard exists because the unguarded path produced a
// WRONG STATUS: a bare Error → 500 for a sector describe_context had just advertised, and a pg 22P02
// for a malformed id (a raw driver message over MCP, an opaque 500 over the bearer mirror).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AccessDenied, type AuthContext } from "../auth/index.js";

const poolQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
vi.mock("../db.js", () => ({
  pool: { query: (...a: unknown[]) => (poolQuery as (...x: unknown[]) => unknown)(...a) },
}));

const { getRecord } = await import("./context.js");
const { QueryValidationError } = await import("./query.js");

const USER = "00000000-0000-0000-0000-000000000001";

function ctx(sectors: string[]): AuthContext {
  return { userId: USER, agentId: "test", grantedSectors: new Set(sectors) };
}

beforeEach(() => {
  poolQuery.mockClear();
});

describe("getRecord — guards before any SQL", () => {
  it("get_record on a bare multi-object sector is a typed error naming the dotted keys, with no SQL issued", async () => {
    const err = await getRecord(ctx(["finance"]), "finance", randomUUID()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryValidationError);
    expect((err as Error).message).toContain("get_record");
    expect((err as Error).message).toContain("finance.transaction");
    expect((err as Error).message).toContain("finance.account");
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("get_record with a malformed id returns null with no SQL issued", async () => {
    await expect(getRecord(ctx(["mail"]), "mail", "not-a-uuid")).resolves.toBeNull();
    await expect(getRecord(ctx(["mail"]), "mail", "")).resolves.toBeNull();
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("a well-formed id on a known sector DOES reach the database (the guards are not a blanket refusal)", async () => {
    const id = randomUUID();
    await expect(getRecord(ctx(["mail"]), "mail", id)).resolves.toBeNull(); // mocked: no rows
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = poolQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain(`from "mail_messages"`);
    expect(values).toEqual([id, USER]);
  });

  it("get_record denies an ungranted sector before the id is even inspected", async () => {
    const err = await getRecord(ctx([]), "mail", "not-a-uuid").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessDenied);
    expect(err).not.toBeInstanceOf(QueryValidationError);
    expect(poolQuery).not.toHaveBeenCalled();

    // Same ordering for the bare-multi-object case: the grant check wins over the teaching error.
    const err2 = await getRecord(ctx([]), "finance", "nope").catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(AccessDenied);
    expect(poolQuery).not.toHaveBeenCalled();
  });
});

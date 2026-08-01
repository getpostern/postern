import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the shared pool so the DB-free guard tests can assert pool.query is NEVER reached on a deny.
// vi.hoisted lets the spy exist before the hoisted vi.mock factory runs.
const { querySpy } = vi.hoisted(() => ({ querySpy: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query: querySpy } }));

import {
  ALL_SECTORS,
  sectorOf,
  assertSector,
  resolveLocal,
  resolveBearer,
  AccessDenied,
  type AuthContext,
} from "./index.js";
import { LOCAL_USER_ID } from "./sectors.js";
import { buildSelect, query } from "../core/query.js";
import { getRecord, fetchLive } from "../core/context.js";

// A ctx that connects but is granted nothing — every assertSector must deny (default-deny per call).
const emptyGrantCtx: AuthContext = {
  userId: "u-1",
  agentId: "agent-x",
  grantedSectors: new Set<string>(),
};

const financeCtx: AuthContext = {
  userId: "u-1",
  agentId: "agent-x",
  grantedSectors: new Set(["finance"]),
};

beforeEach(() => {
  querySpy.mockReset();
  querySpy.mockResolvedValue({ rowCount: 0, rows: [] });
});

describe("sector map", () => {
  it("ALL_SECTORS === the 6 coarse sectors", () => {
    expect([...ALL_SECTORS].sort()).toEqual(
      ["calendar", "contacts", "finance", "health", "home", "mail"].sort(),
    );
  });

  it("sectorOf maps dotted and bare keys to their coarse sector", () => {
    expect(sectorOf("finance.transaction")).toBe("finance");
    expect(sectorOf("health.sleep_session")).toBe("health");
    expect(sectorOf("mail")).toBe("mail");
  });

  it("sectorOf is fail-closed: an unknown target throws AccessDenied", () => {
    expect(() => sectorOf("bogus")).toThrow(AccessDenied);
    expect(() => sectorOf("bogus.thing")).toThrow(AccessDenied);
  });
});

describe("guard (assertSector)", () => {
  it("returns for a granted sector", () => {
    expect(() => assertSector(financeCtx, "finance.transaction")).not.toThrow();
  });

  it("throws AccessDenied with .sector set for an ungranted sector", () => {
    try {
      assertSector(financeCtx, "health.workout");
      throw new Error("expected AccessDenied");
    } catch (e) {
      expect(e).toBeInstanceOf(AccessDenied);
      expect((e as AccessDenied).sector).toBe("health");
    }
  });
});

describe("DENY BEFORE SQL (headline)", () => {
  it("query rejects with AccessDenied and pool.query is NEVER called", async () => {
    await expect(query(emptyGrantCtx, { sector: "finance.transaction" })).rejects.toBeInstanceOf(
      AccessDenied,
    );
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("getRecord rejects with AccessDenied and pool.query is NEVER called", async () => {
    await expect(getRecord(emptyGrantCtx, "finance.transaction", "id-1")).rejects.toBeInstanceOf(
      AccessDenied,
    );
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("fetchLive rejects with AccessDenied and pool.query is NEVER called", async () => {
    await expect(fetchLive(emptyGrantCtx, "finance.transaction")).rejects.toBeInstanceOf(
      AccessDenied,
    );
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe("read scoping (DB-free)", () => {
  it("buildSelect always appends the user_id scope clause with ctx.userId", () => {
    const { sql, values } = buildSelect(financeCtx, {
      sector: "finance.transaction",
      where: { pending: true },
    });
    expect(sql).toContain('"user_id" = $');
    expect(values).toContain(financeCtx.userId);
  });

  it("query runs the user-scoped SELECT for a granted sector", async () => {
    await query(financeCtx, { sector: "finance.transaction", select: ["id"] });
    expect(querySpy).toHaveBeenCalledTimes(1);
    const [sql, values] = querySpy.mock.calls[0];
    expect(sql).toContain('"user_id" = $');
    expect(values).toContain(financeCtx.userId);
  });
});

describe("local resolve", () => {
  it("resolves the operator with all sectors and the seed user id", async () => {
    const ctx = await resolveLocal();
    expect(ctx.agentId).toBe("operator");
    expect(ctx.userId).toBe(LOCAL_USER_ID);
    expect([...ctx.grantedSectors].sort()).toEqual([...ALL_SECTORS].sort());
    // It's a real Set, not a forged always-true object.
    expect(ctx.grantedSectors.has("nonsense")).toBe(false);
  });

  it("is memoized: two calls return the same instance", async () => {
    const a = await resolveLocal();
    const b = await resolveLocal();
    expect(a).toBe(b);
  });
});

// resolveBearer is exercised here against the MOCKED pool (so these run DB-free); the live
// round-trip against a real agent_grants table is covered in bearer.test.ts (gated on DATABASE_URL).
describe("resolveBearer (mocked pool)", () => {
  it("a grant of ['*'] pre-expands to ALL_SECTORS", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [{ user_id: "u-1", agent_id: "claude", sectors: ["*"], revoked_at: null }],
    });
    const ctx = await resolveBearer("secret-key");
    expect([...ctx.grantedSectors].sort()).toEqual([...ALL_SECTORS].sort());
  });

  it("hashes the bearer (sha256 hex), never queries by the raw key", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [{ user_id: "u-1", agent_id: "claude", sectors: ["finance"], revoked_at: null }],
    });
    await resolveBearer("secret-key");
    const [, values] = querySpy.mock.calls[0];
    expect(values[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(values[0]).not.toBe("secret-key");
  });

  it("intersects granted sectors with ALL_SECTORS (drops unknowns)", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [{ user_id: "u-1", agent_id: "claude", sectors: ["finance", "bogus"], revoked_at: null }],
    });
    const ctx = await resolveBearer("k");
    expect([...ctx.grantedSectors]).toEqual(["finance"]);
  });

  it("empty sectors is NOT an error — connects but denies every assertSector", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [{ user_id: "u-1", agent_id: "claude", sectors: [], revoked_at: null }],
    });
    const ctx = await resolveBearer("k");
    expect(ctx.grantedSectors.size).toBe(0);
    expect(() => assertSector(ctx, "finance.transaction")).toThrow(AccessDenied);
  });

  it("unknown hash throws AccessDenied", async () => {
    querySpy.mockResolvedValueOnce({ rows: [] });
    await expect(resolveBearer("nope")).rejects.toBeInstanceOf(AccessDenied);
  });

  it("revoked row throws AccessDenied", async () => {
    querySpy.mockResolvedValueOnce({
      rows: [{ user_id: "u-1", agent_id: "claude", sectors: ["finance"], revoked_at: new Date() }],
    });
    await expect(resolveBearer("k")).rejects.toBeInstanceOf(AccessDenied);
  });
});

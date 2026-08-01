// actions.ts wiring tests: listActions/invokeAction resolve the active connection for the sector,
// resolve the token, and delegate to the connector — with grant gating done FIRST. Audit is NOT
// wired here (that's the edge). DB + vault are mocked.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AuthContext } from "../auth/index.js";
import type { Connector, ActionSpec, ActionContext, ActionResult } from "../connectors/types.js";

const query = vi.fn();
vi.mock("../db.js", () => ({ pool: { query: (...a: unknown[]) => (query as (...x: unknown[]) => unknown)(...a) } }));

const open = vi.fn(async () => Buffer.from("the-token", "utf8"));
vi.mock("../secrets/index.js", () => ({ open: (...a: unknown[]) => (open as (...x: unknown[]) => unknown)(...a) }));

const { invokeAction, listActions } = await import("./actions.js");
const { registerConnector } = await import("../sync/index.js");
const { QueryValidationError } = await import("./query.js");

const USER = "00000000-0000-0000-0000-000000000001";
const CONN = "11111111-1111-1111-1111-111111111111";

function ctx(sectors: string[]): AuthContext {
  return { userId: USER, agentId: "test", grantedSectors: new Set(sectors) };
}

/** A spy HA-like connector that records execute/listActions calls. */
function spyConnector(
  specs: ActionSpec[] = [{ id: "home.light.turn_on", description: "x", params: [] }],
): Connector & {
  executeCalls: { actionId: string; params: Record<string, unknown>; ctx: ActionContext }[];
  listCalls: ActionContext[];
  listFilters: unknown[];
} {
  const executeCalls: { actionId: string; params: Record<string, unknown>; ctx: ActionContext }[] = [];
  const listCalls: ActionContext[] = [];
  const listFilters: unknown[] = [];
  return {
    provider: "home_assistant",
    sector: "home",
    objectType: "home_entity",
    policy: { mode: "push", supportsIncremental: false },
    actions: [],
    executeCalls,
    listCalls,
    listFilters,
    async *sync() {},
    normalize() {
      return {};
    },
    strongKeys() {
      return {};
    },
    async execute(actionId: string, params: Record<string, unknown>, c: ActionContext): Promise<ActionResult> {
      executeCalls.push({ actionId, params, ctx: c });
      return { ok: true, detail: { dispatched: true } };
    },
    async listActions(c: ActionContext, filter?: unknown): Promise<ActionSpec[]> {
      listCalls.push(c);
      listFilters.push(filter);
      return specs;
    },
  };
}

/** N distinct specs — the cap/truncation boundary cases. */
function manySpecs(n: number): ActionSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `home.light.turn_on_${String(i).padStart(3, "0")}`,
    description: "x",
    params: [],
  }));
}

/** pool returns the home connection row for the activeConnection lookup. */
function mockHomeConn() {
  query.mockReset();
  query.mockImplementation((sql: string) => {
    if (typeof sql === "string" && sql.includes("from connectors c")) {
      return Promise.resolve({ rows: [{ id: CONN, provider: "home_assistant", secret_ref: "sec_1" }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  query.mockReset();
  open.mockClear();
});

describe("invokeAction — wiring + gating", () => {
  it("denies an ungranted sector BEFORE any DB/connector work", async () => {
    await expect(invokeAction(ctx([]), "home.light.turn_on", {})).rejects.toMatchObject({ sector: "home" });
    expect(query).not.toHaveBeenCalled();
  });

  it("resolves the active connection, the token, and delegates to connector.execute", async () => {
    const c = spyConnector();
    registerConnector(c);
    mockHomeConn();

    const res = await invokeAction(ctx(["home"]), "home.light.turn_on", { area: "kitchen", brightness: 128 });

    expect(res.ok).toBe(true);
    expect(c.executeCalls).toHaveLength(1);
    const call = c.executeCalls[0];
    expect(call.actionId).toBe("home.light.turn_on");
    expect(call.params).toEqual({ area: "kitchen", brightness: 128 });
    expect(call.ctx.connectionId).toBe(CONN);
    expect(call.ctx.secret).toBe("the-token"); // token resolved + threaded (never logged)
    expect(open).toHaveBeenCalledWith("sec_1", { userId: USER, provider: "home_assistant", purpose: "access" });
  });

  it("no active connection → ok:false (never throws)", async () => {
    registerConnector(spyConnector());
    query.mockResolvedValue({ rows: [] }); // no connection row
    const res = await invokeAction(ctx(["home"]), "home.light.turn_on", {});
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/no active connection/);
  });
});

describe("listActions — delegation across granted sectors", () => {
  it("named sector: grant-checks then delegates to connector.listActions", async () => {
    const c = spyConnector();
    registerConnector(c);
    mockHomeConn();

    const out = await listActions(ctx(["home"]), "home");
    expect(out.actions.map((a) => a.id)).toEqual(["home.light.turn_on"]);
    expect(c.listCalls).toHaveLength(1);
    expect(c.listCalls[0].connectionId).toBe(CONN);
  });

  it("a named but ungranted sector throws", async () => {
    await expect(listActions(ctx([]), "home")).rejects.toMatchObject({ sector: "home" });
  });
});

// ── agent-surface-semantics (#98 item 6): the filter reaches the connector, the cap lives in core,
//    and a trimmed catalog says so instead of passing itself off as the whole action surface ──

describe("listActions — filter pass-through and the honest cap", () => {
  it("the area/domain/entityId filter reaches the connector verbatim", async () => {
    const c = spyConnector();
    registerConnector(c);
    mockHomeConn();

    await listActions(ctx(["home"]), "home", { domain: "light", area: "Kitchen", entityId: "light.k" });
    expect(c.listFilters).toHaveLength(1);
    expect(c.listFilters[0]).toEqual({ domain: "light", area: "Kitchen", entityId: "light.k" });
  });

  it("no filter at all leaves the connector's second argument undefined (byte-identical to before)", async () => {
    const c = spyConnector();
    registerConnector(c);
    mockHomeConn();

    await listActions(ctx(["home"]), "home");
    expect(c.listFilters[0]).toBeUndefined();
  });

  it("limit is not forwarded to the connector", async () => {
    const c = spyConnector();
    registerConnector(c);
    mockHomeConn();

    await listActions(ctx(["home"]), "home", { limit: 2 });
    // buildCatalog would ignore a `limit` key, so leaking it here would silently drop the cap.
    expect(c.listFilters[0]).toBeUndefined();

    await listActions(ctx(["home"]), "home", { domain: "light", limit: 2 });
    expect(c.listFilters[1]).toEqual({ domain: "light", area: undefined, entityId: undefined });
    expect(Object.keys(c.listFilters[1] as object)).not.toContain("limit");
  });

  it("a catalog longer than the cap is trimmed and flagged", async () => {
    registerConnector(spyConnector(manySpecs(150)));
    mockHomeConn();

    const out = await listActions(ctx(["home"]), "home");
    expect(out.actions).toHaveLength(100);
    expect(out.count).toBe(100);
    expect(out.truncated).toBe(true);
    expect(out.actions[0].id).toBe("home.light.turn_on_000"); // the head, not a random slice
  });

  it("a catalog exactly at the cap is not flagged", async () => {
    registerConnector(spyConnector(manySpecs(100)));
    mockHomeConn();

    const out = await listActions(ctx(["home"]), "home");
    expect(out.count).toBe(100);
    expect(out.truncated).toBe(false); // `>=` instead of `>` would fail here
  });

  it("limit is clamped to ACTION_LIMIT_MAX and rejects nonsense", async () => {
    registerConnector(spyConnector(manySpecs(600)));
    mockHomeConn();

    const out = await listActions(ctx(["home"]), "home", { limit: 9999 });
    expect(out.count).toBe(500);
    expect(out.actions).toHaveLength(500);
    expect(out.truncated).toBe(true);

    const under = await listActions(ctx(["home"]), "home", { limit: 3 });
    expect(under.count).toBe(3);
    expect(under.truncated).toBe(true);

    for (const bad of [0, -1, 1.5]) {
      await expect(listActions(ctx(["home"]), "home", { limit: bad })).rejects.toBeInstanceOf(
        QueryValidationError,
      );
    }
  });

  it("an ungranted named sector still throws before any connection lookup", async () => {
    await expect(listActions(ctx([]), "home", { domain: "light" })).rejects.toMatchObject({
      sector: "home",
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("no active connection yields an empty catalog, not a truncated one", async () => {
    registerConnector(spyConnector());
    query.mockResolvedValue({ rows: [] });

    const out = await listActions(ctx(["home"]), "home");
    expect(out).toEqual({ actions: [], count: 0, truncated: false });
  });
});

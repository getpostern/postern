// The action-catalog REST mirror (#89 item 2 / #58) — DB + vault mocked, the REAL core listActions.
//
// The mirror is deliberately exercised through core rather than with core stubbed: `truncated` and
// `count` are then computed by the same code the MCP surface uses, so a route that quietly reshaped
// the answer (the #58 re-commit: a bare array whose `.length` the Console reads) cannot pass.
//
// Proves: the served shape is core's ActionCatalog { actions, count, truncated }, VERBATIM and
// spec-for-spec; a trimmed catalog says so; an unknown sector and a DOTTED read key are typed 400s
// rather than a 403 / a silent empty catalog; and the route is localOnly (non-loopback Host -> 403).

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connector, ActionSpec, ActionContext, ActionResult } from "../connectors/types.js";

const query = vi.fn();
vi.mock("../db.js", () => ({ pool: { query: (...a: unknown[]) => (query as (...x: unknown[]) => unknown)(...a) } }));

const open = vi.fn(async () => Buffer.from("the-token", "utf8"));
vi.mock("../secrets/index.js", () => ({ open: (...a: unknown[]) => (open as (...x: unknown[]) => unknown)(...a) }));

const { getActionCatalog, actionCatalogRoute } = await import("./actions-routes.js");
const { registerConnector } = await import("../sync/index.js");
const { errorToStatus } = await import("./router.js");
const { ForbiddenHostError } = await import("./host-allowlist.js");
import type { RouteContext } from "./router.js";

const CONN = "11111111-1111-1111-1111-111111111111";

function fakeRes() {
  let status = 0;
  let body = "";
  const res = {
    headersSent: false,
    writeHead(s: number) {
      status = s;
      this.headersSent = true;
      return this;
    },
    setHeader() {},
    end(payload?: string) {
      if (payload) body += payload;
      this.headersSent = true;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    get status() {
      return status;
    },
    get payload() {
      return JSON.parse(body) as Record<string, unknown>;
    },
  };
}

function ctxFor(qs: string, host = "127.0.0.1:8787") {
  const r = fakeRes();
  const req = { headers: { host } } as unknown as IncomingMessage;
  const ctx: RouteContext = { req, res: r.res, params: {}, query: new URLSearchParams(qs) };
  return { ctx, r };
}

/** A spy HA-like connector serving a fixed catalog (the shape core delegates to). */
function spyConnector(specs: ActionSpec[]): Connector & { listFilters: unknown[] } {
  const listFilters: unknown[] = [];
  return {
    provider: "home_assistant",
    sector: "home",
    objectType: "home_entity",
    policy: { mode: "push", supportsIncremental: false },
    actions: [],
    listFilters,
    async *sync() {},
    normalize() {
      return {};
    },
    strongKeys() {
      return {};
    },
    async execute(): Promise<ActionResult> {
      return { ok: true };
    },
    async listActions(_c: ActionContext, filter?: unknown): Promise<ActionSpec[]> {
      listFilters.push(filter);
      return specs;
    },
  };
}

function specs(n: number): ActionSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `home.light.turn_on_${String(i).padStart(3, "0")}`,
    description: `spec ${i}`,
    params: [],
  }));
}

/**
 * pool answers the activeConnection lookup with a home connection — and ONLY for `home`. Sector-aware
 * on purpose: a mock that answered every sector would make the no-`sector` case (which enumerates all
 * six) report six copies of the same catalog, hiding what that case actually does.
 */
function mockHomeConn() {
  query.mockReset();
  query.mockImplementation((sql: string, values: unknown[]) => {
    if (typeof sql === "string" && sql.includes("from connectors c") && values?.[1] === "home") {
      return Promise.resolve({ rows: [{ id: CONN, provider: "home_assistant", secret_ref: "sec_1" }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
}

beforeEach(() => {
  query.mockReset();
  open.mockClear();
});

describe("GET /api/actions — the catalog SHAPE (the #58 re-commit guard)", () => {
  it("serves core's ActionCatalog: actions + count + truncated, never a bare array", async () => {
    registerConnector(spyConnector(specs(3)));
    mockHomeConn();
    const { ctx, r } = ctxFor("sector=home");

    await getActionCatalog(ctx);

    expect(r.status).toBe(200);
    // A bare array (or a `{specs}` rename) fails all three of these at once — which is the point: the
    // Console reads `.length` off the array and `truncated` off the envelope.
    expect(Array.isArray(r.payload)).toBe(false);
    expect(Object.keys(r.payload).sort()).toEqual(["actions", "count", "truncated"]);
    expect(r.payload.count).toBe(3);
    expect(r.payload.truncated).toBe(false);
    expect((r.payload.actions as ActionSpec[]).map((s) => s.id)).toEqual([
      "home.light.turn_on_000",
      "home.light.turn_on_001",
      "home.light.turn_on_002",
    ]);
  });

  it("hands the connector's specs through VERBATIM — no re-map, no field drop", async () => {
    const one: ActionSpec[] = [
      {
        id: "home.lock.lock",
        description: "Lock it",
        params: [{ name: "code", type: "string", required: false }],
        domain: "lock",
        service: "lock",
        target: { area: true, entity: true, domain: "lock" },
      },
    ];
    registerConnector(spyConnector(one));
    mockHomeConn();
    const { ctx, r } = ctxFor("sector=home");

    await getActionCatalog(ctx);

    // Deep equality against the connector's own object: a route that rebuilt the spec (dropping
    // `params`, `target`, or `service`) would serve a catalog an agent cannot invoke from.
    expect(r.payload.actions).toEqual(one);
  });

  it("a CAPPED catalog reports truncated:true — the silent-trim lie stays removed", async () => {
    registerConnector(spyConnector(specs(5)));
    mockHomeConn();
    const { ctx, r } = ctxFor("sector=home&limit=2");

    await getActionCatalog(ctx);

    expect(r.payload.count).toBe(2);
    expect((r.payload.actions as ActionSpec[]).length).toBe(2);
    expect(r.payload.truncated).toBe(true);
  });

  it("a genuinely EMPTY catalog is a 200 with actions:[] — not an error, not a 404", async () => {
    // The five read-only sectors: no connector registered for the sector -> nothing contributed.
    query.mockResolvedValue({ rows: [] });
    const { ctx, r } = ctxFor("sector=mail");

    await getActionCatalog(ctx);

    expect(r.status).toBe(200);
    expect(r.payload).toEqual({ actions: [], count: 0, truncated: false });
  });

  it("passes area/domain/entity_id to the connector; `entity_id` is the wire spelling of entityId", async () => {
    const c = spyConnector(specs(1));
    registerConnector(c);
    mockHomeConn();
    const { ctx } = ctxFor("sector=home&area=Kitchen&domain=light&entity_id=light.k");

    await getActionCatalog(ctx);

    // `limit` is a CORE cap and must NOT cross the connector seam (it would be silently ignored there).
    expect(c.listFilters).toEqual([{ area: "Kitchen", domain: "light", entityId: "light.k" }]);
  });
});

describe("GET /api/actions — sector validation (400, never 403 and never a silent empty)", () => {
  it("an unknown sector is a typed 400 naming it, not an AccessDenied 403", async () => {
    mockHomeConn();
    const { ctx } = ctxFor("sector=weather");
    const err = await caught(() => getActionCatalog(ctx));
    // Without the guard, core's assertSector -> sectorOf throws AccessDenied and the operator (who is
    // denied nothing) gets a 403 about a permission that does not exist.
    expect(errorToStatus(err).status).toBe(400);
    expect(String((err as Error).message)).toMatch(/weather/);
    expect(query).not.toHaveBeenCalled(); // rejected before any DB work
  });

  it("a DOTTED read key is a 400 — never a 200 with an empty catalog", async () => {
    registerConnector(spyConnector(specs(2)));
    mockHomeConn();
    const { ctx } = ctxFor("sector=home.entity");
    const err = await caught(() => getActionCatalog(ctx));
    // This is the dangerous one: "home.entity" PASSES assertSector (it reduces to the granted `home`),
    // then matches no connectors.sector row, so without the guard it 200s with actions:[] and the Home
    // lens calmly reports "no actions are exposed" for the one sector that has them.
    expect(errorToStatus(err).status).toBe(400);
    expect(String((err as Error).message)).toMatch(/home\.entity/);
  });

  it("no sector param = every granted sector (core's own semantics), not a 400", async () => {
    registerConnector(spyConnector(specs(1)));
    mockHomeConn();
    const { ctx, r } = ctxFor("");
    await getActionCatalog(ctx);
    expect(r.status).toBe(200);
    // All six sectors are enumerated; only `home` has a connection, so its one spec is the whole answer.
    expect(r.payload.count).toBe(1);
    expect(query.mock.calls.map((c) => (c[1] as unknown[])[1])).toEqual([
      "finance",
      "health",
      "mail",
      "contacts",
      "calendar",
      "home",
    ]);
  });

  it("a non-numeric limit is core's typed 400, not a coerced different question", async () => {
    registerConnector(spyConnector(specs(2)));
    mockHomeConn();
    const { ctx } = ctxFor("sector=home&limit=abc");
    const err = await caught(() => getActionCatalog(ctx));
    expect(errorToStatus(err).status).toBe(400);
    expect(String((err as Error).message)).toMatch(/limit/);
  });
});

describe("GET /api/actions — the loopback guard", () => {
  it("a non-loopback Host is refused (403) before the handler runs", async () => {
    registerConnector(spyConnector(specs(1)));
    mockHomeConn();
    const { ctx } = ctxFor("sector=home", "evil.com");
    const err = await caught(() => actionCatalogRoute(ctx));
    expect(err).toBeInstanceOf(ForbiddenHostError);
    expect(errorToStatus(err).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("a loopback Host is served", async () => {
    registerConnector(spyConnector(specs(1)));
    mockHomeConn();
    const { ctx, r } = ctxFor("sector=home", "localhost:8787");
    await actionCatalogRoute(ctx);
    expect(r.status).toBe(200);
    expect(r.payload.count).toBe(1);
  });
});

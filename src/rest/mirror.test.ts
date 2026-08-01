// Agent read-mirror — the bearer gate + audit behaviour, DB-free (core + authcontext mocked).
// Proves: no/invalid bearer -> 401 BEFORE any core call; an AccessDenied (ungranted sector) -> 403 +
// audit{deny}; a granted read -> the core result + audit{allow, resultCount}; the injected audit hook
// is fired OFF the response path (never awaited — a hanging/throwing hook cannot delay or break the
// response); get_schema is filtered to granted sectors; no secret/token ever appears in a payload.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AccessDenied } from "../auth/index.js";

// ── Mocks: authcontext.resolveBearer + the core read fns. The mirror must call resolveBearer FIRST.
const resolveBearer = vi.fn();
const describeContext = vi.fn();
const coreQuery = vi.fn();
const getRecord = vi.fn();
const fetchLive = vi.fn();

vi.mock("../auth/index.js", async () => {
  const actual = await vi.importActual<typeof import("../auth/index.js")>("../auth/index.js");
  return { ...actual, resolveBearer: (b: string) => resolveBearer(b) };
});
vi.mock("../core/context.js", async () => {
  // Keep the REAL NotFoundError/FetchLiveUnavailableError (router.errorToStatus instanceof-checks
  // them); mock only the data functions.
  const actual = await vi.importActual<typeof import("../core/context.js")>("../core/context.js");
  return {
    ...actual,
    describeContext: (...a: unknown[]) => describeContext(...a),
    getRecord: (...a: unknown[]) => getRecord(...a),
    fetchLive: (...a: unknown[]) => fetchLive(...a),
  };
});
vi.mock("../core/query.js", async () => {
  // Keep the REAL QueryValidationError (router.errorToStatus instanceof-checks it); mock only query.
  const actual = await vi.importActual<typeof import("../core/query.js")>("../core/query.js");
  return { ...actual, query: (...a: unknown[]) => coreQuery(...a) };
});

import { QueryValidationError } from "../core/query.js";
import { NotFoundError, FetchLiveUnavailableError } from "../core/context.js";
import {
  mirrorContext,
  mirrorSchema,
  mirrorQuery,
  mirrorGetRecord,
  mirrorFetchLive,
  operatorContext,
  operatorSchema,
  operatorFetchLive,
} from "./mirror.js";
import { REGISTRY } from "../core/schema.js";
import { ALL_SECTORS } from "../auth/index.js";
import { LOCAL_USER_ID } from "../auth/sectors.js";
import { errorToStatus, type RouteContext } from "./router.js";

/** A capturing fake ServerResponse. */
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
    get body() {
      return body;
    },
  };
}

/** A fake IncomingMessage carrying an Authorization header (or none). */
function fakeReq(auth?: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = auth ? { authorization: auth } : {};
  req.method = "GET";
  req.url = "/api/context";
  return req;
}

function rc(auth: string | undefined, opts: { params?: Record<string, string>; query?: string } = {}) {
  const r = fakeRes();
  const ctx: RouteContext = {
    req: fakeReq(auth),
    res: r.res,
    params: opts.params ?? {},
    query: new URLSearchParams(opts.query ?? ""),
  };
  return { ctx, r };
}

const GRANTED = {
  userId: "u1",
  agentId: "claude",
  grantedSectors: new Set(["finance"]),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bearer gate", () => {
  it("missing Authorization header -> 401, and resolveBearer/core are never called", async () => {
    const { ctx, r } = rc(undefined);
    await expect(mirrorContext(ctx)).rejects.toMatchObject({ name: "UnauthorizedError" });
    expect(resolveBearer).not.toHaveBeenCalled();
    expect(describeContext).not.toHaveBeenCalled();
    expect(r.status).toBe(0); // nothing written; the dispatcher maps the throw to 401
  });

  it("malformed Authorization header -> 401 (no 'Bearer ' prefix)", async () => {
    const { ctx } = rc("Basic abc");
    await expect(mirrorContext(ctx)).rejects.toMatchObject({ name: "UnauthorizedError" });
    expect(resolveBearer).not.toHaveBeenCalled();
  });

  it("resolveBearer throwing AccessDenied propagates (router -> 403); core never runs", async () => {
    resolveBearer.mockRejectedValueOnce(new AccessDenied());
    const { ctx } = rc("Bearer some-key");
    await expect(mirrorContext(ctx)).rejects.toBeInstanceOf(AccessDenied);
    expect(describeContext).not.toHaveBeenCalled();
  });
});

describe("audit on the mirror path", () => {
  it("granted describe_context -> core result + audit{allow, resultCount}", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    describeContext.mockResolvedValueOnce({ sectors: ["finance"], connections: [{ a: 1 }, { b: 2 }] });
    const audit = vi.fn();
    const { ctx, r } = rc("Bearer k", {});

    await mirrorContext(ctx, audit);
    expect(r.status).toBe(200);
    // Audit is fired off the response path (microtask) — flush it.
    await new Promise((res) => setImmediate(res));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      tool: "describe_context",
      decision: "allow",
      resultCount: 2,
      agentId: "claude",
    });
  });

  it("ungranted sector on query -> AccessDenied (403) + audit{deny}", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    coreQuery.mockRejectedValueOnce(new AccessDenied("health"));
    const audit = vi.fn();
    const { ctx } = rc("Bearer k");

    await expect(mirrorQuery(ctx, { sector: "health.sample" }, audit)).rejects.toBeInstanceOf(
      AccessDenied,
    );
    await new Promise((res) => setImmediate(res));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      tool: "query",
      decision: "deny",
      sector: "health",
    });
  });

  it("granted query -> rows + audit{allow, resultCount}", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    coreQuery.mockResolvedValueOnce({ sector: "finance.transaction", object: "transaction", count: 3, rows: [1, 2, 3] });
    const audit = vi.fn();
    const { ctx, r } = rc("Bearer k");

    await mirrorQuery(ctx, { sector: "finance.transaction" }, audit);
    expect(r.status).toBe(200);
    await new Promise((res) => setImmediate(res));
    // #9: the parsed DSL is recorded as args on the allow row (raw; redaction is central in audit()).
    expect(audit.mock.calls[0][0]).toMatchObject({
      tool: "query",
      decision: "allow",
      resultCount: 3,
      args: { sector: "finance.transaction" },
    });
  });

  it("an errored read (non-AccessDenied) now produces an audit row (was invisible) (#10-adjacent)", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    // A core failure that is NOT an AccessDenied: before this fold the mirror re-threw it WITHOUT
    // auditing, so the errored read left no trace at all.
    const err = new QueryValidationError("unknown field 'bogus'");
    coreQuery.mockRejectedValueOnce(err);
    const audit = vi.fn();
    const { ctx } = rc("Bearer k");

    await expect(mirrorQuery(ctx, { sector: "finance.transaction" }, audit)).rejects.toBe(err);
    await new Promise((res) => setImmediate(res));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      tool: "query",
      decision: "allow", // the read PASSED the grant; it failed in core (REST has no `outcome` field)
      sector: "finance", // baseSector of finance.transaction
      args: { sector: "finance.transaction" },
    });
    // The error STRING is captured (secret-free), never row data.
    expect(audit.mock.calls[0][0].denyReason).toContain("bogus");
  });

  it("get_record present -> resultCount 1; absent -> 0", async () => {
    resolveBearer.mockResolvedValue(GRANTED);
    getRecord.mockResolvedValueOnce({ id: "x" });
    const audit = vi.fn();
    const { ctx } = rc("Bearer k", { params: { sector: "finance.account", id: "x" } });
    await mirrorGetRecord(ctx, audit);
    await new Promise((res) => setImmediate(res));
    expect(audit.mock.calls[0][0]).toMatchObject({ tool: "get_record", decision: "allow", resultCount: 1 });
  });
});

describe("audit is OFF the response path (never awaited)", () => {
  it("a hook that never resolves does NOT delay or break the response", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    describeContext.mockResolvedValueOnce({ sectors: ["finance"], connections: [] });
    // A hook that hangs forever: if the handler awaited it, this test would time out.
    const audit = vi.fn(() => {
      return new Promise<void>(() => {}) as unknown as void;
    });
    const { ctx, r } = rc("Bearer k");
    await mirrorContext(ctx, audit);
    expect(r.status).toBe(200); // response served despite the hung hook
  });

  it("a hook that throws synchronously does NOT break the response", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    describeContext.mockResolvedValueOnce({ sectors: ["finance"], connections: [] });
    const audit = vi.fn(() => {
      throw new Error("audit sink down");
    });
    const { ctx, r } = rc("Bearer k");
    await expect(mirrorContext(ctx, audit)).resolves.toBeUndefined();
    expect(r.status).toBe(200);
  });
});

describe("query v2 passthrough (zod must not strip the new fields)", () => {
  it("POST an aggregate query: aggregate reaches core intact and the grouped output round-trips", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    const grouped = {
      sector: "finance.transaction",
      object: "transaction",
      aggregate: { fn: "sum", field: "amount" },
      count: 2,
      groups: [
        { group: { category: "INCOME" }, value: "1500.00" },
        { group: { category: null }, value: "-300.00" },
      ],
    };
    coreQuery.mockResolvedValueOnce(grouped);
    const { ctx, r } = rc("Bearer k");

    const body = {
      sector: "finance.transaction",
      where: { pending: false },
      aggregate: { fn: "sum", field: "amount", groupBy: ["category"] },
    };
    await mirrorQuery(ctx, body);

    // The aggregate (and where) survived queryBody.parse — the silent-strip bug stays dead.
    expect(coreQuery.mock.calls[0][1]).toMatchObject(body);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual(grouped);
  });

  it("orderBy and offset pass through to core", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    coreQuery.mockResolvedValueOnce({ sector: "finance.transaction", object: "transaction", count: 0, rows: [] });
    const { ctx } = rc("Bearer k");

    const body = {
      sector: "finance.transaction",
      orderBy: [{ field: "amount", dir: "desc" }, { field: "posted_at" }],
      offset: 40,
      limit: 20,
    };
    await mirrorQuery(ctx, body);
    expect(coreQuery.mock.calls[0][1]).toMatchObject(body);
  });

  it("includeShadowed passes through the .strict() edge to core intact (dedup drill-through)", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    coreQuery.mockResolvedValueOnce({ sector: "finance.account", object: "account", count: 0, rows: [] });
    const { ctx, r } = rc("Bearer k");

    const body = { sector: "finance.account", includeShadowed: true };
    await mirrorQuery(ctx, body);
    // The new key is DECLARED in queryBody — .strict() would 400 the whole feature otherwise.
    expect(coreQuery.mock.calls[0][1]).toMatchObject(body);
    expect(r.status).toBe(200);
  });

  it("a non-boolean includeShadowed is a 400 at the edge (core never runs)", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    const { ctx } = rc("Bearer k");

    const err = await mirrorQuery(ctx, { sector: "finance.account", includeShadowed: "yes" }).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(coreQuery).not.toHaveBeenCalled();
    const mapped = errorToStatus(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toContain("includeShadowed"); // names the offending field
  });

  it("a QueryValidationError from core surfaces as 400 with its message, not 500", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    const err = new QueryValidationError("offset cannot be combined with aggregate");
    coreQuery.mockRejectedValueOnce(err);
    const { ctx } = rc("Bearer k");

    // The handler rethrows; the dispatcher maps it via errorToStatus -> 400 + the actionable message.
    await expect(
      mirrorQuery(ctx, { sector: "finance.transaction", offset: 1, aggregate: { fn: "count" } }),
    ).rejects.toBe(err);
    expect(errorToStatus(err)).toEqual({
      status: 400,
      body: { error: "offset cannot be combined with aggregate" },
    });
  });
});

describe("strict query edge (#1 reject unknown params, #2 descriptive 400)", () => {
  it("an unknown body key is rejected with a 400 that NAMES the key (no silent strip, core never runs)", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    const { ctx } = rc("Bearer k");

    // `.strict()` makes the misnamed param throw a ZodError instead of being dropped (#1) — so the
    // edge rejects BEFORE core, and the flattened message NAMES the key so the agent self-corrects (#2).
    const err = await mirrorQuery(ctx, { sector: "finance.transaction", bogus: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(coreQuery).not.toHaveBeenCalled();

    const mapped = errorToStatus(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toContain("bogus"); // names the offending key
    expect(mapped.body.error).not.toBe("validation failed"); // non-generic (the #2 fix)
  });

  it("limit:0 returns a 400 whose message NAMES `limit` (non-generic)", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    const { ctx } = rc("Bearer k");

    // limit must be a positive int; 0 fails at the edge, so the descriptive 400 names `limit`.
    const err = await mirrorQuery(ctx, { sector: "finance.transaction", limit: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ZodError);
    expect(coreQuery).not.toHaveBeenCalled();

    const mapped = errorToStatus(err);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toContain("limit"); // names the offending field
    expect(mapped.body.error).not.toBe("validation failed"); // non-generic (the #2 fix)
  });
});

describe("fetch_live mirror — id end-to-end + the typed statuses", () => {
  it("id passes end-to-end: fetchLive receives (ctx, sector, { id }) and the record round-trips", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    const recordResult = {
      sector: "finance.transaction",
      mode: "record",
      id: "11111111-2222-3333-4444-555555555555",
      record: { source: "live" },
    };
    fetchLive.mockResolvedValueOnce(recordResult);
    const audit = vi.fn();
    const { ctx, r } = rc("Bearer k");

    await mirrorFetchLive(ctx, { sector: "finance.transaction", id: recordResult.id }, audit);

    expect(fetchLive).toHaveBeenCalledWith(GRANTED, "finance.transaction", { id: recordResult.id });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual(recordResult);
    // resultCount stays null in both modes (no audit-shape change).
    await new Promise((res) => setImmediate(res));
    expect(audit.mock.calls[0][0]).toMatchObject({ tool: "fetch_live", decision: "allow", resultCount: null });
  });

  it("without id the sync-mode result round-trips and { id: undefined } reaches core", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    const syncResult = { sector: "finance", mode: "sync", synced: true, timed_out: false, last_synced_at: null };
    fetchLive.mockResolvedValueOnce(syncResult);
    const { ctx, r } = rc("Bearer k");

    await mirrorFetchLive(ctx, { sector: "finance" });

    expect((fetchLive.mock.calls[0] as unknown[])[2]).toEqual({ id: undefined });
    expect(JSON.parse(r.body)).toEqual(syncResult);
  });

  it("a NotFoundError from core -> 404 with its message", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    const err = new NotFoundError("no active connection for sector 'finance'");
    fetchLive.mockRejectedValueOnce(err);
    const { ctx } = rc("Bearer k");

    await expect(mirrorFetchLive(ctx, { sector: "finance" })).rejects.toBe(err);
    expect(errorToStatus(err)).toEqual({
      status: 404,
      body: { error: "no active connection for sector 'finance'" },
    });
  });

  it("a FetchLiveUnavailableError from core -> 502 with its message", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    const err = new FetchLiveUnavailableError("source websocket not connected");
    fetchLive.mockRejectedValueOnce(err);
    const { ctx } = rc("Bearer k");

    await expect(mirrorFetchLive(ctx, { sector: "home", id: "x" })).rejects.toBe(err);
    expect(errorToStatus(err)).toEqual({
      status: 502,
      body: { error: "source websocket not connected" },
    });
  });

  it("a QueryValidationError from core still maps to 400 (bare multi-object sector with id)", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED);
    const err = new QueryValidationError(
      "fetch_live with id requires a full object key (finance.account or finance.transaction), got 'finance'",
    );
    fetchLive.mockRejectedValueOnce(err);
    const { ctx } = rc("Bearer k");

    await expect(mirrorFetchLive(ctx, { sector: "finance", id: "x" })).rejects.toBe(err);
    expect(errorToStatus(err).status).toBe(400);
  });
});

describe("get_schema filtered to granted sectors", () => {
  it("only returns objects in the caller's granted sectors", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED); // granted: finance only
    const { ctx, r } = rc("Bearer k");
    await mirrorSchema(ctx);
    const out = JSON.parse(r.body) as Record<string, unknown>;
    const keys = Object.keys(out);
    expect(keys.length).toBeGreaterThan(0);
    // Every returned key must be a finance object; no health/mail/etc leaks.
    for (const k of keys) expect(k.startsWith("finance")).toBe(true);
    expect(out["health.sample"]).toBeUndefined();
    expect(out["mail"]).toBeUndefined();
  });

  it("an ungranted explicit sector returns an empty object (no existence leak)", async () => {
    resolveBearer.mockResolvedValueOnce(GRANTED); // granted: finance only
    const { ctx, r } = rc("Bearer k", { query: "sector=health" });
    await mirrorSchema(ctx);
    expect(JSON.parse(r.body)).toEqual({});
  });
});

// ── The OPERATOR mirror (#89 fifth seam / #57 / #82) ──────────────────────────────────────────────
// The Console holds no agent key, so these three primitives 401'd at it and three drawn affordances
// were dead. What is asserted here is the SECURITY shape as much as the feature: the operator routes
// never consult the Authorization header (so a bearer cannot escalate into them), the bearer routes
// keep 401ing without one (so nothing widened), and the audit split is the deliberate one — the
// cache-only reads are unaudited like `/api/data/:sector`, the upstream-touching fetch_live is audited
// like its sibling POST /api/connectors/:id/sync.
describe("operator mirror — loopback, no bearer", () => {
  it("operatorSchema serves WITHOUT an Authorization header, and never resolves a bearer", async () => {
    const { ctx, r } = rc(undefined);
    await operatorSchema(ctx);
    expect(r.status).toBe(200);
    expect(resolveBearer).not.toHaveBeenCalled();
    const out = JSON.parse(r.body) as Record<string, unknown>;
    // Every REGISTRY object, because resolveLocal grants ALL_SECTORS — the same filter, a wider grant.
    expect(Object.keys(out).sort()).toEqual(Object.keys(REGISTRY).sort());
  });

  it("the BEARER schema route still 401s without a header — the agent path did not widen", async () => {
    const { ctx } = rc(undefined);
    await expect(mirrorSchema(ctx)).rejects.toMatchObject({ name: "UnauthorizedError" });
    const fl = rc(undefined);
    await expect(mirrorFetchLive(fl.ctx, { sector: "finance" })).rejects.toMatchObject({
      name: "UnauthorizedError",
    });
  });

  it("operatorSchema IGNORES a presented bearer — identity is loopback, not the header", async () => {
    // A one-sector agent key is offered. If the operator route consulted it, the answer would shrink to
    // finance — i.e. the header would be an identity input on a route that has no business reading one.
    resolveBearer.mockResolvedValue(GRANTED);
    const { ctx, r } = rc("Bearer k");
    await operatorSchema(ctx);
    expect(resolveBearer).not.toHaveBeenCalled();
    const out = JSON.parse(r.body) as Record<string, unknown>;
    expect(out["health.sample"]).toBeDefined();
    expect(Object.keys(out).sort()).toEqual(Object.keys(REGISTRY).sort());
  });

  it("operatorSchema narrows on ?sector= exactly like the bearer route", async () => {
    const { ctx, r } = rc(undefined, { query: "sector=finance" });
    await operatorSchema(ctx);
    const keys = Object.keys(JSON.parse(r.body) as Record<string, unknown>);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.startsWith("finance")).toBe(true);
  });

  it("operatorSchema on an unknown sector is an empty object, not a 500", async () => {
    const { ctx, r } = rc(undefined, { query: "sector=weather" });
    await operatorSchema(ctx);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({});
  });

  it("operatorContext calls core with the OPERATOR AuthContext", async () => {
    describeContext.mockResolvedValueOnce({ sectors: ALL_SECTORS, connections: [{ a: 1 }] });
    const { ctx, r } = rc(undefined);

    await operatorContext(ctx);

    expect(r.status).toBe(200);
    const passed = describeContext.mock.calls[0][0] as {
      userId: string;
      agentId: string;
      grantedSectors: ReadonlySet<string>;
    };
    expect(passed.userId).toBe(LOCAL_USER_ID);
    expect(passed.agentId).toBe("operator");
    expect([...passed.grantedSectors].sort()).toEqual([...ALL_SECTORS].sort());
  });

  // The "cache-only operator reads are unaudited" posture is enforced by the SIGNATURE, not by an
  // assertion: `operatorContext` / `operatorSchema` accept no AuditHook, so no call site can thread one
  // and typecheck fails if index.ts tries. A spy-based "was not called" test here would be vacuous by
  // construction — the hook it watches cannot reach the handler.
  it("operatorContext / operatorSchema take NO audit hook (arity 1) — the posture is type-enforced", () => {
    expect(operatorContext.length).toBe(1);
    expect(operatorSchema.length).toBe(1);
    // fetch_live, which touches upstream, DOES take one (ctx, body, audit).
    expect(operatorFetchLive.length).toBe(3);
  });

  it("operatorFetchLive IS audited — agentId 'operator', off the response path", async () => {
    fetchLive.mockResolvedValueOnce({ sector: "mail", mode: "sync", synced: true, timed_out: false });
    const audit = vi.fn();
    const { ctx, r } = rc(undefined);

    await operatorFetchLive(ctx, { sector: "mail" }, audit);

    expect(r.status).toBe(200);
    await new Promise((res) => setImmediate(res));
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      tool: "fetch_live",
      decision: "allow",
      agentId: "operator",
      userId: LOCAL_USER_ID,
      sector: "mail",
    });
  });

  it("the operator fetch_live audit is never AWAITED — a hung hook cannot delay the response", async () => {
    fetchLive.mockResolvedValueOnce({ sector: "mail", mode: "sync", synced: true, timed_out: false });
    // If the handler awaited the hook, this test would time out rather than fail.
    const audit = vi.fn(() => new Promise<void>(() => {}) as unknown as void);
    const { ctx, r } = rc(undefined);
    await operatorFetchLive(ctx, { sector: "mail" }, audit);
    expect(r.status).toBe(200);
  });

  it("operatorFetchLive threads the per-record drill id (the #57 mail-body case)", async () => {
    fetchLive.mockResolvedValueOnce({ sector: "mail", mode: "record", record: { body: "x" } });
    const { ctx } = rc(undefined);
    await operatorFetchLive(ctx, { sector: "mail", id: "msg-1" });
    expect(fetchLive.mock.calls[0][1]).toBe("mail");
    expect(fetchLive.mock.calls[0][2]).toEqual({ id: "msg-1" });
  });

  it("operatorFetchLive keeps the STRICT body — a misnamed id is a 400, not a whole-sector sync", async () => {
    const { ctx } = rc(undefined);
    await expect(operatorFetchLive(ctx, { sector: "mail", ids: "msg-1" })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(fetchLive).not.toHaveBeenCalled();
  });
});

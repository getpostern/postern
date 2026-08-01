// Operator verb → session sweep wiring (#99) — DB-free (the pool is mocked), so the contract is
// asserted in CI without Postgres: every verb that changes what an agent may do (mint/rotate, patch
// grants, revoke, delete) ENDS that agent's live MCP sessions, in this process, before it answers.
//
// The registry is REAL: a fake SessionEvictor is mounted with registerSessionStore, so these tests
// exercise the same endAgentSessions path the running gateway does — the wiring, not a mock of it.
//
// ORDER IS THE POINT on the mint path: the DB write must land BEFORE the sweep. A sweep first would
// leave a window in which a fresh initialize legitimately re-resolves the not-yet-rotated row.

import { describe, it, expect, vi, beforeEach } from "vitest";

// The DB pool: `query` for the simple routes, `connect` for postAgent's transaction. Hoisted,
// because the static imports below pull ../db.js in before a plain const would be initialized.
const { queryMock, clientQueryMock, releaseMock, connectMock } = vi.hoisted(() => {
  const clientQueryMock = vi.fn();
  const releaseMock = vi.fn();
  return {
    queryMock: vi.fn(),
    clientQueryMock,
    releaseMock,
    connectMock: vi.fn(async () => ({ query: clientQueryMock, release: releaseMock })),
  };
});
vi.mock("../db.js", () => ({ pool: { query: queryMock, connect: connectMock } }));

// SimpleFIN's claim helper is imported by admin.ts; stub it so the module loads (never called here).
vi.mock("../connectors/simplefin.js", () => ({ claimSetupToken: vi.fn() }));
// The bridge row kill is admin.ts's own concern and hits the transaction client; stub it out.
vi.mock("../mcp/oauth-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/oauth-bridge.js")>();
  return { ...actual, killBridgeRowsForGrant: vi.fn(async () => {}) };
});

import type { ServerResponse } from "node:http";
import type { RouteContext } from "./router.js";
import { LOCAL_USER_ID } from "../auth/sectors.js";
import { registerSessionStore, __resetSessionRegistryForTests } from "../mcp/bearer.js";

/** A minimal capturing fake ServerResponse. */
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
    get json(): unknown {
      return body ? JSON.parse(body) : undefined;
    },
  };
}

function ctxFor(params: Record<string, string> = {}) {
  const r = fakeRes();
  const ctx: RouteContext = {
    req: { headers: { host: "127.0.0.1:8787" } } as unknown as RouteContext["req"],
    res: r.res,
    params,
    query: new URLSearchParams(),
  };
  return { ctx, r };
}

/** The fake edge. `evictAgent` records its args and reports `ids` as the sessions it ended. */
function mountEvictor(ids: string[]): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  registerSessionStore({
    evictAgent(userId: string, agentId: string): string[] {
      calls.push([userId, agentId]);
      return ids;
    },
  });
  return { calls };
}

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
  __resetSessionRegistryForTests();
});

describe("POST /api/agents/:agentId/revoke", () => {
  it("revoking an agent ends its live sessions and reports the count", async () => {
    const { revokeAgent } = await import("./admin.js");
    const evictor = mountEvictor(["s-1", "s-2"]);
    queryMock.mockResolvedValue({ rows: [{ agent_id: "claude", revoked_at: "2026-07-25T10:00:00.000Z" }] });

    const { ctx, r } = ctxFor({ agentId: "claude" });
    await revokeAgent(ctx);

    // The RIGHT agent was swept — not "some agent".
    expect(evictor.calls).toEqual([[LOCAL_USER_ID, "claude"]]);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      agentId: "claude",
      revoked_at: "2026-07-25T10:00:00.000Z",
      sessions_ended: 2,
    });
  });

  it("reports 0 when the agent held no live session", async () => {
    const { revokeAgent } = await import("./admin.js");
    mountEvictor([]);
    queryMock.mockResolvedValue({ rows: [{ agent_id: "codex", revoked_at: "2026-07-25T11:00:00.000Z" }] });

    const { ctx, r } = ctxFor({ agentId: "codex" });
    await revokeAgent(ctx);
    expect((r.json as { sessions_ended: number }).sessions_ended).toBe(0);
  });

  it("an unknown agentId 400s and sweeps nothing", async () => {
    const { revokeAgent } = await import("./admin.js");
    const { ValidationError } = await import("./router.js");
    const evictor = mountEvictor(["s-1"]);
    queryMock.mockResolvedValue({ rows: [] }); // no row updated

    const { ctx } = ctxFor({ agentId: "ghost" });
    await expect(revokeAgent(ctx)).rejects.toBeInstanceOf(ValidationError);
    expect(evictor.calls).toEqual([]); // fail-closed: the row check comes first
  });
});

describe("PATCH /api/agents/:agentId", () => {
  it("patching an agent's sectors ends its live sessions", async () => {
    const { patchAgent } = await import("./admin.js");
    const evictor = mountEvictor(["s-9"]);
    queryMock.mockResolvedValue({
      rows: [
        {
          agent_id: "claude",
          sectors: ["finance"],
          created_at: "2026-07-01T00:00:00.000Z",
          revoked_at: null,
          expires_at: null,
        },
      ],
    });

    const { ctx, r } = ctxFor({ agentId: "claude" });
    await patchAgent(ctx, { sectors: ["finance"] });

    expect(evictor.calls).toEqual([[LOCAL_USER_ID, "claude"]]);
    // The response shape is UNCHANGED (the Console reads it) — the sweep is silent here.
    expect(r.json).toEqual({
      agentId: "claude",
      sectors: ["finance"],
      created_at: "2026-07-01T00:00:00.000Z",
      revoked_at: null,
      expires_at: null,
    });
  });

  it("sweeps on a WIDENING grant too — one rule, not a conditional one", async () => {
    const { patchAgent } = await import("./admin.js");
    const evictor = mountEvictor([]);
    queryMock.mockResolvedValue({
      rows: [
        {
          agent_id: "claude",
          sectors: ["finance", "home", "mail"],
          created_at: "2026-07-01T00:00:00.000Z",
          revoked_at: null,
          expires_at: null,
        },
      ],
    });
    const { ctx } = ctxFor({ agentId: "claude" });
    await patchAgent(ctx, { sectors: ["finance", "home", "mail"] });
    expect(evictor.calls).toEqual([[LOCAL_USER_ID, "claude"]]);
  });

  it("an unknown agentId 400s and sweeps nothing", async () => {
    const { patchAgent } = await import("./admin.js");
    const { ValidationError } = await import("./router.js");
    const evictor = mountEvictor(["s-1"]);
    queryMock.mockResolvedValue({ rows: [] });

    const { ctx } = ctxFor({ agentId: "ghost" });
    await expect(patchAgent(ctx, { sectors: ["finance"] })).rejects.toBeInstanceOf(ValidationError);
    expect(evictor.calls).toEqual([]);
  });
});

describe("POST /api/agents (mint / rotate)", () => {
  it("minting/rotating a key ends sessions cached from the old key, AFTER the commit", async () => {
    const { postAgent } = await import("./admin.js");
    const order: string[] = [];
    clientQueryMock.mockImplementation(async (sql: string) => {
      order.push(typeof sql === "string" ? sql.trim().split(/\s+/)[0].toLowerCase() : "?");
      return { rows: [{ id: "grant-1", expires_at: null }] };
    });
    registerSessionStore({
      evictAgent(): string[] {
        order.push("sweep");
        return ["s-old-key"];
      },
    });

    const { ctx, r } = ctxFor();
    await postAgent(ctx, { agentId: "claude", sectors: ["finance"] });

    expect(r.status).toBe(201);
    // Rotation is the compromise response: a session cached off the OLD key must die with it — but
    // only once the new key_hash is durable. commit BEFORE sweep, always.
    expect(order).toEqual(["begin", "insert", "commit", "sweep"]);
  });

  it("a failed transaction rolls back and sweeps nothing", async () => {
    const { postAgent } = await import("./admin.js");
    const evictor = mountEvictor(["s-1"]);
    clientQueryMock.mockImplementation(async (sql: string) => {
      if (typeof sql === "string" && sql.trim().startsWith("insert")) throw new Error("constraint blew up");
      return { rows: [] };
    });

    const { ctx } = ctxFor();
    await expect(postAgent(ctx, { agentId: "claude", sectors: ["finance"] })).rejects.toThrow(
      /constraint blew up/,
    );
    expect(evictor.calls).toEqual([]); // the old key is still live — do NOT kill its sessions
  });
});

describe("DELETE /api/agents/:agentId", () => {
  it("removing a revoked agent sweeps idempotently and keeps its response shape", async () => {
    const { deleteAgent } = await import("./admin.js");
    const evictor = mountEvictor([]);
    queryMock.mockResolvedValue({ rows: [{ agent_id: "claude" }] });

    const { ctx, r } = ctxFor({ agentId: "claude" });
    await deleteAgent(ctx);

    expect(evictor.calls).toEqual([[LOCAL_USER_ID, "claude"]]);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true }); // unchanged — the Console reads exactly this
  });

  it("a not-yet-revoked agent 400s and sweeps nothing", async () => {
    const { deleteAgent } = await import("./admin.js");
    const { ValidationError } = await import("./router.js");
    const evictor = mountEvictor(["s-1"]);
    // The delete matches no row (revoked_at is null), then the existence probe finds the row.
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ "?column?": 1 }] });

    const { ctx } = ctxFor({ agentId: "claude" });
    await expect(deleteAgent(ctx)).rejects.toBeInstanceOf(ValidationError);
    expect(evictor.calls).toEqual([]);
  });
});

describe("the sweep is best-effort — it can never fail an operator verb", () => {
  it("a throwing edge does not turn a successful revoke into a 500", async () => {
    const { revokeAgent } = await import("./admin.js");
    registerSessionStore({
      evictAgent(): string[] {
        throw new Error("that edge is wedged");
      },
    });
    queryMock.mockResolvedValue({ rows: [{ agent_id: "claude", revoked_at: "2026-07-25T12:00:00.000Z" }] });

    const { ctx, r } = ctxFor({ agentId: "claude" });
    await expect(revokeAgent(ctx)).resolves.toBeUndefined();
    expect(r.status).toBe(200);
    expect((r.json as { sessions_ended: number }).sessions_ended).toBe(0);
  });
});

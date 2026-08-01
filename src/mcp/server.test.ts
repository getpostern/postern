// buildServer(deps) refactor — DB-free. We mock the core functions and drive the server through a real
// in-process MCP client (linked in-memory transports), asserting the two contract points:
//   1) a handler uses the INJECTED resolveCtx (not resolveLocal), and
//   2) every call fires `audit` with the right tool + decision (allow on success, deny on AccessDenied).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccessDenied, type AuthContext } from "../auth/index.js";

// Mock the core modules the server adapts (so no Postgres is touched).
const queryMock = vi.fn();
const describeContextMock = vi.fn();
const getRecordMock = vi.fn();
const invokeActionMock = vi.fn();
vi.mock("../core/query.js", () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock("../core/context.js", () => ({
  describeContext: (...a: unknown[]) => describeContextMock(...a),
  getRecord: (...a: unknown[]) => getRecordMock(...a),
  fetchLive: vi.fn(),
}));
const listActionsMock = vi.fn(async () => ({ actions: [], count: 0, truncated: false }));
vi.mock("../core/actions.js", () => ({
  listActions: (...a: unknown[]) => listActionsMock(...(a as [])),
  invokeAction: (...a: unknown[]) => invokeActionMock(...a),
}));

const { buildServer } = await import("./server.js");
type EdgeAuditEvent = Parameters<import("./server.js").EdgeAudit>[0];

const FAKE_CTX: AuthContext = {
  userId: "u-bearer",
  agentId: "agent-x",
  grantedSectors: new Set(["finance"]),
};

/** Wire a Client to a buildServer(deps) over a linked in-memory pair. */
async function connect(deps: {
  resolveCtx: (extra: unknown) => Promise<AuthContext>;
  audit: (e: EdgeAuditEvent) => void;
}): Promise<Client> {
  const server = buildServer(deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

beforeEach(() => {
  queryMock.mockReset();
  describeContextMock.mockReset();
  getRecordMock.mockReset();
  invokeActionMock.mockReset();
  listActionsMock.mockReset();
  listActionsMock.mockResolvedValue({ actions: [], count: 0, truncated: false });
});

describe("buildServer uses the injected resolveCtx (not resolveLocal)", () => {
  it("a query handler runs the core fn with the resolver's ctx and fires audit allow", async () => {
    const resolveCtx = vi.fn(async () => FAKE_CTX);
    const audit = vi.fn();
    queryMock.mockResolvedValueOnce({ sector: "finance.transaction", object: "transaction", count: 2, rows: [{}, {}] });

    const client = await connect({ resolveCtx, audit });
    const res = await client.callTool({ name: "query", arguments: { sector: "finance.transaction" } });

    // The injected resolver was used; the core fn got THAT ctx (not resolveLocal's operator ctx).
    expect(resolveCtx).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toBe(FAKE_CTX);
    expect((res as { isError?: boolean }).isError).toBeFalsy();

    // Audit fired once: tool=query, decision=allow, the bearer's ids, resultCount from the core result.
    expect(audit).toHaveBeenCalledTimes(1);
    const e = audit.mock.calls[0][0];
    expect(e.tool).toBe("query");
    expect(e.decision).toBe("allow");
    expect(e.outcome).toBe("ok");
    expect(e.userId).toBe("u-bearer");
    expect(e.agentId).toBe("agent-x");
    expect(e.sector).toBe("finance.transaction");
    expect(e.resultCount).toBe(2);
    // #9: the query DSL is carried raw on the audit line (redaction is central in audit()).
    expect(e.args).toMatchObject({ sector: "finance.transaction" });
  });

  it("includeShadowed is declared in the query tool shape and reaches core intact (dedup drill-through)", async () => {
    // The MCP SDK validates arguments against the tool's zod shape; an UNDECLARED key would be
    // stripped/rejected before the handler — so this pins that the drill-through param survives
    // the edge and lands on core query() as-is.
    const audit = vi.fn();
    queryMock.mockResolvedValueOnce({ sector: "finance.account", object: "account", count: 0, rows: [] });
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit });

    const res = await client.callTool({
      name: "query",
      arguments: { sector: "finance.account", includeShadowed: true },
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][1]).toMatchObject({ sector: "finance.account", includeShadowed: true });
  });

  it("describe_context audits allow with the granted-sector count", async () => {
    const audit = vi.fn();
    describeContextMock.mockResolvedValueOnce({ sectors: ["finance"], connections: [] });
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit });

    await client.callTool({ name: "describe_context", arguments: {} });
    const e = audit.mock.calls[0][0];
    expect(e.tool).toBe("describe_context");
    expect(e.decision).toBe("allow");
    expect(e.resultCount).toBe(1);
  });
});

describe("invoke_action threads the connector-reported outcome into the audit line", () => {
  it("{ok:true} → audit outcome 'ok'", async () => {
    const audit = vi.fn();
    invokeActionMock.mockResolvedValueOnce({ ok: true, detail: null });
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit });

    const res = await client.callTool({
      name: "invoke_action",
      arguments: { action_id: "home.light.turn_on", params: {} },
    });
    expect((res as { isError?: boolean }).isError).toBeFalsy();

    expect(audit).toHaveBeenCalledTimes(1);
    const e = audit.mock.calls[0][0];
    expect(e.tool).toBe("invoke_action");
    expect(e.decision).toBe("allow");
    expect(e.outcome).toBe("ok");
  });

  it("{ok:false} → audit outcome 'error' (decision stays allow; the result still returns)", async () => {
    const audit = vi.fn();
    invokeActionMock.mockResolvedValueOnce({ ok: false, detail: "unknown — not retried" });
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit });

    const res = await client.callTool({
      name: "invoke_action",
      arguments: { action_id: "home.light.turn_on" },
    });
    // The ok:false JSON is the tool RESULT (the agent reads it) — not a protocol error.
    expect((res as { isError?: boolean }).isError).toBeFalsy();

    expect(audit).toHaveBeenCalledTimes(1);
    const e = audit.mock.calls[0][0];
    expect(e.tool).toBe("invoke_action");
    expect(e.decision).toBe("allow");
    expect(e.outcome).toBe("error");
  });

  it("a thrown invokeAction still audits outcome 'error' (existing throw path)", async () => {
    const audit = vi.fn();
    invokeActionMock.mockRejectedValueOnce(new Error("dispatch exploded"));
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit });

    const res = await client.callTool({
      name: "invoke_action",
      arguments: { action_id: "home.light.turn_on" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);

    const e = audit.mock.calls[0][0];
    expect(e.tool).toBe("invoke_action");
    expect(e.decision).toBe("allow");
    expect(e.outcome).toBe("error");
  });

  it("reads keep recording outcome 'ok' (no row change for reads)", async () => {
    const audit = vi.fn();
    getRecordMock.mockResolvedValueOnce({ id: "r-1" });
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit });

    await client.callTool({ name: "get_record", arguments: { sector: "finance.transaction", id: "r-1" } });
    const e = audit.mock.calls[0][0];
    expect(e.tool).toBe("get_record");
    expect(e.decision).toBe("allow");
    expect(e.outcome).toBe("ok");
  });
});

describe("a thrown (non-AccessDenied) read still attributes the sector + args (#10/#9)", () => {
  it("a query that THROWS audits sector SET (args.sector) + outcome 'error' + args — not NULL", async () => {
    const audit = vi.fn();
    // Stands in for a QueryValidationError (unknown field) — any non-AccessDenied throw takes the
    // generic-error branch, which (before #10) logged sector=NULL + result_count=NULL.
    queryMock.mockRejectedValueOnce(new Error("query validation failed: unknown field 'bogus'"));
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit });

    const res = await client.callTool({
      name: "query",
      arguments: { sector: "finance.transaction", where: { bogus: 1 } },
    });
    // The handler throw surfaces to the agent as a tool error.
    expect((res as { isError?: boolean }).isError).toBe(true);

    expect(audit).toHaveBeenCalledTimes(1);
    const e = audit.mock.calls[0][0];
    expect(e.tool).toBe("query");
    expect(e.decision).toBe("allow");
    expect(e.outcome).toBe("error");
    // #10: the sector is recorded from the up-front args.sector even though query() threw.
    expect(e.sector).toBe("finance.transaction");
    // #9: the DSL is captured on the error row too (forensics), raw (redaction is central).
    expect(e.args).toMatchObject({ sector: "finance.transaction", where: { bogus: 1 } });
  });
});

// ── agent-surface-semantics (#98 items 1,2,5,6,7,10): what the agent READS before it calls anything.
//    These assert the published TEXT, because the text is the only thing a cold agent has to go on ──

describe("the published MCP surface introduces Postern and teaches its traps", () => {
  /** The tool descriptions, keyed by tool name, as a client actually receives them. */
  async function descriptions(client: Client): Promise<Record<string, string>> {
    const list = await client.listTools();
    return Object.fromEntries(list.tools.map((t) => [t.name, t.description ?? ""]));
  }

  it("the server introduces itself as postern", async () => {
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit: vi.fn() });
    expect(client.getServerVersion()?.name).toBe("postern");
  });

  it("the server ships instructions that name the sign convention and the discovery order", async () => {
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit: vi.fn() });
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("describe_context");
    expect(instructions).toContain("get_schema");
    expect(instructions).toContain("fieldDocs");
    expect(instructions).toMatch(/has_more/);
  });

  it("invoke_action's description advertises no validation and no fictional ids", async () => {
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit: vi.fn() });
    const desc = (await descriptions(client)).invoke_action;
    // The three negatives are the load-bearing ones: a partial edit that swaps the ids but keeps the
    // validation promise (or vice versa) leaves the live defect in place.
    expect(desc).not.toContain("home.turn_on");
    expect(desc).not.toContain("mail.send");
    expect(desc).not.toMatch(/validated against the action's schema/);
    expect(desc).toContain("home.light.turn_on");
    expect(desc).toMatch(/does not type-check/);
  });

  it("query's description states the signed-amount rule and the has_more meaning", async () => {
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit: vi.fn() });
    const desc = (await descriptions(client)).query;
    expect(desc).toMatch(/negative/i);
    expect(desc).toContain("amount < 0");
    expect(desc).toContain("has_more");
  });

  it("describe_context's description distinguishes granted sectors from connections", async () => {
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit: vi.fn() });
    const desc = (await descriptions(client)).describe_context;
    expect(desc).toMatch(/grant/i);
    expect(desc).not.toContain("connected sectors");
    expect(desc).toContain("connection_id");
  });

  it("get_schema's description tells the agent to read fieldDocs before aggregating", async () => {
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit: vi.fn() });
    const desc = (await descriptions(client)).get_schema;
    expect(desc).toContain("fieldDocs");
    expect(desc).toContain("notes");
  });

  it("get_record's description names the dotted-key and non-uuid-id rules", async () => {
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit: vi.fn() });
    const desc = (await descriptions(client)).get_record;
    expect(desc).toContain("finance.transaction");
    expect(desc).toMatch(/returns null/);
  });

  it("list_actions' description names the filter keys and the truncated flag", async () => {
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit: vi.fn() });
    const desc = (await descriptions(client)).list_actions;
    expect(desc).toContain("domain");
    expect(desc).toContain("truncated");
  });
});

describe("list_actions edge wiring (#98 item 6)", () => {
  it("forwards the filter and limit to core, mapping entity_id → entityId", async () => {
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit: vi.fn() });
    await client.callTool({
      name: "list_actions",
      arguments: { sector: "home", domain: "light", entity_id: "light.k", limit: 5 },
    });
    expect(listActionsMock).toHaveBeenCalledTimes(1);
    const call = listActionsMock.mock.calls[0] as unknown as [unknown, string, unknown];
    expect(call[0]).toBe(FAKE_CTX);
    expect(call[1]).toBe("home");
    expect(call[2]).toEqual({ domain: "light", entityId: "light.k", limit: 5 });
  });

  it("audits the returned count, not the object", async () => {
    const audit = vi.fn();
    listActionsMock.mockResolvedValueOnce({
      actions: [
        { id: "a", description: "", params: [] },
        { id: "b", description: "", params: [] },
        { id: "c", description: "", params: [] },
      ],
      count: 3,
      truncated: false,
    } as never);
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit });

    await client.callTool({ name: "list_actions", arguments: { sector: "home" } });
    const e = audit.mock.calls[0][0];
    expect(e.tool).toBe("list_actions");
    expect(e.resultCount).toBe(3);
  });
});

describe("AccessDenied at the edge → audit deny then the error propagates", () => {
  it("a core AccessDenied is audited as deny and surfaces as a tool error", async () => {
    const audit = vi.fn();
    queryMock.mockImplementationOnce(async () => {
      throw new AccessDenied("home"); // an ungranted sector, before any SQL
    });
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit });

    const res = await client.callTool({ name: "query", arguments: { sector: "home" } });
    // The SDK reports the handler throw as an error result back to the agent.
    expect((res as { isError?: boolean }).isError).toBe(true);

    expect(audit).toHaveBeenCalledTimes(1);
    const e = audit.mock.calls[0][0];
    expect(e.tool).toBe("query");
    expect(e.decision).toBe("deny");
    expect(e.denyReason).toContain("home");
    expect(e.sector).toBe("home");
  });
});

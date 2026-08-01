// fetch_live over MCP — DB-free (core mocked), driven through a real in-process client over linked
// in-memory transports (the server.test.ts harness; a separate file because server.test.ts belongs
// to a sibling unit this wave). Proves the edge contract for the wired seventh primitive:
//   * the new optional `id` is accepted and reaches core as fetchLive(ctx, sector, { id }),
//   * without `id` the call still works (sync mode) and the result round-trips,
//   * a core throw (e.g. NotFoundError) surfaces as a tool error, not a crash.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthContext } from "../auth/index.js";

// Mock the core modules the server adapts (so no Postgres is touched).
const fetchLiveMock = vi.fn();
vi.mock("../core/context.js", () => ({
  describeContext: vi.fn(),
  getRecord: vi.fn(),
  fetchLive: (...a: unknown[]) => fetchLiveMock(...a),
}));
vi.mock("../core/query.js", () => ({ query: vi.fn() }));

const { buildServer } = await import("./server.js");
type EdgeAuditEvent = Parameters<import("./server.js").EdgeAudit>[0];

const FAKE_CTX: AuthContext = {
  userId: "u-bearer",
  agentId: "agent-x",
  grantedSectors: new Set(["finance", "home"]),
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
  fetchLiveMock.mockReset();
});

describe("fetch_live tool — both modes reach core", () => {
  it("record mode: `id` is accepted and core gets fetchLive(ctx, sector, { id })", async () => {
    const audit = vi.fn();
    const recordResult = {
      sector: "finance.transaction",
      mode: "record",
      id: "11111111-2222-3333-4444-555555555555",
      record: { source: "live" },
    };
    fetchLiveMock.mockResolvedValueOnce(recordResult);
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit });

    const res = await client.callTool({
      name: "fetch_live",
      arguments: { sector: "finance.transaction", id: recordResult.id },
    });

    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(fetchLiveMock).toHaveBeenCalledTimes(1);
    expect(fetchLiveMock.mock.calls[0][0]).toBe(FAKE_CTX);
    expect(fetchLiveMock.mock.calls[0][1]).toBe("finance.transaction");
    expect(fetchLiveMock.mock.calls[0][2]).toEqual({ id: recordResult.id });

    // The raw payload round-trips; the audit line keeps resultCount null (no shape change).
    const content = (res as { content: Array<{ text: string }> }).content;
    expect(JSON.parse(content[0].text)).toEqual(recordResult);
    const e = audit.mock.calls[0][0] as EdgeAuditEvent;
    expect(e.tool).toBe("fetch_live");
    expect(e.decision).toBe("allow");
    expect(e.sector).toBe("finance.transaction");
    expect(e.resultCount).toBeNull();
  });

  it("sync mode: no `id` still works and the bounded-sync result round-trips", async () => {
    const syncResult = { sector: "finance", mode: "sync", synced: true, timed_out: false, last_synced_at: null };
    fetchLiveMock.mockResolvedValueOnce(syncResult);
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit: vi.fn() });

    const res = await client.callTool({ name: "fetch_live", arguments: { sector: "finance" } });

    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect((fetchLiveMock.mock.calls[0] as unknown[])[2]).toEqual({ id: undefined });
    const content = (res as { content: Array<{ text: string }> }).content;
    expect(JSON.parse(content[0].text)).toEqual(syncResult);
  });

  it("a core throw surfaces as a tool error result (the SDK boundary holds)", async () => {
    fetchLiveMock.mockRejectedValueOnce(new Error("no active connection for sector 'calendar'"));
    const client = await connect({ resolveCtx: async () => FAKE_CTX, audit: vi.fn() });

    const res = await client.callTool({ name: "fetch_live", arguments: { sector: "calendar" } });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});

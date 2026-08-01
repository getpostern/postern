// HTTP edge round-trip (in-process) — DB-free. resolveBearer + the core `query` are mocked, so a real
// StreamableHTTPClientTransport drives a real startHttpEdge over loopback. Asserts the headline edge
// behaviors: 401-before-any-tool, the bearer's ctx flows into the tool, ctx is resolved ONCE per
// session (no second resolveBearer), and an ungranted sector → tool error + an audit `deny`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AccessDenied, type AuthContext } from "../auth/index.js";

// Mock resolveBearer (the only DB hit) + the core query the granted path runs.
const resolveBearerMock = vi.fn<(token: string) => Promise<AuthContext>>();
const queryMock = vi.fn();
vi.mock("../auth/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/index.js")>();
  return { ...actual, resolveBearer: (t: string) => resolveBearerMock(t) };
});
vi.mock("../core/query.js", () => ({ query: (...a: unknown[]) => queryMock(...a) }));

const { startHttpEdge, MAX_SESSIONS } = await import("./http.js");
const { endAgentSessions, __resetSessionRegistryForTests } = await import("./bearer.js");
const { GC_INTERVAL_MS, BRIDGE_DENY_AUDIT_CAP } = await import("./oauth-bridge.js");
const { queue } = await import("../audit/queue.js");
type EdgeAuditEvent = Parameters<import("./server.js").EdgeAudit>[0];
type QueuedAudit = { tool: string; decision: string; denyReason?: string | null };

const auditQueueBuf = (): QueuedAudit[] => (queue as unknown as { buf: QueuedAudit[] }).buf;
const resetAuditQueue = (): void => {
  (queue as unknown as { buf: QueuedAudit[] }).buf = [];
};

const GOOD = "good-bearer";
const FINANCE_CTX: AuthContext = {
  userId: "u-finance",
  agentId: "agent-finance",
  grantedSectors: new Set(["finance"]),
};

let edge: { port: number; close(): Promise<void> };
let auditEvents: EdgeAuditEvent[];

async function startEdge(): Promise<void> {
  auditEvents = [];
  edge = startHttpEdge({ port: 0, audit: (e) => auditEvents.push(e) });
  // listen(0) is async — wait until the OS has assigned a real port before any client connects.
  for (let i = 0; i < 200 && edge.port === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A client with the bearer set on every HTTP request (the configured-bearer wire form). */
async function connectClient(token?: string): Promise<Client> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${edge.port}/mcp`), {
    requestInit: { headers },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport); // runs the MCP initialize handshake (the bearer gate)
  return client;
}

beforeEach(async () => {
  resolveBearerMock.mockReset();
  queryMock.mockReset();
  // The session registry + revoke fence are PROCESS-wide module state (#99). Reset BEFORE the edge
  // mounts itself, so a stale fence can never refuse the next test's initialize.
  __resetSessionRegistryForTests();
  // The bridge's ONE switch must be off for the pinned bridge-OFF shapes regardless of the shell env.
  delete process.env.MCP_PUBLIC_URL;
  await startEdge();
});

afterEach(async () => {
  await edge.close();
});

describe("bearer gate at init", () => {
  it("NO bearer → init fails (401 before any tool/session)", async () => {
    await expect(connectClient(undefined)).rejects.toBeTruthy();
    // resolveBearer is never reached for a missing bearer; no session bound; no audit.
    expect(resolveBearerMock).not.toHaveBeenCalled();
    expect(auditEvents).toHaveLength(0);
  });

  it("an unknown/revoked bearer → init fails (resolveBearer throws AccessDenied → 401)", async () => {
    resolveBearerMock.mockRejectedValueOnce(new AccessDenied("unknown agent"));
    await expect(connectClient("bad")).rejects.toBeTruthy();
    expect(resolveBearerMock).toHaveBeenCalledTimes(1);
  });
});

describe("a valid bearer → a session whose ctx is the bearer's, resolved once", () => {
  it("query runs with the bearer's ctx and reuses the cached ctx on the second call", async () => {
    resolveBearerMock.mockResolvedValue(FINANCE_CTX);
    queryMock.mockResolvedValue({ sector: "finance.transaction", object: "transaction", count: 1, rows: [{ id: "t1" }] });

    const client = await connectClient(GOOD);

    // First tool call: the core fn gets the bearer's ctx (NOT the operator).
    await client.callTool({ name: "query", arguments: { sector: "finance.transaction" } });
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toMatchObject({ userId: "u-finance", agentId: "agent-finance" });

    // Second tool call on the SAME session: cached ctx, NO second resolveBearer.
    await client.callTool({ name: "query", arguments: { sector: "finance.transaction" } });
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(resolveBearerMock).toHaveBeenCalledTimes(1); // resolved ONCE per session

    // Both calls were audited allow.
    const queryAudits = auditEvents.filter((e) => e.tool === "query");
    expect(queryAudits).toHaveLength(2);
    expect(queryAudits.every((e) => e.decision === "allow")).toBe(true);
    expect(queryAudits[0].agentId).toBe("agent-finance");
    // #9: the DSL flows through the HTTP edge onto the audit line (raw; redaction is central).
    expect(queryAudits[0].args).toMatchObject({ sector: "finance.transaction" });

    await client.close();
  });

  it("an ungranted sector → a tool error + an audit deny (real assertion)", async () => {
    resolveBearerMock.mockResolvedValue(FINANCE_CTX);
    // The core query throws AccessDenied for a sector the bearer wasn't granted (before any SQL).
    queryMock.mockImplementation(async (_ctx: AuthContext, params: { sector: string }) => {
      if (params.sector === "home") throw new AccessDenied("home");
      return { sector: params.sector, object: "x", count: 0, rows: [] };
    });

    const client = await connectClient(GOOD);
    const res = await client.callTool({ name: "query", arguments: { sector: "home" } });
    expect((res as { isError?: boolean }).isError).toBe(true);

    const deny = auditEvents.find((e) => e.tool === "query" && e.decision === "deny");
    expect(deny).toBeTruthy();
    expect(deny!.sector).toBe("home");
    expect(deny!.denyReason).toContain("home");

    await client.close();
  });

  it("an expiring credential dies MID-SESSION at its deadline (per-call resolver check)", async () => {
    resolveBearerMock.mockResolvedValue({ ...FINANCE_CTX, expiresAt: new Date(Date.now() + 400) });
    queryMock.mockResolvedValue({ sector: "finance.transaction", object: "transaction", count: 0, rows: [] });

    const client = await connectClient(GOOD);
    // Before the deadline: the cached ctx serves normally.
    const ok = await client.callTool({ name: "query", arguments: { sector: "finance.transaction" } });
    expect((ok as { isError?: boolean }).isError).toBeFalsy();

    await new Promise((r) => setTimeout(r, 500)); // cross the deadline
    const dead = await client.callTool({ name: "query", arguments: { sector: "finance.transaction" } });
    expect((dead as { isError?: boolean }).isError).toBe(true);

    const deny = auditEvents.find((e) => e.tool === "query" && e.decision === "deny");
    expect(deny).toBeTruthy();
    expect(deny!.denyReason).toBe("expired"); // reason vocabulary, NOT written into sector
    expect(deny!.sector).toBe("finance.transaction"); // the up-front meta sector, untouched by reason

    await client.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// #99 — an operator verb ends live MCP sessions IN PROCESS. Before this the MCP edge only ever read
// `revoked_at` once, at initialize (http.ts handleInitialize → resolveBearer), so a revoke landed on
// the REST mirror instantly (it re-resolves per request, mirror.ts:47-50) and on the MCP edge not at
// all until the client reconnected. These drive the REAL edge over loopback: connect, make a
// SUCCESSFUL call, sweep, then prove the very next call on the SAME open session is refused.
// ═══════════════════════════════════════════════════════════════════════════════════

describe("revocation reaches an already-open MCP session (#99)", () => {
  it("revoking an agent denies the very next tool call on an already-open session", async () => {
    resolveBearerMock.mockResolvedValue(FINANCE_CTX);
    queryMock.mockResolvedValue({ sector: "finance.transaction", object: "transaction", count: 0, rows: [] });

    const client = await connectClient(GOOD);

    // The positive control: the session WORKS first. Without this the test could pass for the wrong
    // reason (e.g. a broken edge that denies everything).
    const ok = await client.callTool({ name: "query", arguments: { sector: "finance.transaction" } });
    expect((ok as { isError?: boolean }).isError).toBeFalsy();
    expect(queryMock).toHaveBeenCalledTimes(1);

    // The operator verb. One live session ended, on THIS edge, in THIS process — no reconnect, no
    // restart, no expiry, and no second resolveBearer.
    expect(endAgentSessions(FINANCE_CTX.userId, FINANCE_CTX.agentId)).toBe(1);

    await expect(
      client.callTool({ name: "query", arguments: { sector: "finance.transaction" } }),
    ).rejects.toBeTruthy();
    // The load-bearing assertion: NO data was served after the revoke.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(resolveBearerMock).toHaveBeenCalledTimes(1); // still no per-call DB hit

    await client.close().catch(() => {});
  });

  it("a narrowed grant is not served from the session cache", async () => {
    // PATCH /api/agents/:id sweeps too, so the previously-granted sector stops being served from the
    // cached grantedSectors Set — the whole point of sweeping on grant EDITS, not only on revoke.
    resolveBearerMock.mockResolvedValue(FINANCE_CTX);
    queryMock.mockResolvedValue({ sector: "finance.transaction", object: "transaction", count: 0, rows: [] });

    const client = await connectClient(GOOD);
    const ok = await client.callTool({ name: "query", arguments: { sector: "finance.transaction" } });
    expect((ok as { isError?: boolean }).isError).toBeFalsy();

    endAgentSessions(FINANCE_CTX.userId, FINANCE_CTX.agentId);

    await expect(
      client.callTool({ name: "query", arguments: { sector: "finance.transaction" } }),
    ).rejects.toBeTruthy();
    expect(queryMock).toHaveBeenCalledTimes(1); // the granted sector is no longer served

    await client.close().catch(() => {});
  });

  it("a session that was still AUTHORIZING when the revoke swept is never served", async () => {
    // The race the bind() fence exists for: this session resolved a still-live grant microseconds
    // before the revoke, so the sweep could not see it. Without the fence it would bind AFTER the
    // sweep and outlive the revoke — the exact hole a push-only design leaves open.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    resolveBearerMock.mockImplementation(async () => {
      await gate;
      return FINANCE_CTX;
    });
    queryMock.mockResolvedValue({ sector: "finance.transaction", object: "transaction", count: 0, rows: [] });

    const connecting = connectClient(GOOD).catch(() => null);
    await new Promise((r) => setTimeout(r, 20)); // the initialize is now parked inside authorize()
    endAgentSessions(FINANCE_CTX.userId, FINANCE_CTX.agentId);
    // The gap is the ASSERTION, not padding. The fence refuses a bind whose `resolvedAt` is at or
    // before the sweep stamp, and `resolvedAt` is captured immediately BEFORE authorize() — i.e.
    // ~20ms before the sweep here. Release with no gap and the mutation this test exists to catch —
    // moving that capture to AFTER `await auth.authorize(token)` (http.ts handleInitialize) — lands
    // resolvedAt in the same millisecond as the stamp, `fencedAt >= resolvedAt` still holds, and the
    // test passes on broken code. Sleeping here puts the mutated capture strictly AFTER the fence,
    // so the mutant binds, serves a revoked session, and this test goes red. Verified 2026-07-25.
    await new Promise((r) => setTimeout(r, 30));
    release!();

    const raced = await connecting;
    if (raced) {
      await expect(
        raced.callTool({ name: "query", arguments: { sector: "finance.transaction" } }),
      ).rejects.toBeTruthy();
      await raced.close().catch(() => {});
    }
    expect(queryMock).not.toHaveBeenCalled(); // the raced session NEVER served a row

    // Positive control: the fence is a race guard, not a lockout — a session that resolves AFTER it
    // (a re-mint, a reconnect) is served normally.
    resolveBearerMock.mockImplementation(async () => FINANCE_CTX);
    const fresh = await connectClient(GOOD);
    const ok = await fresh.callTool({ name: "query", arguments: { sector: "finance.transaction" } });
    expect((ok as { isError?: boolean }).isError).toBeFalsy();
    expect(queryMock).toHaveBeenCalledTimes(1);
    await fresh.close();
  });

  it("sweeping a DIFFERENT agent leaves this session serving", async () => {
    resolveBearerMock.mockResolvedValue(FINANCE_CTX);
    queryMock.mockResolvedValue({ sector: "finance.transaction", object: "transaction", count: 0, rows: [] });

    const client = await connectClient(GOOD);
    await client.callTool({ name: "query", arguments: { sector: "finance.transaction" } });

    expect(endAgentSessions(FINANCE_CTX.userId, "some-other-agent")).toBe(0);

    const still = await client.callTool({ name: "query", arguments: { sector: "finance.transaction" } });
    expect((still as { isError?: boolean }).isError).toBeFalsy();
    expect(queryMock).toHaveBeenCalledTimes(2);

    await client.close();
  });

  it("a closed edge is unmounted: a later sweep never reaches it", async () => {
    resolveBearerMock.mockResolvedValue(FINANCE_CTX);
    queryMock.mockResolvedValue({ sector: "finance.transaction", object: "transaction", count: 0, rows: [] });

    // A SECOND edge, so afterEach's teardown of the primary one is untouched.
    const second = startHttpEdge({ port: 0, audit: () => {} });
    for (let i = 0; i < 200 && second.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${second.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${GOOD}` } },
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    // It IS mounted while it lives: the sweep finds the primary edge's 0 sessions + this one's 1.
    expect(endAgentSessions(FINANCE_CTX.userId, FINANCE_CTX.agentId)).toBe(1);

    await client.close().catch(() => {});
    await second.close();
    // …and nothing survives its teardown. (close() also drops every session, so the explicit
    // unregisterStore() in http.ts is memory hygiene rather than a separately observable behaviour
    // — it keeps a dead edge out of the process-wide Set.)
    expect(endAgentSessions(FINANCE_CTX.userId, FINANCE_CTX.agentId)).toBe(0);
  });
});

describe("the session map is bounded (#99)", () => {
  it(
    "a new initialize past MAX_SESSIONS is refused with 503 and no live session is evicted",
    async () => {
      resolveBearerMock.mockResolvedValue(FINANCE_CTX);
      queryMock.mockResolvedValue({ sector: "finance.transaction", object: "transaction", count: 0, rows: [] });

      // The FIRST session is a real client, so we can prove it still works after the cap is hit —
      // a cap implemented as LRU eviction would silently kill a standing claude.ai session.
      const first = await connectClient(GOOD);
      expect(
        ((await first.callTool({ name: "query", arguments: { sector: "finance.transaction" } })) as {
          isError?: boolean;
        }).isError,
      ).toBeFalsy();

      // Fill to exactly the cap with raw initializes (each one a real, bound session).
      for (let i = 1; i < MAX_SESSIONS; i++) {
        const r = await rawInitialize(GOOD);
        expect(r.status).toBe(200);
        await r.body?.cancel().catch(() => {});
      }

      const over = await rawInitialize(GOOD);
      expect(over.status).toBe(503);
      expect(await over.json()).toMatchObject({ error: { code: -32000, message: "Too many sessions" } });

      // …and the session that was already live is UNTOUCHED.
      const still = await first.callTool({ name: "query", arguments: { sector: "finance.transaction" } });
      expect((still as { isError?: boolean }).isError).toBeFalsy();

      await first.close();
    },
    60_000,
  );
});

// ── mcp-auth-bridge: the bridge-ON shapes (metadata routes, the 401 challenge, the throttled
//    initialize-denial audit) + the explicit bridge-OFF inertness pins. DB-free — the bridge's
//    authorize/token flows (which do hit Postgres) live in oauth-bridge.db.test.ts.

const BRIDGE_URL = "https://gw.example.ts.net:10000"; // metadata content only — never dialed

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

async function rawInitialize(token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${edge.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: INIT_BODY,
  });
}

async function restartWithBridge(
  initDenyAudit?: { cap?: number; windowMs?: number },
  bridgeDeps?: Parameters<typeof startHttpEdge>[0]["bridgeDeps"],
): Promise<void> {
  await edge.close();
  auditEvents = [];
  edge = startHttpEdge({
    port: 0,
    audit: (e) => auditEvents.push(e),
    bridge: { publicUrl: BRIDGE_URL },
    initDenyAudit,
    bridgeDeps,
  });
  for (let i = 0; i < 200 && edge.port === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("OAuth bridge OFF (the default) — byte-identical edge", () => {
  it("no bridge routes exist: the well-knowns 404 exactly like any non-/mcp path", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
    ]) {
      const r = await fetch(`http://127.0.0.1:${edge.port}${path}`);
      expect(r.status).toBe(404);
    }
  });

  it("a 401 carries NO WWW-Authenticate header", async () => {
    const r = await rawInitialize(); // missing bearer
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBeNull();
  });

  it("a PRESENTED-but-refused bearer is audited as an 'initialize' deny (forensic; bridge-independent)", async () => {
    resolveBearerMock.mockRejectedValue(new AccessDenied(undefined, "revoked"));
    const r = await rawInitialize("bad-key");
    expect(r.status).toBe(401);
    const denies = auditEvents.filter((e) => e.tool === "initialize" && e.decision === "deny");
    expect(denies).toHaveLength(1);
    expect(denies[0].denyReason).toBe("revoked");
  });

  // ADR 0035 §D2 — the beta promise, as its own acceptance criterion. A user who never enables
  // exposure gets a byte-identically loopback-only gateway: every bridge path is UNREACHABLE, no
  // challenge header exists, no GC interval is created, and the hardening's own knob cannot turn
  // any of it on by itself.
  it("with the bridge off the edge is byte-identical and nothing new is reachable", async () => {
    const NOT_FOUND = { jsonrpc: "2.0", error: { code: -32601, message: "Not found" }, id: null };
    const paths: [string, string][] = [
      ["POST", "/register"],
      ["POST", "/token"],
      ["GET", "/authorize"],
      ["POST", "/authorize"],
      ["GET", "/.well-known/oauth-protected-resource"],
      ["GET", "/.well-known/oauth-protected-resource/mcp"],
      ["GET", "/.well-known/oauth-authorization-server"],
    ];
    for (const [method, path] of paths) {
      const r = await fetch(`http://127.0.0.1:${edge.port}${path}`, {
        method,
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual(NOT_FOUND);
    }

    // No WWW-Authenticate on a 401, with or without a presented bearer.
    resolveBearerMock.mockRejectedValue(new AccessDenied(undefined, "revoked"));
    for (const token of [undefined, "bad-key"]) {
      const r = await rawInitialize(token);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBeNull();
    }

    // No bridge GC interval, and MCP_TRUSTED_PROXIES alone changes NOTHING (it is meaningless
    // without MCP_PUBLIC_URL and is never even parsed then).
    process.env.MCP_TRUSTED_PROXIES = "172.18.0.0/16";
    const spy = vi.spyOn(globalThis, "setInterval");
    const off = startHttpEdge({ port: 0, audit: () => {} });
    for (let i = 0; i < 200 && off.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
    try {
      expect(spy.mock.calls.some((c) => c[1] === GC_INTERVAL_MS)).toBe(false);
      const wk = await fetch(`http://127.0.0.1:${off.port}/.well-known/oauth-authorization-server`);
      expect(wk.status).toBe(404);
      expect(await wk.json()).toEqual(NOT_FOUND);
    } finally {
      spy.mockRestore();
      delete process.env.MCP_TRUSTED_PROXIES;
      await off.close();
    }
  });
});

describe("OAuth bridge ON (mcp-auth-bridge)", () => {
  it("MCP_PUBLIC_URL alone turns it on: `bridge` omitted derives the config from the env", async () => {
    // The ONE switch, exercised through the branch src/index.ts does NOT take (it passes `bridge`
    // explicitly). Without this cell the `activeBridgeConfig()` fallback in startHttpEdge is only
    // ever observed returning null, so a fallback that silently stopped working would look green.
    process.env.MCP_PUBLIC_URL = "https://derived.example.ts.net:10000";
    process.env.MCP_TRUSTED_PROXIES = "172.18.0.0/16";
    const derived = startHttpEdge({ port: 0, audit: () => {} });
    for (let i = 0; i < 200 && derived.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
    try {
      const wk = await fetch(
        `http://127.0.0.1:${derived.port}/.well-known/oauth-authorization-server`,
      );
      expect(wk.status).toBe(200);
      expect(await wk.json()).toMatchObject({
        issuer: "https://derived.example.ts.net:10000",
        token_endpoint: "https://derived.example.ts.net:10000/token",
      });
      // …and the derived config carries the trusted-proxy list, not just the URL.
      const challenged = await fetch(`http://127.0.0.1:${derived.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: INIT_BODY,
      });
      expect(challenged.status).toBe(401);
      expect(challenged.headers.get("www-authenticate")).toContain(
        "https://derived.example.ts.net:10000/.well-known/oauth-protected-resource/mcp",
      );
    } finally {
      delete process.env.MCP_PUBLIC_URL;
      delete process.env.MCP_TRUSTED_PROXIES;
      await derived.close();
    }
  });

  it("401s carry the RFC 9728 WWW-Authenticate challenge on the 401 status", async () => {
    await restartWithBridge();
    resolveBearerMock.mockRejectedValue(new AccessDenied(undefined, "unknown agent"));

    // Presented-but-refused bearer → challenge + error="invalid_token".
    const refused = await rawInitialize("bad-key");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BRIDGE_URL}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
    );

    // Missing bearer → challenge without the invalid_token attribution.
    const missing = await rawInitialize();
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${BRIDGE_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("bridge routes dispatch BEFORE the /mcp check: PRM (both paths) + full AS metadata", async () => {
    await restartWithBridge();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await fetch(`http://127.0.0.1:${edge.port}${path}`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        resource: `${BRIDGE_URL}/mcp`,
        authorization_servers: [BRIDGE_URL],
        bearer_methods_supported: ["header"],
      });
    }
    const meta = await fetch(`http://127.0.0.1:${edge.port}/.well-known/oauth-authorization-server`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toEqual({
      issuer: BRIDGE_URL,
      authorization_endpoint: `${BRIDGE_URL}/authorize`,
      token_endpoint: `${BRIDGE_URL}/token`,
      registration_endpoint: `${BRIDGE_URL}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("initialize denials audit with the reason vocabulary, capped per window with a coalesced overflow", async () => {
    await restartWithBridge({ cap: 2, windowMs: 150 });
    resolveBearerMock.mockRejectedValue(new AccessDenied(undefined, "revoked"));

    // 4 denials in one window → 2 audited (the cap), 2 coalesced.
    for (let i = 0; i < 4; i++) await rawInitialize("bad-key");
    let denies = auditEvents.filter((e) => e.tool === "initialize" && e.decision === "deny");
    expect(denies).toHaveLength(2);
    expect(denies.every((e) => e.denyReason === "revoked")).toBe(true);
    expect(denies.every((e) => e.userId === null && e.agentId === null)).toBe(true);

    // The next window emits ONE coalesced overflow line + resumes auditing.
    await new Promise((r) => setTimeout(r, 200));
    await rawInitialize("bad-key");
    denies = auditEvents.filter((e) => e.tool === "initialize" && e.decision === "deny");
    const overflow = denies.find((e) => e.denyReason?.startsWith("throttled:"));
    expect(overflow).toBeTruthy();
    expect(overflow!.denyReason).toBe("throttled: 2 initialize denials coalesced");
    expect(denies.filter((e) => e.denyReason === "revoked")).toHaveLength(3);
  });

  it("an initialize-denial flood is still capped independently of the bridge denial cap", async () => {
    // The two throttles (http.ts's initialize window and oauth-bridge.ts's auditBridgeDeny window)
    // must NEVER share a counter, or one flood silently suppresses the other's forensic rows.
    resetAuditQueue();
    const emptyPool = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return { query: async () => ({ rows: [], rowCount: 0 }), release: () => {} };
      },
    };
    await restartWithBridge({ cap: 2, windowMs: 60_000 }, { pool: emptyPool });
    resolveBearerMock.mockRejectedValue(new AccessDenied(undefined, "revoked"));

    // Blow well past the initialize cap: 2 audited, the rest coalesced into the NEXT window.
    for (let i = 0; i < 6; i++) await rawInitialize("bad-key");
    expect(auditEvents.filter((e) => e.tool === "initialize" && e.decision === "deny")).toHaveLength(2);

    // In the SAME window, four bridge denials (unknown client). The bridge's own cap is 30, so all
    // four must land — they would not if the two shared the exhausted initialize counter.
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "pcgcl_nobody",
      redirect_uri: "https://client.test/cb",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
    });
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`http://127.0.0.1:${edge.port}/authorize?${q}`, { redirect: "manual" });
      expect(r.status).toBe(400);
      await r.text();
    }
    expect(BRIDGE_DENY_AUDIT_CAP).toBeGreaterThan(4);
    const bridgeDenies = auditQueueBuf().filter(
      (e) => e.tool === "oauth_token" && e.denyReason === "authorize: unknown client",
    );
    expect(bridgeDenies).toHaveLength(4);
    // …and the initialize stream is untouched by the bridge traffic.
    expect(auditEvents.filter((e) => e.tool === "initialize" && e.decision === "deny")).toHaveLength(2);
    resetAuditQueue();
  });

  it("a MISSING bearer is audited too when the bridge is on (a public edge's probes are visible)", async () => {
    await restartWithBridge();
    await rawInitialize();
    const denies = auditEvents.filter((e) => e.tool === "initialize" && e.decision === "deny");
    expect(denies).toHaveLength(1);
  });
});

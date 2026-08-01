import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { AccessDenied } from "../auth/index.js";
import { noteReachedAt } from "../gateway/reached-at.js";
import { buildServer, type EdgeAudit } from "./server.js";
import { extractBearer, sessionAuth, registerSessionStore } from "./bearer.js";
import {
  activeBridgeConfig,
  bridgeRoutes,
  gcBridgeRows,
  GC_INTERVAL_MS,
  type BridgeConfig,
  type BridgeDeps,
} from "./oauth-bridge.js";

const SESSION_HEADER = "mcp-session-id";
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB cap — MCP JSON-RPC frames are small; this guards memory.

/** Initialize-denial audit throttle defaults: per-minute cap with a coalesced overflow line, so a
 *  Funnel-exposed edge's bot noise cannot flood the append-only audit_log. */
const INIT_DENY_AUDIT_CAP = 30;
const INIT_DENY_AUDIT_WINDOW_MS = 60_000;

/**
 * Hard cap on concurrent MCP sessions per edge (#99): the transport + ctx maps are otherwise
 * unbounded. A new initialize past the cap is REFUSED (503) rather than evicting an existing
 * session — an MCP client legitimately holds one session for days (the claude.ai `:443`
 * standing-access finding), so LRU eviction would silently kill a live connection, which is a
 * functional regression. Only an ALREADY-AUTHENTICATED caller can reach this check, so refusing is
 * not an anonymous DoS lever. No TTL/idle sweep either: MCP clients legitimately idle for hours.
 */
export const MAX_SESSIONS = 512;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** A JSON-RPC error envelope, so a 401/400 reaches the client as a protocol error, not a bare status. */
function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  json(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

/** Read and JSON-parse the request body, capped. Returns undefined for an empty body (GET/DELETE). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return undefined;
  return JSON.parse(raw);
}

/**
 * The remote MCP edge: MCP-over-Streamable-HTTP via the SDK's `StreamableHTTPServerTransport`, mounted
 * on a Node `http` server at `POST/GET/DELETE /mcp`. Harness-agnostic: paste the URL + a bearer into
 * any client.
 *
 * Lifecycle (the locked "ctx resolved once per session" model):
 *  - An **initialize** POST (no `Mcp-Session-Id`): extract the bearer → `sessionAuth.authorize(token)`
 *    (the only DB hit; **401 before any tool runs** if the bearer is missing/unknown/revoked) → make a
 *    transport with a fresh session id → on `sessioninitialized`, `bind(sessionId, ctx)` → `connect` it
 *    to a `buildServer({ resolveCtx: sessionAuth.resolver(), audit })`.
 *  - A subsequent request carries `Mcp-Session-Id` → routed to that session's transport; the cached ctx
 *    is read in-memory (no second `resolveBearer`).
 *  - `DELETE` (or transport close) → `drop(sessionId)`.
 *
 * The bearer is never logged. Sessions are isolated per edge (one agent's ctx can't reach another's).
 *
 * OAuth bridge (mcp-auth-bridge, ADR 0029): when enabled (`opts.bridge`, defaulting to
 * MCP_PUBLIC_URL), the bridge's same-origin routes are dispatched BEFORE the /mcp check, 401s carry
 * the RFC 9728 `WWW-Authenticate` challenge, and the bridge GC interval runs for the edge's life.
 * Disabled (the default): none of that exists — the edge is byte-identical to the pre-bridge shape.
 */
export function startHttpEdge(opts: {
  host?: string;
  port: number;
  audit: EdgeAudit;
  /** Bridge config; ABSENT = derive from MCP_PUBLIC_URL (the one switch); explicit null = off. */
  bridge?: BridgeConfig | null;
  /** Test seam for the init-denial audit throttle (defaults: cap 30 / 60s window). */
  initDenyAudit?: { cap?: number; windowMs?: number };
  /** Test seam passed straight through to bridgeRoutes (injectable pool / clock). Ignored when the
   *  bridge is off — it can never mount a route by itself. */
  bridgeDeps?: BridgeDeps;
}): { port: number; close(): Promise<void> } {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // onEvict fires when an operator verb sweeps a session out of the ctx store (#99): tear the
  // transport down too, so the client sees the connection end rather than a silently dead session.
  const auth = sessionAuth({
    onEvict: (sessionId: string) => {
      const transport = transports.get(sessionId);
      transports.delete(sessionId);
      if (transport) void transport.close().catch(() => {});
    },
  });
  // Mount this edge into the process-wide registry so endAgentSessions (called by the admin routes,
  // in the SAME process) can reach it. Unmounted first thing in close().
  const unregisterStore = registerSessionStore(auth);
  const bridge = opts.bridge !== undefined ? opts.bridge : activeBridgeConfig();
  const routes = bridge ? bridgeRoutes(bridge, opts.bridgeDeps) : null;

  // Bridge GC: owned interval, started at mount, torn down in close(). Hygiene, never revocation.
  const gcTimer = bridge
    ? setInterval(() => {
        void gcBridgeRows().catch(() => {
          // best-effort sweep; deadness is enforced at resolve/token time regardless
        });
      }, GC_INTERVAL_MS)
    : null;
  if (gcTimer && typeof gcTimer.unref === "function") gcTimer.unref();

  // ── Initialize-denial audit (throttled). Today's parity: with the bridge OFF an anonymous
  // (no-bearer) probe stays silent — pinned edge shape; a PRESENTED-but-refused bearer is always
  // audited (the forensic signal), and with the bridge ON everything is (throttled).
  const denyCap = opts.initDenyAudit?.cap ?? INIT_DENY_AUDIT_CAP;
  const denyWindowMs = opts.initDenyAudit?.windowMs ?? INIT_DENY_AUDIT_WINDOW_MS;
  let denyWindowStart = 0;
  let denyCount = 0;
  let denyOverflow = 0;

  function auditInitDeny(e: AccessDenied, hadToken: boolean): void {
    if (!hadToken && !bridge) return;
    const now = Date.now();
    if (now - denyWindowStart >= denyWindowMs) {
      if (denyOverflow > 0) {
        // Coalesced overflow: ONE line summarizing the denials the previous window's cap swallowed.
        opts.audit({
          userId: null,
          agentId: null,
          tool: "initialize",
          decision: "deny",
          denyReason: `throttled: ${denyOverflow} initialize denials coalesced`,
        });
      }
      denyWindowStart = now;
      denyCount = 0;
      denyOverflow = 0;
    }
    if (denyCount < denyCap) {
      denyCount++;
      opts.audit({
        userId: null,
        agentId: null,
        tool: "initialize",
        decision: "deny",
        // reason vocabulary (unknown agent/revoked/expired) — never the bearer itself.
        denyReason: e.reason ?? e.message,
      });
    } else {
      denyOverflow++;
    }
  }

  async function handleInitialize(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    // 401 BEFORE any tool/session: a missing/unknown/revoked bearer never reaches buildServer.
    const token = extractBearer(req.headers);
    // Captured IMMEDIATELY before the resolve: any revoke stamped at or after this instant swept
    // without seeing this session, so bind() must refuse it (the initialize/revoke race fence).
    const resolvedAt = Date.now();
    let ctx;
    try {
      ctx = await auth.authorize(token);
    } catch (e) {
      if (e instanceof AccessDenied) {
        auditInitDeny(e, token != null);
        if (bridge) {
          // RFC 9728: the challenge points clients at the protected-resource metadata — on the 401
          // status specifically (the header on a 200 is ignored).
          res.setHeader(
            "WWW-Authenticate",
            `Bearer resource_metadata="${bridge.publicUrl}/.well-known/oauth-protected-resource/mcp"` +
              (token != null ? `, error="invalid_token"` : ""),
          );
        }
        rpcError(res, 401, -32001, "Unauthorized");
        return;
      }
      throw e;
    }

    // Bounded session map (#99). Checked AFTER authorize (so only an authenticated caller can reach
    // it) and BEFORE the transport exists (so nothing is left half-built). Refuse, never evict.
    if (transports.size >= MAX_SESSIONS) {
      rpcError(res, 503, -32000, "Too many sessions");
      return;
    }

    // Set when the revoke fence refuses this session's bind (a revoke swept while this initialize
    // was still resolving). The transport is torn down AFTER handleRequest below, never from inside
    // the SDK callback: closing mid-handleRequest leaves the client's initialize hanging forever,
    // which is a worse failure than a denial. Refused or not, it is never added to `transports`, so
    // no request after this one can reach it — it is never served.
    let bindRefused = false;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        // Cache THIS session's ctx (resolved once); track the transport for later routing.
        if (!auth.bind(sessionId, ctx, resolvedAt)) {
          bindRefused = true;
          return;
        }
        transports.set(sessionId, transport);
      },
      onsessionclosed: (sessionId: string) => {
        auth.drop(sessionId);
        transports.delete(sessionId);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        auth.drop(sid);
        transports.delete(sid);
      }
    };

    // Each session gets its own server bound to the bearer-session resolver (the cached ctx) + audit.
    const server = buildServer({ resolveCtx: auth.resolver(), audit: opts.audit });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    // The fence refused this session (a revoke landed mid-initialize): tear the transport down now
    // that the response is out. Nothing was cached and nothing was routed to it.
    if (bindRefused) void transport.close().catch(() => {});
  }

  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      try {
        // Note the address this request named us by, for the Console's "has anything actually
        // reached me here?" observation (#119). BEFORE the path split, so EVERY inbound request
        // counts: a cloud MCP client fetches /.well-known/... long before it reaches /mcp, and even
        // a 404 proves traffic is arriving. EVIDENCE, NEVER TRUTH — this value is attacker-chosen
        // and src/gateway/reached-at.ts is a dead end that no gate reads. It changes NOTHING about
        // the response: not the bearer gate, not the bridge dispatch, not the OFF-path 404.
        noteReachedAt(req.headers.host);

        const url = req.url ?? "";
        const path = url.split("?")[0];

        // Bridge routes dispatch BEFORE the /mcp check — mounted only when the bridge is enabled;
        // with it off these paths 404 exactly as before.
        if (routes) {
          const handler = routes.get(`${req.method ?? "GET"} ${path}`);
          if (handler) {
            await handler(req, res);
            return;
          }
        }

        if (path !== "/mcp") {
          rpcError(res, 404, -32601, "Not found");
          return;
        }

        const sessionHeader = req.headers[SESSION_HEADER];
        const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

        if (req.method === "DELETE") {
          if (sessionId && transports.has(sessionId)) {
            const transport = transports.get(sessionId)!;
            await transport.handleRequest(req, res);
            // handleRequest closes the transport → onclose/onsessionclosed drops it; belt-and-suspenders:
            auth.drop(sessionId);
            transports.delete(sessionId);
          } else {
            rpcError(res, 404, -32001, "Unknown session");
          }
          return;
        }

        // Existing session: route by Mcp-Session-Id to its transport (in-memory cached ctx, no DB).
        if (sessionId && transports.has(sessionId)) {
          const transport = transports.get(sessionId)!;
          const body = req.method === "POST" ? await readJsonBody(req) : undefined;
          await transport.handleRequest(req, res, body);
          return;
        }

        // No (valid) session id. A POST initialize starts a new authenticated session; anything else is bad.
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          if (isInitializeRequest(body)) {
            await handleInitialize(req, res, body);
          } else {
            rpcError(res, 400, -32000, "Missing or invalid Mcp-Session-Id");
          }
          return;
        }

        rpcError(res, 400, -32000, "Missing or invalid Mcp-Session-Id");
      } catch (e) {
        // Never leak internals (no bearer, no stack) onto the wire.
        if (!res.headersSent) rpcError(res, 500, -32603, "Internal error");
        else res.end();
      }
    })();
  });

  // HTTP keep-alive for transport reuse (the SDK recommends a persistent connection per session).
  httpServer.keepAliveTimeout = 60_000;
  httpServer.listen(opts.port, opts.host ?? "127.0.0.1");

  return {
    get port(): number {
      const addr = httpServer.address();
      return addr && typeof addr === "object" ? addr.port : opts.port;
    },
    async close(): Promise<void> {
      // Unmount FIRST: a torn-down edge must never be swept by a later endAgentSessions.
      unregisterStore();
      if (gcTimer) clearInterval(gcTimer);
      for (const transport of transports.values()) {
        try {
          await transport.close();
        } catch {
          // best-effort teardown
        }
      }
      transports.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

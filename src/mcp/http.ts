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
 * unbounded.
 *
 * At the cap a new initialize no longer simply fails (#147). Hosted clients (claude.ai, ChatGPT)
 * ABANDON sessions — every new chat or reconnect leaves one behind and nothing ever removes it — so
 * a plain refuse-at-cap hands every slot to zombies and starves the live callers the cap exists to
 * protect (prod, 2026-08-08: ~85 abandoned sessions/day filled the map in 6 days, and only a
 * container restart cleared it). Instead the initialize reclaims ONE slot, taken from the session
 * that has gone longest without serving a request, and only when that session has been idle at
 * least `SESSION_IDLE_RECLAIM_MS`. When nothing qualifies — every slot recently active, i.e.
 * genuine saturation — the refusal is byte-identical to the one that shipped before (503, same
 * JSON-RPC envelope; clients parse it).
 *
 * Still deliberate, and still the reason there is no TTL: an MCP client legitimately holds one
 * session idle for hours-to-days (the claude.ai `:443` standing-access finding), so a background
 * sweep that kills idle sessions is a functional regression. Nothing is ever reclaimed below the
 * cap; reclamation happens only on demand, only under pressure, and only to the single most-idle
 * session. Only an ALREADY-AUTHENTICATED caller can reach any of it, so it is not an anonymous DoS
 * lever.
 *
 * What a reclaim leaves the client in is exactly what a container restart leaves EVERY client in:
 * its next request carries a session id this edge no longer knows, and it gets the same response an
 * unknown session id has always got here. That response-class parity is the property this unit
 * pins — recovery beyond it is the client's own behaviour, not a protocol guarantee, and notably
 * the vendored SDK client has no unknown-session auto-reinitialize of its own (it special-cases
 * 401/403). What IS observed is that the hosted clients re-establish after session loss: every
 * container restart drops all 512 at once and they come back without human help.
 */
export const MAX_SESSIONS = 512;

/**
 * How long a session must have gone WITHOUT serving a request before the cap may reclaim it — the
 * unit's definition of "abandoned". One hour: long enough that a session in a live conversation is
 * never a candidate, short enough that a busy day's traffic cannot leave the edge deaf until
 * tomorrow. It is a floor, not a TTL: nothing sweeps on it, and even at the cap only the single
 * most-idle session goes.
 */
export const SESSION_IDLE_RECLAIM_MS = 60 * 60_000;

/**
 * One live session: its transport and the ONE recency stamp (epoch ms of the most recent request it
 * served). The stamp lives INSIDE the transport-map entry rather than in a map of its own, so there
 * is no third bookkeeping structure that could drift from the two stores that already exist.
 */
interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

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
  /** Test seam for the session-capacity path (#147): an injectable clock, so a test can cross the
   *  idle threshold deterministically instead of putting fake timers next to real socket I/O, and a
   *  smaller cap, so it can reach the cap without opening 512 real sessions. Production passes
   *  neither — the defaults are `Date.now` and `MAX_SESSIONS`. */
  sessionDeps?: { now?: () => number; maxSessions?: number };
}): { port: number; close(): Promise<void> } {
  const transports = new Map<string, SessionEntry>();
  const now = opts.sessionDeps?.now ?? ((): number => Date.now());
  const maxSessions = opts.sessionDeps?.maxSessions ?? MAX_SESSIONS;
  // onEvict fires when an operator verb sweeps a session out of the ctx store (#99): tear the
  // transport down too, so the client sees the connection end rather than a silently dead session.
  const auth = sessionAuth({
    onEvict: (sessionId: string) => {
      const entry = transports.get(sessionId);
      transports.delete(sessionId);
      if (entry) void entry.transport.close().catch(() => {});
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
    // Deliberately NOT the edge's injected `now`: this throttle is a wall-clock audit window, not
    // session recency, and the name is kept distinct so a test clock can never silently steer it.
    const at = Date.now();
    if (at - denyWindowStart >= denyWindowMs) {
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
      denyWindowStart = at;
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

  // ── Session capacity (#147). Two events an operator must be able to see in `docker compose logs`:
  // a slot reclaimed from an abandoned session, and a genuine-saturation refusal. Before this, the
  // refusal wrote only to the wire, so a box that had gone deaf left no trace at all.

  /**
   * Emit ONE operator-facing capacity line on stderr (stdout is the JSON-RPC channel on stdio).
   * Fire-and-forget: never awaited, never audited — capacity is operational, not an agent-visible
   * decision, and audit is the wrong channel for it. The line carries the event and the counts and
   * nothing else: the bearer is never logged, and neither is the session id, which routes straight
   * to a bound ctx and is therefore itself a credential.
   */
  function logCapacity(event: "reclaim" | "refuse", detail: string): void {
    try {
      console.error(
        `[pci-gateway] mcp_session_capacity ${event}: ${detail} (sessions ${transports.size}/${maxSessions})`,
      );
    } catch {
      // Best-effort telemetry: a logging failure must never become an edge failure.
    }
  }

  /**
   * Free ONE slot at the cap, or report that none may be freed.
   *
   * The victim is the session that has gone longest without serving a request — never one that
   * served more recently than a session left in place — and it is taken only if it has been idle at
   * least `SESSION_IDLE_RECLAIM_MS`. Otherwise this returns false and the caller refuses exactly as
   * the pre-#147 edge did.
   *
   * Removal touches BOTH stores (the cached ctx and the transport map) and does so ITSELF, before
   * the transport is torn down — never relying on `transport.onclose` to finish the job, since a
   * close that fails or never fires would otherwise leave a half-dead entry behind. The reclaimed id
   * then falls through to the no-valid-session branch, i.e. it gets exactly the response an unknown
   * session id has always got on this edge. That parity is the pinned property; what a given client
   * does with it is the client's own behaviour.
   */
  function reclaimIdleSession(): boolean {
    let victimId: string | undefined;
    let victim: SessionEntry | undefined;
    for (const [sessionId, entry] of transports) {
      if (victim === undefined || entry.lastSeen < victim.lastSeen) {
        victimId = sessionId;
        victim = entry;
      }
    }
    if (victimId === undefined || victim === undefined) return false;
    const idleMs = now() - victim.lastSeen;
    // Nothing here is abandoned — every slot is recently active. That is genuine saturation.
    if (idleMs < SESSION_IDLE_RECLAIM_MS) return false;
    // Logged BEFORE the removal so the count is the at-cap count the operator is diagnosing.
    logCapacity("reclaim", `freed the least-recently-used session after ${Math.round(idleMs / 1000)}s idle`);
    // Resolvable store FIRST, matching bearer.ts's evictAgent invariant: nothing may still resolve a
    // ctx for a session that is being torn down. These two lines are synchronous and adjacent by
    // design — NEVER insert an await between them, or a request landing in the gap would route to a
    // transport whose ctx has already gone.
    auth.drop(victimId);
    transports.delete(victimId);
    void victim.transport.close().catch(() => {});
    return true;
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

    // Bounded session map (#99) that does not starve live callers (#147). Checked AFTER authorize
    // (so only an authenticated caller can reach it) and BEFORE the transport exists (so nothing is
    // left half-built). At the cap, reclaim one abandoned slot; if there is none to reclaim the
    // refusal is byte-identical to the pre-#147 one.
    if (transports.size >= maxSessions && !reclaimIdleSession()) {
      logCapacity("refuse", "no session idle long enough to reclaim");
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
        transports.set(sessionId, { transport, lastSeen: now() });
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
            const { transport } = transports.get(sessionId)!;
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
          const entry = transports.get(sessionId)!;
          // The ONE recency stamp (#147): this session is serving a request right now, so it is not
          // abandoned. Stamped on receipt, before the body is read, so a slow request still counts.
          entry.lastSeen = now();
          const body = req.method === "POST" ? await readJsonBody(req) : undefined;
          await entry.transport.handleRequest(req, res, body);
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
      for (const { transport } of transports.values()) {
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

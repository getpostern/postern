import { resolveBearer, AccessDenied, type AuthContext } from "../auth/index.js";
import {
  bridgeTokensAcceptable,
  resolveBridgeToken,
  BRIDGE_ACCESS_TOKEN_PREFIX,
} from "./oauth-bridge.js";
import type { CtxResolver } from "./server.js";

/**
 * Extract the bearer token from an incoming request's headers.
 *
 * Parses `Authorization: Bearer <key>` and returns `<key>`, or `null` when the header is missing or
 * malformed (so the caller responds 401 before any tool runs). Tolerant of Node's header shapes:
 * - case-insensitive header name (`Authorization` / `authorization`),
 * - array-valued headers (Node may give `string[]`) — the first element is used,
 * - a case-insensitive `Bearer ` scheme prefix.
 *
 * The token itself is never logged or returned anywhere but to `resolveBearer` (which compares only
 * its sha256).
 */
export function extractBearer(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  let raw: string | string[] | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "authorization") {
      raw = value;
      break;
    }
  }
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return null;

  // Token must start with a non-space char; trailing whitespace is trimmed. A scheme with no token
  // ("Bearer", "Bearer   ") yields no match → null.
  const match = /^\s*Bearer\s+(\S.*?)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * The narrow capability the operator-verb sweep needs: end every live session belonging to one
 * (userId, agentId). SessionAuth extends it; a test double can implement just this.
 */
export interface SessionEvictor {
  /** Evict every cached session whose ctx matches (userId, agentId). Returns the evicted ids. */
  evictAgent(userId: string, agentId: string): string[];
}

/**
 * Per-session bearer auth + ctx store. The agent's AuthContext is resolved ONCE at session init
 * (`authorize` → `resolveBearer`, the only DB hit) and cached by `Mcp-Session-Id`; every later tool
 * call reads the cached ctx — an in-memory lookup, no per-call DB and no per-call bearer.
 *
 * Revocation (#99): because the ctx is cached, a `revoked_at` written after the session initialized
 * would never be seen — the MCP edge and the REST mirror (which re-resolves the bearer on EVERY
 * request, mirror.ts:47-50) disagreed about what Revoke means. The fix is a PUSH, not a per-call
 * read: an operator verb calls `endAgentSessions`, which sweeps this map. The per-call DB hit stays
 * explicitly rejected — the grant check must remain an in-memory Set membership test
 * (auth/resolve.ts:6-9).
 */
export interface SessionAuth extends SessionEvictor {
  /** Resolve a presented bearer to its AuthContext. Throws AccessDenied on a missing/unknown/revoked key. */
  authorize(token: string | null): Promise<AuthContext>;
  /**
   * Cache the session's ctx (resolved once, at `sessioninitialized`). `resolvedAt` is Date.now()
   * captured IMMEDIATELY BEFORE `authorize()` ran. Returns false when a revoke landed at or after
   * `resolvedAt` — the ctx is then NOT cached and the caller must not serve the session. That is the
   * initialize/revoke race fence: without it, a session that read a still-live grant microseconds
   * before the revoke would bind AFTER the sweep and outlive it.
   */
  bind(sessionId: string, ctx: AuthContext, resolvedAt: number): boolean;
  /** The CtxResolver to hand buildServer: (extra) => the bound ctx for extra.sessionId. */
  resolver(): CtxResolver;
  /** Drop a session's cached ctx (on session close / DELETE). */
  drop(sessionId: string): void;
}

/** The minimal shape of the SDK tool-handler `extra` the resolver reads. */
interface ExtraWithSession {
  sessionId?: string;
}

// ── The process-wide session registry (#99) ───────────────────────────────────
// src/index.ts main() starts the REST edge and the MCP HTTP edge in the SAME Node process, so an
// in-process registry is sufficient for an operator verb to reach every live MCP session — no IPC,
// no DB channel, no polling. It lives here rather than in a new module because this file already
// owns session identity.

/** Every mounted edge's session store. Mount/unmount is the edge's lifecycle, not a global. */
const liveStores = new Set<SessionEvictor>();

/** `${userId}\u0000${agentId}` -> epoch ms of the most recent operator verb against that agent. */
const revokeFence = new Map<string, number>();

/**
 * How long a fence entry is honoured. It only has to outlive an in-flight initialize (milliseconds);
 * 5 minutes is a generous bound that also keeps the map from growing without limit. Expiry is what
 * lets a re-minted key connect again after a revoke.
 */
const REVOKE_FENCE_TTL_MS = 5 * 60_000;

function fenceKey(userId: string, agentId: string): string {
  return `${userId}\u0000${agentId}`;
}

/** Mount a store into the process-wide registry. Returns its unregister function. */
export function registerSessionStore(store: SessionEvictor): () => void {
  liveStores.add(store);
  return () => {
    liveStores.delete(store);
  };
}

/**
 * The operator-verb entry point (revoke · patch grants · mint/rotate · delete): evict (userId,
 * agentId) across every mounted edge AND raise the revoke fence so a session initializing RIGHT NOW
 * cannot bind afterwards. Returns the number of live sessions ended. Never throws — a broken edge
 * must not turn a successful revoke into a 500, and the DB write has already committed by the time
 * this runs.
 */
export function endAgentSessions(userId: string, agentId: string): number {
  const now = Date.now();
  for (const [k, at] of revokeFence) {
    if (now - at > REVOKE_FENCE_TTL_MS) revokeFence.delete(k);
  }
  revokeFence.set(fenceKey(userId, agentId), now);

  let ended = 0;
  for (const store of [...liveStores]) {
    try {
      ended += store.evictAgent(userId, agentId).length;
    } catch {
      // One bad store must never abort the sweep of the others.
    }
  }
  return ended;
}

/** Test-only: clear the process-wide registry + fence between suites. */
export function __resetSessionRegistryForTests(): void {
  liveStores.clear();
  revokeFence.clear();
}

/**
 * Construct an isolated session store. Each HTTP edge owns one `sessionAuth()`; sessions never share
 * state across edges, and one agent's ctx can never leak into another agent's session (keyed strictly
 * by the SDK-generated `Mcp-Session-Id`).
 *
 * `onEvict` is how the edge tears down the transport of a session this store just dropped — see
 * http.ts. It is called for each id evicted by `evictAgent` and for a `bind` the fence refused; it
 * must not throw (a throwing hook is swallowed so one bad session cannot abort a sweep).
 */
export function sessionAuth(opts?: { onEvict?: (sessionId: string) => void }): SessionAuth {
  const sessions = new Map<string, AuthContext>();

  const notifyEvicted = (sessionId: string): void => {
    try {
      opts?.onEvict?.(sessionId);
    } catch {
      // best-effort teardown notification — never let it abort a sweep
    }
  };

  return {
    async authorize(token: string | null): Promise<AuthContext> {
      if (token == null) throw new AccessDenied(); // missing bearer → 401, before any session/tool
      // Bridge tokens (pcgat_) resolve against the bridge tables FIRST — but ONLY when THIS PROCESS
      // IS SERVING THE BRIDGE. That is what bridgeTokensAcceptable() means: the config this process
      // actually mounted, or (for an env-configured gateway, byte-identically to before) MCP_PUBLIC_URL.
      // It is deliberately NOT "MCP_PUBLIC_URL is set" any more — a gateway published from the Console
      // has no env var describing it, and the old test would have mounted the bridge, completed a whole
      // OAuth flow, issued a token and then rejected that token here on every call. With the bridge off
      // the lookup still never happens and tokens minted during an earlier ON period are inert
      // (fail-closed). null = unknown to the bridge → fall through to the static-key resolve (which
      // then denies as an unknown agent).
      if (token.startsWith(BRIDGE_ACCESS_TOKEN_PREFIX) && bridgeTokensAcceptable()) {
        const ctx = await resolveBridgeToken(token); // token/grant expired|revoked → AccessDenied
        if (ctx) return ctx;
      }
      return resolveBearer(token); // unknown/revoked → AccessDenied (thrown by resolveBearer)
    },

    bind(sessionId: string, ctx: AuthContext, resolvedAt: number): boolean {
      // The initialize/revoke race fence. `resolvedAt` is when this session STARTED authorizing; a
      // fence stamped at or after that instant means the sweep ran while this initialize was in
      // flight and could not have seen it. Refuse to cache — an unbound session is already denied by
      // the resolver below, so this closes the one window the sweep alone cannot.
      const fencedAt = revokeFence.get(fenceKey(ctx.userId, ctx.agentId));
      if (fencedAt !== undefined && fencedAt >= resolvedAt) {
        notifyEvicted(sessionId);
        return false;
      }
      sessions.set(sessionId, ctx);
      return true;
    },

    evictAgent(userId: string, agentId: string): string[] {
      // Bridge-derived sessions are covered for free: resolveBridgeToken returns a ctx carrying the
      // GRANT's own userId/agentId (oauth-bridge.ts:256), so it matches the same predicate.
      const evicted: string[] = [];
      for (const [sessionId, bound] of sessions) {
        if (bound.userId === userId && bound.agentId === agentId) evicted.push(sessionId);
      }
      for (const sessionId of evicted) sessions.delete(sessionId);
      // Delete FIRST, then notify: the hook tears down transports and must never observe a session
      // that is still resolvable.
      for (const sessionId of evicted) notifyEvicted(sessionId);
      return evicted;
    },

    resolver(): CtxResolver {
      return async (extra: unknown): Promise<AuthContext> => {
        const sessionId = (extra as ExtraWithSession | undefined)?.sessionId;
        const ctx = sessionId ? sessions.get(sessionId) : undefined;
        if (!ctx) {
          // No bound ctx for this session — the session was never authorized (or already dropped).
          // Deny rather than fall back, so an unauthenticated call can never read data.
          throw new AccessDenied();
        }
        // Per-call deadline on the session-cached ctx (in-memory, zero cost): an expiring
        // credential — bearer key expiry or a bridge access token's ≤3600s life — dies mid-session
        // at its deadline instead of persisting to teardown.
        if (ctx.expiresAt != null && ctx.expiresAt.getTime() <= Date.now()) {
          throw new AccessDenied(undefined, "expired");
        }
        return ctx;
      };
    },

    drop(sessionId: string): void {
      sessions.delete(sessionId);
    },
  };
}

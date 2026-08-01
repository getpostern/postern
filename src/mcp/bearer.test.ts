// bearer/session unit tests — DB-free. resolveBearer is mocked so we assert the auth/cache contract
// (parse the header, 401 on missing/unknown/revoked, ctx resolved ONCE per session, isolation) without
// Postgres. These are the headline behaviors: 401-before-tool and once-per-session ctx.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccessDenied, type AuthContext } from "../auth/index.js";

// Mock the auth module's resolveBearer; keep AccessDenied + the rest real.
const resolveBearerMock = vi.fn<(token: string) => Promise<AuthContext>>();
vi.mock("../auth/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/index.js")>();
  return { ...actual, resolveBearer: (token: string) => resolveBearerMock(token) };
});

// Import AFTER the mock is registered.
const {
  extractBearer,
  sessionAuth,
  registerSessionStore,
  endAgentSessions,
  __resetSessionRegistryForTests,
} = await import("./bearer.js");

function ctx(over: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "u1",
    agentId: "claude",
    grantedSectors: new Set(["finance"]),
    ...over,
  };
}

/**
 * bind()'s third argument is `resolvedAt` — Date.now() captured immediately BEFORE authorize() ran.
 * A bind that is not exercising the revoke fence uses "now", which is always >= any fence this
 * suite raised, so it caches normally.
 */
function bindNow(
  auth: ReturnType<typeof sessionAuth>,
  sessionId: string,
  bound: AuthContext,
): boolean {
  return auth.bind(sessionId, bound, Date.now());
}

beforeEach(() => {
  resolveBearerMock.mockReset();
  // The registry + revoke fence are PROCESS-wide module state; a stale fence from a previous test
  // would refuse binds in the next one.
  __resetSessionRegistryForTests();
});

describe("extractBearer", () => {
  it("parses 'Bearer <key>' from Authorization", () => {
    expect(extractBearer({ authorization: "Bearer abc123" })).toBe("abc123");
  });

  it("is case-insensitive on the header name and the scheme", () => {
    expect(extractBearer({ Authorization: "bearer xyz" })).toBe("xyz");
    expect(extractBearer({ AUTHORIZATION: "BEARER zzz" })).toBe("zzz");
  });

  it("tolerates array-valued headers (Node shape)", () => {
    expect(extractBearer({ authorization: ["Bearer arr-key"] })).toBe("arr-key");
  });

  it("trims surrounding whitespace around the token", () => {
    expect(extractBearer({ authorization: "Bearer   spaced  " })).toBe("spaced");
  });

  it("returns null for missing / malformed / wrong-scheme headers", () => {
    expect(extractBearer({})).toBeNull();
    expect(extractBearer({ authorization: "Basic abc" })).toBeNull();
    expect(extractBearer({ authorization: "Bearer" })).toBeNull(); // no token
    expect(extractBearer({ authorization: "Bearer    " })).toBeNull(); // whitespace only
    expect(extractBearer({ authorization: undefined })).toBeNull();
  });
});

describe("sessionAuth.authorize", () => {
  it("a valid bearer resolves to its ctx", async () => {
    const expected = ctx();
    resolveBearerMock.mockResolvedValueOnce(expected);
    const auth = sessionAuth();
    await expect(auth.authorize("good")).resolves.toBe(expected);
    expect(resolveBearerMock).toHaveBeenCalledWith("good");
  });

  it("a MISSING bearer (null) throws AccessDenied WITHOUT touching resolveBearer (401 path)", async () => {
    const auth = sessionAuth();
    await expect(auth.authorize(null)).rejects.toBeInstanceOf(AccessDenied);
    expect(resolveBearerMock).not.toHaveBeenCalled();
  });

  it("an unknown/revoked bearer surfaces resolveBearer's AccessDenied", async () => {
    resolveBearerMock.mockRejectedValueOnce(new AccessDenied("unknown agent"));
    const auth = sessionAuth();
    await expect(auth.authorize("bad")).rejects.toBeInstanceOf(AccessDenied);
  });
});

describe("bind + resolver() — the once-per-session ctx store", () => {
  it("resolver returns the bound ctx for a given extra.sessionId", async () => {
    const bound = ctx({ agentId: "agent-a" });
    const auth = sessionAuth();
    bindNow(auth, "sess-a", bound);
    const resolve = auth.resolver();
    await expect(resolve({ sessionId: "sess-a" })).resolves.toBe(bound);
  });

  it("authorize runs ONCE per session — later tool calls read the cached ctx (no second resolveBearer)", async () => {
    const bound = ctx();
    resolveBearerMock.mockResolvedValueOnce(bound);
    const auth = sessionAuth();

    // Init: one authorize → one resolveBearer, then bind.
    const resolved = await auth.authorize("k");
    bindNow(auth, "sess-1", resolved);
    expect(resolveBearerMock).toHaveBeenCalledTimes(1);

    // Many later tool calls hit only the in-memory store.
    const resolve = auth.resolver();
    await resolve({ sessionId: "sess-1" });
    await resolve({ sessionId: "sess-1" });
    await resolve({ sessionId: "sess-1" });
    expect(resolveBearerMock).toHaveBeenCalledTimes(1); // still ONE — never a per-call DB hit
  });

  it("isolation: one session's ctx never leaks into another's", async () => {
    const a = ctx({ agentId: "agent-a", grantedSectors: new Set(["finance"]) });
    const b = ctx({ agentId: "agent-b", grantedSectors: new Set(["home"]) });
    const auth = sessionAuth();
    bindNow(auth, "sess-a", a);
    bindNow(auth, "sess-b", b);
    const resolve = auth.resolver();
    await expect(resolve({ sessionId: "sess-a" })).resolves.toBe(a);
    await expect(resolve({ sessionId: "sess-b" })).resolves.toBe(b);
  });

  it("resolver denies an unknown / dropped session (no fallback to operator)", async () => {
    const auth = sessionAuth();
    const resolve = auth.resolver();
    await expect(resolve({ sessionId: "never-bound" })).rejects.toBeInstanceOf(AccessDenied);
    await expect(resolve({})).rejects.toBeInstanceOf(AccessDenied); // no sessionId at all

    bindNow(auth, "sess-x", ctx());
    auth.drop("sess-x");
    await expect(resolve({ sessionId: "sess-x" })).rejects.toBeInstanceOf(AccessDenied);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════
// #99 — session revocation. An operator verb (revoke · patch grants · mint/rotate · delete) must end
// live MCP sessions IN PROCESS, so both agent edges agree about what Revoke means: the REST mirror
// re-resolves the bearer on every request (mirror.ts:47-50) and always denied immediately; the MCP
// edge caches the ctx per session and did not. The fix is a push (endAgentSessions → evictAgent),
// never a per-call DB read — the grant check must stay an in-memory Set test (auth/resolve.ts:6-9).
// ═══════════════════════════════════════════════════════════════════════════════════

describe("evictAgent — ending one agent's live sessions", () => {
  it("evicting an agent drops exactly its own sessions and leaves the others resolvable", async () => {
    const auth = sessionAuth();
    const claudeA = ctx({ userId: "u1", agentId: "claude" });
    const claudeB = ctx({ userId: "u1", agentId: "claude" });
    const other = ctx({ userId: "u1", agentId: "codex", grantedSectors: new Set(["home"]) });
    bindNow(auth, "s-claude-1", claudeA);
    bindNow(auth, "s-claude-2", claudeB);
    bindNow(auth, "s-codex", other);

    const evicted = auth.evictAgent("u1", "claude");
    expect(evicted.sort()).toEqual(["s-claude-1", "s-claude-2"]);

    const resolve = auth.resolver();
    await expect(resolve({ sessionId: "s-claude-1" })).rejects.toBeInstanceOf(AccessDenied);
    await expect(resolve({ sessionId: "s-claude-2" })).rejects.toBeInstanceOf(AccessDenied);
    // The survivor must still RESOLVE to its own ctx — an evictAgent that cleared the whole map
    // would pass a count-only assertion.
    await expect(resolve({ sessionId: "s-codex" })).resolves.toBe(other);
  });

  it("the (userId, agentId) predicate is BOTH fields — a same-named agent of another user survives", async () => {
    const auth = sessionAuth();
    const mine = ctx({ userId: "u1", agentId: "claude" });
    const theirs = ctx({ userId: "u2", agentId: "claude" });
    bindNow(auth, "s-mine", mine);
    bindNow(auth, "s-theirs", theirs);

    expect(auth.evictAgent("u1", "claude")).toEqual(["s-mine"]);
    await expect(auth.resolver()({ sessionId: "s-theirs" })).resolves.toBe(theirs);
  });

  it("an evicted session id is reported to onEvict", () => {
    const seen: string[] = [];
    const auth = sessionAuth({ onEvict: (sid) => seen.push(sid) });
    bindNow(auth, "s-1", ctx());
    bindNow(auth, "s-2", ctx());
    bindNow(auth, "s-other", ctx({ agentId: "codex" }));

    auth.evictAgent("u1", "claude");
    expect(seen.sort()).toEqual(["s-1", "s-2"]); // exactly the evicted ids — this is what closes the
    // transport in http.ts; without it the client keeps a live socket to a dead session.
  });

  it("a throwing onEvict does not abort the rest of the eviction", async () => {
    const auth = sessionAuth({
      onEvict: (sid) => {
        if (sid === "s-1") throw new Error("teardown exploded");
      },
    });
    bindNow(auth, "s-1", ctx());
    bindNow(auth, "s-2", ctx());
    expect(auth.evictAgent("u1", "claude").sort()).toEqual(["s-1", "s-2"]);
    await expect(auth.resolver()({ sessionId: "s-2" })).rejects.toBeInstanceOf(AccessDenied);
  });
});

describe("the revoke fence — the initialize/revoke race", () => {
  it("a session authorized before a revoke that already swept is refused at bind", async () => {
    const auth = sessionAuth();
    const t0 = Date.now() - 1; // strictly before the fence stamp, so the comparison is deterministic
    endAgentSessions("u1", "a1");

    expect(auth.bind("s1", ctx({ userId: "u1", agentId: "a1" }), t0)).toBe(false);
    await expect(auth.resolver()({ sessionId: "s1" })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("a refused bind is reported to onEvict so the caller can tear its transport down", () => {
    const seen: string[] = [];
    const auth = sessionAuth({ onEvict: (sid) => seen.push(sid) });
    const t0 = Date.now() - 1;
    endAgentSessions("u1", "a1");
    expect(auth.bind("s-raced", ctx({ userId: "u1", agentId: "a1" }), t0)).toBe(false);
    expect(seen).toEqual(["s-raced"]);
  });

  it("a session authorized after the fence binds normally", async () => {
    const auth = sessionAuth();
    endAgentSessions("u1", "a1");
    const bound = ctx({ userId: "u1", agentId: "a1" });

    // A re-mint/reconnect resolves AFTER the revoke: it must be served, or a revoked-then-re-minted
    // key could never connect again.
    expect(auth.bind("s2", bound, Date.now() + 1)).toBe(true);
    await expect(auth.resolver()({ sessionId: "s2" })).resolves.toBe(bound);
  });

  it("the fence is scoped to the swept agent — another agent binds freely", async () => {
    const auth = sessionAuth();
    const t0 = Date.now() - 1;
    endAgentSessions("u1", "a1");
    const other = ctx({ userId: "u1", agentId: "a2" });
    expect(auth.bind("s3", other, t0)).toBe(true);
    await expect(auth.resolver()({ sessionId: "s3" })).resolves.toBe(other);
  });
});

describe("endAgentSessions — the process-wide sweep", () => {
  /** A minimal SessionEvictor double: reports `ids` and records the args it was called with. */
  function fakeStore(ids: string[]): { evictAgent: (u: string, a: string) => string[]; args: unknown[][] } {
    const args: unknown[][] = [];
    return {
      args,
      evictAgent(userId: string, agentId: string): string[] {
        args.push([userId, agentId]);
        return ids;
      },
    };
  }

  it("sums across every mounted store and is 0 with none mounted", () => {
    expect(endAgentSessions("u1", "claude")).toBe(0); // nothing mounted (the stdio-only process)

    const one = fakeStore(["a"]);
    const two = fakeStore(["b", "c"]);
    const offOne = registerSessionStore(one);
    const offTwo = registerSessionStore(two);

    expect(endAgentSessions("u1", "claude")).toBe(3); // 1 + 2 — it does not stop at the first store
    expect(one.args).toEqual([["u1", "claude"]]);
    expect(two.args).toEqual([["u1", "claude"]]);

    offOne();
    offTwo();
    expect(endAgentSessions("u1", "claude")).toBe(0); // unregistered edges are never swept
  });

  it("one throwing store does not abort the sweep", () => {
    const thrower = {
      evictAgent(): string[] {
        throw new Error("this edge is broken");
      },
    };
    const good = fakeStore(["x", "y"]);
    registerSessionStore(thrower);
    registerSessionStore(good);

    expect(endAgentSessions("u1", "claude")).toBe(2); // the good store still ran
    expect(good.args).toEqual([["u1", "claude"]]);
  });

  it("a real sessionAuth mounted in the registry is swept end to end", async () => {
    const auth = sessionAuth();
    registerSessionStore(auth);
    const bound = ctx({ userId: "u1", agentId: "claude" });
    bindNow(auth, "s-live", bound);
    await expect(auth.resolver()({ sessionId: "s-live" })).resolves.toBe(bound);

    expect(endAgentSessions("u1", "claude")).toBe(1);
    await expect(auth.resolver()({ sessionId: "s-live" })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("never throws", () => {
    expect(() => endAgentSessions("", "")).not.toThrow();
  });
});

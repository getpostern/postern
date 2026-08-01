// OAuth-bridge unit tests — DB-free. Covers the pure surfaces: the ONE-switch config parsing
// (MCP_PUBLIC_URL; named fail-closed errors; canonicalization; the env→config wiring), the pinned
// redirect-URI policy (registration rule + the ADR 0035 §D3 reserved-path guard over the whole
// loopback RANGE + port-agnostic matching), the discovery documents (PRM both paths + the FULL RFC
// 8414 doc — served without touching the DB), the fail-closed OFF gate, and the rest of the
// public-edge surface: trusted-proxy client identity WHERE IT EXISTS, the one plain rate limiter and
// its bucket-map memory bound, the DB semaphore, the deny-audit throttle split by cost-to-trigger,
// the LRU eviction policy and the required-expiry rule.
// Every window/bucket assertion drives the injected `deps.now`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "../db.js";
import { queue } from "../audit/queue.js";
import type { AuditEntry } from "../audit/index.js";

const { resolveBearerMock } = vi.hoisted(() => ({ resolveBearerMock: vi.fn() }));
vi.mock("../auth/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/index.js")>();
  return { ...actual, resolveBearer: (t: string) => resolveBearerMock(t) };
});

import { AccessDenied } from "../auth/index.js";
import {
  bridgeConfigFromEnv,
  activeBridgeConfig,
  BridgeConfigError,
  bridgeRoutes,
  resolveBridgeToken,
  isRegistrableRedirectUri,
  redirectUriMatches,
  parseTrustedProxies,
  isTrustedProxy,
  resolveClientIp,
  canonicalizeUrl,
  resourceMatches,
  createRateLimiter,
  BRIDGE_ACCESS_TOKEN_PREFIX,
  BRIDGE_DB_CONCURRENCY,
  BRIDGE_DENY_AUDIT_CAP,
  BRIDGE_RATE_CAPACITY,
  BUCKET_MAX_KEYS,
  CLIENT_CAP,
  type BridgePool,
  type BridgePoolClient,
  type BridgeQueryResult,
} from "./oauth-bridge.js";

const savedEnv = process.env.MCP_PUBLIC_URL;
const savedProxies = process.env.MCP_TRUSTED_PROXIES;

beforeEach(() => {
  delete process.env.MCP_PUBLIC_URL;
  delete process.env.MCP_TRUSTED_PROXIES;
  resolveBearerMock.mockReset();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MCP_PUBLIC_URL;
  else process.env.MCP_PUBLIC_URL = savedEnv;
  if (savedProxies === undefined) delete process.env.MCP_TRUSTED_PROXIES;
  else process.env.MCP_TRUSTED_PROXIES = savedProxies;
  vi.restoreAllMocks();
});

// ── Fakes ────────────────────────────────────────────────────────────────────────

/** Minimal writeHead/end capture standing in for a ServerResponse. */
function fakeRes(): { statusCode: number; headers: Record<string, unknown>; body: string } & ServerResponse {
  const r = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: "",
    writeHead(status: number, headers?: Record<string, unknown>) {
      r.statusCode = status;
      if (headers) Object.assign(r.headers, headers);
      return r;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") r.body += chunk;
    },
    setHeader(name: string, value: unknown) {
      r.headers[name.toLowerCase()] = value;
    },
  };
  return r as unknown as { statusCode: number; headers: Record<string, unknown>; body: string } & ServerResponse;
}

/** A real Readable standing in for an IncomingMessage (readBody iterates it). */
function fakeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
  ip?: string;
}): IncomingMessage {
  const stream = Readable.from(
    opts.body !== undefined ? [Buffer.from(opts.body, "utf8")] : [],
  ) as unknown as IncomingMessage & Record<string, unknown>;
  stream.headers = { ...(opts.headers ?? {}) } as IncomingMessage["headers"];
  stream.url = opts.url ?? "/";
  stream.method = opts.method ?? "GET";
  (stream as unknown as { socket: unknown }).socket = { remoteAddress: opts.ip ?? "127.0.0.1" };
  return stream as unknown as IncomingMessage;
}

const EMPTY: BridgeQueryResult = { rows: [], rowCount: 0 };

interface StubPool extends BridgePool {
  sqls: string[];
  connectCount: number;
}

/** A structural pg stand-in. `handler` answers by SQL fragment; anything unmatched → empty. */
function stubPool(handler: (sql: string, values: unknown[]) => BridgeQueryResult | undefined): StubPool {
  const p: StubPool = {
    sqls: [],
    connectCount: 0,
    async query(sql: string, values: unknown[] = []): Promise<BridgeQueryResult> {
      p.sqls.push(sql);
      return handler(sql, values) ?? EMPTY;
    },
    async connect(): Promise<BridgePoolClient> {
      p.connectCount += 1;
      return { query: (sql, values) => p.query(sql, values ?? []), release: () => {} };
    },
  };
  return p;
}

const CLIENT_ROW = {
  client_id: "pcgcl_test",
  client_name: "Test Client",
  redirect_uris: ["https://client.test/cb"],
};

/** A pool that answers the client lookup with `redirectUris` and nothing else. */
function clientPool(redirectUris: string[] = CLIENT_ROW.redirect_uris): StubPool {
  return stubPool((sql) =>
    sql.includes("from oauth_bridge_clients")
      ? { rows: [{ ...CLIENT_ROW, redirect_uris: redirectUris }], rowCount: 1 }
      : undefined,
  );
}

const auditBuf = (): AuditEntry[] => (queue as unknown as { buf: AuditEntry[] }).buf;
const resetAudit = (): void => {
  (queue as unknown as { buf: AuditEntry[] }).buf = [];
};

// ── Config ───────────────────────────────────────────────────────────────────────

describe("bridgeConfigFromEnv — the ONE switch, fail-closed", () => {
  it("unset / empty / whitespace → null (bridge OFF)", () => {
    expect(bridgeConfigFromEnv({})).toBeNull();
    expect(bridgeConfigFromEnv({ MCP_PUBLIC_URL: "" })).toBeNull();
    expect(bridgeConfigFromEnv({ MCP_PUBLIC_URL: "   " })).toBeNull();
    // MCP_TRUSTED_PROXIES alone never turns anything on (and is never even parsed).
    expect(bridgeConfigFromEnv({ MCP_TRUSTED_PROXIES: "172.18.0.0/16" })).toBeNull();
  });

  it("https accepted; trailing slash normalized away (the PRM exact-match depends on it)", () => {
    expect(bridgeConfigFromEnv({ MCP_PUBLIC_URL: "https://gw.example.ts.net:10000" })).toEqual({
      publicUrl: "https://gw.example.ts.net:10000",
      trustedProxies: [],
    });
    expect(bridgeConfigFromEnv({ MCP_PUBLIC_URL: "https://gw.example.ts.net:10000/" })).toEqual({
      publicUrl: "https://gw.example.ts.net:10000",
      trustedProxies: [],
    });
  });

  it("http allowed ONLY for localhost/127.0.0.1 dev", () => {
    expect(bridgeConfigFromEnv({ MCP_PUBLIC_URL: "http://localhost:8788" })?.publicUrl).toBe(
      "http://localhost:8788",
    );
    expect(bridgeConfigFromEnv({ MCP_PUBLIC_URL: "http://127.0.0.1:8788" })?.publicUrl).toBe(
      "http://127.0.0.1:8788",
    );
    expect(() => bridgeConfigFromEnv({ MCP_PUBLIC_URL: "http://gw.example.com" })).toThrow(
      BridgeConfigError,
    );
    expect(() => bridgeConfigFromEnv({ MCP_PUBLIC_URL: "http://gw.example.com" })).toThrow(
      /must be https/,
    );
  });

  it("malformed / query-carrying values throw a NAMED error (boot refuses to start)", () => {
    expect(() => bridgeConfigFromEnv({ MCP_PUBLIC_URL: "not a url" })).toThrow(BridgeConfigError);
    expect(() => bridgeConfigFromEnv({ MCP_PUBLIC_URL: "https://gw.example.com/?x=1" })).toThrow(
      BridgeConfigError,
    );
  });

  it("the parsed proxy list actually REACHES the config (the env→BridgeConfig wiring)", () => {
    // Nothing else in the non-DB suite would notice if bridgeConfigFromEnv parsed MCP_TRUSTED_PROXIES
    // and then dropped it on the floor: every other cell constructs the BridgeConfig by hand. The
    // whole variable would silently do nothing on a real box.
    const env = {
      MCP_PUBLIC_URL: "https://gw.example.com",
      MCP_TRUSTED_PROXIES: "172.18.0.0/16, ::1",
    };
    for (const cfg of [bridgeConfigFromEnv(env), activeBridgeConfig(env)]) {
      expect(cfg).not.toBeNull();
      const trusted = cfg!.trustedProxies;
      expect(trusted).toBeDefined();
      expect(trusted!.map((p) => p.prefixBits)).toEqual([16, 128]);
      expect(isTrustedProxy("172.18.9.9", trusted!)).toBe(true);
      expect(isTrustedProxy("10.0.0.1", trusted!)).toBe(false);
      // …and it is the value identity resolution then honours, end to end.
      expect(
        resolveClientIp(
          fakeReq({ ip: "172.18.0.1", headers: { "x-forwarded-for": "203.0.113.44" } }),
          trusted!,
        ),
      ).toBe("203.0.113.44");
    }
    // A malformed entry still refuses at boot through the same wiring.
    expect(() =>
      bridgeConfigFromEnv({ MCP_PUBLIC_URL: "https://gw.example.com", MCP_TRUSTED_PROXIES: "nope" }),
    ).toThrow(BridgeConfigError);
  });

  it("activeBridgeConfig never throws: invalid behaves as OFF (fail-closed)", () => {
    expect(activeBridgeConfig({ MCP_PUBLIC_URL: "http://spoofable.example.com" })).toBeNull();
    expect(activeBridgeConfig({})).toBeNull();
    expect(activeBridgeConfig({ MCP_PUBLIC_URL: "https://ok.example.com" })?.publicUrl).toBe(
      "https://ok.example.com",
    );
    // A malformed trusted-proxy list is ALSO fail-closed here (boot already refused loudly).
    expect(
      activeBridgeConfig({ MCP_PUBLIC_URL: "https://ok.example.com", MCP_TRUSTED_PROXIES: "nope" }),
    ).toBeNull();
  });
});

// ── Client identity: honour a real proxy where one exists, and be honest where none does ──

describe("trusted proxies + client identity (ADR 0035 §D3 item 1, as narrowed by the 07-25 ruling)", () => {
  it("a malformed trusted-proxy entry refuses at boot rather than silently trusting nothing", () => {
    expect(() => parseTrustedProxies("172.18.0.0/99")).toThrow(BridgeConfigError);
    expect(() => parseTrustedProxies("not-an-ip")).toThrow(BridgeConfigError);
    expect(() => parseTrustedProxies("172.18.0.0/abc")).toThrow(BridgeConfigError);
    expect(() => parseTrustedProxies("fd00::/200")).toThrow(BridgeConfigError);
    expect(parseTrustedProxies("")).toEqual([]);
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies("  ")).toEqual([]);
    // And a good list parses, whitespace and mixed families tolerated.
    const t = parseTrustedProxies(" 172.18.0.0/16 , 127.0.0.1 ,fd00::/8 ");
    expect(t).toHaveLength(3);
    expect(t.map((e) => e.prefixBits)).toEqual([16, 32, 8]);
    expect(isTrustedProxy("172.18.5.9", t)).toBe(true);
    expect(isTrustedProxy("172.19.5.9", t)).toBe(false);
    expect(isTrustedProxy("127.0.0.1", t)).toBe(true);
    expect(isTrustedProxy("fd00::1", t)).toBe(true);
    expect(isTrustedProxy("::1", t)).toBe(false);
    // An IPv4-mapped socket address matches its v4 CIDR (one client is one key).
    expect(isTrustedProxy("::ffff:172.18.5.9", t)).toBe(true);
  });

  it("a forged forwarded header from an untrusted peer is ignored entirely", () => {
    const req = fakeReq({ ip: "10.0.0.5", headers: { "x-forwarded-for": "1.2.3.4" } });
    // No trusted list at all — today's behaviour, preserved exactly for every loopback-only user.
    expect(resolveClientIp(req, [])).toBe("10.0.0.5");
    // A trusted list that does NOT contain the peer is just as inert.
    expect(resolveClientIp(req, parseTrustedProxies("172.18.0.0/16"))).toBe("10.0.0.5");
    // …and an IPv4-mapped peer normalizes to one key.
    expect(
      resolveClientIp(fakeReq({ ip: "::ffff:10.0.0.5", headers: { "x-forwarded-for": "1.2.3.4" } }), []),
    ).toBe("10.0.0.5");
  });

  it("behind a configured proxy the real caller is the rightmost untrusted hop", () => {
    const trusted = parseTrustedProxies("127.0.0.1,172.18.0.0/16");
    const req = fakeReq({
      ip: "127.0.0.1",
      headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7, 172.18.0.1" },
    });
    expect(resolveClientIp(req, trusted)).toBe("203.0.113.7");
    // A port suffix on a hop is stripped; an all-trusted chain falls back to the peer.
    expect(
      resolveClientIp(
        fakeReq({ ip: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.7:41234" } }),
        trusted,
      ),
    ).toBe("203.0.113.7");
    expect(
      resolveClientIp(fakeReq({ ip: "127.0.0.1", headers: { "x-forwarded-for": "172.18.0.9" } }), trusted),
    ).toBe("127.0.0.1");
    expect(resolveClientIp(fakeReq({ ip: "127.0.0.1" }), trusted)).toBe("127.0.0.1");
    // A multi-valued header is joined, not silently truncated.
    expect(
      resolveClientIp(
        fakeReq({ ip: "127.0.0.1", headers: { "x-forwarded-for": ["9.9.9.9", "203.0.113.8, 172.18.0.1"] } }),
        trusted,
      ),
    ).toBe("203.0.113.8");
  });

  it("one flooding source stays limited even when it varies a forged forwarded header on every request", async () => {
    // The peer IS trusted (a real proxy hop), so XFF is read — but only the RIGHTMOST untrusted
    // entry counts. xff[0] is fully attacker-controlled even behind a legitimate proxy.
    const routes = bridgeRoutes(
      { publicUrl: "https://gw.example.com", trustedProxies: parseTrustedProxies("127.0.0.1") },
      { pool: stubPool(() => undefined) },
    );
    const register = routes.get("POST /register")!;
    const fire = async (xff: string): Promise<number> => {
      const res = fakeRes();
      await register(
        fakeReq({
          method: "POST",
          ip: "127.0.0.1",
          headers: { "content-type": "application/json", "x-forwarded-for": xff },
          body: "{}", // refused without a row, but still metered
        }),
        res,
      );
      return res.statusCode;
    };

    const statuses: number[] = [];
    const FLOOD = BRIDGE_RATE_CAPACITY + 5;
    for (let i = 0; i < FLOOD; i++) {
      statuses.push(await fire(`10.9.${(i >> 8) & 255}.${i & 255}, 198.51.100.4`)); // ONE real client
    }
    // Exactly the capacity admitted (each a 400 on the bad body), the rest refused.
    expect(statuses.filter((s) => s === 400)).toHaveLength(BRIDGE_RATE_CAPACITY);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(statuses[statuses.length - 1]).toBe(429);
    // WHERE identities are genuinely distinguishable, the flood is not collateral on anyone else.
    expect(await fire("198.51.100.5")).toBe(400);
  });

  it("behind a Funnel there is NO client identity — the limit is global, and this pins it", async () => {
    // The accepted limitation (operator ruling 2026-07-25), asserted rather than glossed. Tailscale
    // terminates TLS and proxies from localhost, and Docker NATs every connection to one address, so
    // with no trusted proxy configured — every Funnel deployment — the owner and an attacker resolve
    // to the SAME key. Nobody may later read this limiter as per-caller protection.
    const owner = fakeReq({ ip: "127.0.0.1", headers: { "x-forwarded-for": "203.0.113.9" } });
    const stranger = fakeReq({ ip: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.9" } });
    expect(resolveClientIp(owner, [])).toBe(resolveClientIp(stranger, []));

    // …and therefore a flood really can refuse the next caller. No data, key or established
    // connection is at risk — only connection SETUP — which is the accepted trade.
    const routes = bridgeRoutes(
      { publicUrl: "https://gw.example.com" }, // no trustedProxies: the shipped Funnel shape
      { pool: stubPool(() => undefined) },
    );
    const fire = async (xff: string): Promise<number> => {
      const res = fakeRes();
      await routes.get("POST /register")!(
        fakeReq({
          method: "POST",
          ip: "127.0.0.1",
          headers: { "content-type": "application/json", "x-forwarded-for": xff },
          body: "{}",
        }),
        res,
      );
      return res.statusCode;
    };
    for (let i = 0; i < BRIDGE_RATE_CAPACITY; i++) expect(await fire("198.51.100.9")).toBe(400);
    expect(await fire("203.0.113.9")).toBe(429); // a "different" caller — same bucket
  });

  it("key churn cannot hand a limited source a fresh burst", () => {
    // BUCKET_MAX_KEYS is the shipped bound; the cell drives a small one so the churn is fast.
    expect(BUCKET_MAX_KEYS).toBe(10_000);
    const t = 1_700_000_000_000;
    const limiter = createRateLimiter({
      capacity: 10,
      refillPerMin: 10,
      maxKeys: 100,
      now: () => t, // frozen: nothing refills, so only the eviction policy can change an outcome
    });

    // The flooder drains its own bucket.
    for (let i = 0; i < 10; i++) expect(limiter.take("198.51.100.1")).toBe(true);
    expect(limiter.take("198.51.100.1")).toBe(false);

    // Now churn fresh keys past the bound many times over, while the flooder keeps hammering.
    for (let i = 0; i < 1000; i++) {
      limiter.take(`10.0.${(i >> 8) & 255}.${i & 255}`);
      if (i % 10 === 0) expect(limiter.take("198.51.100.1")).toBe(false);
    }
    expect(limiter.keyCount()).toBeLessThanOrEqual(100);
    // The load-bearing assertion: the churn did NOT reset the flooder.
    expect(limiter.take("198.51.100.1")).toBe(false);
  });

  it("a bucket that has refilled to full is dropped first (dropping it is identical to keeping it)", () => {
    let t = 1_700_000_000_000;
    const limiter = createRateLimiter({
      capacity: 10,
      refillPerMin: 600, // one full refill per second
      maxKeys: 50,
      now: () => t,
    });
    for (let i = 0; i < 50; i++) limiter.take(`10.1.0.${i}`);
    expect(limiter.keyCount()).toBe(50);
    t += 60_000; // every existing bucket is now full again
    limiter.take("10.2.0.1"); // trips the bound → the full buckets are reclaimed
    // EVERY full bucket goes, not just enough to reach the 90% LRU target (which would leave 45).
    expect(limiter.keyCount()).toBe(1);
  });
});

// ── §D3 item 4 — redirect-URI policy ─────────────────────────────────────────────

describe("redirect-URI policy (pinned end-to-end)", () => {
  it("registration: https anywhere, http only on loopback hosts", () => {
    expect(isRegistrableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isRegistrableRedirectUri("http://localhost:3030/cb")).toBe(true);
    expect(isRegistrableRedirectUri("http://127.0.0.1:41211/cb")).toBe(true);
    expect(isRegistrableRedirectUri("http://[::1]:8080/cb")).toBe(true);
    expect(isRegistrableRedirectUri("http://evil.example.com/cb")).toBe(false);
    expect(isRegistrableRedirectUri("myapp://cb")).toBe(false);
    expect(isRegistrableRedirectUri("not a uri")).toBe(false);
  });

  it("a redirect address pointing into the gateway's own route namespace is refused at registration", () => {
    for (const uri of [
      "http://localhost:1/api/export",
      "http://localhost:1/api",
      "http://127.0.0.1:8787/admin/x",
      "http://localhost:8787/healthz",
      "http://localhost:1/mcp",
      "http://localhost:1/authorize",
      "http://localhost:1/token",
      "http://localhost:1/register",
      "http://localhost:1/%61pi/export", // percent-encoded 'a' — the decoded form is checked too
      "http://localhost:1/API/export", // case-insensitive
      "http://localhost:1/cb/%2e%2e/api/export", // an encoded parent segment
      "http://[::1]:1/api/export",
    ]) {
      expect(isRegistrableRedirectUri(uri)).toBe(false);
    }
    // A genuine loopback callback is untouched, and a REMOTE https origin is unaffected entirely.
    expect(isRegistrableRedirectUri("http://localhost:1/callback")).toBe(true);
    expect(isRegistrableRedirectUri("http://localhost:1/oauth/cb")).toBe(true);
    expect(isRegistrableRedirectUri("http://localhost:1/apiary/cb")).toBe(true); // prefix, not a segment
    expect(isRegistrableRedirectUri("https://claude.ai/api/mcp/callback")).toBe(true);
    expect(isRegistrableRedirectUri("https://claude.ai/admin")).toBe(true);
  });

  it("the loopback test is a RANGE test — 127.0.0.2 and *.localhost are the same machine", () => {
    // A three-string allowlist ({localhost, 127.0.0.1, [::1]}) let every other loopback spelling
    // fall straight through the confused-deputy guard: 127.0.0.2:8787 reaches the identical admin
    // edge as 127.0.0.1:8787, and browsers resolve every *.localhost name to loopback (RFC 6761).
    for (const uri of [
      "http://127.0.0.2:8787/api/export",
      "http://127.9.9.9:8787/admin/erase",
      "http://127.0.0.1:8787/api/export",
      "https://127.0.0.2/api/export",
      "http://app.localhost:8787/api/export",
      "http://[::ffff:127.0.0.1]:8787/api/export", // the IPv4-mapped spelling of the same address
    ]) {
      expect(isRegistrableRedirectUri(uri)).toBe(false);
      expect(redirectUriMatches(uri, uri)).toBe(false);
    }
    // Anti-vacuity: the same hosts OUTSIDE the reserved namespace still register (they are ordinary
    // loopback callbacks), and a non-loopback address that merely LOOKS close is untouched.
    expect(isRegistrableRedirectUri("http://127.0.0.2:8787/callback")).toBe(true);
    expect(isRegistrableRedirectUri("http://app.localhost:8787/callback")).toBe(true);
    expect(isRegistrableRedirectUri("https://notlocalhost.example/api/export")).toBe(true);
    expect(isRegistrableRedirectUri("http://128.0.0.1:8787/callback")).toBe(false); // not loopback → http refused
    expect(isRegistrableRedirectUri("https://localhost.evil.example/api/export")).toBe(true);
  });

  it("the reserved-path guard is scoped to the loopback HOST, not to the http scheme", () => {
    // The scheme is not what makes the confused deputy work — the loopback target is. A browser
    // follows a 302 to `https://localhost/api/export` exactly as it follows the http form.
    for (const uri of [
      "https://localhost/api/export",
      "https://localhost:8787/admin/erase",
      "https://127.0.0.1/api/export",
      "https://[::1]/mcp",
      "https://localhost/%61pi/export",
      "https://localhost/healthz",
    ]) {
      expect(isRegistrableRedirectUri(uri)).toBe(false);
      expect(redirectUriMatches(uri, uri)).toBe(false); // and it can never be matched either
    }
    // Anti-vacuity: a loopback https callback OUTSIDE the reserved namespace still registers, and a
    // remote origin's /api path is none of our business.
    expect(isRegistrableRedirectUri("https://localhost:3030/callback")).toBe(true);
    expect(isRegistrableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
  });

  it("match: byte-equal everywhere; the PORT alone is ignored for loopback http", () => {
    expect(redirectUriMatches("https://claude.ai/cb", "https://claude.ai/cb")).toBe(true);
    // Loopback port-agnostic (Claude Code declares both localhost + 127.0.0.1 with ephemeral ports).
    expect(redirectUriMatches("http://localhost:3030/cb", "http://localhost:52111/cb")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1:3030/cb", "http://127.0.0.1/cb")).toBe(true);
    expect(redirectUriMatches("http://[::1]:3030/cb", "http://[::1]:9/cb")).toBe(true);
    // Host stays exact even across loopback forms.
    expect(redirectUriMatches("http://localhost:3030/cb", "http://127.0.0.1:3030/cb")).toBe(false);
    // Path/query stay byte-equal.
    expect(redirectUriMatches("http://localhost:3030/cb", "http://localhost:3030/cb2")).toBe(false);
    expect(redirectUriMatches("http://localhost:3030/cb?a=1", "http://localhost:3030/cb?a=2")).toBe(false);
    // Non-loopback: the port is NOT ignored.
    expect(redirectUriMatches("https://claude.ai:444/cb", "https://claude.ai:445/cb")).toBe(false);
    expect(redirectUriMatches("https://claude.ai/cb", "https://evil.example.com/cb")).toBe(false);
  });

  it("a client registered against a loopback admin path can never be matched, even byte-identically", () => {
    expect(redirectUriMatches("http://localhost:1/api/export", "http://localhost:8787/api/export")).toBe(
      false,
    );
    // The byte-identical pair is the one the `registered === presented` fast path used to wave through.
    expect(
      redirectUriMatches("http://localhost:8787/api/export", "http://localhost:8787/api/export"),
    ).toBe(false);
    expect(redirectUriMatches("http://localhost:1/mcp", "http://localhost:1/mcp")).toBe(false);
    // …and a scheme registration can never sneak past on identity either.
    expect(redirectUriMatches("myapp://cb", "myapp://cb")).toBe(false);
  });

  it("Claude Code's ephemeral loopback port still connects", () => {
    // The regression sentinel for §D3 item 4: the fix is WRONG if this goes red.
    expect(redirectUriMatches("http://localhost:0/callback", "http://localhost:52345/callback")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1:0/callback", "http://127.0.0.1:52345/callback")).toBe(true);
    // …across the whole loopback range, since that is what the guard now recognises.
    expect(redirectUriMatches("http://127.0.0.2:0/callback", "http://127.0.0.2:52345/callback")).toBe(true);
    expect(redirectUriMatches("http://app.localhost:0/cb", "http://app.localhost:52345/cb")).toBe(true);
    // Host stays exact even inside the range.
    expect(redirectUriMatches("http://127.0.0.2:0/callback", "http://127.0.0.3:0/callback")).toBe(false);
    // A differing PATH is still refused.
    expect(redirectUriMatches("http://localhost:0/callback", "http://localhost:52345/other")).toBe(false);
  });
});

// ── Discovery ────────────────────────────────────────────────────────────────────

describe("discovery documents (DB-free; served straight from config)", () => {
  const cfg = { publicUrl: "https://gw.example.ts.net:10000" };
  const routes = bridgeRoutes(cfg);

  it("PRM is mounted at BOTH well-known paths with the exact resource + AS list", async () => {
    for (const path of [
      "GET /.well-known/oauth-protected-resource",
      "GET /.well-known/oauth-protected-resource/mcp",
    ]) {
      const handler = routes.get(path);
      expect(handler).toBeTruthy();
      const res = fakeRes();
      await handler!({} as IncomingMessage, res);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        resource: "https://gw.example.ts.net:10000/mcp",
        authorization_servers: ["https://gw.example.ts.net:10000"],
        bearer_methods_supported: ["header"],
      });
    }
  });

  it("AS metadata is the FULL RFC 8414 document (every field load-bearing for discovery)", async () => {
    const handler = routes.get("GET /.well-known/oauth-authorization-server");
    const res = fakeRes();
    await handler!({} as IncomingMessage, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      issuer: "https://gw.example.ts.net:10000",
      authorization_endpoint: "https://gw.example.ts.net:10000/authorize",
      token_endpoint: "https://gw.example.ts.net:10000/token",
      registration_endpoint: "https://gw.example.ts.net:10000/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("the route map carries exactly the bridge endpoints (register/authorize/token + well-knowns)", () => {
    // ADR 0035 §D6: whole-port Funnel exposes EXACTLY this set. A route added here widens the
    // public surface; a route moved to the REST edge is forbidden outright.
    expect([...routes.keys()].sort()).toEqual(
      [
        "GET /.well-known/oauth-protected-resource",
        "GET /.well-known/oauth-protected-resource/mcp",
        "GET /.well-known/oauth-authorization-server",
        "POST /register",
        "GET /authorize",
        "POST /authorize",
        "POST /token",
      ].sort(),
    );
  });
});

// ── §7 — MCP_PUBLIC_URL canonicalization ─────────────────────────────────────────

describe("MCP_PUBLIC_URL canonicalization (both sides of every resource comparison)", () => {
  const authorizeQuery = (over: Record<string, string> = {}): string =>
    "/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: "pcgcl_test",
      redirect_uri: "https://client.test/cb",
      state: "s",
      code_challenge: "Zm9vYmFyYmF6".padEnd(43, "x"),
      code_challenge_method: "S256",
      ...over,
    }).toString();

  it("canonicalizeUrl lowercases the host, drops the default port and trims trailing slashes", () => {
    expect(canonicalizeUrl("https://Box.ts.net:443")).toBe("https://box.ts.net");
    expect(canonicalizeUrl("https://Box.ts.net:443/")).toBe("https://box.ts.net");
    expect(canonicalizeUrl("https://box.ts.net/mcp/")).toBe("https://box.ts.net/mcp");
    expect(canonicalizeUrl("http://LocalHost:80/x")).toBe("http://localhost/x");
    expect(canonicalizeUrl("nonsense")).toBeNull();
  });

  it("a public URL typed with a capitalised host and an explicit :443 accepts the plain presented resource", async () => {
    const cfg = bridgeConfigFromEnv({ MCP_PUBLIC_URL: "https://Box.ts.net:443" })!;
    expect(cfg.publicUrl).toBe("https://box.ts.net");

    const routes = bridgeRoutes(cfg, { pool: clientPool() });
    const res = fakeRes();
    await routes.get("GET /authorize")!(
      fakeReq({ url: authorizeQuery({ resource: "https://box.ts.net/mcp" }) }),
      res,
    );
    expect(res.statusCode).toBe(200); // the approval page, NOT an invalid_target redirect
    expect(res.headers.location).toBeUndefined();

    // …and the reverse direction: canonical config, decorated presented value.
    const routes2 = bridgeRoutes({ publicUrl: "https://box.ts.net" }, { pool: clientPool() });
    const res2 = fakeRes();
    await routes2.get("GET /authorize")!(
      fakeReq({ url: authorizeQuery({ resource: "https://Box.ts.net:443/mcp" }) }),
      res2,
    );
    expect(res2.statusCode).toBe(200);
  });

  it("a genuinely foreign resource is still rejected after canonicalization", async () => {
    // The anti-vacuity partner: "canonicalize to always-equal" would pass the previous cell alone.
    for (const foreign of [
      "https://evil.example/mcp",
      "https://box.ts.net.evil.example/mcp",
      "https://box.ts.net/other",
      "not a url",
    ]) {
      const routes = bridgeRoutes({ publicUrl: "https://box.ts.net" }, { pool: clientPool() });
      const res = fakeRes();
      await routes.get("GET /authorize")!(fakeReq({ url: authorizeQuery({ resource: foreign }) }), res);
      expect(res.statusCode).toBe(302);
      expect(new URL(String(res.headers.location)).searchParams.get("error")).toBe("invalid_target");
    }
  });
});

// ── §D3 item 4c — the anti-phishing display ──────────────────────────────────────

describe("the approval page's anti-phishing display", () => {
  it("names the full destination including its path, not just the host", async () => {
    const routes = bridgeRoutes(
      { publicUrl: "https://gw.example.com" },
      { pool: clientPool(["http://localhost:1/oauth/cb"]) },
    );
    const res = fakeRes();
    await routes.get("GET /authorize")!(
      fakeReq({
        url:
          "/authorize?" +
          new URLSearchParams({
            response_type: "code",
            client_id: "pcgcl_test",
            redirect_uri: "http://localhost:8787/oauth/cb",
            code_challenge: "x".repeat(43),
            code_challenge_method: "S256",
          }).toString(),
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    // Assert on the literal actually emitted — `.origin` alone would carry no path.
    expect(res.body).toContain("<strong>http://localhost:8787/oauth/cb</strong>");
  });
});

// ── #109 — the two pages a user sees mid-OAuth, and the retired product name ──────
//
// The product renamed to POSTERN on 2026-07-12; the bridge's ERROR page still said "Personal Context
// Gateway". Both cells scan the HTML the bridge actually EMITS, not the repo source — a grep would
// pass on a page whose title is assembled from a variable. They guard DIFFERENT things, and the
// distinction is the point: only one of them is the #109 fix.
//
//   error page    — the FIX. Its title changed. Mutation: restore `<title>Personal Context
//                   Gateway</title>` in the error branch -> RED (both assertions).
//   approval page — a REGRESSION FENCE, not a fix. Its title was ALWAYS "Authorize agent access",
//                   so the retired name was never there to remove; the cell exists so the page can
//                   never GROW it, and it pins the title the page must actually carry so there is a
//                   value to fail against. Mutation: change that title, or paste the retired name
//                   anywhere in the approval body -> RED.

describe("the two pages a user sees mid-OAuth carry no retired product name", () => {
  const query = (over: Record<string, string> = {}): string =>
    "/authorize?" +
    new URLSearchParams({
      response_type: "code",
      client_id: "pcgcl_test",
      redirect_uri: "https://client.test/cb",
      state: "s",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
      ...over,
    }).toString();

  /** Drive GET /authorize and hand back the rendered page. */
  const render = async (pool: BridgePool): Promise<{ statusCode: number; body: string }> => {
    const routes = bridgeRoutes({ publicUrl: "https://gw.example.com" }, { pool });
    const res = fakeRes();
    await routes.get("GET /authorize")!(fakeReq({ url: query() }), res);
    return { statusCode: res.statusCode, body: res.body };
  };

  it("the error page (unknown client) titles itself Postern, not the retired product name", async () => {
    // An empty client lookup is the open-redirect guard's error-PAGE branch (it never redirects).
    const page = await render(stubPool(() => undefined));
    expect(page.statusCode).toBe(400);
    expect(page.body).toContain("<title>Postern</title>");
    expect(page.body).not.toContain("Personal Context Gateway");
  });

  it("the approval page keeps its own action title and must never GROW the retired name", async () => {
    const page = await render(clientPool());
    expect(page.statusCode).toBe(200);
    // The real title, not merely "a <title> exists": the previous assertion was satisfied by any
    // non-empty page, so the cell had nothing to fail against. This page is deliberately titled by
    // the ACTION it asks for, not by the product — it is the anti-phishing surface (ADR 0029 §7).
    expect(page.body).toContain("<title>Authorize agent access</title>");
    expect(page.body).not.toContain("Personal Context Gateway");
  });
});

// ── The DB semaphore — the one guard that works without client identity ──────────

describe("the public port cannot exhaust the pool the private one depends on", () => {
  it("POST /token is rate limited, which it was not at all", async () => {
    const routes = bridgeRoutes(
      { publicUrl: "https://gw.example.com" },
      { pool: stubPool(() => undefined) },
    );
    const token = routes.get("POST /token")!;
    const fire = async (ip: string): Promise<{ status: number; retryAfter: unknown }> => {
      const res = fakeRes();
      await token(
        fakeReq({
          method: "POST",
          ip,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "pcgrt_x" }).toString(),
        }),
        res,
      );
      return { status: res.statusCode, retryAfter: res.headers["retry-after"] };
    };

    const statuses: number[] = [];
    for (let i = 0; i < BRIDGE_RATE_CAPACITY + 2; i++) statuses.push((await fire("203.0.113.90")).status);
    expect(statuses.filter((s) => s === 400)).toHaveLength(BRIDGE_RATE_CAPACITY);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    const refused = await fire("203.0.113.90");
    expect(refused.status).toBe(429);
    expect(refused.retryAfter).toBe("60"); // 429 is a recoverable state real OAuth clients retry
    // Where identities ARE distinguishable, a different caller is untouched.
    expect((await fire("203.0.113.91")).status).toBe(400);
  });

  it("one budget, one limiter: the routes share it (no per-class ceilings to reason about)", async () => {
    // Not a defence property — a simplicity one. Four separately-tuned limiters were four places for
    // a future change to introduce an asymmetry nobody meant.
    const routes = bridgeRoutes(
      { publicUrl: "https://gw.example.com" },
      { pool: stubPool(() => undefined) },
    );
    const register = async (): Promise<number> => {
      const res = fakeRes();
      await routes.get("POST /register")!(
        fakeReq({
          method: "POST",
          ip: "203.0.113.60",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        res,
      );
      return res.statusCode;
    };
    for (let i = 0; i < BRIDGE_RATE_CAPACITY; i++) expect(await register()).toBe(400);

    // The SAME identity is now out of budget on every other bridge route too.
    for (const [route, req] of [
      ["GET /authorize", fakeReq({ url: "/authorize?client_id=x", ip: "203.0.113.60" })],
      [
        "POST /token",
        fakeReq({
          method: "POST",
          ip: "203.0.113.60",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "pcgrt_x" }).toString(),
        }),
      ],
    ] as const) {
      const res = fakeRes();
      await routes.get(route)!(req, res);
      expect(res.statusCode).toBe(429);
    }
    // Discovery is deliberately never metered — static JSON, no DB, no audit, no mutable state.
    const prm = fakeRes();
    await routes.get("GET /.well-known/oauth-protected-resource")!(
      fakeReq({ ip: "203.0.113.60" }),
      prm,
    );
    expect(prm.statusCode).toBe(200);
  });

  it("the public routes never hold more of the connection pool than their slot allows", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((r) => {
      openGate = r;
    });
    let connectCount = 0;
    const blocking: BridgePool = {
      async query(): Promise<BridgeQueryResult> {
        return EMPTY;
      },
      async connect(): Promise<BridgePoolClient> {
        connectCount += 1;
        await gate; // every acquirer parks here holding its slot
        return { query: async () => EMPTY, release: () => {} };
      },
    };
    const routes = bridgeRoutes({ publicUrl: "https://gw.example.com" }, { pool: blocking });
    const token = routes.get("POST /token")!;

    const responses = Array.from({ length: 8 }, () => fakeRes());
    const runs = responses.map((res) =>
      token(
        fakeReq({
          method: "POST",
          ip: "203.0.113.50",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: "pcgac_x",
            code_verifier: "v",
            client_id: "pcgcl_test",
            redirect_uri: "https://client.test/cb",
          }).toString(),
        }),
        res,
      ),
    );

    // Let every request reach the slot guard.
    for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));

    // EXACTLY the slot count reached the pool — `===`, so raising the cap fails this.
    expect(connectCount).toBe(BRIDGE_DB_CONCURRENCY);
    const busy = responses.filter((r) => r.statusCode === 503);
    expect(busy).toHaveLength(8 - BRIDGE_DB_CONCURRENCY);
    expect(busy.every((r) => r.headers["retry-after"] === "1")).toBe(true);
    expect(busy.every((r) => JSON.parse(r.body).error === "temporarily_unavailable")).toBe(true);

    // Every bridge route draws on the SAME semaphore, and a browser route answers with a page.
    const pageRes = fakeRes();
    await routes.get("GET /authorize")!(fakeReq({ url: "/authorize?client_id=x" }), pageRes);
    expect(pageRes.statusCode).toBe(503);
    expect(pageRes.headers["retry-after"]).toBe("1");
    expect(String(pageRes.headers["content-type"])).toContain("text/html");
    expect(connectCount).toBe(BRIDGE_DB_CONCURRENCY); // it never reached the pool

    // POST /authorize is not exempt either — one semaphore, no reserved pools.
    const credRes = fakeRes();
    await routes.get("POST /authorize")!(
      fakeReq({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "pcgcl_test", key: "k" }).toString(),
      }),
      credRes,
    );
    expect(credRes.statusCode).toBe(503);
    expect(connectCount).toBe(BRIDGE_DB_CONCURRENCY);

    openGate();
    await Promise.all(runs); // all 8 requests complete — none is left hanging
    expect(connectCount).toBe(BRIDGE_DB_CONCURRENCY);
    expect(responses.filter((r) => r.statusCode === 400)).toHaveLength(BRIDGE_DB_CONCURRENCY);
  });

});

// ── §D3 item 2 — eviction must be LEAST-RECENTLY-USED, not oldest-by-creation ────

describe("registration evicts the client nobody is using, never the owner's", () => {
  /** Drive a registration at the cap and capture every statement the transaction issued. */
  async function registerAtCap(): Promise<{ sqls: string[]; values: unknown[][] }> {
    const sqls: string[] = [];
    const values: unknown[][] = [];
    const pool: BridgePool = {
      async query(): Promise<BridgeQueryResult> {
        return EMPTY;
      },
      async connect(): Promise<BridgePoolClient> {
        return {
          async query(sql: string, vals: unknown[] = []): Promise<BridgeQueryResult> {
            sqls.push(sql);
            values.push(vals);
            if (sql.includes("count(*)")) return { rows: [{ n: CLIENT_CAP }], rowCount: 1 };
            if (sql.includes("select c.client_id from oauth_bridge_clients")) {
              return { rows: [{ client_id: "pcgcl_junk" }], rowCount: 1 };
            }
            return EMPTY;
          },
          release: () => {},
        };
      },
    };
    const routes = bridgeRoutes({ publicUrl: "https://gw.example.com" }, { pool });
    const res = fakeRes();
    await routes.get("POST /register")!(
      fakeReq({
        method: "POST",
        ip: "203.0.113.77",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://client.test/cb"], client_name: "n" }),
      }),
      res,
    );
    expect(res.statusCode).toBe(201);
    return { sqls, values };
  }

  it("the victim query keys on last_used_at, ascending — oldest-by-CREATION would evict the owner", async () => {
    // If this were `order by c.created_at`, an attacker's 50 fresh registrations would make the
    // OLDEST row the owner's long-lived claude.ai client, and eviction would be a *more* efficient
    // lockout than refusal ever was. The owner's client is in constant use; the attacker's junk is
    // never used again. `last_used_at` is the only column that tells them apart.
    const { sqls } = await registerAtCap();
    const victimSql = sqls.find((s) => s.includes("select c.client_id from oauth_bridge_clients"));
    expect(victimSql).toBeTruthy();
    const normalized = victimSql!.replace(/\s+/g, " ");
    expect(normalized).toContain("order by coalesce(c.last_used_at, c.created_at) asc");
    expect(normalized).not.toMatch(/order by c\.created_at/);
    expect(normalized).not.toContain("desc");
  });

  it("a client holding a LIVE token is excluded from the victim set entirely", async () => {
    const { sqls } = await registerAtCap();
    const victimSql = sqls
      .find((s) => s.includes("select c.client_id from oauth_bridge_clients"))!
      .replace(/\s+/g, " ");
    expect(victimSql).toContain("not exists");
    expect(victimSql).toContain("from oauth_bridge_tokens t");
    expect(victimSql).toContain("t.client_id = c.client_id");
    expect(victimSql).toContain("t.refresh_expires_at > now()"); // LIVE, not merely present
  });

  it("eviction deletes exactly the victims returned, codes included, inside the locked transaction", async () => {
    const { sqls, values } = await registerAtCap();
    // The critical section: begin → advisory lock → count → pick → delete → insert → commit.
    const order = sqls.map((s) => s.replace(/\s+/g, " ").slice(0, 60));
    expect(order[0]).toBe("begin");
    expect(order[1]).toContain("pg_advisory_xact_lock");
    expect(sqls[sqls.length - 1]).toBe("commit");
    const codeDelete = sqls.findIndex((s) => s.includes("delete from oauth_bridge_codes"));
    const clientDelete = sqls.findIndex((s) => s.includes("delete from oauth_bridge_clients"));
    const insert = sqls.findIndex((s) => s.includes("insert into oauth_bridge_clients"));
    expect(codeDelete).toBeGreaterThan(0); // codes have no FK — they must be swept explicitly
    expect(clientDelete).toBeGreaterThan(codeDelete);
    expect(insert).toBeGreaterThan(clientDelete);
    // Both deletes are parameterized with EXACTLY the ids the victim query returned.
    expect(values[codeDelete]).toEqual([["pcgcl_junk"]]);
    expect(values[clientDelete]).toEqual([["pcgcl_junk"]]);
  });
});

// ── §D3 item 5 — the deny-audit throttle ─────────────────────────────────────────

describe("denial audits do not evict real ones (ADR 0035 §D3 item 5)", () => {
  it("GET /authorize is metered BEFORE it can audit anything", async () => {
    // §5a. GET /authorize was entirely unmetered: its three auditBridgeDeny calls were reachable at
    // line rate by an anonymous flood holding no credential. The limiter is now its first statement,
    // so a refused request never reaches lookupClient and never emits a deny row.
    resetAudit();
    const db = stubPool(() => undefined);
    const routes = bridgeRoutes({ publicUrl: "https://gw.example.com" }, { pool: db });
    const url =
      "/authorize?" +
      new URLSearchParams({
        response_type: "code",
        client_id: "pcgcl_nope",
        redirect_uri: "https://client.test/cb",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
      }).toString();

    const statuses: number[] = [];
    for (let i = 0; i < BRIDGE_RATE_CAPACITY + 5; i++) {
      const res = fakeRes();
      await routes.get("GET /authorize")!(fakeReq({ url, ip: "198.51.100.77" }), res);
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((s) => s === 400)).toHaveLength(BRIDGE_RATE_CAPACITY);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    // The refused five reached neither the DB nor the audit log: exactly the admitted ones did.
    expect(db.sqls).toHaveLength(BRIDGE_RATE_CAPACITY);
    // …and of those, the deny throttle capped what was actually enqueued (the second half of §5).
    expect(auditBuf().filter((e) => e.tool === "oauth_token")).toHaveLength(BRIDGE_DENY_AUDIT_CAP);
    resetAudit();
  });

  it("a denial flood emits a capped number of audit entries plus one coalesced summary", async () => {
    resetAudit();
    let t = 1_700_000_000_000;
    const routes = bridgeRoutes(
      { publicUrl: "https://gw.example.com" },
      { pool: stubPool(() => undefined), now: () => t }, // no client row ⇒ every GET is a denial
    );
    const authorize = routes.get("GET /authorize")!;
    const url =
      "/authorize?" +
      new URLSearchParams({
        response_type: "code",
        client_id: "pcgcl_nope",
        redirect_uri: "https://client.test/cb",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
      }).toString();

    // A denial flood, each request a distinct identity so the limiter is not the binding constraint
    // and the throttle is what the cell actually measures.
    const FLOOD = BRIDGE_DENY_AUDIT_CAP * 3;
    for (let i = 0; i < FLOOD; i++) {
      const res = fakeRes();
      await authorize(fakeReq({ url, ip: `198.51.100.${i + 1}` }), res);
      expect(res.statusCode).toBe(400);
    }

    const denies = () =>
      auditBuf().filter((e) => e.tool === "oauth_token" && e.decision === "deny");
    expect(denies()).toHaveLength(BRIDGE_DENY_AUDIT_CAP); // exactly the cap, NOT all 90
    expect(denies().every((e) => e.denyReason === "authorize: unknown client")).toBe(true);

    // Roll the window: ONE coalesced line naming exactly what the cap swallowed, then auditing resumes.
    t += 60_000;
    const res = fakeRes();
    await authorize(fakeReq({ url, ip: "203.0.113.200" }), res);

    const coalesced = denies().filter((e) => String(e.denyReason).startsWith("throttled:"));
    expect(coalesced).toHaveLength(1);
    expect(coalesced[0].denyReason).toBe(
      `throttled: ${FLOOD - BRIDGE_DENY_AUDIT_CAP} further bridge denials suppressed`,
    );
    expect(denies().filter((e) => e.denyReason === "authorize: unknown client")).toHaveLength(
      BRIDGE_DENY_AUDIT_CAP + 1,
    );
    resetAudit();
  });

  it("a flood of the CHEAPEST denial cannot buy silence on the most valuable one", async () => {
    // One shared window across every deny reason IS an exhaustible pool: an unknown client_id is
    // free to generate, a refused agent key is someone guessing the owner's credential. The cheap
    // one must never be able to suppress the expensive one.
    resetAudit();
    resolveBearerMock.mockRejectedValue(new AccessDenied(undefined, "unknown agent"));
    const t = 1_700_000_000_000;
    const pool = stubPool((sql) =>
      sql.includes("from oauth_bridge_clients") ? { rows: [CLIENT_ROW], rowCount: 1 } : undefined,
    );
    const routes = bridgeRoutes({ publicUrl: "https://gw.example.com" }, { pool, now: () => t });
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "pcgcl_test",
      redirect_uri: "https://client.test/cb",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
    });

    // The owner's approval page first (its own CSRF token), before the flood.
    const page = fakeRes();
    await routes.get("GET /authorize")!(fakeReq({ url: `/authorize?${q}`, ip: "192.0.2.7" }), page);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1];

    // Flood the CHEAP class far past its budget: stale-CSRF denials, free to generate.
    for (let i = 0; i < BRIDGE_DENY_AUDIT_CAP * 3; i++) {
      const res = fakeRes();
      await routes.get("POST /authorize")!(
        fakeReq({
          method: "POST",
          ip: `203.0.113.${(i % 200) + 1}`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ csrf: "stale", ...Object.fromEntries(q) }).toString(),
        }),
        res,
      );
    }
    const denies = (): AuditEntry[] =>
      auditBuf().filter((e) => e.tool === "oauth_token" && e.decision === "deny");
    expect(denies().filter((e) => e.denyReason === "authorize: csrf")).toHaveLength(
      BRIDGE_DENY_AUDIT_CAP,
    ); // the cheap budget IS spent — the flood is real

    // Now the high-value event, in the SAME window the flood exhausted.
    const attack = fakeRes();
    await routes.get("POST /authorize")!(
      fakeReq({
        method: "POST",
        ip: "192.0.2.7",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, key: "guessed-key", ...Object.fromEntries(q) }).toString(),
      }),
      attack,
    );
    expect(attack.statusCode).toBe(400);
    expect(denies().filter((e) => e.denyReason === "authorize: key refused")).toHaveLength(1);
    resetAudit();
  });

  it("high-value denials are never throttled by each other either — frequency IS the alarm", async () => {
    // An event you would suppress for being frequent is exactly the event whose frequency is the
    // signal. Every one of these key-guessing attempts must land its own row.
    resetAudit();
    resolveBearerMock.mockRejectedValue(new AccessDenied(undefined, "unknown agent"));
    const t = 1_700_000_000_000;
    const pool = stubPool((sql) =>
      sql.includes("from oauth_bridge_clients") ? { rows: [CLIENT_ROW], rowCount: 1 } : undefined,
    );
    const routes = bridgeRoutes({ publicUrl: "https://gw.example.com" }, { pool, now: () => t });
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "pcgcl_test",
      redirect_uri: "https://client.test/cb",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
    });
    const ATTEMPTS = BRIDGE_DENY_AUDIT_CAP * 2;
    for (let i = 0; i < ATTEMPTS; i++) {
      const ip = `192.0.2.${(i % 200) + 1}`; // per-identity buckets must not be the binding limit
      const page = fakeRes();
      await routes.get("GET /authorize")!(fakeReq({ url: `/authorize?${q}`, ip }), page);
      const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1];
      const res = fakeRes();
      await routes.get("POST /authorize")!(
        fakeReq({
          method: "POST",
          ip,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ csrf, key: `guess-${i}`, ...Object.fromEntries(q) }).toString(),
        }),
        res,
      );
      expect(res.statusCode).toBe(400);
    }
    const refused = auditBuf().filter((e) => e.denyReason === "authorize: key refused");
    expect(refused).toHaveLength(ATTEMPTS); // every single one, well past BRIDGE_DENY_AUDIT_CAP
    resetAudit();
  });
});

// ── §D3 item 6 — a cloud key must carry an expiry ────────────────────────────────

describe("a key handed to a cloud client must carry an expiry (ADR 0035 §D3 item 6)", () => {
  const REDIRECT = "https://client.test/cb";
  const CHALLENGE = "x".repeat(43);

  /** Drive GET /authorize (for the csrf token) then POST /authorize with the pasted key. */
  async function approve(opts: {
    pool: StubPool;
    key: string;
  }): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
    const routes = bridgeRoutes({ publicUrl: "https://gw.example.com" }, { pool: opts.pool });
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "pcgcl_test",
      redirect_uri: REDIRECT,
      state: "st",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    });
    const page = fakeRes();
    await routes.get("GET /authorize")!(fakeReq({ url: `/authorize?${q}` }), page);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)![1];

    const res = fakeRes();
    await routes.get("POST /authorize")!(
      fakeReq({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, key: opts.key, ...Object.fromEntries(q) }).toString(),
      }),
      res,
    );
    return { statusCode: res.statusCode, body: res.body, headers: res.headers };
  }

  const grantPool = (expiresAt: Date | null): StubPool =>
    stubPool((sql) => {
      if (sql.includes("from oauth_bridge_clients")) return { rows: [CLIENT_ROW], rowCount: 1 };
      if (sql.includes("from agent_grants")) {
        return {
          rows: [
            {
              id: "g1",
              user_id: "u1",
              agent_id: "a1",
              revoked_at: null,
              expires_at: expiresAt,
            },
          ],
          rowCount: 1,
        };
      }
      return undefined;
    });

  it("a never-expiring key is refused with its own actionable wording, and no code row is written", async () => {
    resolveBearerMock.mockResolvedValue({ userId: "u1", agentId: "a1", grantedSectors: new Set() });
    const pool = grantPool(null);
    const r = await approve({ pool, key: "a-perfectly-valid-key" });
    expect(r.statusCode).toBe(400);
    expect(r.headers.location).toBeUndefined();
    expect(r.body).toContain("This agent key never expires.");
    expect(r.body).toContain("mint or rotate a key with a 30/90/365-day expiry in the Console");
    // The load-bearing half: nothing was minted.
    expect(pool.sqls.some((s) => s.includes("insert into oauth_bridge_codes"))).toBe(false);
  });

  it("a key WITH an expiry completes the authorization unchanged", async () => {
    // The anti-vacuity partner: without it, "refuse every key" would pass the previous cell.
    resolveBearerMock.mockResolvedValue({ userId: "u1", agentId: "a1", grantedSectors: new Set() });
    const pool = grantPool(new Date(Date.now() + 86_400_000));
    const r = await approve({ pool, key: "a-perfectly-valid-key" });
    expect(r.statusCode).toBe(302);
    const loc = new URL(String(r.headers.location));
    expect(loc.searchParams.get("code")?.startsWith("pcgac_")).toBe(true);
    expect(loc.searchParams.get("state")).toBe("st");
    expect(loc.searchParams.get("iss")).toBe("https://gw.example.com");
    expect(pool.sqls.some((s) => s.includes("insert into oauth_bridge_codes"))).toBe(true);
  });

  it("an unknown, a revoked and an expired key are refused in byte-identical wording", async () => {
    // §D3 item 6's distinct wording must never leak into the oracle-sensitive cases.
    const rendered: string[] = [];
    for (const reason of ["unknown agent", "revoked", "expired"]) {
      resolveBearerMock.mockRejectedValue(new AccessDenied(undefined, reason));
      const r = await approve({ pool: grantPool(null), key: `key-${reason}` });
      expect(r.statusCode).toBe(400);
      rendered.push(r.body.replace(/name="csrf" value="[^"]+"/, 'name="csrf" value="CSRF"'));
    }
    expect(rendered[0]).toBe(rendered[1]);
    expect(rendered[1]).toBe(rendered[2]);
    expect(rendered[0]).toContain("That agent key was not accepted.");
    expect(rendered[0]).not.toContain("This agent key never expires.");
  });
});

// ── Tuning is exported, never duplicated in a test ───────────────────────────────

describe("pinned tuning", () => {
  it("the shipped constants are the ones the guards were sized against", () => {
    expect(CLIENT_CAP).toBe(50);
    expect(BRIDGE_DENY_AUDIT_CAP).toBe(30);
    // Sized for AVAILABILITY: legitimate use is a connection setup every few weeks plus ~1 refresh
    // per hour per connection, so the limiter must be orders of magnitude above that, not close to it.
    expect(BRIDGE_RATE_CAPACITY).toBeGreaterThanOrEqual(60);
  });

  it("the DB semaphore stays strictly below the shared pool, or it protects nothing", () => {
    // The one property this file exists to keep: whatever arrives on the public port, the loopback
    // admin edge still finds connections. `src/db.ts:9` is `max: 10`; 4 leaves ≥6.
    expect(BRIDGE_DB_CONCURRENCY).toBe(4);
    expect(BRIDGE_DB_CONCURRENCY).toBeLessThan(10);
  });
});

// ── Canonicalization must not become a validation bypass ─────────────────────────

describe("resourceMatches — tolerance for case and default port, nothing else", () => {
  const CANON = "https://gw.example.com/mcp";

  it("accepts exactly the canonical resource, case- and default-port-insensitively", () => {
    expect(resourceMatches("https://gw.example.com/mcp", CANON)).toBe(true);
    expect(resourceMatches("https://GW.EXAMPLE.com/mcp", CANON)).toBe(true);
    expect(resourceMatches("https://gw.example.com:443/mcp", CANON)).toBe(true);
    expect(resourceMatches("https://gw.example.com/mcp/", CANON)).toBe(true);
  });

  it("a query, fragment or userinfo is NOT canonicalized away — it is refused", () => {
    // Each of these canonicalizes to exactly CANON. Comparing canonical forms would accept them all.
    for (const smuggled of [
      "https://gw.example.com/mcp?x=1",
      "https://gw.example.com/mcp#frag",
      "https://attacker:pw@gw.example.com/mcp",
      "https://attacker@gw.example.com/mcp",
      "https://gw.example.com/mcp?next=https://evil.example",
    ]) {
      expect(canonicalizeUrl(smuggled)).toBe(CANON); // the bypass really is available
      expect(resourceMatches(smuggled, CANON)).toBe(false); // and really is closed
    }
    // A bare `?` or `#` carries nothing — WHATWG parses both to an empty component, so there is
    // nothing to smuggle and nothing to refuse. Stated so the guard's edge is not mistaken for a gap.
    expect(resourceMatches("https://gw.example.com/mcp?", CANON)).toBe(true);
    expect(resourceMatches("https://evil.example/mcp", CANON)).toBe(false);
    expect(resourceMatches("not a url", CANON)).toBe(false);
  });

  it("the wire handlers use it: a smuggled resource is refused end-to-end", async () => {
    const routes = bridgeRoutes({ publicUrl: "https://gw.example.com" }, { pool: clientPool() });
    const res = fakeRes();
    await routes.get("GET /authorize")!(
      fakeReq({
        url:
          "/authorize?" +
          new URLSearchParams({
            response_type: "code",
            client_id: "pcgcl_test",
            redirect_uri: "https://client.test/cb",
            code_challenge: "x".repeat(43),
            code_challenge_method: "S256",
            resource: "https://gw.example.com/mcp?next=https://evil.example",
          }).toString(),
      }),
      res,
    );
    expect(res.statusCode).toBe(302);
    expect(new URL(String(res.headers.location)).searchParams.get("error")).toBe("invalid_target");
  });

  it("/token refuses a smuggled resource on a code that is otherwise perfectly valid", async () => {
    // Anti-vacuity by construction: the SAME stub, the SAME code, differing only in the resource.
    const verifier = "v".repeat(43);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const codeRow = {
      id: "c1",
      client_id: "pcgcl_test",
      agent_grant_id: "g1",
      code_challenge: challenge,
      redirect_uri: "https://client.test/cb",
      resource: CANON,
      expires_at: new Date(Date.now() + 60_000),
    };
    const redeem = async (resource: string): Promise<{ status: number; error: string }> => {
      const pool = stubPool((sql) => {
        if (sql.includes("update oauth_bridge_codes")) return { rows: [codeRow], rowCount: 1 };
        if (sql.includes("from agent_grants")) {
          return {
            rows: [{ id: "g1", user_id: "u1", agent_id: "a1", revoked_at: null, expires_at: null }],
            rowCount: 1,
          };
        }
        return undefined;
      });
      const routes = bridgeRoutes({ publicUrl: "https://gw.example.com" }, { pool });
      const res = fakeRes();
      await routes.get("POST /token")!(
        fakeReq({
          method: "POST",
          ip: "192.0.2.44",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: "pcgac_x",
            code_verifier: verifier,
            client_id: "pcgcl_test",
            redirect_uri: "https://client.test/cb",
            resource,
          }).toString(),
        }),
        res,
      );
      return { status: res.statusCode, error: String(JSON.parse(res.body).error ?? "") };
    };

    expect(await redeem("https://gw.example.com/mcp#anchor")).toEqual({
      status: 400,
      error: "invalid_target",
    });
    expect(await redeem("https://user:pw@gw.example.com/mcp")).toEqual({
      status: 400,
      error: "invalid_target",
    });
    // The partner that makes the two above mean something: the canonical resource still succeeds.
    const ok = await redeem("https://GW.example.com:443/mcp");
    expect(ok.status).toBe(200);
  });
});

describe("resolveBridgeToken — fail-closed OFF gate (inert tokens, tables never consulted)", () => {
  it("bridge OFF: a pcgat_ token resolves to null WITHOUT any pool query", async () => {
    const spy = vi.spyOn(pool, "query");
    await expect(resolveBridgeToken(`${BRIDGE_ACCESS_TOKEN_PREFIX}anything`)).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("a non-bridge prefix is never a bridge token (no pool query), even with the bridge ON", async () => {
    process.env.MCP_PUBLIC_URL = "https://gw.example.com";
    const spy = vi.spyOn(pool, "query");
    await expect(resolveBridgeToken("some-static-agent-key")).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

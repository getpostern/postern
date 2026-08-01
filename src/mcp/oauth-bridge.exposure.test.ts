// console-exposure-surface — the DB-FREE half of the bridge's config-resolution surface (ADR 0035
// §D1/§D6). Everything here runs without Postgres: the mount note, the token gate, the published-route
// descriptors, and the guarantee that the Console's validator and the boot validator are ONE function.
//
// Module state and env leak across files in the same worker, and a leaked mount silently satisfies
// half the gates in this unit — so afterEach clears BOTH, unconditionally.

import { describe, it, expect, afterEach, vi } from "vitest";
import { pool } from "../db.js";
import { AccessDenied } from "../auth/index.js";
import { sessionAuth } from "./bearer.js";
import {
  BRIDGE_ACCESS_TOKEN_PREFIX,
  BridgeConfigError,
  PUBLISHED_ROUTES,
  bridgeConfigFromEnv,
  bridgeRoutes,
  bridgeTokensAcceptable,
  canonicalizeUrl,
  mountedBridgeConfig,
  noteBridgeMount,
  resolveBridgeToken,
  resourceMatches,
  validatePublicUrl,
  type BridgeRouteAuth,
} from "./oauth-bridge.js";

const ENV_KEY = "MCP_PUBLIC_URL";
const savedEnv = process.env[ENV_KEY];

afterEach(() => {
  noteBridgeMount(null);
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  vi.restoreAllMocks();
});

/** The method×path expansion the http edge dispatches on ("<METHOD> <path>"). */
function expand(descriptors: readonly { path: string; methods: readonly string[] }[]): Set<string> {
  return new Set(descriptors.flatMap((d) => d.methods.map((m) => `${m} ${d.path}`)));
}

describe("the mount note (what THIS process is serving)", () => {
  it("building the route table does not make a gateway think it is published", () => {
    delete process.env[ENV_KEY];
    // bridgeRoutes must stay PURE with respect to process state: several suites build a route map at
    // describe scope, and a note inside it would leak a live config into every fail-closed cell in the
    // repo — turning "the bridge tables are never consulted" into a pool query with no database.
    const routes = bridgeRoutes({ publicUrl: "https://x.example" });
    expect(routes.size).toBeGreaterThan(0); // the map really was built (not a vacuous pass)
    expect(mountedBridgeConfig()).toBeNull();
    expect(bridgeTokensAcceptable()).toBe(false);
  });

  it("a gateway serving the bridge accepts its own tokens even when no environment variable describes it", async () => {
    delete process.env[ENV_KEY];

    // (a) mounted from the DB, no env var anywhere — the whole point of this unit.
    noteBridgeMount({ publicUrl: "https://db.example" });
    expect(bridgeTokensAcceptable()).toBe(true);

    // …and the gate at the resolve site really lets the lookup through.
    const through = vi.spyOn(pool, "query").mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await expect(resolveBridgeToken(`${BRIDGE_ACCESS_TOKEN_PREFIX}abc`)).resolves.toBeNull();
    expect(through).toHaveBeenCalledTimes(1);
    through.mockRestore();

    // (b) nothing mounted, nothing in the env → inert, and the tables are NEVER consulted.
    noteBridgeMount(null);
    expect(bridgeTokensAcceptable()).toBe(false);
    const blocked = vi.spyOn(pool, "query").mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await expect(resolveBridgeToken(`${BRIDGE_ACCESS_TOKEN_PREFIX}abc`)).resolves.toBeNull();
    expect(blocked).not.toHaveBeenCalled();
    blocked.mockRestore();

    // (c) the env-configured gateway is byte-identical to before this unit: env alone still opens it.
    process.env[ENV_KEY] = "https://env.example";
    expect(bridgeTokensAcceptable()).toBe(true);
  });

  it("the session-auth gate opens on what this process serves, not on an environment variable", async () => {
    delete process.env[ENV_KEY];
    const auth = sessionAuth();

    // Mounted from the DB, nothing in the env. The bridge lookup must happen FIRST; under the
    // pre-exposure env-only gate it would have been skipped entirely and the ONLY query would be
    // resolveBearer's agent_grants read — which is exactly the silent 401-your-own-token failure.
    noteBridgeMount({ publicUrl: "https://db.example" });
    const spy = vi.spyOn(pool, "query").mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await expect(auth.authorize(`${BRIDGE_ACCESS_TOKEN_PREFIX}abc`)).rejects.toBeInstanceOf(
      AccessDenied,
    );
    const sqls = spy.mock.calls.map((c) => String(c[0]));
    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toContain("oauth_bridge_tokens");
    expect(sqls[1]).toContain("agent_grants");
    spy.mockRestore();

    // Anti-vacuity partner: with nothing mounted and no env var, the bridge table is never touched.
    noteBridgeMount(null);
    const spy2 = vi.spyOn(pool, "query").mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await expect(auth.authorize(`${BRIDGE_ACCESS_TOKEN_PREFIX}abc`)).rejects.toBeInstanceOf(
      AccessDenied,
    );
    expect(spy2.mock.calls.map((c) => String(c[0])).join("")).not.toContain("oauth_bridge_tokens");
    spy2.mockRestore();
  });
});

describe("the published-route disclosure (ADR 0035 §D6)", () => {
  it("the disclosure lists exactly what the edge actually serves, and nothing else", () => {
    const served = new Set(bridgeRoutes({ publicUrl: "https://example.invalid" }).keys());
    const disclosed = expand(PUBLISHED_ROUTES.filter((d) => d.path !== "/mcp"));

    // Both sides non-empty, and the comparison is SET EQUALITY (not length): a route added to the map
    // without a descriptor fails, and a descriptor with no route fails too.
    expect(served.size).toBe(7);
    expect(disclosed.size).toBe(7);
    expect(served).toEqual(disclosed);

    // /mcp is the eighth: the http edge serves it and the bridge map deliberately does not carry it.
    expect(PUBLISHED_ROUTES).toHaveLength(8);
    expect(served.has("POST /mcp")).toBe(false);
    const mcp = PUBLISHED_ROUTES.find((d) => d.path === "/mcp");
    expect(mcp?.methods).toEqual(["POST", "GET", "DELETE"]);
  });

  it("the sign-in page is disclosed as carrying no data about the user, not as static JSON", () => {
    const byAuth = (auth: BridgeRouteAuth): typeof PUBLISHED_ROUTES =>
      PUBLISHED_ROUTES.filter((d) => d.auth === auth);

    const authorizeGet = PUBLISHED_ROUTES.find(
      (d) => d.path === "/authorize" && d.methods.includes("GET"),
    );
    expect(authorizeGet?.auth).toBe("open_no_user_data");

    expect(byAuth("open_write").map((d) => `${d.methods.join(" ")} ${d.path}`)).toEqual([
      "POST /register",
    ]);
    expect(byAuth("key_login").map((d) => `${d.methods.join(" ")} ${d.path}`)).toEqual([
      "POST /authorize",
    ]);
    expect(byAuth("code_gated").map((d) => `${d.methods.join(" ")} ${d.path}`)).toEqual([
      "POST /token",
    ]);
    expect(byAuth("bearer_gated").map((d) => d.path)).toEqual(["/mcp"]);
    // The three static discovery documents + GET /authorize — §D6's prose says "four static JSON"
    // and miscounts; there are three JSON documents and one HTML page carrying no user data.
    expect(byAuth("open_no_user_data")).toHaveLength(4);
  });
});

describe("one validator for the Console and for boot", () => {
  const BAD = [
    "http://evil.example",
    "ftp://x",
    "https://x/?a=1",
    "https://x#f",
    "not a url",
    // #126: a path is refused on BOTH paths too — the whole reason this suite pairs them.
    "https://x/mcp",
    "https://x/postern",
    // …and so is userinfo, which `canonicalizeUrl` would otherwise strip on its way through.
    "https://user:pw@x",
    "https://x@evil.example",
  ];

  it("an address the Console accepts is one the gateway can boot with", () => {
    for (const raw of BAD) {
      expect(() => validatePublicUrl(raw)).toThrow(BridgeConfigError);
      expect(() => bridgeConfigFromEnv({ MCP_PUBLIC_URL: raw })).toThrow(BridgeConfigError);

      // The two must not DRIFT: same rule, same message, on both paths.
      const fromValidator = (() => {
        try {
          validatePublicUrl(raw);
        } catch (e) {
          return (e as Error).message;
        }
        throw new Error(`validatePublicUrl accepted ${raw}`);
      })();
      const fromBoot = (() => {
        try {
          bridgeConfigFromEnv({ MCP_PUBLIC_URL: raw });
        } catch (e) {
          return (e as Error).message;
        }
        throw new Error(`bridgeConfigFromEnv accepted ${raw}`);
      })();
      expect(fromValidator).toBe(fromBoot);
    }

    // Anti-vacuity partner: a good address is ACCEPTED by both, identically. Without this, a
    // validator that refused everything would pass every cell above.
    for (const good of ["https://gw.example.ts.net", "http://localhost:8788", "http://127.0.0.1:8788"]) {
      expect(validatePublicUrl(good).publicUrl).toBe(
        bridgeConfigFromEnv({ MCP_PUBLIC_URL: good })?.publicUrl,
      );
    }

    // …and the env path still carries the field validatePublicUrl knows nothing about.
    expect(
      bridgeConfigFromEnv({ MCP_PUBLIC_URL: "https://gw.example.com", MCP_TRUSTED_PROXIES: "::1" })
        ?.trustedProxies,
    ).toHaveLength(1);
  });

  it("a trailing slash never reaches the discovery documents", () => {
    expect(validatePublicUrl("https://x.ts.net/").publicUrl).toBe("https://x.ts.net");
    expect(validatePublicUrl("https://x.ts.net///").publicUrl).toBe("https://x.ts.net");
    // Canonicalization is the other half of the same promise (the PRM `resource` is an exact match).
    expect(validatePublicUrl("https://X.TS.NET:443/").publicUrl).toBe("https://x.ts.net");
  });

  // #126. The address field's most natural paste is the MCP URL — it is what the Gatehouse card shows
  // and what a user hands an agent — and accepting it published a gateway whose own discovery
  // documents 404. The refusal has to arrive with the value to save, or it just moves the guessing.
  it("the address is an ORIGIN, and a pasted path is refused with the origin to save instead", () => {
    const pasted = "https://gw.example.ts.net/mcp";
    expect(() => validatePublicUrl(pasted)).toThrow(BridgeConfigError);

    const mcp = (() => {
      try {
        validatePublicUrl(pasted);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("validatePublicUrl accepted the MCP URL");
    })();
    // It names WHAT was pasted, WHY it is the wrong field, and the exact string to save.
    expect(mcp).toContain(pasted);
    expect(mcp).toContain('"https://gw.example.ts.net"');
    expect(mcp).toMatch(/MCP URL/);

    // Any other path is refused too, and also names the origin — trailing `/mcp` is a wording case,
    // not the rule. A message that only handled `/mcp` would leave `/postern` refused and unfixable.
    const other = (() => {
      try {
        validatePublicUrl("https://gw.example.ts.net/postern/gateway/");
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("validatePublicUrl accepted a path");
    })();
    expect(other).toContain('"https://gw.example.ts.net"');
    expect(other).toMatch(/must not carry a path/);
    expect(other).not.toMatch(/MCP URL/);

    // Anti-vacuity: the ONLY thing refused is a path. The origin it names is itself accepted, port
    // and all, and a bare origin with trailing slashes still passes (the cell above pins that too).
    expect(validatePublicUrl("https://gw.example.ts.net").publicUrl).toBe("https://gw.example.ts.net");
    expect(validatePublicUrl("https://gw.example.ts.net:8443/").publicUrl).toBe(
      "https://gw.example.ts.net:8443",
    );
    expect(validatePublicUrl("http://localhost:8788").publicUrl).toBe("http://localhost:8788");
  });

  // The same silent-rewrite class as the path, one field over, and the more dangerous half: userinfo
  // changes WHICH HOST the value names. `https://gw.example@evil.example` parses with hostname
  // `evil.example`, so canonicalization published the gateway as the attacker's host and said nothing.
  it("userinfo is refused rather than silently stripped, and the refusal does not hand back the wrong host", () => {
    const disguised = "https://gw.example@evil.example";
    // The whole hazard in one assertion: canonicalization alone turns this into someone else's origin.
    expect(canonicalizeUrl(disguised)).toBe("https://evil.example");
    expect(() => validatePublicUrl(disguised)).toThrow(BridgeConfigError);

    const message = (() => {
      try {
        validatePublicUrl(disguised);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("validatePublicUrl accepted a userinfo address");
    })();
    // It names the host that WOULD have been published — the silent rewrite, made visible — and it
    // stops there. The path refusals end in "save this instead"; this one must NOT, because the
    // origin of this input is the attacker's host and prescribing it would be the same defect again.
    expect(message).toContain("evil.example");
    expect(message).toMatch(/username or password/);
    expect(message).not.toMatch(/Save "https:\/\/evil\.example"/);

    // The ordinary credential form is refused too, and the asymmetry with the presented-value side is
    // closed: `resourceMatches` has always refused userinfo, and now so does the saved value.
    expect(() => validatePublicUrl("https://user:pw@gw.example")).toThrow(BridgeConfigError);
    expect(() => validatePublicUrl("https://user@gw.example")).toThrow(BridgeConfigError);
    expect(resourceMatches("https://user:pw@gw.example/mcp", "https://gw.example/mcp")).toBe(false);

    // Anti-vacuity: the same host with no credentials on it is still accepted, unchanged.
    expect(validatePublicUrl("https://gw.example").publicUrl).toBe("https://gw.example");
  });
});

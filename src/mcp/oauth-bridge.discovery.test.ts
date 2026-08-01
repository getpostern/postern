// THE STRUCTURAL GUARD #126 was missing: nothing in this repo related what the gateway ADVERTISES to
// what the edge actually ROUTES. So a public address carrying a path sailed through the validator,
// and the gateway published `authorization_endpoint` / `token_endpoint` / `registration_endpoint`
// values that 404 on the very gateway that advertised them — with the boot log, both well-knowns, and
// the Console's serving indicator all green. The only symptom was a vendor error on the far end.
//
// The property asserted here: **every absolute URL this gateway states about itself is answered by
// this gateway, the way a client would actually ask for it.** It is asserted against a REAL edge over
// REAL HTTP — the URLs are read out of the JSON the handlers actually emitted (and out of a real 401's
// challenge header), and each one is then dialed against the live route dispatch. Nothing here
// rebuilds a URL the way the handler does; a guard that re-derives the same string concatenation
// passes on exactly the config that shipped the bug (this repo's signature defect — memory
// `tests-that-cannot-fail`).
//
// THREE ways this guard was itself too weak, each closed below because a reviewer walked through it:
//   1. **Method-blind.** Probing GET-then-POST-then-DELETE and accepting any non-404 let a field
//      advertised at a WRONG-but-routed path audit clean — `authorization_endpoint` pointing at
//      `/token` passes if POST /token answers. Each field is now probed with the method its own RFC
//      role implies, and a field whose role this guard does not know is a FAILURE rather than a pass:
//      a new URL in a discovery document has to be declared here before it can be certified.
//   2. **A hardcoded document list.** Two literal well-known paths were audited, so a third discovery
//      document added later would publish unroutable URLs unwatched. The document set is now read off
//      the live route map.
//   3. **The 401 challenge was outside it.** `WWW-Authenticate: resource_metadata="…"` is a fourth
//      absolute URL built by the same concatenation, in a different file, and it is the FIRST one a
//      strict client follows.
//
// DB-FREE by construction: a stub pool is injected, and every probe below is shaped to be refused
// before any handler reaches a query it needs an answer from.

import { describe, it, expect, afterEach } from "vitest";
import { startHttpEdge } from "./http.js";
import {
  BridgeConfigError,
  bridgeRoutes,
  validatePublicUrl,
  type BridgeConfig,
  type BridgePool,
} from "./oauth-bridge.js";

/** The gateway is asked for nothing it needs a row back from; every probe is refused before that. */
const stubPool: BridgePool = {
  query: async () => ({ rows: [], rowCount: 0 }),
  connect: async () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => {},
  }),
};

let edge: { port: number; close(): Promise<void> } | null = null;

async function startEdge(bridge: BridgeConfig): Promise<number> {
  edge = startHttpEdge({ port: 0, audit: () => {}, bridge, bridgeDeps: { pool: stubPool } });
  // listen(0) is async — wait for the OS-assigned port before anything dials it.
  for (let i = 0; i < 200 && edge.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
  return edge.port;
}

afterEach(async () => {
  await edge?.close();
  edge = null;
});

// ── What a client DOES with each stated URL ──────────────────────────────────────────────────────

type Method = "GET" | "POST";

interface Role {
  /** The method a client uses on this URL. Wrong method = wrong route, however green the path looks. */
  method: Method;
  /** RFC 8414 §3.1: the value is an ISSUER IDENTIFIER, not an endpoint — a client inserts the
   *  well-known segment before the issuer's own path to build the URL it actually fetches. */
  wellKnown?: true;
}

/**
 * The declared roles. A field absent from this table is reported as unauditable rather than passed:
 * this guard cannot certify a URL when it does not know how a client would ask for it, and "we did
 * not know, so we said fine" is how the next silent failure ships. Adding a URL to a discovery
 * document is therefore a deliberate act with one line of cost here.
 */
const ROLES: Record<string, Role> = {
  // RFC 8414 §3.1 — the issuer is never dialed directly, and THIS is where #126 bit: a
  // `https://<host>/mcp` issuer sends clients to `/.well-known/oauth-authorization-server/mcp`, while
  // `/.well-known/oauth-protected-resource/mcp` (a different document) does exist and looks fine.
  issuer: { method: "GET", wellKnown: true },
  authorization_servers: { method: "GET", wellKnown: true },
  // RFC 9728's protected resource — the MCP endpoint, which MCP clients POST to.
  resource: { method: "POST" },
  // The RFC 8414 endpoints, each with the method its own RFC gives it.
  authorization_endpoint: { method: "GET" }, // RFC 6749 §3.1 — a browser navigation
  token_endpoint: { method: "POST" }, // RFC 6749 §3.2
  registration_endpoint: { method: "POST" }, // RFC 7591 §3.1
  // RFC 9728 §5.1 — the metadata URL a 401 challenge points at. Fetched, never derived.
  "WWW-Authenticate resource_metadata": { method: "GET" },
};

/** `authorization_servers[0]` → `authorization_servers`. Array position is not a different role. */
const roleOf = (field: string): Role | null => ROLES[field.replace(/\[\d+\]$/, "")] ?? null;

// ── What the gateway stated, read off the wire ───────────────────────────────────────────────────

interface Stated {
  field: string;
  value: string;
}

/** Every absolute http(s) URL anywhere in a document, with the field it was stated under. */
function absoluteUrls(doc: unknown, field = "$"): Stated[] {
  if (typeof doc === "string") {
    try {
      const u = new URL(doc);
      return u.protocol === "https:" || u.protocol === "http:" ? [{ field, value: doc }] : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(doc)) return doc.flatMap((v, i) => absoluteUrls(v, `${field}[${i}]`));
  if (doc && typeof doc === "object") {
    return Object.entries(doc).flatMap(([k, v]) => absoluteUrls(v, field === "$" ? k : `${field}.${k}`));
  }
  return [];
}

/**
 * Every discovery document this gateway serves — read off the REAL route registration, never a list
 * someone has to remember to extend. `bridgeRoutes` is pure with respect to process state (three
 * other suites build it at describe scope for exactly that reason), so enumerating it here mounts
 * nothing and publishes nothing.
 */
function discoveryDocumentPaths(cfg: BridgeConfig): string[] {
  return [...bridgeRoutes(cfg).keys()]
    .filter((key) => key.startsWith("GET /.well-known/"))
    .map((key) => key.slice("GET ".length))
    .sort();
}

async function fetchDocuments(port: number, paths: string[]): Promise<Stated[]> {
  const stated: Stated[] = [];
  for (const path of paths) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    expect(res.status).toBe(200);
    stated.push(...absoluteUrls(await res.json()));
  }
  return stated;
}

/**
 * The `WWW-Authenticate` challenge on a real 401 — the FIRST URL a strict client follows, and the one
 * the discovery documents cannot speak for because a different file builds it (src/mcp/http.ts).
 * Provoked with an unauthenticated `initialize`, which is refused before any transport or DB touch.
 */
async function fetchChallengeUrl(port: number): Promise<Stated | null> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "guard", version: "0" },
      },
    }),
  });
  expect(res.status).toBe(401); // no bearer, bridge on — the challenge rides THIS status specifically
  const found = /resource_metadata="([^"]+)"/.exec(res.headers.get("www-authenticate") ?? "");
  return found ? { field: "WWW-Authenticate resource_metadata", value: found[1] } : null;
}

// ── The audit ────────────────────────────────────────────────────────────────────────────────────

interface Unreachable {
  field: string;
  value: string;
  reason: "foreign origin" | "not routed" | "unknown role";
}

/** Does this gateway answer that path for that method? A 404 is the edge's "no such route"; anything
 *  else — a 200, a 400 for a malformed request, an error page — proves the route exists, which is the
 *  whole question. */
async function isRouted(port: number, path: string, method: Method): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  await res.arrayBuffer(); // drain, or the socket stays open past close()
  return res.status !== 404;
}

/**
 * The audit itself, over URLs the caller supplies. Taking the stated URLs as an ARGUMENT rather than
 * fetching them internally is what lets the mutation cells below feed doctored values through the
 * identical code path — the auditor cannot be quietly in agreement with the handler.
 */
async function unreachable(port: number, origin: string, stated: Stated[]): Promise<Unreachable[]> {
  expect(stated.length).toBeGreaterThan(4); // something really was stated
  const bad: Unreachable[] = [];
  for (const { field, value } of stated) {
    const url = new URL(value);
    if (url.origin !== origin) {
      bad.push({ field, value, reason: "foreign origin" });
      continue;
    }
    const role = roleOf(field);
    if (!role) {
      bad.push({ field, value, reason: "unknown role" });
      continue;
    }
    const path = role.wellKnown
      ? `/.well-known/oauth-authorization-server${url.pathname.replace(/\/+$/, "")}`
      : `${url.pathname}${url.search}`;
    if (!(await isRouted(port, path, role.method))) {
      bad.push({ field, value, reason: "not routed" });
    }
  }
  return bad;
}

/** Everything this gateway states about itself: every discovery document, plus the 401 challenge. */
async function everythingStated(port: number, cfg: BridgeConfig): Promise<Stated[]> {
  const stated = await fetchDocuments(port, discoveryDocumentPaths(cfg));
  const challenge = await fetchChallengeUrl(port);
  expect(challenge).not.toBeNull(); // the bridge is on, so a 401 MUST carry one
  return [...stated, challenge!];
}

// ── The property ─────────────────────────────────────────────────────────────────────────────────

describe("this gateway can only advertise what it routes", () => {
  const GOOD = "https://gw.example";

  it("every URL it states about itself is answered by it, the way a client asks", async () => {
    // The config comes from the ONE validator, not from a literal: this cell asserts the property for
    // an address the product can actually be in, and the #126 cell below asserts the validator is the
    // only reason it cannot be in the other one.
    const cfg: BridgeConfig = validatePublicUrl(GOOD);
    const port = await startEdge(cfg);
    const stated = await everythingStated(port, cfg);

    expect(await unreachable(port, GOOD, stated)).toEqual([]);

    // The values whose absence would make the pass vacuous — read from what was actually served.
    const byField = new Map(stated.map((s) => [s.field, s.value]));
    expect(byField.get("issuer")).toBe(GOOD);
    expect(byField.get("authorization_endpoint")).toBe(`${GOOD}/authorize`);
    expect(byField.get("token_endpoint")).toBe(`${GOOD}/token`);
    expect(byField.get("registration_endpoint")).toBe(`${GOOD}/register`);
    expect(byField.get("authorization_servers[0]")).toBe(GOOD);
    expect(byField.get("WWW-Authenticate resource_metadata")).toBe(
      `${GOOD}/.well-known/oauth-protected-resource/mcp`,
    );

    // `resource` names the MCP endpoint EXACTLY ONCE — the `/mcp/mcp` doubling is what a
    // path-carrying address produced, and it is a different failure from an unroutable endpoint.
    expect(new URL(byField.get("resource")!).pathname).toBe("/mcp");
  });

  it("EVERY discovery document this gateway serves is audited, not the two someone listed", async () => {
    // The audited set is derived from the live route map, so a discovery document added later is
    // covered without anyone remembering this file. Set equality against that same route map — the
    // `PUBLISHED_ROUTES` disclosure idiom — so a future hardcoded literal list turns this red.
    const cfg = validatePublicUrl(GOOD);
    const served = [...bridgeRoutes(cfg).keys()]
      .filter((k) => k.startsWith("GET ") && k.includes("/.well-known/"))
      .map((k) => k.slice("GET ".length))
      .sort();
    expect(discoveryDocumentPaths(cfg)).toEqual(served);
    expect(served).toEqual([
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]);

    // …and the protected-resource document is the SAME document at both of its paths. claude.ai
    // probes the path-inserted form first and the bare one second; they must not be able to drift.
    const port = await startEdge(cfg);
    const inserted = await (
      await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)
    ).json();
    const bare = await (
      await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`)
    ).json();
    expect(inserted).toEqual(bare);
  });

  // ── Anti-vacuity ───────────────────────────────────────────────────────────────────────────────

  it("#126 itself: a path-carrying address advertises endpoints that 404 here, and is refused", async () => {
    // The exact value found live on 2026-07-27 — the URL the Gatehouse card displays and a user hands
    // an agent, i.e. the most natural thing to paste into the address field.
    const PASTED = "https://gw.example/mcp";

    // Constructed by hand, because the shipped gateway can no longer be configured this way — which
    // is the point of the pairing below.
    const cfg: BridgeConfig = { publicUrl: PASTED };
    const port = await startEdge(cfg);
    const stated = await everythingStated(port, cfg);
    const bad = await unreachable(port, "https://gw.example", stated);

    // Every URL the far end needs is dead, and the guard says so field by field — including the 401
    // challenge, which pointed at `/mcp/.well-known/…` and is the first thing a strict client follows.
    const dead = new Set(bad.filter((b) => b.reason === "not routed").map((b) => b.field));
    for (const field of [
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "issuer",
      "authorization_servers[0]",
      "resource",
      "WWW-Authenticate resource_metadata",
    ]) {
      expect(dead).toContain(field);
    }
    // …and the `/mcp` doubling, the other half of the same defect.
    expect(new Map(stated.map((s) => [s.field, s.value])).get("resource")).toBe(
      "https://gw.example/mcp/mcp",
    );

    // THE PAIRING. The only thing standing between a user and that gateway is the ONE validator, so
    // the refusal is asserted here, next to the damage it prevents — and it names the origin to save.
    expect(() => validatePublicUrl(PASTED)).toThrow(BridgeConfigError);
    expect(() => validatePublicUrl(PASTED)).toThrow(/https:\/\/gw\.example"/);
  });

  it("a URL advertised at a path that answers a DIFFERENT question is caught", async () => {
    // The method-blindness cell. A guard that accepted "any method that is not a 404" passed the
    // first two of these: `/token` answers POST, so a field pointing at it looked routed however
    // wrong it was. Fed through the SAME auditor and the SAME live edge as the real documents above.
    const cfg = validatePublicUrl(GOOD);
    const port = await startEdge(cfg);
    const real = await everythingStated(port, cfg);

    const doctored: Stated[] = [
      ...real.filter((s) => s.field !== "authorization_endpoint"),
      // A browser navigation aimed at the token endpoint: GET /token is not served.
      { field: "authorization_endpoint", value: `${GOOD}/token` },
      // A field this guard has never been told about — unauditable, therefore refused. Aimed at a
      // path that IS routed, so nothing but the unknown role can be what catches it.
      { field: "introspection_endpoint", value: `${GOOD}/token` },
      // And an endpoint aimed at somebody else's host, which is a different fault again.
      { field: "revocation_endpoint", value: "https://attacker.example/revoke" },
    ];

    expect(await unreachable(port, GOOD, doctored)).toEqual([
      { field: "authorization_endpoint", value: `${GOOD}/token`, reason: "not routed" },
      { field: "introspection_endpoint", value: `${GOOD}/token`, reason: "unknown role" },
      {
        field: "revocation_endpoint",
        value: "https://attacker.example/revoke",
        reason: "foreign origin",
      },
    ]);

    // Anti-vacuity for the anti-vacuity: the untouched set still audits clean on the same edge, so
    // the three failures above are the doctoring and not a broken probe.
    expect(await unreachable(port, GOOD, real)).toEqual([]);
  });
});

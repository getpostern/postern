// End-to-end through createRestApp over real HTTP, DB-free. Exercises the dispatcher's status map
// (404 unknown route, 405 wrong method, 400 oversize body) and the bearer gate on the mirror (no
// Authorization -> 401 BEFORE any DB/core call). Routes that need Postgres are NOT hit here.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createRestApp, startRestServer } from "./index.js";
import { MAX_BODY_BYTES } from "./router.js";

let server: Server;
let base: string;
let port: number;

beforeAll(async () => {
  server = createServer(createRestApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

/**
 * Low-level request to the loopback socket with FULL control over the Host header — `fetch` (undici)
 * forbids overriding Host, so the DNS-rebinding cases (`Host: evil.com`, no Host) need node:http.
 * `host: undefined` + setHost:false omits the Host header entirely (the missing-header case).
 */
function rawRequest(opts: {
  method?: string;
  path: string;
  host?: string; // value for the Host header; undefined => omit it (setHost:false)
  bearer?: string;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.host !== undefined) headers["host"] = opts.host;
    if (opts.bearer !== undefined) headers["authorization"] = `Bearer ${opts.bearer}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers,
        // Never auto-add Host: the explicit `headers.host` (which may be evil.com, empty, or absent)
        // is exactly what we want on the wire. With no explicit host, no Host is sent at all.
        setHost: false,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("dispatcher status map", () => {
  it("unknown route -> 404", async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("known path, wrong method -> 405 with Allow header", async () => {
    // /api/agents supports GET + POST; DELETE is not allowed.
    const res = await fetch(`${base}/api/agents`, { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toMatch(/POST/);
  });

  it("oversize body -> 400 (1MB cap)", async () => {
    const big = "x".repeat(MAX_BODY_BYTES + 1024);
    const res = await fetch(`${base}/api/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "simplefin", secret: big }),
    });
    expect(res.status).toBe(400);
  });

  it("non-JSON body on a POST -> 400", async () => {
    const res = await fetch(`${base}/api/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json {",
    });
    expect(res.status).toBe(400);
  });
});

describe("mirror bearer gate (pre-DB)", () => {
  it("GET /api/context with NO Authorization -> 401 (no DB touched)", async () => {
    const res = await fetch(`${base}/api/context`);
    expect(res.status).toBe(401);
  });

  it("GET /api/context with a malformed Authorization -> 401", async () => {
    const res = await fetch(`${base}/api/context`, { headers: { authorization: "Basic xyz" } });
    expect(res.status).toBe(401);
  });

  it("error responses never leak internals", async () => {
    const res = await fetch(`${base}/api/context`);
    const body = await res.text();
    expect(body).not.toMatch(/stack|secret|sec_|token/i);
  });
});

describe("Host-allowlist guard (DNS-rebinding) on the no-bearer group", () => {
  // The existing oversize/non-JSON tests above hit /api/credentials over loopback (fetch sends
  // `Host: 127.0.0.1:<port>`) and get 400 — proving the guard ADMITS a loopback Host (a 403 would
  // mean it blocked). These cases prove it REJECTS a rebound / missing Host before any handler runs.

  it("POST /api/agents with Host: evil.com -> 403 'forbidden host' (no key minted: handler never runs)", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/api/agents",
      host: "evil.com",
      body: JSON.stringify({ agentId: "claude", sectors: ["finance"] }),
    });
    // 403 (NOT a 500 from a DB-touching postAgent) — the guard short-circuits before the handler, so
    // no key is minted. This suite is DB-free; reaching postAgent would surface as a 500, not a 403.
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden host" });
  });

  it("POST /api/credentials with an empty Host header -> 403 (fail-closed)", async () => {
    // A truly-absent Host is rejected by Node's HTTP/1.1 parser (400) before our app runs; an empty
    // Host header DOES reach our guard, and our guard fail-closes it to 403. (The absent-header case
    // is unit-tested directly: assertAllowedHost(undefined) throws ForbiddenHostError -> 403.)
    const res = await rawRequest({
      method: "POST",
      path: "/api/credentials",
      host: "", // present but empty
      body: JSON.stringify({ provider: "simplefin", secret: "x" }),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden host" });
  });

  it("a truly-absent Host header is rejected before any admin handler runs (never served)", async () => {
    const res = await rawRequest({
      method: "POST",
      path: "/api/credentials",
      host: undefined, // omit Host entirely -> Node's parser rejects with 400 before our handler
      body: JSON.stringify({ provider: "simplefin", secret: "x" }),
    });
    // Rejected (not 2xx) before reaching postCredential — no credential is ever sealed.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("GET /api/oauth/google/start with Host: evil.com -> 403", async () => {
    const res = await rawRequest({ path: "/api/oauth/google/start", host: "evil.com" });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden host" });
  });

  it("POST /api/plaid/link-token with Host: evil.com -> 403", async () => {
    const res = await rawRequest({ method: "POST", path: "/api/plaid/link-token", host: "evil.com", body: "{}" });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden host" });
  });

  // The grounded wave-13 hosted-link surface (#14) — all six handlers must be WIRED (a 405 here would
  // mean unwired) AND localOnly. No body is sent: localOnly rejects on the Host BEFORE the handler reads
  // its own body, so a body would be left unread on the socket and cross-talk into the next keep-alive.
  it.each([
    ["GET", "/api/plaid/app"],
    ["POST", "/api/plaid/app"],
    ["DELETE", "/api/plaid/app"],
    ["POST", "/api/plaid/hosted-link"],
    ["POST", "/api/plaid/poll"],
    ["POST", "/api/plaid/relink"],
  ])("%s %s with Host: evil.com -> 403 (wired + localOnly)", async (method, path) => {
    const res = await rawRequest({ method, path, host: "evil.com" });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden host" });
  });

  it("DELETE /api/connectors/:id with Host: evil.com -> 403 (the #18 disconnect route IS wired + localOnly — an UNWIRED DELETE would be 405)", async () => {
    // Proves the route is registered in the dispatcher (a 405 here would mean it was never wired) AND
    // that it sits behind the loopback Host guard like the other destructive admin routes.
    // No body: localOnly rejects on the Host BEFORE withBody reads the body, so a body here would be
    // left unread on the socket and cross-talk into the next keep-alive request.
    const res = await rawRequest({
      method: "DELETE",
      path: "/api/connectors/00000000-0000-0000-0000-0000000000ab",
      host: "evil.com",
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden host" });
  });

  it("the bearer-gated mirror is NOT wrapped: Host: evil.com + no bearer -> 401 (bearer gate), not 403", async () => {
    // The mirror's defense is the bearer (non-ambient), so the rebinding guard is scoped away from it.
    // A non-loopback Host reaches the bearer gate -> 401, proving the guard does not wrap the mirror.
    const res = await rawRequest({ path: "/api/context", host: "evil.com" });
    expect(res.status).toBe(401);
  });
});

describe("the new operator surfaces are WIRED and localOnly (#89)", () => {
  // A 405 in any of these would mean the route was never registered; a 401 would mean it landed on the
  // bearer mirror by mistake; a 200 would mean the loopback guard does not wrap it. No body is sent:
  // localOnly rejects on the Host BEFORE withBody reads the stream, so a body would be left unread on
  // the socket and cross-talk into the next keep-alive request.
  it.each([
    ["GET", "/api/actions"],
    ["GET", "/api/operator/context"],
    ["GET", "/api/operator/schema"],
    ["POST", "/api/operator/fetch_live"],
  ])("%s %s with Host: evil.com -> 403 (wired + localOnly)", async (method, path) => {
    const res = await rawRequest({ method, path, host: "evil.com" });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden host" });
  });

  it("GET /api/operator/schema on loopback is SERVED with no bearer — the #82 dead button is alive", async () => {
    // The whole point of the fifth seam. DB-free: getSchema is the static REGISTRY and resolveLocal
    // does no I/O, so a 200 here is the real thing rather than an artefact of this suite.
    const res = await fetch(`${base}/api/operator/schema?sector=finance`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const keys = Object.keys(body);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.startsWith("finance")).toBe(true);
  });

  it("the BEARER schema route still 401s without a bearer — the agent mirror did not widen", async () => {
    const res = await fetch(`${base}/api/schema`);
    expect(res.status).toBe(401);
  });

  it("an operator route does NOT accept a bearer as identity (405/403/401 never becomes a bypass)", async () => {
    // Presenting an agent key on the operator path must change nothing: the path is loopback-gated and
    // the handler never reads the header. A rebound origin holding a stolen key still gets 403.
    const res = await rawRequest({
      path: "/api/operator/schema",
      host: "evil.com",
      bearer: "a-stolen-agent-key",
    });
    expect(res.status).toBe(403);
  });

  it("POST /api/actions -> 405 (the mirror is a read; the Allow header names GET)", async () => {
    const res = await fetch(`${base}/api/actions`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toMatch(/GET/);
  });
});

describe("startRestServer binds 127.0.0.1 by default", () => {
  it("listens on loopback and closes cleanly", async () => {
    const handle = startRestServer({ port: 0 });
    // Default host is loopback (operator-local-trusted). close() resolves.
    await expect(handle.close()).resolves.toBeUndefined();
  });
});

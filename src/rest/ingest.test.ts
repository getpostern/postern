// DB-free wiring tests for the push-ingest edge over real HTTP. Proves the routing/guarding
// contract WITHOUT Postgres: the ingest route is registered BARE (NOT Host-allowlisted — it's
// intentionally external; its gate is the per-connection secret verified inside the handler), while
// the admin mint route stays localOnly. The auth + round-trip behaviors that need Postgres live in
// ingest.db.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createRestApp } from "./index.js";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer(createRestApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Low-level request with FULL control over the Host header (undici/fetch forbids overriding Host).
 * `host: undefined` omits the Host header entirely.
 */
function rawRequest(opts: {
  method?: string;
  path: string;
  host?: string;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.host !== undefined) headers["host"] = opts.host;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const req = httpRequest(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers, setHost: false },
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

describe("push-ingest route is registered BARE (Host-exempt) while admin mint stays localOnly", () => {
  const id = randomUUID();

  it("the admin mint route IS Host-guarded: Host: evil.com -> 403 forbidden host (before any handler/DB)", async () => {
    const res = await rawRequest({
      method: "POST",
      path: `/api/connectors/${id}/webhook`,
      host: "evil.com",
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "forbidden host" });
  });

  it("the ingest route is NOT Host-guarded: Host: evil.com reaches the handler (never a 403 forbidden host)", async () => {
    // The handler's defense is the per-connection secret, not a same-origin guard — so a non-loopback
    // Host must NOT short-circuit to 403. (With a DB it 401s on the unknown id; DB-free it 500s on the
    // pool — either way it is NOT the 403 the Host-allowlist would produce.)
    const res = await rawRequest({
      method: "POST",
      path: `/api/ingest/${id}`,
      host: "evil.com",
      body: "{}",
    });
    expect(res.status).not.toBe(403);
  });

  it("GET on the ingest path -> 405 (the route is POST-only)", async () => {
    const res = await rawRequest({ method: "GET", path: `/api/ingest/${id}`, host: "127.0.0.1" });
    expect(res.status).toBe(405);
  });
});

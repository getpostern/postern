// /api/exposure over a real Postgres AND over real HTTP (gated on DATABASE_URL; disposable *_test DB
// only). The whole route group is exercised through createRestApp(), so the registrations in
// src/rest/index.ts are part of what is under test — a route that exists but is never wired up would
// pass a handler-level test and fail here.
//
// The two properties worth stating plainly, because they are what a Console bug would breach:
//   · consent is enforced SERVER-SIDE, with strict `=== true` (a truthy value is not consent), and
//   · the status route reports what the process is SERVING, never what it was merely told to serve —
//     in BOTH directions, because "I clicked stop publishing" while the edge is still up is the one
//     dishonesty with a real safety cost.
//
// Host control needs node:http (`fetch`/undici forbids overriding Host), exactly as in app.test.ts.

import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pool } from "../db.js";
import { lockTestResource } from "../test-support/advisory-lock.js";
import { createRestApp } from "./index.js";
import { startHttpEdge } from "../mcp/http.js";
import { LOCAL_USER_ID } from "../auth/sectors.js";
import { PUBLISHED_ROUTES, noteBridgeMount, resolveBridgeConfig } from "../mcp/oauth-bridge.js";
import { noteReachedAt, __resetReachedAtForTests } from "../gateway/reached-at.js";
import type { ExposureStatus } from "./exposure-routes.js";

// The one injected fault: a store write that fails. Everything else passes through to the real store.
const hoisted = vi.hoisted(() => ({ failWrite: false }));
vi.mock("../gateway/exposure-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/exposure-config.js")>();
  return {
    ...actual,
    setExposure: async (publicUrl: string) => {
      if (hoisted.failWrite) throw new Error("simulated gateway_exposure write fault");
      return actual.setExposure(publicUrl);
    },
  };
});

const HAS_DB = !!process.env.DATABASE_URL;
const VALID = "https://gw.example.ts.net";

let server: Server;
let port = 0;

const savedPublicUrl = process.env.MCP_PUBLIC_URL;
const savedHttpPort = process.env.MCP_HTTP_PORT;

/** Low-level request with FULL control over the Host header (the DNS-rebinding cases need it). */
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

const getStatus = async (): Promise<ExposureStatus> => {
  const r = await rawRequest({ path: "/api/exposure", host: "127.0.0.1" });
  expect(r.status).toBe(200);
  return JSON.parse(r.body) as ExposureStatus;
};
const post = (body: unknown, host = "127.0.0.1") =>
  rawRequest({ method: "POST", path: "/api/exposure", host, body: JSON.stringify(body) });
const del = (host = "127.0.0.1") =>
  rawRequest({ method: "DELETE", path: "/api/exposure", host });

async function rowCount(): Promise<number> {
  const r = await pool.query(`select 1 from gateway_exposure where id = true`);
  return r.rowCount ?? 0;
}

/** Start the audit writer with a huge interval, run fn, then stop() to drain deterministically. */
async function withFlushedAudit(fn: () => Promise<void>): Promise<void> {
  const { startAuditWriter } = await import("../audit/index.js");
  const stop = startAuditWriter({ intervalMs: 1_000_000, batchSize: 1_000_000 });
  try {
    await fn();
  } finally {
    await stop();
  }
}

async function exposureAuditRows(): Promise<
  Array<{ tool: string; decision: string; outcome: string; args: unknown; agent_id: string }>
> {
  const res = await pool.query(
    `select tool, decision, outcome, args, agent_id from audit_log
       where tool in ('set_exposure', 'clear_exposure') and user_id = $1 order by id asc`,
    [LOCAL_USER_ID],
  );
  return res.rows as Array<{
    tool: string;
    decision: string;
    outcome: string;
    args: unknown;
    agent_id: string;
  }>;
}

describe.skipIf(!HAS_DB)("/api/exposure", () => {
  // `gateway_exposure` is a ONE-ROW table driven by THREE db suites (this one,
  // src/gateway/exposure-config.db.test.ts and src/mcp/oauth-bridge.exposure.db.test.ts). Under
  // parallel file execution their deletes and writes land inside each other's cells, so hold the
  // table for the whole suite (#38/#115 idiom). Same key in all three, or the mutex is decorative.
  let releaseLock: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    releaseLock = await lockTestResource("gateway_exposure");
    server = createServer(createRestApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  }, 120_000);

  beforeEach(async () => {
    hoisted.failWrite = false;
    await pool.query(`delete from gateway_exposure where id = true`);
    delete process.env.MCP_PUBLIC_URL;
    process.env.MCP_HTTP_PORT = "8788";
    noteBridgeMount(null);
    // Process-wide module state, like the mount note: a sighting left over from an earlier cell
    // silently satisfies "nothing has reached this address yet" and the guard stops guarding.
    __resetReachedAtForTests();
  });

  afterEach(() => {
    hoisted.failWrite = false;
    noteBridgeMount(null);
    __resetReachedAtForTests();
  });

  afterAll(async () => {
    await pool.query(`delete from gateway_exposure where id = true`);
    await pool.query(
      `delete from audit_log where tool in ('set_exposure', 'clear_exposure') and user_id = $1`,
      [LOCAL_USER_ID],
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (savedPublicUrl === undefined) delete process.env.MCP_PUBLIC_URL;
    else process.env.MCP_PUBLIC_URL = savedPublicUrl;
    if (savedHttpPort === undefined) delete process.env.MCP_HTTP_PORT;
    else process.env.MCP_HTTP_PORT = savedHttpPort;
    await releaseLock?.(); // only after the final cleanup — a waiting suite must see an empty table
  });

  // ── The guard that matters most: only the operator's own browser may publish this gateway ──

  it("a stranger's browser cannot publish this gateway", async () => {
    const publish = await post({ publicUrl: VALID, acknowledged: true }, "evil.com");
    expect(publish.status).toBe(403);
    expect(await rowCount()).toBe(0);

    // Set a row through the legitimate origin, then prove a rebound page cannot remove it either.
    expect((await post({ publicUrl: VALID, acknowledged: true })).status).toBe(200);
    expect(await rowCount()).toBe(1);

    const stop = await del("evil.com");
    expect(stop.status).toBe(403);
    expect(await rowCount()).toBe(1); // still published — the refusal was real, not cosmetic

    const read = await rawRequest({ path: "/api/exposure", host: "evil.com" });
    expect(read.status).toBe(403);
  });

  // ── Consent, enforced server-side ──

  it("publishing without acknowledging the consequences is refused", async () => {
    // EVERY fixture below is otherwise-VALID: a well-formed https publicUrl, with MCP_HTTP_PORT set to
    // a valid port. The ONLY thing between the request and setExposure is the consent check — the
    // chain is body shape → acknowledged → validatePublicUrl → MCP_HTTP_PORT → setExposure, and a
    // fixture that tripped any later link would 400 for the wrong reason and the guard would pass
    // while broken.
    expect(process.env.MCP_HTTP_PORT).toBe("8788");

    const fixtures: unknown[] = [
      { publicUrl: VALID, acknowledged: false },
      { publicUrl: VALID }, // the key absent entirely
      { publicUrl: VALID, acknowledged: "yes" }, // truthy, not true
      { publicUrl: VALID, acknowledged: 1 }, // truthy, not true
    ];
    for (const body of fixtures) {
      const r = await post(body);
      expect(r.status).toBe(400);
      expect(await rowCount()).toBe(0);
    }

    // The anti-vacuity partner: the SAME url with real consent is accepted and does write the row.
    // Without it, "refuse everything" would pass all four cells above.
    const ok = await post({ publicUrl: VALID, acknowledged: true });
    expect(ok.status).toBe(200);
    expect(await rowCount()).toBe(1);
  });

  it("an address a hosted client could never reach on this box is refused at the click, not at the next reboot", async () => {
    delete process.env.MCP_HTTP_PORT;

    const r = await post({ publicUrl: VALID, acknowledged: true });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/MCP_HTTP_PORT/);
    expect(await rowCount()).toBe(0);

    // Partner: with a port, the identical request is accepted — the refusal is about the port, and
    // this is the cell that would catch "refuse everything".
    process.env.MCP_HTTP_PORT = "8788";
    expect((await post({ publicUrl: VALID, acknowledged: true })).status).toBe(200);
  });

  it("a malformed address is refused with a reason the operator can act on", async () => {
    const r = await post({ publicUrl: "http://evil.example", acknowledged: true });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/https/);
    expect(await rowCount()).toBe(0);

    // A query-carrying value is refused with its own reason (validatePublicUrl's, not a generic one).
    const q = await post({ publicUrl: "https://gw.example.ts.net/?a=1", acknowledged: true });
    expect(q.status).toBe(400);
    expect(JSON.parse(q.body).error).toMatch(/query or fragment/);
    expect(await rowCount()).toBe(0);

    // An unknown key is rejected too (the .strict() REST convention).
    const extra = await post({ publicUrl: VALID, acknowledged: true, bogus: 1 });
    expect(extra.status).toBe(400);
    expect(await rowCount()).toBe(0);
  });

  it("the MCP URL pasted into the address field is refused at the click, with the origin to save", async () => {
    // #126: the most natural paste — it is the URL the Gatehouse card shows and the one a user hands
    // an agent. Accepting it wrote a row that booted a gateway advertising endpoints that 404 on
    // itself, with every health signal green. The refusal must be legible HERE, where the user acts.
    const mcpUrl = `${VALID}/mcp`;
    const r = await post({ publicUrl: mcpUrl, acknowledged: true });
    expect(r.status).toBe(400);
    const message = JSON.parse(r.body).error as string;
    expect(message).toContain(mcpUrl); // what was pasted
    expect(message).toContain(`"${VALID}"`); // what to save instead
    expect(await rowCount()).toBe(0); // and NOTHING was stored

    // Any other path is refused the same way, and nothing is stored for it either.
    const deep = await post({ publicUrl: `${VALID}/postern`, acknowledged: true });
    expect(deep.status).toBe(400);
    expect(JSON.parse(deep.body).error).toMatch(/must not carry a path/);
    expect(await rowCount()).toBe(0);

    // The partner: the origin the refusal named is accepted, and DOES write the row. Without it,
    // "refuse every address" would pass every assertion above.
    expect((await post({ publicUrl: VALID, acknowledged: true })).status).toBe(200);
    expect(await rowCount()).toBe(1);
  });

  // ── Honesty: configured vs serving, in BOTH directions ──

  it("the gateway reports what it is serving, not what it was told to serve", async () => {
    expect((await post({ publicUrl: VALID, acknowledged: true })).status).toBe(200);
    // Nothing has been mounted: this process is serving nothing, whatever the row says.
    const s = await getStatus();
    expect(s.configured).not.toBeNull();
    expect(s.configured?.publicUrl).toBe(VALID);
    expect(s.configured?.source).toBe("db");
    expect(typeof s.configured?.consentedAt).toBe("string");
    expect(s.serving).toBeNull();
    expect(s.restartRequired).toBe(true);

    // The partner: once the process HAS mounted that config, the disagreement disappears.
    noteBridgeMount({ publicUrl: VALID });
    const live = await getStatus();
    expect(live.serving).toEqual({ publicUrl: VALID });
    expect(live.restartRequired).toBe(false);
  });

  it("turning exposure off does not make the gate private until the gateway restarts", async () => {
    noteBridgeMount({ publicUrl: "https://x.example" });
    expect((await post({ publicUrl: "https://x.example", acknowledged: true })).status).toBe(200);

    const r = await del();
    expect(r.status).toBe(200);
    const s = JSON.parse(r.body) as ExposureStatus;
    expect(s.configured).toBeNull();
    expect(s.serving).toEqual({ publicUrl: "https://x.example" });
    // TRUE in this direction too — a one-directional `configured != null && serving == null` would
    // tell a user who just clicked "stop publishing" that they are already private. They are not.
    expect(s.restartRequired).toBe(true);
    expect(await rowCount()).toBe(0);
  });

  // ── #119: has anything actually reached us at the address the user gave us? ──

  it("the served status reports not-yet-reached distinctly from not-configured", async () => {
    // Shape 1 — NOTHING CONFIGURED. There is no address to be observed at, so we cannot say. The
    // Console tells this apart from shape 2 by `configured`, which is the discriminator.
    const none = await getStatus();
    expect(none.configured).toBeNull();
    expect(none.observedAtConfiguredAddress).toBeNull();

    // Shape 2 — CONFIGURED, NEVER REACHED. `null`, not `false`: a gateway that has just been
    // published and has had no traffic yet must not be reported as a failure. This is the cell a
    // `configured ? true : null` or a `configured != null && !observed` shortcut fails.
    expect((await post({ publicUrl: VALID, acknowledged: true })).status).toBe(200);
    const saved = await getStatus();
    expect(saved.configured?.publicUrl).toBe(VALID);
    expect(saved.observedAtConfiguredAddress).toBeNull();

    // Shape 2b — REACHED, BUT SOMEWHERE ELSE. This is the diagnostic answer #119 exists for: traffic
    // is arriving at this gateway and none of it names the published address, so the problem is
    // upstream of Postern (the Funnel, MagicDNS, the certificate) and not in the gateway.
    // REBOUND AT MERGE (Decision 2a): this drove `false` with `localhost:8788` — a loopback client,
    // which is exactly the traffic that must NOT answer a question about public reachability. Only
    // genuinely public traffic under a different name earns the "check what you saved" diagnosis.
    noteReachedAt("someone-elses.example.ts.net");
    expect((await getStatus()).observedAtConfiguredAddress).toBe(false);

    // Shape 3 — CONFIGURED AND REACHED.
    noteReachedAt(new URL(VALID).host);
    expect((await getStatus()).observedAtConfiguredAddress).toBe(true);

    // It answers about the CONFIGURED address, never about whatever this process happens to serve:
    // with a different address mounted, the field still tracks what the user typed, and
    // restartRequired is the field that explains the disagreement.
    noteBridgeMount({ publicUrl: "https://something-else.example" });
    const live = await getStatus();
    expect(live.serving).toEqual({ publicUrl: "https://something-else.example" });
    expect(live.restartRequired).toBe(true);
    expect(live.observedAtConfiguredAddress).toBe(true);
  });

  it("an observed Host never becomes the configured address", async () => {
    // THE security cell. Everything the recorder holds arrived as a `Host` header on the public MCP
    // edge, chosen by whoever opened the socket. A stranger names us whatever they like, loudly.
    for (const h of ["attacker.example", "gw.example.ts.net", "169.254.169.254"]) {
      for (let i = 0; i < 30; i++) noteReachedAt(h);
    }

    // 1. It never becomes `configured`, and it never publishes a gateway nobody published.
    const s = await getStatus();
    expect(s.configured).toBeNull();
    expect(s.serving).toBeNull();
    expect(s.restartRequired).toBe(false);
    expect(s.observedAtConfiguredAddress).toBeNull(); // nothing configured ⇒ nothing to say
    expect(await rowCount()).toBe(0);

    // 2. It never reaches validatePublicUrl as permission: an address that was refused before we
    //    were "reached" there is refused after, for the same reason.
    const bad = await post({ publicUrl: "http://attacker.example", acknowledged: true });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/https/);
    expect(await rowCount()).toBe(0);

    // 3. It never becomes consent either — being reached somewhere is not the operator agreeing to
    //    publish there.
    expect((await post({ publicUrl: "https://attacker.example" })).status).toBe(400);
    expect(await rowCount()).toBe(0);

    // ANTI-VACUITY: the operator's own explicit, consented, well-formed save still works. Without
    // this, a build that refused every POST would pass all three assertions above.
    expect((await post({ publicUrl: VALID, acknowledged: true })).status).toBe(200);
    const after = await getStatus();
    expect(after.configured?.publicUrl).toBe(VALID); // the operator's value, not the loud one
    // FIXED AT MERGE. This asserted `false`, but the stranger fixture above names `gw.example.ts.net`
    // — which IS `new URL(VALID).host`. So it was reached at VALID, by this cell's own doing, and the
    // throw made every assertion below it unreachable: assertion 4 had never run. Keeping the stranger
    // on our own would-be address is the STRONGER cell — a stranger naming us and still not becoming
    // `configured` is exactly the confused deputy — so the security claim rides on the line above.
    expect(after.observedAtConfiguredAddress).toBe(true);
    // …and an address nothing ever named is still answered honestly, so `true` above is not blanket.
    expect((await post({ publicUrl: "https://never-named.example.ts.net", acknowledged: true })).status).toBe(200);
    expect((await getStatus()).observedAtConfiguredAddress).toBe(false);

    // 4. And it does not move the §Decision 5 refusal either: an env-published gate is still
    //    env-published, however many times a stranger names the box something else.
    process.env.MCP_PUBLIC_URL = "https://env.example";
    for (let i = 0; i < 30; i++) noteReachedAt("env.example");
    expect((await del()).status).toBe(409);
    expect(await rowCount()).toBe(1);
  });

  // ── §Decision 5: an env-sourced gate cannot be stopped from here, and we say so ──

  it("stopping publication is REFUSED, not reported as done, when the box's own .env is what publishes this gate", async () => {
    // This is prod (docs/runbooks/deploy-and-operations.md:191): MCP_PUBLIC_URL in the box's .env,
    // no Console row. The old behaviour deleted a row that did not exist, audited outcome "ok" and
    // returned a 200 whose body positively asserted nothing was pending — while the gateway stayed
    // published, then and after every future restart.
    process.env.MCP_PUBLIC_URL = "https://env.example";
    expect(await rowCount()).toBe(0);

    const r = await del();
    expect(r.status).toBe(409);
    const err = JSON.parse(r.body).error as string;
    expect(err).toMatch(/MCP_PUBLIC_URL/); // names the variable
    expect(err).toMatch(/\.env/); // names where it lives
    expect(err).toMatch(/restart/i); // names the escape

    // Nothing moved. The status route still says exactly what it said before the request.
    const s = await getStatus();
    expect(s.configured).toEqual({
      publicUrl: "https://env.example",
      source: "env",
      consentedAt: null,
    });
  });

  it("a stored address is not silently removed when removing it would just hand the gate back to the .env", async () => {
    // The row is what `configured.source` reports as "db", so the Console's Stop is enabled here —
    // but deleting it would let MCP_PUBLIC_URL win again and the gate would stay published. The
    // refusal is decided from the RESOLVED source, never from the delete's row count (clearExposure
    // cannot tell "deleted 1" from "deleted 0"), so the row must SURVIVE the refusal.
    expect((await post({ publicUrl: VALID, acknowledged: true })).status).toBe(200);
    expect(await rowCount()).toBe(1);
    process.env.MCP_PUBLIC_URL = "https://env.example";

    expect((await del()).status).toBe(409);
    expect(await rowCount()).toBe(1);

    // THE MUTATION PARTNER, and the one the spec names: flip the effective source back to "db" alone
    // by removing the env var, and the identical request succeeds. Without this cell a DELETE that
    // refused unconditionally would pass every assertion above.
    delete process.env.MCP_PUBLIC_URL;
    expect((await del()).status).toBe(200);
    expect(await rowCount()).toBe(0);
  });

  it("a refused stop is audited as a refusal, never as a success", async () => {
    await withFlushedAudit(async () => {}); // flush stragglers BEFORE clearing
    await pool.query(
      `delete from audit_log where tool in ('set_exposure', 'clear_exposure') and user_id = $1`,
      [LOCAL_USER_ID],
    );

    await withFlushedAudit(async () => {
      process.env.MCP_PUBLIC_URL = "https://env.example";
      expect((await del()).status).toBe(409);
      // The partner, in the same flush window: a stop that really stops audits "ok". Without it,
      // auditing every clear as "error" would pass the assertion below.
      delete process.env.MCP_PUBLIC_URL;
      expect((await post({ publicUrl: VALID, acknowledged: true })).status).toBe(200);
      expect((await del()).status).toBe(200);
    });

    const rows = await exposureAuditRows();
    expect(rows.map((r) => `${r.tool}:${r.outcome}`)).toEqual([
      "clear_exposure:error",
      "set_exposure:ok",
      "clear_exposure:ok",
    ]);
    // The refusal names itself, so the trail says WHY nothing was removed.
    expect(rows[0].args).toMatchObject({ refused: "env_sourced" });
  });

  it("the gateway reports its own MCP address from the port it is actually configured with", async () => {
    process.env.MCP_HTTP_PORT = "9999";
    expect((await getStatus()).localEndpoint).toBe("http://localhost:9999/mcp");

    delete process.env.MCP_HTTP_PORT;
    expect((await getStatus()).localEndpoint).toBeNull();

    process.env.MCP_HTTP_PORT = "not-a-port";
    expect((await getStatus()).localEndpoint).toBeNull();
  });

  it("the published list on the wire is the edge's real route table", async () => {
    const s = await getStatus();
    expect(s.publishedRoutes).toHaveLength(8);
    const onWire = new Set(
      s.publishedRoutes.flatMap((d) => d.methods.map((m) => `${m} ${d.path}`)),
    );
    const inCode = new Set(
      PUBLISHED_ROUTES.flatMap((d) => d.methods.map((m) => `${m} ${d.path}`)),
    );
    expect(onWire.size).toBeGreaterThan(0);
    expect(onWire).toEqual(inCode);
    // Each row carries the vocabulary the Console renders a sentence from.
    for (const d of s.publishedRoutes) {
      expect(typeof d.auth).toBe("string");
      expect(d.auth.length).toBeGreaterThan(0);
    }
  });

  // ── Audit ──

  it("publishing and unpublishing both leave a trail", async () => {
    await withFlushedAudit(async () => {}); // flush stragglers BEFORE clearing
    await pool.query(
      `delete from audit_log where tool in ('set_exposure', 'clear_exposure') and user_id = $1`,
      [LOCAL_USER_ID],
    );

    await withFlushedAudit(async () => {
      expect((await post({ publicUrl: VALID, acknowledged: true })).status).toBe(200);
      expect((await del()).status).toBe(200);
    });

    const rows = await exposureAuditRows();
    expect(rows.map((r) => r.tool)).toEqual(["set_exposure", "clear_exposure"]);
    expect(rows.every((r) => r.agent_id === "operator")).toBe(true);
    expect(rows.every((r) => r.decision === "allow")).toBe(true);
    expect(rows.every((r) => r.outcome === "ok")).toBe(true);
    // The URL is logged IN FULL: it is public by construction and a redacted one is useless.
    expect(rows[0].args).toEqual({ publicUrl: VALID });
    expect(rows[1].args).toEqual({});
  });

  it("a saved address that fails to store is still recorded as an attempt", async () => {
    await withFlushedAudit(async () => {});
    await pool.query(
      `delete from audit_log where tool in ('set_exposure', 'clear_exposure') and user_id = $1`,
      [LOCAL_USER_ID],
    );

    await withFlushedAudit(async () => {
      hoisted.failWrite = true;
      const r = await post({ publicUrl: VALID, acknowledged: true });
      expect(r.status).toBeGreaterThanOrEqual(500);
      expect(await rowCount()).toBe(0);
    });

    const rows = await exposureAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("set_exposure");
    expect(rows[0].outcome).toBe("error");
    expect(rows[0].args).toEqual({ publicUrl: VALID });
  });

  // ── ADR 0035 §D2 — bridge-OFF parity, over the resolver this unit introduced ──

  it("a gateway nobody has published is byte-identical to one that has no exposure feature at all", async () => {
    delete process.env.MCP_PUBLIC_URL;
    expect(await rowCount()).toBe(0);

    const resolved = await resolveBridgeConfig();
    expect(resolved.cfg).toBeNull(); // nothing configured from EITHER source

    const edge = startHttpEdge({ port: 0, audit: () => {}, bridge: resolved.cfg });
    for (let i = 0; i < 200 && edge.port === 0; i++) await new Promise((r) => setTimeout(r, 5));
    try {
      // Reuse http.test.ts's pinned body shape rather than snapshotting current behaviour: a fresh
      // expectation would agree with a regression.
      const NOT_FOUND = { jsonrpc: "2.0", error: { code: -32601, message: "Not found" }, id: null };
      for (const d of PUBLISHED_ROUTES) {
        if (d.path === "/mcp") continue;
        for (const method of d.methods) {
          const r = await fetch(`http://127.0.0.1:${edge.port}${d.path}`, {
            method,
            ...(method === "POST" ? { body: "{}" } : {}),
          });
          expect(r.status).toBe(404);
          expect(await r.json()).toEqual(NOT_FOUND);
        }
      }

      const mcp = await fetch(`http://127.0.0.1:${edge.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        }),
      });
      expect(mcp.status).toBe(401);
      expect(mcp.headers.get("www-authenticate")).toBeNull();
    } finally {
      await edge.close();
    }
  });
});

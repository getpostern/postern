// Plaid route DB round-trips — gated on DATABASE_URL. The Plaid NETWORK is mocked at the `fetch` layer
// (so the REAL exchangeAndStore / app-config / vault / DB writes run), with PLAID_* env as the config
// fallback. Covers the grounded wave-13 surface: BYO app creds (seal, never echo), hosted-link mint,
// per-Item exchange (external_item_id keying), multi-Item poll (distinct items + idempotent re-poll),
// and update-mode relink (carries the stored token, never echoed).

import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./router.js";
import { lockTestResource } from "../test-support/advisory-lock.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001";

// plaid_app is a one-row singleton shared by every parallel vitest fork (#38): hold the advisory
// lock for the whole file (this suite is plaid_app-centric — beforeEach wipes the row) so another
// worker's `delete from plaid_app` can't land mid-test. Acquired file-level and released in the
// file-level afterAll BELOW the final cleanup, so even the teardown deletes run under the lock.
let releasePlaidAppLock: (() => Promise<void>) | undefined;
beforeAll(async () => {
  releasePlaidAppLock = await lockTestResource("plaid_app");
}, 120_000);

// ── fetch mock: route Plaid endpoints (no module mocking — the routes run the REAL client) ──
const consumed = new Set<string>(); // public_tokens already exchanged (the idempotency model)
let pollTokens: string[] = []; // what /link/token/get returns this test
let lastCreateBody: Record<string, unknown> | undefined;

function installPlaidFetchMock() {
  consumed.clear();
  pollTokens = [];
  lastCreateBody = undefined;
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    if (u.includes("/link/token/create")) {
      lastCreateBody = body;
      return new Response(
        JSON.stringify({ link_token: "link-tok-1", hosted_link_url: "https://link.plaid.com/h/sess" }),
        { status: 200 },
      );
    }
    if (u.includes("/link/token/get")) {
      return new Response(
        JSON.stringify({ link_sessions: [{ finished_at: "2026-06-21T20:00:00Z", results: { item_add_results: pollTokens.map((pt) => ({ public_token: pt })) } }] }),
        { status: 200 },
      );
    }
    if (u.includes("/item/public_token/exchange")) {
      const pt = body.public_token as string;
      if (consumed.has(pt)) {
        return new Response(JSON.stringify({ error_code: "INVALID_PUBLIC_TOKEN" }), { status: 400 });
      }
      consumed.add(pt);
      return new Response(JSON.stringify({ access_token: `access-${pt}`, item_id: `item-${pt}` }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const realFetch = globalThis.fetch;

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (!HAS_DB) return;
  const { pool } = await import("../db.js");
  await pool.query(`delete from provider_credentials where provider = 'plaid' and user_id = $1`, [LOCAL_USER]);
  await pool.query(`delete from plaid_app`);
  await pool.query(`delete from audit_log where tool in ('set_plaid_app', 'delete_plaid_app') and user_id = $1`, [LOCAL_USER]);
  await releasePlaidAppLock?.();
  await pool.end();
});

/** A capturing fake ServerResponse. */
function fakeRes() {
  let status = 0;
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead(s: number, h?: Record<string, string>) {
      status = s;
      if (h) Object.assign(headers, h);
      this.headersSent = true;
      return this;
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    end(payload?: string) {
      if (payload) body += payload;
      this.headersSent = true;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
  };
}

/** A fake IncomingMessage that streams a JSON body (for readJson). */
function fakeReq(body?: unknown): IncomingMessage {
  const stream = new PassThrough();
  stream.end(Buffer.from(body === undefined ? "" : JSON.stringify(body), "utf8"));
  return stream as unknown as IncomingMessage;
}

function ctxFor(body?: unknown, params: Record<string, string> = {}) {
  const r = fakeRes();
  const ctx: RouteContext = {
    req: fakeReq(body),
    res: r.res,
    params,
    query: new URLSearchParams(),
  };
  return { ctx, r };
}

describe.skipIf(!HAS_DB)("Plaid routes (DB; fetch mocked)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    installPlaidFetchMock();
    process.env.PLAID_CLIENT_ID = "test-client-id";
    process.env.PLAID_SECRET = "test-secret";
    process.env.PLAID_ENV = "sandbox";
    const { pool } = await import("../db.js");
    await pool.query(`delete from provider_credentials where provider = 'plaid' and user_id = $1`, [LOCAL_USER]);
    await pool.query(`delete from plaid_app`);
  });

  // ── BYO app creds ──
  it("app: set seals the secret (never echoed); get returns clientId+env only; delete clears", async () => {
    const { setPlaidAppRoute, getPlaidAppRoute, deletePlaidAppRoute } = await import("./plaid-routes.js");

    const set = ctxFor({ clientId: "ci-123", clientSecret: "cs-super-secret", env: "production" });
    await setPlaidAppRoute(set.ctx);
    expect(set.r.status).toBe(200);
    expect(set.r.body).not.toContain("cs-super-secret");
    expect(JSON.parse(set.r.body)).toEqual({ configured: true, clientId: "ci-123", env: "production" });

    const get = ctxFor();
    await getPlaidAppRoute(get.ctx);
    expect(JSON.parse(get.r.body)).toEqual({ configured: true, clientId: "ci-123", env: "production" });
    expect(get.r.body).not.toContain("cs-super-secret");

    const del = ctxFor();
    await deletePlaidAppRoute(del.ctx);
    expect(JSON.parse(del.r.body)).toEqual({ configured: false });

    const get2 = ctxFor();
    await getPlaidAppRoute(get2.ctx);
    expect(JSON.parse(get2.r.body).configured).toBe(false);
  });

  // ── hosted-link mint (frozen Console contract: camelCase { linkToken, hostedLinkUrl }) ──
  it("hosted-link: returns EXACTLY { linkToken, hostedLinkUrl }", async () => {
    const { postPlaidHostedLink } = await import("./plaid-routes.js");
    const { ctx, r } = ctxFor();
    await postPlaidHostedLink(ctx);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({
      linkToken: "link-tok-1",
      hostedLinkUrl: "https://link.plaid.com/h/sess",
    });
  });

  // ── single exchange (per-Item keying) ──
  it("exchange: seals access_token, sets external_item_id, custody=byo_app; token never echoed", async () => {
    const { postPlaidExchange } = await import("./plaid-routes.js");
    const { open } = await import("../secrets/index.js");
    const { pool } = await import("../db.js");

    const { ctx, r } = ctxFor({ public_token: "pt-solo" });
    await postPlaidExchange(ctx);

    expect(r.status).toBe(201);
    const payload = JSON.parse(r.body);
    expect(payload.provider).toBe("plaid");
    expect(payload.sector).toBe("finance");
    expect(payload.itemId).toBe("item-pt-solo");
    expect(r.body).not.toContain("access-pt-solo");

    const cred = await pool.query(
      `select custody, secret_ref, status, external_item_id, item_status from provider_credentials where id = $1`,
      [payload.credentialId],
    );
    expect(cred.rows[0].custody).toBe("byo_app");
    expect(cred.rows[0].external_item_id).toBe("item-pt-solo");
    expect(cred.rows[0].item_status).toBe("ok");
    const opened = await open(cred.rows[0].secret_ref, {
      userId: LOCAL_USER,
      provider: "plaid",
      purpose: "access",
    });
    expect(opened.toString("utf8")).toBe("access-pt-solo");
  });

  it("exchange: a failed/consumed public_token writes NO rows and is a 4xx", async () => {
    const { postPlaidExchange } = await import("./plaid-routes.js");
    const { ValidationError } = await import("./router.js");
    const { pool } = await import("../db.js");

    consumed.add("pt-bad"); // pre-consume → exchange returns 400
    const { ctx } = ctxFor({ public_token: "pt-bad" });
    await expect(postPlaidExchange(ctx)).rejects.toBeInstanceOf(ValidationError);

    const cnt = await pool.query(
      `select count(*)::int as n from provider_credentials where provider = 'plaid' and user_id = $1`,
      [LOCAL_USER],
    );
    expect(cnt.rows[0].n).toBe(0);
  });

  // ── multi-Item poll: two item_add_results → two distinct connectors (frozen { complete, connections }) ──
  it("poll: two item_add_results → two connectors, returning the frozen { complete, connections } shape", async () => {
    const { postPlaidPoll } = await import("./plaid-routes.js");
    const { pool } = await import("../db.js");
    pollTokens = ["pt-a", "pt-b"];

    const { ctx, r } = ctxFor({ linkToken: "link-tok-1" });
    await postPlaidPoll(ctx);
    expect(r.status).toBe(200);
    const payload = JSON.parse(r.body);

    // EXACTLY the frozen contract — { complete, connections } and nothing else (no created/skipped/etc).
    expect(Object.keys(payload).sort()).toEqual(["complete", "connections"]);
    expect(payload.complete).toBe(true);
    expect(payload.connections).toHaveLength(2);
    // Each connection is { connectionId, itemId, institutionName, health: { status } | null } — nothing more.
    for (const c of payload.connections) {
      expect(Object.keys(c).sort()).toEqual(["connectionId", "health", "institutionName", "itemId"]);
      expect(typeof c.connectionId).toBe("string");
      expect(c.itemId).toMatch(/^item-pt-[ab]$/);
      expect(c.institutionName).toBeNull(); // no sync has run yet → not resolved
      expect(c.health).toEqual({ status: "ok" }); // exchangeAndStore seeds item_status 'ok'
    }

    const items = await pool.query(
      `select external_item_id from provider_credentials where provider = 'plaid' and user_id = $1 order by external_item_id`,
      [LOCAL_USER],
    );
    expect(items.rows.map((x) => x.external_item_id)).toEqual(["item-pt-a", "item-pt-b"]);

    // Count only SUITE-OWNED connectors (join on the Items this poll created): another worker
    // (finance-routes.db.test.ts) inserts provider='plaid' connectors for the same seed user.
    const conns = await pool.query(
      `select count(*)::int as n from connectors c
         join provider_credentials pc on pc.id = c.credential_id
        where c.provider = 'plaid' and c.user_id = $1 and pc.external_item_id = any($2)`,
      [LOCAL_USER, ["item-pt-a", "item-pt-b"]],
    );
    expect(conns.rows[0].n).toBe(2);
  });

  // ── idempotent re-poll: an already-consumed public_token creates no duplicate ──
  it("poll: re-polling an already-consumed public_token is skipped (no duplicate, empty connections)", async () => {
    const { postPlaidPoll } = await import("./plaid-routes.js");
    const { pool } = await import("../db.js");
    pollTokens = ["pt-dup"];

    const first = ctxFor({ linkToken: "link-tok-1" });
    await postPlaidPoll(first.ctx);
    expect(JSON.parse(first.r.body).connections).toHaveLength(1);

    const second = ctxFor({ linkToken: "link-tok-1" });
    await postPlaidPoll(second.ctx); // pt-dup is now consumed → exchange 400 → skipped, no connection
    const p2 = JSON.parse(second.r.body);
    expect(Object.keys(p2).sort()).toEqual(["complete", "connections"]);
    expect(p2.connections).toHaveLength(0);

    // Suite-owned scope (see the two-Item poll test above): count only the connector(s) tied to
    // THIS test's Item, so a concurrent worker's plaid connector can't inflate the count.
    const conns = await pool.query(
      `select count(*)::int as n from connectors c
         join provider_credentials pc on pc.id = c.credential_id
        where c.provider = 'plaid' and c.user_id = $1 and pc.external_item_id = any($2)`,
      [LOCAL_USER, ["item-pt-dup"]],
    );
    expect(conns.rows[0].n).toBe(1);
  });

  // ── update-mode relink: carries the stored token, never echoes it ──
  it("relink: mints an update-mode link carrying the stored access_token, never echoed", async () => {
    const { postPlaidRelink } = await import("./plaid-routes.js");
    const { seal } = await import("../secrets/index.js");
    const { pool } = await import("../db.js");

    const secretRef = await seal({ userId: LOCAL_USER, provider: "plaid", purpose: "access" }, "access-relink-secret");
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, external_item_id, item_status, status)
       values ($1, 'plaid', 'byo_app', $2, 'item-relink', 'action_required', 'active') returning id`,
      [LOCAL_USER, secretRef],
    );
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', 'plaid', 'active') returning id`,
      [LOCAL_USER, cred.rows[0].id],
    );

    const { ctx, r } = ctxFor({ connectionId: conn.rows[0].id });
    await postPlaidRelink(ctx);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({
      linkToken: "link-tok-1",
      hostedLinkUrl: "https://link.plaid.com/h/sess",
    });
    expect(r.body).not.toContain("access-relink-secret");
    // The minted link carried the stored access token (update mode).
    expect(lastCreateBody?.access_token).toBe("access-relink-secret");
  });

  // ── plaid_app mutations are audited (#32): set + delete + error outcomes; NEVER the secret ──

  /**
   * Start the async audit writer with a huge interval/batch so nothing flushes on a timer; run `fn`
   * (which enqueues an audit line via auditAdmin), then stop() to deterministically drain the queue.
   */
  async function withFlushedAudit(fn: () => Promise<void>): Promise<void> {
    const { startAuditWriter } = await import("../audit/index.js");
    const stop = startAuditWriter({ intervalMs: 1_000_000, batchSize: 1_000_000 });
    try {
      await fn();
    } finally {
      await stop(); // drain-flush the enqueued audit line(s)
    }
  }

  /**
   * Flush any audit lines OTHER tests left enqueued on the shared singleton queue (the route handlers
   * now audit), so a clean DELETE of audit_log isn't undone by a straggler flushing into our window.
   */
  async function drainQueuedAudits(): Promise<void> {
    await withFlushedAudit(async () => {});
  }

  async function plaidAppAuditRows() {
    const { pool } = await import("../db.js");
    const res = await pool.query(
      `select tool, decision, outcome, args from audit_log
         where tool in ('set_plaid_app', 'delete_plaid_app') and user_id = $1 order by id asc`,
      [LOCAL_USER],
    );
    return res.rows as Array<{ tool: string; decision: string; outcome: string; args: unknown }>;
  }

  it("set: a successful POST /api/plaid/app writes audit set_plaid_app ok, args={env}, NO secret", async () => {
    const { setPlaidAppRoute } = await import("./plaid-routes.js");
    const { pool } = await import("../db.js");
    await drainQueuedAudits(); // flush stragglers from earlier tests BEFORE clearing
    await pool.query(`delete from audit_log where tool in ('set_plaid_app', 'delete_plaid_app') and user_id = $1`, [LOCAL_USER]);

    await withFlushedAudit(async () => {
      const { ctx, r } = ctxFor({ clientId: "ci-aud", clientSecret: "cs-top-secret", env: "production" });
      await setPlaidAppRoute(ctx);
      expect(r.status).toBe(200);
    });

    const rows = await plaidAppAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("set_plaid_app");
    expect(rows[0].decision).toBe("allow");
    expect(rows[0].outcome).toBe("ok");
    expect(rows[0].args).toEqual({ env: "production" });
    // The secret can NEVER reach the audit row (we pass only { env }; redaction is the second wall).
    expect(JSON.stringify(rows[0].args)).not.toContain("cs-top-secret");
  });

  it("delete: a successful DELETE /api/plaid/app writes audit delete_plaid_app ok", async () => {
    const { deletePlaidAppRoute } = await import("./plaid-routes.js");
    const { pool } = await import("../db.js");
    await drainQueuedAudits(); // flush stragglers from earlier tests BEFORE clearing
    await pool.query(`delete from audit_log where tool in ('set_plaid_app', 'delete_plaid_app') and user_id = $1`, [LOCAL_USER]);

    await withFlushedAudit(async () => {
      const { ctx, r } = ctxFor();
      await deletePlaidAppRoute(ctx);
      expect(r.status).toBe(200);
    });

    const rows = await plaidAppAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("delete_plaid_app");
    expect(rows[0].outcome).toBe("ok");
    expect(rows[0].args).toEqual({});
  });

  it("set: a failed mutation (whitespace clientId → ConfigError) audits set_plaid_app error, still no secret", async () => {
    const { setPlaidAppRoute } = await import("./plaid-routes.js");
    const { pool } = await import("../db.js");
    await drainQueuedAudits(); // flush stragglers from earlier tests BEFORE clearing
    await pool.query(`delete from audit_log where tool in ('set_plaid_app', 'delete_plaid_app') and user_id = $1`, [LOCAL_USER]);

    await withFlushedAudit(async () => {
      // " " passes zod min(1) but setPlaidApp trims → "" → ConfigError; the route audits 'error' + rethrows.
      const { ctx } = ctxFor({ clientId: " ", clientSecret: "cs-top-secret", env: "sandbox" });
      await expect(setPlaidAppRoute(ctx)).rejects.toBeTruthy();
    });

    const rows = await plaidAppAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("set_plaid_app");
    expect(rows[0].outcome).toBe("error");
    expect(rows[0].args).toEqual({ env: "sandbox" });
    expect(JSON.stringify(rows[0].args)).not.toContain("cs-top-secret");
  });
});

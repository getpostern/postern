// Agent-key expiry DB round-trips (mcp-auth-bridge child B) — gated on DATABASE_URL.
//
// SCHEMA NOTE: the `agent_grants.expires_at timestamptz` column is owned by migration
// 0014_oauth_bridge_and_key_expiry.sql (merged tree — verified byte-identical DDL). The beforeAll
// `alter table ... if not exists` below is a retained no-op belt from the parallel-build phase.
// Never run against live pci; the vitest globalSetup guard enforces a *_test DATABASE_URL.
//
// Proves the child-B acceptance rows: mint-with-expiry round-trips on POST/GET/PATCH (PATCH leaves
// expiry untouched — uniform row shape); default mint is never-expiring; re-mint (rotate) REPLACES
// the expiry it resends (a rotated 90-day key stays 90-day; an omitted field resets to never);
// bad expiresInDays → typed 400 NAMING the field; an expired key denies at resolveBearer with
// 'expired' while a live one resolves and carries ctx.expiresAt.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./router.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001";
const AGENT = "test-expiry-agent";
const DAY_MS = 86_400_000;
// Clock tolerance between the DB's now() and the test process clock.
const TOLERANCE_MS = 5 * 60_000;

/** A capturing fake ServerResponse (the admin.db.test.ts pattern). */
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

function ctxFor(params: Record<string, string> = {}) {
  const r = fakeRes();
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1:8787" };
  const ctx: RouteContext = { req, res: r.res, params, query: new URLSearchParams("") };
  return { ctx, r };
}

async function mint(body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
  const { postAgent } = await import("./admin.js");
  const { ctx, r } = ctxFor();
  await postAgent(ctx, body);
  return { status: r.status, payload: JSON.parse(r.body) };
}

async function listRows(): Promise<Array<Record<string, unknown>>> {
  const { listAgents } = await import("./admin.js");
  const { ctx, r } = ctxFor();
  await listAgents(ctx);
  return JSON.parse(r.body);
}

async function cleanup() {
  const { pool } = await import("../db.js");
  await pool.query(`delete from agent_grants where user_id = $1 and agent_id = $2`, [LOCAL_USER, AGENT]);
}

describe.skipIf(!HAS_DB)("agent-key expiry (DB)", () => {
  beforeAll(async () => {
    const { pool } = await import("../db.js");
    // Child A's migration DDL, applied to the disposable test DB only (see the file header).
    await pool.query(`alter table agent_grants add column if not exists expires_at timestamptz`);
    await cleanup();
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    const { pool } = await import("../db.js");
    await pool.end();
  });

  it("mint with expiresInDays → expires_at ≈ now + N days, served on POST, GET AND PATCH (PATCH leaves it untouched)", async () => {
    const { status, payload } = await mint({ agentId: AGENT, sectors: ["finance"], expiresInDays: 90 });
    expect(status).toBe(201);
    expect(payload.key).toBeTruthy();
    expect(payload.expires_at).toBeTruthy();
    const minted = new Date(payload.expires_at as string).getTime();
    expect(Math.abs(minted - (Date.now() + 90 * DAY_MS))).toBeLessThan(TOLERANCE_MS);

    // GET serves the same deadline.
    const row = (await listRows()).find((r) => r.agentId === AGENT);
    expect(row).toBeTruthy();
    expect(new Date(row!.expires_at as string).getTime()).toBe(minted);

    // PATCH (sectors only) serves the deadline unchanged — expiry is not a grants edit.
    const { patchAgent } = await import("./admin.js");
    const { ctx, r } = ctxFor({ agentId: AGENT });
    await patchAgent(ctx, { sectors: ["mail"] });
    expect(r.status).toBe(200);
    const patched = JSON.parse(r.body);
    expect(patched.sectors).toEqual(["mail"]);
    expect(new Date(patched.expires_at as string).getTime()).toBe(minted);
  });

  it("default mint (no expiresInDays) is never-expiring: expires_at null on POST and GET", async () => {
    const { status, payload } = await mint({ agentId: AGENT, sectors: ["finance"] });
    expect(status).toBe(201);
    expect(payload.expires_at).toBeNull();
    const row = (await listRows()).find((r) => r.agentId === AGENT);
    expect(row!.expires_at).toBeNull();
  });

  it("re-mint (rotate) REPLACES expiry via excluded.expires_at: 30d → 90d stays 90d; omitted resets to never; the old key dies", async () => {
    const first = await mint({ agentId: AGENT, sectors: ["finance"], expiresInDays: 30 });

    // The Console's rotate resends the current lifetime (here explicitly 90 to prove replacement).
    const second = await mint({ agentId: AGENT, sectors: ["finance"], expiresInDays: 90 });
    expect(second.payload.key).not.toBe(first.payload.key);
    const t2 = new Date(second.payload.expires_at as string).getTime();
    expect(Math.abs(t2 - (Date.now() + 90 * DAY_MS))).toBeLessThan(TOLERANCE_MS);

    // The rotated-out key no longer resolves (the upsert replaced key_hash).
    const { resolveBearer, AccessDenied } = await import("../auth/index.js");
    await expect(resolveBearer(first.payload.key as string)).rejects.toBeInstanceOf(AccessDenied);

    // A re-mint WITHOUT the field deliberately resets to never (absent = never; the FE resends).
    const third = await mint({ agentId: AGENT, sectors: ["finance"] });
    expect(third.payload.expires_at).toBeNull();
  });

  it("bad expiresInDays → typed 400 NAMING the field (0, negative, fractional, out-of-range, non-number)", async () => {
    const { postAgent } = await import("./admin.js");
    const { ValidationError } = await import("./router.js");
    for (const bad of [0, -5, 1.5, 3651, "30", true]) {
      const { ctx } = ctxFor();
      const err = await postAgent(ctx, { agentId: AGENT, sectors: ["finance"], expiresInDays: bad }).then(
        () => {
          throw new Error(`expected ValidationError for ${JSON.stringify(bad)}`);
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain("expiresInDays");
    }
    // Nothing was minted by any of the rejects.
    expect((await listRows()).find((r) => r.agentId === AGENT)).toBeUndefined();
  });

  it("an expired key is denied at resolveBearer with 'expired'; a live one resolves with ctx.expiresAt", async () => {
    const { pool } = await import("../db.js");
    const { resolveBearer, AccessDenied } = await import("../auth/index.js");

    const { payload } = await mint({ agentId: AGENT, sectors: ["finance"], expiresInDays: 30 });
    const key = payload.key as string;

    // Live: resolves, and the ctx carries the deadline (the per-call mid-session seam).
    const ctx = await resolveBearer(key);
    expect(ctx.expiresAt).toBeInstanceOf(Date);
    expect(Math.abs((ctx.expiresAt as Date).getTime() - (Date.now() + 30 * DAY_MS))).toBeLessThan(TOLERANCE_MS);

    // Push the deadline into the past → the SAME key is dead at resolve.
    await pool.query(
      `update agent_grants set expires_at = now() - interval '1 second' where user_id = $1 and agent_id = $2`,
      [LOCAL_USER, AGENT],
    );
    const err = await resolveBearer(key).then(
      () => {
        throw new Error("expected AccessDenied");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AccessDenied);
    expect((err as Error).message).toContain("expired");
    expect((err as { reason?: string }).reason).toBe("expired");
  });

  it("MERGED-TREE SEAM: rotate (re-mint) deletes the grant's oauth-bridge codes+tokens in the same transaction (ADR 0029 §5)", async () => {
    const { pool } = await import("../db.js");
    const { createHash } = await import("node:crypto");

    await mint({ agentId: AGENT, sectors: ["finance"] });
    const grant = await pool.query(
      `select id from agent_grants where user_id = $1 and agent_id = $2`,
      [LOCAL_USER, AGENT],
    );
    const grantId = grant.rows[0].id as string;

    // Simulate bridge-derived credentials from the CURRENT key's life (hashes only, per the schema).
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    await pool.query(
      `insert into oauth_bridge_tokens (agent_grant_id, client_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at)
       values ($1, 'client-seam-test', $2, $3, now() + interval '1 hour', now() + interval '30 days')`,
      [grantId, sha("pcgat_seamtest"), sha("pcgrt_seamtest")],
    );
    await pool.query(
      `insert into oauth_bridge_codes (agent_grant_id, client_id, code_hash, code_challenge, redirect_uri, expires_at)
       values ($1, 'client-seam-test', $2, 'chal', 'https://claude.ai/api/mcp/auth_callback', now() + interval '5 minutes')`,
      [grantId, sha("pcgac_seamtest")],
    );

    // Rotate = mint the same agentId again. The old key's derived rows MUST die transactionally.
    const { status } = await mint({ agentId: AGENT, sectors: ["finance"] });
    expect(status).toBe(201);
    const tokens = await pool.query(`select count(*)::int as n from oauth_bridge_tokens where agent_grant_id = $1`, [grantId]);
    const codes = await pool.query(`select count(*)::int as n from oauth_bridge_codes where agent_grant_id = $1`, [grantId]);
    expect(tokens.rows[0].n).toBe(0);
    expect(codes.rows[0].n).toBe(0);
  });
});

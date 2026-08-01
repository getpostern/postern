// PATCH /api/agents/:agentId — editing a key's expiry IN PLACE (#80 backend half), against a real
// Postgres.
//
// The point of the unit is that the deadline moves and the SECRET DOES NOT, so almost every cell below
// re-presents the ORIGINAL key to resolveBearer afterwards. A test that only read `expires_at` back
// out of the row would pass just as happily against an implementation that quietly rotated the key —
// which is the exact cost (#80) exists to remove.
//
// The other half is the refusal: an expiry edit must never be a way to bring a dead key back. "Dead"
// is a live predicate here, not a stored flag — nothing stamps a row when it expires — so the cells
// that matter most assert on what resolveBearer does with the original secret AFTER a refused edit.
//
// Never run against live pci; the vitest globalSetup guard enforces a *_test DATABASE_URL.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./router.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001";
const AGENT = "test-expiry-patch-agent";
const DAY_MS = 86_400_000;
/** Clock tolerance between the DB's now() and the test process clock. */
const TOLERANCE_MS = 5 * 60_000;

function fakeRes() {
  let status = 0;
  let body = "";
  const res = {
    headersSent: false,
    writeHead(s: number) {
      status = s;
      this.headersSent = true;
      return this;
    },
    setHeader() {},
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

/** Mint (or rotate) the fixture key and return the raw secret + the served expiry. */
async function mint(body: Record<string, unknown>): Promise<{ key: string; expiresAt: string | null }> {
  const { postAgent } = await import("./admin.js");
  const { ctx, r } = ctxFor();
  await postAgent(ctx, { agentId: AGENT, sectors: ["finance"], ...body });
  const payload = JSON.parse(r.body);
  return { key: payload.key as string, expiresAt: payload.expires_at as string | null };
}

async function patch(body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
  const { patchAgent } = await import("./admin.js");
  const { ctx, r } = ctxFor({ agentId: AGENT });
  await patchAgent(ctx, body);
  return { status: r.status, payload: JSON.parse(r.body) };
}

async function patchErr(body: unknown, agentId = AGENT): Promise<Error> {
  const { patchAgent } = await import("./admin.js");
  const { ctx } = ctxFor({ agentId });
  return patchAgent(ctx, body).then(
    () => {
      throw new Error(`expected a ValidationError for ${JSON.stringify(body)}`);
    },
    (e: Error) => e,
  );
}

/** The row as the DB holds it — the only witness that a refused edit wrote nothing. */
async function row(): Promise<{ sectors: string[]; expires_at: Date | null; revoked_at: Date | null }> {
  const { pool } = await import("../db.js");
  const res = await pool.query(
    `select sectors, expires_at, revoked_at from agent_grants where user_id = $1 and agent_id = $2`,
    [LOCAL_USER, AGENT],
  );
  return res.rows[0];
}

/** Does the ORIGINAL secret still open the gate? */
async function resolves(key: string): Promise<boolean> {
  const { resolveBearer } = await import("../auth/index.js");
  return resolveBearer(key).then(
    () => true,
    () => false,
  );
}

function daysFromNow(iso: string | null | undefined): number {
  return (new Date(String(iso)).getTime() - Date.now()) / DAY_MS;
}

async function cleanup() {
  const { pool } = await import("../db.js");
  await pool.query(`delete from agent_grants where user_id = $1 and agent_id = $2`, [LOCAL_USER, AGENT]);
}

describe.skipIf(!HAS_DB)("PATCH /api/agents/:agentId — in-place expiry edit (DB)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    const { pool } = await import("../db.js");
    await pool.end();
  });

  it("EXTENDS the deadline without touching the secret — the same key still resolves", async () => {
    const { key, expiresAt } = await mint({ expiresInDays: 30 });
    expect(daysFromNow(expiresAt)).toBeCloseTo(30, 1);

    const { status, payload } = await patch({ expiresInDays: 90 });
    expect(status).toBe(200);
    expect(Math.abs(new Date(payload.expires_at as string).getTime() - (Date.now() + 90 * DAY_MS))).toBeLessThan(
      TOLERANCE_MS,
    );
    // THE POINT OF THE UNIT: no rotation happened.
    expect(await resolves(key)).toBe(true);
    expect((await row()).sectors).toEqual(["finance"]); // and the grant set was left alone
  });

  it("SHORTENS the deadline the same way", async () => {
    const { key } = await mint({ expiresInDays: 3650 });
    const { payload } = await patch({ expiresInDays: 1 });
    expect(daysFromNow(payload.expires_at as string)).toBeCloseTo(1, 1);
    expect(await resolves(key)).toBe(true);
  });

  it("CLEARS the deadline with an explicit null — never-expiring, still the same key", async () => {
    const { key } = await mint({ expiresInDays: 30 });
    const { status, payload } = await patch({ expiresInDays: null });
    expect(status).toBe(200);
    expect(payload.expires_at).toBeNull();
    expect((await row()).expires_at).toBeNull();
    expect(await resolves(key)).toBe(true);
  });

  it("sets a deadline on a key that never had one (the mint default is never-expiring)", async () => {
    const { key, expiresAt } = await mint({});
    expect(expiresAt).toBeNull();
    const { payload } = await patch({ expiresInDays: 60 });
    expect(daysFromNow(payload.expires_at as string)).toBeCloseTo(60, 1);
    expect(await resolves(key)).toBe(true);
  });

  it("ABSENT expiresInDays leaves the deadline exactly as it was — the shipped sectors-only PATCH", async () => {
    await mint({ expiresInDays: 45 });
    const before = (await row()).expires_at;
    const { status, payload } = await patch({ sectors: ["mail", "calendar"] });
    expect(status).toBe(200);
    expect(payload.sectors).toEqual(["mail", "calendar"]);
    expect(new Date(payload.expires_at as string).getTime()).toBe(before!.getTime());
    // Absent must NOT be read as the mint convention (absent = never); that would silently clear it.
    expect((await row()).expires_at).not.toBeNull();
  });

  it("edits sectors AND expiry in one PATCH", async () => {
    const { key } = await mint({ expiresInDays: 30 });
    const { payload } = await patch({ sectors: ["health"], expiresInDays: 120 });
    expect(payload.sectors).toEqual(["health"]);
    expect(daysFromNow(payload.expires_at as string)).toBeCloseTo(120, 1);
    expect(await resolves(key)).toBe(true);
  });

  // ── The refusal: an expiry edit is never a resurrection ────────────────────────────────────────

  it("an EXPIRED key cannot be un-expired — not by a new deadline, and not by clearing it", async () => {
    const { pool } = await import("../db.js");
    const { key } = await mint({ expiresInDays: 30 });
    await pool.query(
      `update agent_grants set expires_at = now() - interval '1 second' where user_id = $1 and agent_id = $2`,
      [LOCAL_USER, AGENT],
    );
    expect(await resolves(key)).toBe(false); // dead, per resolveBearer

    for (const body of [{ expiresInDays: 90 }, { expiresInDays: null }]) {
      const err = await patchErr(body);
      expect(err.name).toBe("ValidationError");
      expect(err.message).toContain("expired");
      expect(err.message).toContain("rotate");
      // The write must not have happened, and the ORIGINAL secret must still be dead. This is the
      // assertion the whole guard exists for: `expires_at = null` on an expired row would hand a key
      // that already ran out its life its access straight back.
      const r = await row();
      expect(r.expires_at).not.toBeNull();
      expect(r.expires_at!.getTime()).toBeLessThan(Date.now());
      expect(await resolves(key)).toBe(false);
    }
  });

  it("a REVOKED key's expiry cannot be edited either", async () => {
    const { revokeAgent } = await import("./admin.js");
    const { key } = await mint({ expiresInDays: 30 });
    const { ctx } = ctxFor({ agentId: AGENT });
    await revokeAgent(ctx);
    expect(await resolves(key)).toBe(false);

    const err = await patchErr({ expiresInDays: 90 });
    expect(err.name).toBe("ValidationError");
    expect(err.message).toContain("revoked");
    expect((await row()).revoked_at).not.toBeNull();
    expect(await resolves(key)).toBe(false);
  });

  it("a refused expiry edit writes NOTHING — the sectors in the same body do not slip through", async () => {
    const { revokeAgent } = await import("./admin.js");
    await mint({ expiresInDays: 30 });
    const before = (await row()).expires_at;
    const { ctx } = ctxFor({ agentId: AGENT });
    await revokeAgent(ctx);

    await patchErr({ sectors: ["home", "mail"], expiresInDays: 900 });
    const r = await row();
    expect(r.sectors).toEqual(["finance"]); // not ["home","mail"]
    expect(r.expires_at!.getTime()).toBe(before!.getTime());
  });

  it("a SECTORS-ONLY patch on a dead key still works — the guard narrows nothing that worked before", async () => {
    const { revokeAgent } = await import("./admin.js");
    await mint({ expiresInDays: 30 });
    const { ctx } = ctxFor({ agentId: AGENT });
    await revokeAgent(ctx);

    const { status, payload } = await patch({ sectors: ["mail"] });
    expect(status).toBe(200);
    expect(payload.sectors).toEqual(["mail"]);
    expect(payload.revoked_at).not.toBeNull(); // still revoked; the edit is inert, as it always was
  });

  it("an expiry edit is NOT a rotation: the grant's oauth-bridge tokens survive it", async () => {
    const { pool } = await import("../db.js");
    const { createHash } = await import("node:crypto");
    await mint({ expiresInDays: 30 });
    const grant = await pool.query(`select id from agent_grants where user_id = $1 and agent_id = $2`, [
      LOCAL_USER,
      AGENT,
    ]);
    const grantId = grant.rows[0].id as string;
    const sha = (v: string) => createHash("sha256").update(v).digest("hex");
    await pool.query(
      `insert into oauth_bridge_tokens (agent_grant_id, client_id, access_hash, refresh_hash, access_expires_at, refresh_expires_at)
       values ($1, 'client-expiry-patch-test', $2, $3, now() + interval '1 hour', now() + interval '20 days')`,
      [grantId, sha("pcgat_patchtest"), sha("pcgrt_patchtest")],
    );

    await patch({ expiresInDays: 365 });

    // Mint/rotate kills these (ADR 0029 §5) precisely because it replaces the secret. An expiry edit
    // does not replace the secret, so forcing every connected client to re-authorize would be a cost
    // with no security purchase — and the bridge re-reads the grant per token/refresh anyway, so a
    // SHORTENED deadline still binds them.
    const n = await pool.query(
      `select count(*)::int as n from oauth_bridge_tokens where agent_grant_id = $1`,
      [grantId],
    );
    expect(n.rows[0].n).toBe(1);
    await pool.query(`delete from oauth_bridge_tokens where agent_grant_id = $1`, [grantId]);
  });

  // ── Validation ────────────────────────────────────────────────────────────────────────────────

  it("bad expiresInDays → a typed 400 that NAMES the field, and nothing is written", async () => {
    await mint({ expiresInDays: 30 });
    const before = (await row()).expires_at;
    for (const bad of [0, -5, 1.5, 3651, "30", true, {}, []]) {
      const err = await patchErr({ expiresInDays: bad });
      expect(err.name, `expiresInDays=${JSON.stringify(bad)}`).toBe("ValidationError");
      expect(err.message).toContain("expiresInDays");
    }
    expect((await row()).expires_at!.getTime()).toBe(before!.getTime());
  });

  it("a body with neither field is a 400, not a silent 200 no-op", async () => {
    await mint({ expiresInDays: 30 });
    for (const body of [{}, { nonsense: 1 }]) {
      const err = await patchErr(body);
      expect(err.name).toBe("ValidationError");
      expect(err.message).toContain("nothing to update");
    }
  });

  it("an unknown agentId is 'unknown agentId', with or without an expiry field", async () => {
    for (const body of [{ sectors: ["finance"] }, { expiresInDays: 30 }, { expiresInDays: null }]) {
      const err = await patchErr(body, "no-such-agent-anywhere");
      expect(err.name).toBe("ValidationError");
      expect(err.message).toBe("unknown agentId");
    }
  });

  it("bad sectors are still rejected generically (the pre-existing contract)", async () => {
    await mint({ expiresInDays: 30 });
    const err = await patchErr({ sectors: "finance" });
    expect(err.name).toBe("ValidationError");
    expect(err.message).toBe("invalid request body");
  });
});

// Agent PASSAGE on GET /api/agents (#89 item 4 / #80) — `last_seen_at` and the per-sector
// `last_read_at`, against a real Postgres. Gated on DATABASE_URL.
//
// WHY THE FIXTURE LOOKS LIKE THIS. The whole issue is that the obvious implementation — reduce the
// `/api/audit` feed to a last-seen per agent — is WRONG rather than slow, and looks perfect in any
// small fixture. So the fixture is deliberately BIGGER THAN THE FEED WINDOW: a quiet agent with one
// week-old row, behind 1001 newer rows belonging to a busy agent. The premise is asserted directly in
// SQL (the quiet row really is outside the newest-1000 window) before the conclusion is asserted on
// the wire (its last_seen_at is nevertheless its real instant). Shrink the fixture below ~1000 rows
// and a feed-reduction implementation passes — which is exactly how it would have shipped.
//
// Isolation: every agent id carries this suite's prefix and every query/cleanup filters on it. The
// throwaway database is shared with whatever else runs in the session, so nothing here truncates
// audit_log (the admin.audit.db.test.ts convention).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { RouteContext } from "./router.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001";
const OTHER_USER = "00000000-0000-0000-0000-0000000a55e0";
const P = "passage-test-"; // every fixture agent id starts with this
const QUIET = `${P}quiet`;
const BUSY = `${P}busy`;
const NEVER = `${P}never`;
const MIXED = `${P}mixed`;
const FOREIGN = `${P}foreign`; // same agent id under ANOTHER user
/** The /api/audit window this test must be bigger than (admin.ts caps `limit` at 1000). */
const FEED_CAP = 1000;

interface AgentWire {
  agentId: string;
  last_seen_at: string | null;
  last_read_at: Record<string, string>;
}

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

async function agents(): Promise<Map<string, AgentWire>> {
  const { listAgents } = await import("./admin.js");
  const r = fakeRes();
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1:8787" };
  const ctx: RouteContext = { req, res: r.res, params: {}, query: new URLSearchParams("") };
  await listAgents(ctx);
  expect(r.status).toBe(200);
  const rows = JSON.parse(r.body) as AgentWire[];
  return new Map(rows.filter((a) => a.agentId.startsWith(P)).map((a) => [a.agentId, a]));
}

const WEEK_AGO = "2026-07-19T09:00:00.000Z";
const RECENT = "2026-07-26T09:00:00.000Z";

describe.skipIf(!HAS_DB)("GET /api/agents — agent passage (DB)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = (await import("../db.js")).pool;
    await pool.query(`insert into users (id, label) values ($1, $2) on conflict (id) do nothing`, [
      OTHER_USER,
      "passage-db-test-other",
    ]);
    await pool.query(`delete from audit_log where agent_id like $1`, [`${P}%`]);
    await pool.query(`delete from agent_grants where agent_id like $1`, [`${P}%`]);

    for (const [user, agentId] of [
      [LOCAL_USER, QUIET],
      [LOCAL_USER, BUSY],
      [LOCAL_USER, NEVER],
      [LOCAL_USER, MIXED],
      [OTHER_USER, FOREIGN],
      [LOCAL_USER, FOREIGN],
    ] as const) {
      await pool.query(
        `insert into agent_grants (user_id, agent_id, key_hash, sectors)
         values ($1, $2, $3, '{mail,finance,home}')
         on conflict (user_id, agent_id) do nothing`,
        [user, agentId, `hash-${user}-${agentId}`],
      );
    }

    const line = async (
      user: string,
      agentId: string,
      tool: string,
      sector: string | null,
      decision: string,
      at: string,
    ): Promise<void> => {
      await pool.query(
        `insert into audit_log (user_id, agent_id, tool, sector, decision, created_at)
         values ($1, $2, $3, $4, $5, $6::timestamptz)`,
        [user, agentId, tool, sector, decision, at],
      );
    };

    // The QUIET agent: ONE read, a week ago. Everything about this test is about this row surviving.
    await line(LOCAL_USER, QUIET, "query", "mail", "allow", WEEK_AGO);

    // The BUSY agent: FEED_CAP + 1 rows, all NEWER, so the quiet row is pushed clean out of any
    // newest-first page the audit feed can serve.
    await pool.query(
      `insert into audit_log (user_id, agent_id, tool, sector, decision, created_at)
       select $1, $2, 'query', 'finance', 'allow', $3::timestamptz + (g * interval '1 second')
         from generate_series(1, $4) as g`,
      [LOCAL_USER, BUSY, RECENT, FEED_CAP + 1],
    );

    // The MIXED agent, one row per case the two grains have to separate:
    await line(LOCAL_USER, MIXED, "query", "mail", "allow", "2026-07-20T10:00:00.000Z"); // a real read
    await line(LOCAL_USER, MIXED, "query", "finance", "deny", "2026-07-21T10:00:00.000Z"); // denied: not a read
    await line(LOCAL_USER, MIXED, "invoke_action", "home", "allow", "2026-07-22T10:00:00.000Z"); // an ACT
    await line(LOCAL_USER, MIXED, "describe_context", null, "allow", "2026-07-23T10:00:00.000Z"); // no sector

    // The FOREIGN agent id exists under BOTH users; only the OTHER user's row has any activity.
    await line(OTHER_USER, FOREIGN, "query", "mail", "allow", RECENT);
  });

  afterAll(async () => {
    await pool.query(`delete from audit_log where agent_id like $1`, [`${P}%`]);
    await pool.query(`delete from agent_grants where agent_id like $1`, [`${P}%`]);
    await pool.query(`delete from users where id = $1`, [OTHER_USER]);
  });

  it("the fixture's premise holds: the quiet agent is OUTSIDE the newest-1000 audit window", async () => {
    // Asserted in SQL rather than through the audit handler, so this stays true regardless of what the
    // feed's own filters/pager do. If this ever fails, the test below has stopped proving anything.
    const res = await pool.query(
      `select 1 from (
         select agent_id from audit_log where user_id = $1
         order by created_at desc, id desc limit $2
       ) w where w.agent_id = $3 limit 1`,
      [LOCAL_USER, FEED_CAP, QUIET],
    );
    expect(res.rowCount).toBe(0);
  });

  it("a QUIET agent still reports its real last_seen_at — not 'never'", async () => {
    const a = (await agents()).get(QUIET)!;
    expect(a).toBeDefined();
    expect(a.last_seen_at).not.toBeNull();
    expect(new Date(a.last_seen_at!).toISOString()).toBe(WEEK_AGO);
  });

  it("a NEVER-SEEN agent reports null (served-but-never), and an empty last_read_at", async () => {
    const a = (await agents()).get(NEVER)!;
    // null and absent are different facts: null is "we serve this, and it is genuinely never".
    expect(a.last_seen_at).toBeNull();
    expect("last_seen_at" in a).toBe(true);
    expect(a.last_read_at).toEqual({});
  });

  it("last_seen_at counts ANY audited call — including a deny and a sector-less read", async () => {
    const a = (await agents()).get(MIXED)!;
    // The newest row is the sector-less describe_context; a last-seen restricted to sector'd allows
    // would report the 20th instead and understate a live key by three days.
    expect(new Date(a.last_seen_at!).toISOString()).toBe("2026-07-23T10:00:00.000Z");
  });

  it("last_read_at is per-sector, ALLOWED reads only — no denies, no invoke_action", async () => {
    const a = (await agents()).get(MIXED)!;
    expect(Object.keys(a.last_read_at)).toEqual(["mail"]);
    expect(new Date(a.last_read_at.mail).toISOString()).toBe("2026-07-20T10:00:00.000Z");
    // finance was DENIED — the agent did not read it, so the read lane must not claim it did.
    expect(a.last_read_at.finance).toBeUndefined();
    // home was ACTED on, not read — the sector lens captions acting in its own lane.
    expect(a.last_read_at.home).toBeUndefined();
  });

  it("a busy agent's own last_seen_at is its newest row", async () => {
    const a = (await agents()).get(BUSY)!;
    const expected = new Date(new Date(RECENT).getTime() + (FEED_CAP + 1) * 1000).toISOString();
    expect(new Date(a.last_seen_at!).toISOString()).toBe(expected);
    expect(new Date(a.last_read_at.finance).toISOString()).toBe(expected);
  });

  it("ANOTHER user's audit rows never bleed into this user's passage (user-scoped)", async () => {
    const a = (await agents()).get(FOREIGN)!;
    // Same agent id, activity under a different user. Drop the `user_id = $1` clause and this reads as
    // an active key that this user has never actually been visited by.
    expect(a.last_seen_at).toBeNull();
    expect(a.last_read_at).toEqual({});
  });
});

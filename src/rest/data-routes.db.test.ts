// Operator data-read routes (DB), gated on DATABASE_URL so CI stays green without Postgres. The
// handlers are exercised DIRECTLY (a constructed RouteContext + a parsed body / params) — the routes
// are not wired into the app in this worktree (the mother wires them at merge), so there is no HTTP
// server here. Fixtures seed finance_transactions for the seeded LOCAL_USER plus a SECOND user, all
// tagged with a unique `source_object_id` token ("drtst_") so every assertion scopes to this suite's
// rows and never collides with other suites' LOCAL_USER finance rows.
//
// Proves the spec's acceptance: list returns the operator's rows with filter / sort / limit-offset /
// aggregation working (all from reusing core query()); unknown sector / field / bad op -> 400;
// tombstoned rows excluded from the list but truthful on the drill; drill returns the FULL row incl.
// `raw`; absent id -> 404; user_id-scoped (no cross-user reach); and both routes are localOnly
// (non-loopback Host -> 403) with NO bearer required.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  postDataQuery,
  getDataRecord,
  dataQueryRoute,
  dataRecordRoute,
} from "./data-routes.js";
import { errorToStatus, type RouteContext } from "./router.js";
import { QueryValidationError } from "../core/query.js";
import { NotFoundError } from "../core/context.js";
import { ForbiddenHostError } from "./host-allowlist.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001"; // the seeded operator (db/schema.sql)
const TOKEN = "drtst_"; // unique source_object_id prefix scoping every query to this suite's rows

// ── Fake req/res so the bare handlers can be called without a socket ──────────────
interface Captured {
  status?: number;
  body?: string;
}

/** A minimal ServerResponse that captures sendJson's writeHead status + end payload. */
function makeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = {};
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(payload?: string) {
      captured.body = payload;
      return res;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

/** A header-only req (no body stream) — enough for getDataRecord + the localOnly Host check. */
function headerReq(host = "127.0.0.1"): IncomingMessage {
  return { headers: { host } } as unknown as IncomingMessage;
}

/** A streaming req that emits `body` once — for the wrapped dataQueryRoute (which reads its own body). */
function streamReq(body: string, host = "127.0.0.1"): IncomingMessage {
  const r = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  (r as unknown as { headers: Record<string, string> }).headers = { host };
  return r;
}

function ctxFor(params: Record<string, string>, req: IncomingMessage): { ctx: RouteContext; captured: Captured } {
  const { res, captured } = makeRes();
  return { ctx: { req, res, params, query: new URLSearchParams() }, captured };
}

/** Parse a captured sendJson body. */
function parseBody(captured: Captured): unknown {
  return JSON.parse(captured.body ?? "null");
}

/** Run a call and return whatever it throws — catches SYNC throws (localOnly) AND rejected promises. */
async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
}

describe.skipIf(!HAS_DB)("operator data-read routes (DB)", () => {
  let connId: string; // LOCAL_USER's connection
  let credId: string;
  let u2Id: string; // second user (cross-user scoping)
  let u2CredId: string;
  let u2ConnId: string;
  const ids: Record<string, string> = {}; // source_object_id -> row uuid

  async function db() {
    return (await import("../db.js")).pool;
  }

  /** Insert one finance_transactions row, return its uuid. */
  async function insertTx(
    connectionId: string,
    userId: string,
    soid: string,
    fields: { amount: number; category: string; posted_at: string; deleted_at?: string },
  ): Promise<string> {
    const pool = await db();
    const r = await pool.query(
      `insert into finance_transactions
         (connection_id, user_id, source_object_id, posted_at, amount, currency, description, merchant, category, raw, deleted_at)
       values ($1,$2,$3,$4,$5,'USD',$6,'DataRouteTest',$7,$8,$9)
       returning id`,
      [
        connectionId,
        userId,
        soid,
        fields.posted_at,
        fields.amount,
        `desc ${soid}`,
        fields.category,
        JSON.stringify({ sentinel: soid, note: "raw-payload" }),
        fields.deleted_at ?? null,
      ],
    );
    return r.rows[0].id as string;
  }

  beforeAll(async () => {
    const pool = await db();

    // Clean any leftovers from a prior aborted run (provider is unique per (user_id, provider)).
    await pool.query(`delete from provider_credentials where user_id = $1 and provider = 'fake_dataread'`, [LOCAL_USER]);
    await pool.query(`delete from users where label = 'datatest-u2'`);

    // LOCAL_USER credential + connector.
    credId = (
      await pool.query(
        `insert into provider_credentials (user_id, provider, custody, status)
         values ($1, 'fake_dataread', 'static_token', 'active') returning id`,
        [LOCAL_USER],
      )
    ).rows[0].id as string;
    connId = (
      await pool.query(
        `insert into connectors (user_id, credential_id, sector, provider, status)
         values ($1, $2, 'finance', 'fake_dataread', 'active') returning id`,
        [LOCAL_USER, credId],
      )
    ).rows[0].id as string;

    // Live rows: a/b = FOOD_AND_DRINK, c = TRAVEL, d = INCOME (money in). tomb = tombstoned FOOD.
    ids.a = await insertTx(connId, LOCAL_USER, `${TOKEN}a`, { amount: -50, category: "FOOD_AND_DRINK", posted_at: "2026-01-03T00:00:00Z" });
    ids.b = await insertTx(connId, LOCAL_USER, `${TOKEN}b`, { amount: -20, category: "FOOD_AND_DRINK", posted_at: "2026-01-02T00:00:00Z" });
    ids.c = await insertTx(connId, LOCAL_USER, `${TOKEN}c`, { amount: -100, category: "TRAVEL", posted_at: "2026-01-01T00:00:00Z" });
    ids.d = await insertTx(connId, LOCAL_USER, `${TOKEN}d`, { amount: 200, category: "INCOME", posted_at: "2026-01-04T00:00:00Z" });
    ids.tomb = await insertTx(connId, LOCAL_USER, `${TOKEN}tomb`, {
      amount: -999,
      category: "FOOD_AND_DRINK",
      posted_at: "2026-01-05T00:00:00Z",
      deleted_at: "2026-01-06T00:00:00Z",
    });

    // Second user with a row that ALSO matches the TOKEN filter — must never appear for the operator.
    u2Id = (await pool.query(`insert into users (label) values ('datatest-u2') returning id`)).rows[0].id as string;
    u2CredId = (
      await pool.query(
        `insert into provider_credentials (user_id, provider, custody, status)
         values ($1, 'fake_dataread_u2', 'static_token', 'active') returning id`,
        [u2Id],
      )
    ).rows[0].id as string;
    u2ConnId = (
      await pool.query(
        `insert into connectors (user_id, credential_id, sector, provider, status)
         values ($1, $2, 'finance', 'fake_dataread_u2', 'active') returning id`,
        [u2Id, u2CredId],
      )
    ).rows[0].id as string;
    ids.other = await insertTx(u2ConnId, u2Id, `${TOKEN}other`, { amount: -7, category: "FOOD_AND_DRINK", posted_at: "2026-01-06T00:00:00Z" });
  });

  afterAll(async () => {
    const pool = await db();
    // FK cascade: credential -> connectors -> finance_transactions. Then U2 has no refs left.
    await pool.query(`delete from provider_credentials where id = any($1)`, [[credId, u2CredId]]);
    await pool.query(`delete from users where id = $1`, [u2Id]);
    await pool.end();
  });

  // ── POST list: filter / sort / limit-offset / aggregation; tombstone + user scoping ──
  it("list returns the operator's live rows (tombstone excluded; another user's rows excluded)", async () => {
    const { ctx, captured } = ctxFor({ sector: "finance.transaction" }, headerReq());
    await postDataQuery(ctx, { where: { source_object_id: { contains: TOKEN } } });
    expect(captured.status).toBe(200);
    const out = parseBody(captured) as { count: number; rows: { source_object_id: string }[] };
    const soids = out.rows.map((r) => r.source_object_id).sort();
    expect(soids).toEqual([`${TOKEN}a`, `${TOKEN}b`, `${TOKEN}c`, `${TOKEN}d`]);
    expect(out.count).toBe(4);
    expect(soids).not.toContain(`${TOKEN}tomb`); // tombstone excluded from the list
    expect(soids).not.toContain(`${TOKEN}other`); // another user's row never reachable
  });

  it("filter: where amount < 0 returns only the spending rows", async () => {
    const { ctx, captured } = ctxFor({ sector: "finance.transaction" }, headerReq());
    await postDataQuery(ctx, { where: { source_object_id: { contains: TOKEN }, amount: { lt: 0 } } });
    const out = parseBody(captured) as { count: number; rows: { source_object_id: string }[] };
    expect(out.rows.map((r) => r.source_object_id).sort()).toEqual([`${TOKEN}a`, `${TOKEN}b`, `${TOKEN}c`]);
    expect(out.count).toBe(3);
  });

  it("sort + limit/offset: orderBy amount asc, offset 1 limit 2 returns the middle window", async () => {
    const { ctx, captured } = ctxFor({ sector: "finance.transaction" }, headerReq());
    await postDataQuery(ctx, {
      where: { source_object_id: { contains: TOKEN } },
      orderBy: [{ field: "amount", dir: "asc" }],
      offset: 1,
      limit: 2,
    });
    const out = parseBody(captured) as { rows: { source_object_id: string; amount: string }[] };
    // amount asc over {c:-100, a:-50, b:-20, d:200}; offset 1 limit 2 -> [a, b].
    expect(out.rows.map((r) => r.source_object_id)).toEqual([`${TOKEN}a`, `${TOKEN}b`]);
    expect(out.rows[0].amount).toBe("-50"); // numeric returns a precision-safe string
  });

  it("aggregation: sum(amount) grouped by category (tombstone excluded from the sums)", async () => {
    const { ctx, captured } = ctxFor({ sector: "finance.transaction" }, headerReq());
    await postDataQuery(ctx, {
      where: { source_object_id: { contains: TOKEN } },
      aggregate: { fn: "sum", field: "amount", groupBy: ["category"] },
    });
    const out = parseBody(captured) as {
      aggregate: { fn: string; field: string };
      count: number;
      groups: { group: { category: string }; value: string }[];
    };
    expect(out.aggregate).toEqual({ fn: "sum", field: "amount" });
    expect(out.count).toBe(3);
    const byCat = Object.fromEntries(out.groups.map((g) => [g.group.category, g.value]));
    expect(byCat["FOOD_AND_DRINK"]).toBe("-70"); // -50 + -20; the -999 tombstone is excluded
    expect(byCat["TRAVEL"]).toBe("-100");
    expect(byCat["INCOME"]).toBe("200");
  });

  it("aggregation: count over the scoped set", async () => {
    const { ctx, captured } = ctxFor({ sector: "finance.transaction" }, headerReq());
    await postDataQuery(ctx, { where: { source_object_id: { contains: TOKEN } }, aggregate: { fn: "count" } });
    const out = parseBody(captured) as { groups: { value: number }[] };
    expect(out.groups[0].value).toBe(4); // count -> JS number; tombstone excluded
  });

  // ── 400s: unknown sector / unknown field / bad op (QueryValidationError -> 400) ──
  it("unknown sector -> 400 (bare multi-object key and a bogus name alike)", async () => {
    for (const sector of ["finance", "totallybogus"]) {
      const { ctx } = ctxFor({ sector }, headerReq());
      const err = await caught(() => postDataQuery(ctx, {}));
      expect(err).toBeInstanceOf(QueryValidationError);
      expect(errorToStatus(err).status).toBe(400);
    }
  });

  it("unknown field in where -> 400", async () => {
    const { ctx } = ctxFor({ sector: "finance.transaction" }, headerReq());
    const err = await caught(() => postDataQuery(ctx, { where: { not_a_real_field: { eq: 1 } } }));
    expect(err).toBeInstanceOf(QueryValidationError);
    expect(errorToStatus(err).status).toBe(400);
  });

  it("bad operator -> 400", async () => {
    const { ctx } = ctxFor({ sector: "finance.transaction" }, headerReq());
    const err = await caught(() => postDataQuery(ctx, { where: { amount: { wat: 1 } } }));
    expect(err).toBeInstanceOf(QueryValidationError);
    expect(errorToStatus(err).status).toBe(400);
  });

  // ── GET drill: full row incl. raw; tombstone-truthful; absent -> 404; user-scoped ──
  it("drill returns the FULL row incl. raw (live row)", async () => {
    const { ctx, captured } = ctxFor({ sector: "finance.transaction", id: ids.a }, headerReq());
    await getDataRecord(ctx);
    expect(captured.status).toBe(200);
    const out = parseBody(captured) as { record: Record<string, unknown> };
    const rec = out.record;
    expect(rec.id).toBe(ids.a);
    expect(rec.source_object_id).toBe(`${TOKEN}a`);
    expect(rec.user_id).toBe(LOCAL_USER);
    expect(rec.connection_id).toBe(connId); // full row, not a projection
    expect(rec.deleted_at).toBeNull();
    expect(rec.raw).toEqual({ sentinel: `${TOKEN}a`, note: "raw-payload" }); // raw jsonb present
  });

  it("drill is tombstone-truthful: a tombstoned row IS returned with deleted_at set", async () => {
    const { ctx, captured } = ctxFor({ sector: "finance.transaction", id: ids.tomb }, headerReq());
    await getDataRecord(ctx);
    expect(captured.status).toBe(200);
    const out = parseBody(captured) as { record: { source_object_id: string; deleted_at: string | null } };
    expect(out.record.source_object_id).toBe(`${TOKEN}tomb`);
    expect(out.record.deleted_at).not.toBeNull();
  });

  it("absent id -> 404 (NotFoundError)", async () => {
    const { ctx } = ctxFor({ sector: "finance.transaction", id: randomUUID() }, headerReq());
    const err = await caught(() => getDataRecord(ctx));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(errorToStatus(err).status).toBe(404);
  });

  it("drill is user_id-scoped: another user's row is unreachable -> 404", async () => {
    const { ctx } = ctxFor({ sector: "finance.transaction", id: ids.other }, headerReq());
    const err = await caught(() => getDataRecord(ctx));
    expect(err).toBeInstanceOf(NotFoundError); // exists, but owned by U2 -> null -> 404 (no cross-user reach)
    expect(errorToStatus(err).status).toBe(404);
  });

  it("drill: unknown sector -> 400", async () => {
    const { ctx } = ctxFor({ sector: "finance", id: randomUUID() }, headerReq());
    const err = await caught(() => getDataRecord(ctx));
    expect(err).toBeInstanceOf(QueryValidationError);
    expect(errorToStatus(err).status).toBe(400);
  });

  // ── localOnly: non-loopback Host -> 403; loopback passes (NO bearer required) ──
  it("both wrapped routes reject a non-loopback Host -> 403 (localOnly throws before any work)", async () => {
    const q = ctxFor({ sector: "finance.transaction" }, headerReq("evil.com"));
    const qErr = await caught(() => dataQueryRoute(q.ctx)); // localOnly throws SYNCHRONOUSLY
    expect(qErr).toBeInstanceOf(ForbiddenHostError);
    expect(errorToStatus(qErr).status).toBe(403);

    const g = ctxFor({ sector: "finance.transaction", id: ids.a }, headerReq("evil.com"));
    const gErr = await caught(() => dataRecordRoute(g.ctx));
    expect(gErr).toBeInstanceOf(ForbiddenHostError);
    expect(errorToStatus(gErr).status).toBe(403);
  });

  it("wrapped routes pass on loopback with NO bearer (operator path, end-to-end)", async () => {
    // GET drill through localOnly.
    const g = ctxFor({ sector: "finance.transaction", id: ids.c }, headerReq("127.0.0.1"));
    await dataRecordRoute(g.ctx);
    expect(g.captured.status).toBe(200);
    expect((parseBody(g.captured) as { record: { source_object_id: string } }).record.source_object_id).toBe(`${TOKEN}c`);

    // POST list through localOnly — dataQueryRoute reads the body off the stream itself.
    const body = JSON.stringify({ where: { source_object_id: { contains: TOKEN } }, limit: 1 });
    const q = ctxFor({ sector: "finance.transaction" }, streamReq(body, "127.0.0.1"));
    await dataQueryRoute(q.ctx);
    expect(q.captured.status).toBe(200);
    expect((parseBody(q.captured) as { rows: unknown[] }).rows.length).toBe(1);
  });

  // ── includeShadowed (finance-dedup-trust-batch): the inspector accepts the drill-through key ──
  it("includeShadowed: the operator inspector serves winner + shadow with the linkage columns (end-to-end)", async () => {
    const pool = await db();
    // Shadow a fresh row behind ids.a (the linkage FK target must be a real finance_transactions id).
    const shadowId = await insertTx(connId, LOCAL_USER, `${TOKEN}shadow`, {
      amount: -50,
      category: "FOOD_AND_DRINK",
      posted_at: "2026-01-03T00:00:00Z",
    });
    await pool.query(`update finance_transactions set shadowed_by_id = $2, dedup_status = 'shadow' where id = $1`, [
      shadowId,
      ids.a,
    ]);
    try {
      // Default list: the shadow stays hidden (the served fold is unchanged by the feature).
      const folded = ctxFor({ sector: "finance.transaction" }, headerReq());
      await postDataQuery(folded.ctx, { where: { source_object_id: { contains: TOKEN } } });
      const foldedOut = parseBody(folded.captured) as { count: number; rows: Array<Record<string, unknown>> };
      expect(foldedOut.count).toBe(4);
      expect(foldedOut.rows[0]).not.toHaveProperty("shadowed_by_id");

      // Drill-through (via the wrapped route — the FULL edge: localOnly + body parse + core).
      const body = JSON.stringify({ where: { source_object_id: { contains: TOKEN } }, includeShadowed: true });
      const q = ctxFor({ sector: "finance.transaction" }, streamReq(body, "127.0.0.1"));
      await dataQueryRoute(q.ctx);
      expect(q.captured.status).toBe(200);
      const out = parseBody(q.captured) as { count: number; rows: Array<Record<string, unknown>> };
      expect(out.count).toBe(5); // the shadow is now served alongside the reals
      const shadow = out.rows.find((r) => r.source_object_id === `${TOKEN}shadow`);
      expect(shadow!.shadowed_by_id).toBe(ids.a); // linkage column populated, read-only
      expect(shadow!).not.toHaveProperty("dedup_group_id"); // finance_transactions has no such column
    } finally {
      await pool.query(`delete from finance_transactions where id = $1`, [shadowId]);
    }
  });

  // ── provenance (#65/#122): the inspector list answers "which connection is this row from?" without
  //    the client having to ask, because that question is why this surface exists ──
  it("rows mode carries __provenance by DEFAULT — the client never has to ask", async () => {
    const { ctx, captured } = ctxFor({ sector: "finance.transaction" }, headerReq());
    await postDataQuery(ctx, { where: { source_object_id: { contains: TOKEN } } });
    expect(captured.status).toBe(200);
    const out = parseBody(captured) as { count: number; rows: Array<Record<string, unknown>> };
    expect(out.count).toBe(4);
    for (const row of out.rows) {
      expect(row.__provenance).toEqual({ connection_id: connId, provider: "fake_dataread", merged: false });
      expect(row).not.toHaveProperty("__pci_conn"); // internal alias never on the wire
      expect(row).not.toHaveProperty("connection_id"); // and never as a REGISTRY-looking column
    }
  });

  it("provenance survives the FULL edge (localOnly + body parse + core), select and all", async () => {
    const body = JSON.stringify({
      where: { source_object_id: { contains: TOKEN } },
      select: ["source_object_id"],
      limit: 1,
    });
    const q = ctxFor({ sector: "finance.transaction" }, streamReq(body, "127.0.0.1"));
    await dataQueryRoute(q.ctx);
    expect(q.captured.status).toBe(200);
    const row = (parseBody(q.captured) as { rows: Array<Record<string, unknown>> }).rows[0];
    // A narrow select does not opt out: provenance rides alongside whatever was projected.
    expect(Object.keys(row).sort()).toEqual(["__provenance", "source_object_id"]);
    expect((row.__provenance as { provider: string }).provider).toBe("fake_dataread");
  });

  it("AGGREGATE requests still succeed — the default must never inject the param core rejects", async () => {
    // The trap in defaulting a rows-only param at the route: injecting it unconditionally would turn
    // every existing aggregate request from this inspector into a 400.
    const { ctx, captured } = ctxFor({ sector: "finance.transaction" }, headerReq());
    await postDataQuery(ctx, {
      where: { source_object_id: { contains: TOKEN } },
      aggregate: { fn: "sum", field: "amount", groupBy: ["category"] },
    });
    expect(captured.status).toBe(200);
    const out = parseBody(captured) as { count: number; groups: unknown[] };
    expect(out.count).toBe(3);
    expect(out.groups).toHaveLength(3);
  });

  it("an explicit includeProvenance: false opts a rows read out (the default is a default, not a floor)", async () => {
    const { ctx, captured } = ctxFor({ sector: "finance.transaction" }, headerReq());
    await postDataQuery(ctx, { where: { source_object_id: { contains: TOKEN } }, includeProvenance: false });
    const out = parseBody(captured) as { rows: Array<Record<string, unknown>> };
    expect(out.rows.length).toBe(4);
    for (const row of out.rows) expect(row).not.toHaveProperty("__provenance");
  });

  it("an EXPLICIT includeProvenance with an aggregate is still the typed 400 naming the field", async () => {
    const { ctx } = ctxFor({ sector: "finance.transaction" }, headerReq());
    const err = await caught(() =>
      postDataQuery(ctx, { aggregate: { fn: "count" }, includeProvenance: true }),
    );
    expect(err).toBeInstanceOf(QueryValidationError);
    expect(errorToStatus(err).status).toBe(400);
    expect(String((err as Error).message)).toContain("includeProvenance");
  });

  it("connection_id is served, NOT accepted: it is still rejected as a filter/sort/select key -> 400", async () => {
    for (const body of [
      { where: { connection_id: connId } },
      { orderBy: [{ field: "connection_id" }] },
      { select: ["connection_id"] },
      { aggregate: { fn: "count", groupBy: ["connection_id"] } },
    ]) {
      const { ctx } = ctxFor({ sector: "finance.transaction" }, headerReq());
      const err = await caught(() => postDataQuery(ctx, body));
      expect(err, JSON.stringify(body)).toBeInstanceOf(QueryValidationError);
      expect(errorToStatus(err).status).toBe(400);
      expect(String((err as Error).message)).toContain("connection_id");
    }
  });

  it("includeShadowed on a non-dedup sector -> 400 naming the field (typed, never a silent no-op)", async () => {
    const { ctx } = ctxFor({ sector: "home" }, headerReq());
    const err = await caught(() => postDataQuery(ctx, { includeShadowed: true }));
    expect(err).toBeInstanceOf(QueryValidationError);
    expect(errorToStatus(err).status).toBe(400);
    expect(String((err as Error).message)).toContain("includeShadowed");
  });
});

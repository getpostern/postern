// GET /api/audit — the sector filter and the keyset pager (#61), against a real Postgres.
//
// WHY THE FIXTURE LOOKS LIKE THIS. Every row it inserts exists to make one specific wrong
// implementation fail:
//   - rows in THREE sectors plus one with a NULL sector, so a missing `sector` clause cannot pass by
//     accident (an unfiltered read returns all of them);
//   - THREE rows sharing ONE created_at to the microsecond — the shape the batch writer actually
//     produces — positioned so a page boundary lands INSIDE that group, so a cursor that carries only
//     `created_at` silently drops the rest of the batch;
//   - TWO rows inside one millisecond but at different microseconds, so a cursor rebuilt from the
//     served (millisecond-truncated) value provably loses the one between the two;
//   - a row inserted DURING pagination, so an OFFSET pager provably repeats a row.
//
// Every query below also passes `agent=<this fixture's agent>`. That is deliberate isolation: the
// throwaway test database is shared with whatever else runs in the same session, and a `delete from
// audit_log where user_id = …` in a beforeEach could break a sibling suite mid-assertion. Filtering
// instead of truncating keeps the fixture exact AND makes every paging assertion double as proof that
// the cursor composes with a filter rather than replacing it.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { RouteContext } from "./router.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001";
const AGENT = "test-audit-cursor-agent";

/** A capturing fake ServerResponse (the admin.db.test.ts pattern; headers are load-bearing here). */
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
    get headers() {
      return headers;
    },
  };
}

interface Page {
  status: number;
  rows: Array<Record<string, unknown>>;
  hasMore: string | undefined;
  next: string | undefined;
}

/** Call getAudit with `agent` pinned to this fixture plus whatever extra params the test names. */
async function page(extra: Record<string, string> = {}): Promise<Page> {
  const { getAudit } = await import("./admin.js");
  const q = new URLSearchParams({ agent: AGENT, ...extra });
  const r = fakeRes();
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { host: "127.0.0.1:8787" };
  const ctx: RouteContext = { req, res: r.res, params: {}, query: q };
  await getAudit(ctx);
  return {
    status: r.status,
    rows: JSON.parse(r.body),
    hasMore: r.headers["x-postern-audit-has-more"],
    next: r.headers["x-postern-audit-next"],
  };
}

/** getAudit is expected to throw: return the error instead of the page. */
async function pageErr(extra: Record<string, string>): Promise<Error> {
  return page(extra).then(
    () => {
      throw new Error(`expected a ValidationError for ${JSON.stringify(extra)}`);
    },
    (e: Error) => e,
  );
}

// ── The fixture, oldest → newest. Insert order fixes the bigserial ids, so id ASCENDS with
//    created_at and the (created_at desc, id desc) order below is fully determined.
const BATCH_TS = "2026-03-01T00:00:02.000002Z"; // three rows share this instant, like a real flush
/** d2 and d sit inside ONE millisecond. A millisecond-precision cursor cannot tell them apart. */
const MICRO_LOW = "2026-03-01T00:00:04.123200Z";
const MICRO_HIGH = "2026-03-01T00:00:04.123456Z";
const FIXTURE: Array<{
  key: string;
  ts: string;
  sector: string | null;
  tool: string;
  decision: "allow" | "deny";
}> = [
  { key: "a", ts: "2026-03-01T00:00:01.000000Z", sector: "finance", tool: "query", decision: "allow" },
  { key: "b1", ts: BATCH_TS, sector: "health", tool: "query", decision: "allow" },
  { key: "b2", ts: BATCH_TS, sector: "finance", tool: "query", decision: "allow" },
  { key: "b3", ts: BATCH_TS, sector: "mail", tool: "get_record", decision: "deny" },
  { key: "c", ts: "2026-03-01T00:00:03.500000Z", sector: null, tool: "get_schema", decision: "allow" },
  { key: "d2", ts: MICRO_LOW, sector: "finance", tool: "query", decision: "allow" },
  { key: "d", ts: MICRO_HIGH, sector: "finance", tool: "query", decision: "allow" },
  { key: "e", ts: "2026-03-01T00:00:06.000001Z", sector: "mail", tool: "invoke_action", decision: "allow" },
];
/** Newest-first, i.e. exactly what `order by created_at desc, id desc` must produce. */
const NEWEST_FIRST = ["e", "d", "d2", "c", "b3", "b2", "b1", "a"];

/** fixture key → the row's audit_log.id (as served: pg renders bigint as a string). */
let ids: Record<string, string> = {};

async function seed() {
  const { pool } = await import("../db.js");
  await pool.query(`delete from audit_log where user_id = $1 and agent_id = $2`, [LOCAL_USER, AGENT]);
  ids = {};
  for (const row of FIXTURE) {
    const res = await pool.query(
      `insert into audit_log (user_id, agent_id, tool, sector, decision, result_count, created_at)
       values ($1, $2, $3, $4, $5, 1, $6::timestamptz) returning id`,
      [LOCAL_USER, AGENT, row.tool, row.sector, row.decision, row.ts],
    );
    ids[row.key] = String(res.rows[0].id);
  }
}

/** Which fixture rows a page holds, by key, in served order. */
function keysOf(rows: Array<Record<string, unknown>>): string[] {
  const byId = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
  return rows.map((r) => byId.get(String(r.id)) ?? `?${String(r.id)}`);
}

/** Walk the whole pager, following the served cursor, and return every key it yielded. */
async function walkAll(limit: number, extra: Record<string, string> = {}): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const p: Page = await page({ ...extra, limit: String(limit), ...(cursor ? { before: cursor } : {}) });
    seen.push(...keysOf(p.rows));
    if (p.hasMore !== "true") {
      expect(p.next).toBeUndefined(); // end-of-history serves no cursor to nowhere
      return seen;
    }
    expect(p.next).toBeTruthy();
    cursor = p.next;
  }
  throw new Error("pager did not terminate in 50 pages — it is looping, not advancing");
}

describe.skipIf(!HAS_DB)("GET /api/audit — sector filter + keyset pager (DB)", () => {
  beforeAll(seed);
  beforeEach(seed);
  afterAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(`delete from audit_log where user_id = $1 and agent_id = $2`, [LOCAL_USER, AGENT]);
    await pool.end();
  });

  // ── #61 part 1 — the sector filter ────────────────────────────────────────────────────────────

  it("sector= filters on the dedicated column: only that sector's rows, NULL-sector rows excluded", async () => {
    const all = await page({ limit: "100" });
    expect(keysOf(all.rows)).toEqual(NEWEST_FIRST); // the fixture really does span sectors + null

    const finance = await page({ sector: "finance", limit: "100" });
    expect(finance.status).toBe(200);
    expect(keysOf(finance.rows)).toEqual(["d", "d2", "b2", "a"]);
    expect(finance.rows.every((r) => r.sector === "finance")).toBe(true);

    const mail = await page({ sector: "mail", limit: "100" });
    expect(keysOf(mail.rows)).toEqual(["e", "b3"]);

    // The gateway-wide verbs (sector NULL) belong to no sector and must not leak into one.
    const health = await page({ sector: "health", limit: "100" });
    expect(keysOf(health.rows)).toEqual(["b1"]);
    expect(keysOf(finance.rows)).not.toContain("c");
    expect(keysOf(mail.rows)).not.toContain("c");
  });

  it("an unknown sector is an empty page, not a 400 — the ledger is history, not a registry", async () => {
    const p = await page({ sector: "no-such-sector-ever", limit: "100" });
    expect(p.status).toBe(200);
    expect(p.rows).toEqual([]);
    expect(p.hasMore).toBe("false");
  });

  it("the pre-existing filters still work alongside it (tool, decision, since)", async () => {
    expect(keysOf((await page({ tool: "query", limit: "100" })).rows)).toEqual(["d", "d2", "b2", "b1", "a"]);
    expect(keysOf((await page({ decision: "deny", limit: "100" })).rows)).toEqual(["b3"]);
    const since = await page({ since: "2026-03-01T00:00:03.000000Z", limit: "100" });
    expect(keysOf(since.rows)).toEqual(["e", "d", "d2", "c"]);
  });

  // ── SQL-adjacency — a filter VALUE can only ever be a bind parameter ───────────────────────────

  it("an attacker-supplied filter value reaches SQL as a PARAMETER only: no clause escape, no drop", async () => {
    const { pool } = await import("../db.js");
    // `' or 1=1 --` is the payload that WORKS under the extended protocol if a value is interpolated:
    // it is one statement, and it would widen the sector clause to every row this agent has.
    for (const field of ["sector", "tool", "decision", "agent"] as const) {
      for (const payload of [
        "' or 1=1 --",
        "x' or '1'='1",
        "finance'; drop table audit_log; --",
        "%",
        "_",
      ]) {
        const p = await page({ limit: "100", [field]: payload });
        // Not "some rows" — ZERO. A parameter matches nothing here, and `%`/`_` prove the value is not
        // being fed to LIKE either.
        expect(p.rows, `${field}=${payload} must match nothing`).toEqual([]);
      }
    }
    // The table is intact and the fixture is untouched: nothing executed but a SELECT.
    const reg = await pool.query(`select to_regclass('audit_log') as t`);
    expect(reg.rows[0].t).toBe("audit_log");
    expect(keysOf((await page({ limit: "100" })).rows)).toEqual(NEWEST_FIRST);
  });

  it("a cursor that is not the server's own is REFUSED, injection payloads included", async () => {
    for (const bad of [
      "' or 1=1 --",
      "2026-03-01T00:00:04.123456Z'; drop table audit_log; --",
      "2026-03-01T00:00:04.123456Z", // no id half — the shape that silently drops a batch
      "42", // id half only
      "2026-03-01T00:00:04.123Z|7", // millisecond precision: not what the server minted
      "2026-03-01T00:00:04.123456Z|", // empty id
      "2026-03-01T00:00:04.123456Z|-1",
      "2026-03-01T00:00:04.123456Z|9999999999999999999", // past 2^63-1: would be a 500 on the cast
      "not-a-time|1",
    ]) {
      const err = await pageErr({ before: bad, limit: "2" });
      expect(err.name, `cursor ${bad}`).toBe("ValidationError");
      expect(err.message).toContain("before");
    }
    const { pool } = await import("../db.js");
    expect((await pool.query(`select to_regclass('audit_log') as t`)).rows[0].t).toBe("audit_log");
  });

  // ── #61 part 2 — the cursor ───────────────────────────────────────────────────────────────────

  it("paging the whole ledger yields EVERY row EXACTLY once, in order, across a batch boundary", async () => {
    // limit 2 over 8 rows puts a page boundary between b2 and b1 — INSIDE the three rows that share
    // one microsecond. A created_at-only cursor loses b1 here (with `<`) or repeats the batch (`<=`).
    const walked = await walkAll(2);
    expect(walked).toEqual(NEWEST_FIRST);
    expect(new Set(walked).size).toBe(walked.length); // no row served twice

    // Same answer at every page size — the pager is not an artefact of one limit, and each size lands
    // the boundary somewhere else in the batch.
    for (const limit of [1, 3, 4, 5, 6, 7, 8]) {
      expect(await walkAll(limit), `limit ${limit}`).toEqual(NEWEST_FIRST);
    }
  });

  it("a row landing mid-pagination cannot skip or repeat one — this is where OFFSET fails", async () => {
    const { pool } = await import("../db.js");
    const first = await page({ limit: "2" });
    expect(keysOf(first.rows)).toEqual(["e", "d"]);
    expect(first.hasMore).toBe("true");

    // The fire-and-forget writer flushes while the operator reads: a NEWER row lands at the head.
    const inserted = await pool.query(
      `insert into audit_log (user_id, agent_id, tool, sector, decision, created_at)
       values ($1, $2, 'query', 'finance', 'allow', '2026-03-01T00:00:09.000000Z'::timestamptz) returning id`,
      [LOCAL_USER, AGENT],
    );
    ids["z"] = String(inserted.rows[0].id);

    const second = await page({ limit: "2", before: first.next! });
    // OFFSET 2 would answer ["d","d2"] here — d repeated, because the window shifted by one row.
    expect(keysOf(second.rows)).toEqual(["d2", "c"]);
    expect(keysOf(second.rows)).not.toContain("z"); // and the new row is not smuggled into the past

    // The rest of the walk still completes, still exactly once each.
    const rest: string[] = [...keysOf(first.rows), ...keysOf(second.rows)];
    let cursor = second.next;
    while (cursor) {
      const p = await page({ limit: "2", before: cursor });
      rest.push(...keysOf(p.rows));
      cursor = p.hasMore === "true" ? p.next : undefined;
    }
    expect(rest).toEqual(NEWEST_FIRST);
  });

  it("the cursor is SERVER-MINTED because the served created_at is millisecond-truncated", async () => {
    // Page down to the microsecond row so the cursor is minted from it.
    const p = await page({ limit: "2" });
    expect(keysOf(p.rows)).toEqual(["e", "d"]);

    // What the wire carries for d has lost the microseconds (node-postgres → JS Date → JSON).
    const served = String(p.rows[1].created_at);
    expect(served).not.toContain("123456");
    expect(served).toContain("04.123");
    // What the header carries has not.
    expect(p.next).toBe(`${MICRO_HIGH}|${ids["d"]}`);

    // The server's own cursor advances by exactly one row: d2 is next.
    const correct = await page({ limit: "2", before: p.next! });
    expect(keysOf(correct.rows)).toEqual(["d2", "c"]);

    // A client that rebuilt the cursor from the wire value would anchor at .123000 — up to 999µs
    // BEFORE the row it was standing on — and everything inside that window VANISHES. d2 is in it.
    // This is the failure the header exists to prevent, demonstrated rather than asserted about.
    const rebuilt = await page({ limit: "2", before: `2026-03-01T00:00:04.123000Z|${ids["d"]}` });
    expect(keysOf(rebuilt.rows)).not.toContain("d2");
    expect(keysOf(rebuilt.rows)).toEqual(["c", "b3"]);
  });

  it("has_more comes from the probe row, so an exactly-full FINAL page reports end-of-history", async () => {
    // 8 rows, limit 8: full page AND nothing beyond it. `count === limit` would claim there is more
    // and hand out a cursor to an empty page.
    const exact = await page({ limit: String(NEWEST_FIRST.length) });
    expect(keysOf(exact.rows)).toEqual(NEWEST_FIRST);
    expect(exact.hasMore).toBe("false");
    expect(exact.next).toBeUndefined();

    // One fewer, and there genuinely is more.
    const short = await page({ limit: String(NEWEST_FIRST.length - 1) });
    expect(short.rows).toHaveLength(NEWEST_FIRST.length - 1);
    expect(short.hasMore).toBe("true");
    expect(short.next).toBeTruthy();
    const last = await page({ limit: String(NEWEST_FIRST.length - 1), before: short.next! });
    expect(keysOf(last.rows)).toEqual(["a"]);
    expect(last.hasMore).toBe("false");

    // An empty result still states the capability, so "no cursor" can only mean end-of-history.
    const none = await page({ sector: "nothing-here" });
    expect(none.hasMore).toBe("false");
  });

  it("the cursor composes with a filter instead of replacing it (sector-scoped paging is complete)", async () => {
    expect(await walkAll(1, { sector: "finance" })).toEqual(["d", "d2", "b2", "a"]);
    expect(await walkAll(2, { sector: "mail" })).toEqual(["e", "b3"]);
    // …and with `since`, whose floor must survive every page.
    expect(await walkAll(1, { since: "2026-03-01T00:00:03.000000Z" })).toEqual(["e", "d", "d2", "c"]);
  });

  it("the served row shape is unchanged: the 11 documented fields and no paging internals", async () => {
    const p = await page({ limit: "1" });
    expect(Object.keys(p.rows[0])).toEqual([
      "id",
      "agent_id",
      "tool",
      "sector",
      "decision",
      "deny_reason",
      "args",
      "result_count",
      "outcome",
      "request_id",
      "created_at",
    ]);
    expect(JSON.stringify(p.rows)).not.toContain("cursor_ts");
  });

  it("the cursor survives a REAL http round trip — headers and query encoding, not a fake res", async () => {
    // Everything above talks to a hand-written fake ServerResponse whose writeHead merges what
    // setHeader put there. If real Node did NOT merge, the entire paging contract would be dead on the
    // wire and every assertion above would still be green — the shape of defect this repo keeps
    // catching. So: one real socket, and the cursor goes out and comes back through a real query
    // string (the `|` separator has to survive percent-encoding both ways).
    const { getAudit } = await import("./admin.js");
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const ctx: RouteContext = { req, res, params: {}, query: url.searchParams };
      void getAudit(ctx).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const url = (qs: string) => `http://127.0.0.1:${port}/api/audit?agent=${encodeURIComponent(AGENT)}&${qs}`;

      const first = await fetch(url("limit=2"));
      expect(first.status).toBe(200);
      expect(first.headers.get("content-type")).toBe("application/json");
      expect(first.headers.get("x-postern-audit-has-more")).toBe("true");
      const cursor = first.headers.get("x-postern-audit-next");
      expect(cursor).toBe(`${MICRO_HIGH}|${ids["d"]}`);
      expect(keysOf((await first.json()) as Array<Record<string, unknown>>)).toEqual(["e", "d"]);

      const second = await fetch(url(`limit=2&before=${encodeURIComponent(cursor!)}`));
      expect(second.status).toBe(200);
      expect(keysOf((await second.json()) as Array<Record<string, unknown>>)).toEqual(["d2", "c"]);

      // End of history over the wire: has-more false, no cursor to nowhere.
      const last = await fetch(url(`limit=${NEWEST_FIRST.length}`));
      expect(last.headers.get("x-postern-audit-has-more")).toBe("false");
      expect(last.headers.get("x-postern-audit-next")).toBeNull();
      await last.json();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("limit is still validated and still capped, and the probe row never reaches the wire", async () => {
    const { AUDIT_LIMIT_MAX } = await import("./admin.js");
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      const err = await pageErr({ limit: bad });
      expect(err.name).toBe("ValidationError");
      expect(err.message).toContain("limit");
    }
    // Over the ceiling is capped, not rejected — and a page never serves limit+1 rows.
    const p = await page({ limit: String(AUDIT_LIMIT_MAX + 5000) });
    expect(p.rows.length).toBeLessThanOrEqual(AUDIT_LIMIT_MAX);
    expect(keysOf(p.rows)).toEqual(NEWEST_FIRST);
    expect((await page({ limit: "1" })).rows).toHaveLength(1);
  });
});

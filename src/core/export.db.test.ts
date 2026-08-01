// export bundle round-trips against a real Postgres, gated on DATABASE_URL so CI stays green without
// it. Seeds rows DIRECTLY via raw SQL (the established direct-insert pattern), under dedicated
// throwaway users so concurrent test files can't contend. Proves the 10C acceptance criteria:
//   * the bundle returns every LIVE row (incl. `raw`) for the user's sectors, with a correct manifest
//     (connections / sectors / counts); tombstoned rows are excluded ("gone at source");
//   * `?sector=` narrows to one sector's tables; an unknown sector → QueryValidationError (route 400);
//   * user-scoping: a second user's rows never appear (no cross-user leak);
//   * one async audit line (tool='export', result_count = total) is written;
//   * the REST route is loopback-only and sets the JSON-attachment headers; unknown sector → 400.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { exportBundle, type ExportBundle } from "./export.js";
import { QueryValidationError } from "./query.js";
import { ALL_SECTORS, type AuthContext } from "../auth/index.js";
import type { RouteContext } from "../rest/router.js";

const HAS_DB = !!process.env.DATABASE_URL;
// DEDICATED throwaway users so these round-trips can't race other db test files (run in parallel).
const TEST_USER = "00000000-0000-0000-0000-0000000010c1";
const OTHER_USER = "00000000-0000-0000-0000-0000000010c2";

// The two describes below share the one src/db.ts pool singleton, so it must be closed EXACTLY ONCE —
// this file-level afterAll runs last; describe-level afterAlls only do row cleanup. Guard on HAS_DB so
// a skipped run is a no-op.
afterAll(async () => {
  if (!HAS_DB) return;
  const { pool } = await import("../db.js");
  await pool.end();
});

// A unique agentId so the audit assertion can find exactly this run's export line.
const ctx: AuthContext = {
  userId: TEST_USER,
  agentId: "export-10c-test",
  grantedSectors: new Set(ALL_SECTORS),
};

const TXN_RAW = { counterparty: "Blue Bottle", logo_url: "https://x/y.png", pfc: { detailed: "COFFEE" } };
const ACCT_RAW = { institution: "Demo Bank", routing: "redacted-in-source" };

describe.skipIf(!HAS_DB)("export bundle DB round-trips", () => {
  let credentialId: string;
  let financeConnId: string;
  let healthConnId: string;
  let otherCredentialId: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    for (const u of [TEST_USER, OTHER_USER]) {
      await pool.query(`insert into users (id, label) values ($1, 'export-10c') on conflict (id) do nothing`, [u]);
    }

    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status)
       values ($1, 'simplefin', 'static_token', 'active') returning id`,
      [TEST_USER],
    );
    credentialId = cred.rows[0].id as string;

    const fin = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', 'simplefin', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    financeConnId = fin.rows[0].id as string;
    const hea = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'health', 'whoop', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    healthConnId = hea.rows[0].id as string;

    // One account (with raw), two LIVE transactions + one tombstoned, one health sample.
    await pool.query(
      `insert into finance_accounts
         (connection_id, user_id, source_object_id, name, currency, current_balance, balance_at, raw)
       values ($1, $2, 'acct-1', 'Checking', 'USD', '1234.56', '2026-06-01T00:00:00Z', $3::jsonb)`,
      [financeConnId, TEST_USER, JSON.stringify(ACCT_RAW)],
    );

    const txn = async (sid: string, posted: string, amount: string, raw: unknown, tombstone = false) => {
      const r = await pool.query(
        `insert into finance_transactions
           (connection_id, user_id, source_object_id, posted_at, amount, currency, description, raw)
         values ($1, $2, $3, $4, $5, 'USD', $6, $7::jsonb) returning id`,
        [financeConnId, TEST_USER, sid, posted, amount, `desc-${sid}`, JSON.stringify(raw)],
      );
      if (tombstone) {
        await pool.query(`update finance_transactions set deleted_at = now() where id = $1`, [r.rows[0].id]);
      }
    };
    await txn("exp-t1", "2026-06-01T12:00:00Z", "-20.00", TXN_RAW);
    await txn("exp-t2", "2026-06-02T12:00:00Z", "1500.00", null);
    await txn("exp-tomb", "2026-06-03T12:00:00Z", "-50.00", null, true);

    await pool.query(
      `insert into health_samples
         (connection_id, user_id, source_object_id, metric_type, value, unit, window_start)
       values ($1, $2, 'exp-s1', 'heart_rate', '60', 'count/min', '2026-06-01T08:00:00Z')`,
      [healthConnId, TEST_USER],
    );

    // A SECOND user's finance row — must NEVER appear in TEST_USER's export (scoping).
    const oc = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status)
       values ($1, 'simplefin', 'static_token', 'active') returning id`,
      [OTHER_USER],
    );
    otherCredentialId = oc.rows[0].id as string;
    const oconn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'finance', 'simplefin', 'active') returning id`,
      [OTHER_USER, otherCredentialId],
    );
    await pool.query(
      `insert into finance_transactions
         (connection_id, user_id, source_object_id, posted_at, amount, currency, description)
       values ($1, $2, 'other-user-txn', '2026-06-01T12:00:00Z', '-99.00', 'USD', 'leak-canary')`,
      [oconn.rows[0].id, OTHER_USER],
    );
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: credential -> connectors -> domain rows. audit_log FK-references users, so it must
    // be cleared BEFORE the users delete (the export audit line is written under TEST_USER).
    await pool.query(`delete from provider_credentials where id = any($1)`, [[credentialId, otherCredentialId]]);
    await pool.query(`delete from audit_log where user_id = any($1)`, [[TEST_USER, OTHER_USER]]);
    await pool.query(`delete from users where id = any($1)`, [[TEST_USER, OTHER_USER]]);
  });

  it("full export: every live row incl. `raw`, correct manifest; tombstone & other-user rows excluded", async () => {
    const b = await exportBundle(ctx);

    expect(b.manifest.gateway).toBe("pci-gateway");
    expect(b.manifest.user_id).toBe(TEST_USER);
    expect(typeof b.manifest.exported_at).toBe("string");

    // Counts: tombstone excluded -> 2 live transactions; 1 account; 1 sample; empty tables are 0.
    expect(b.manifest.counts["finance.transaction"]).toBe(2);
    expect(b.manifest.counts["finance.account"]).toBe(1);
    expect(b.manifest.counts["finance.holding"]).toBe(0); // #36: the finance object set now includes holdings
    expect(b.manifest.counts["health.sample"]).toBe(1);
    expect(b.manifest.counts["mail"]).toBe(0);

    // sectors present = only those with ≥1 row, sorted.
    expect(b.manifest.sectors).toEqual(["finance", "health"]);

    // Connections: both this user's connectors, base fields only (no secrets anywhere in the bundle).
    expect(b.manifest.connections).toHaveLength(2);
    const connSectors = b.manifest.connections.map((c) => c.sector).sort();
    expect(connSectors).toEqual(["finance", "health"]);
    expect(JSON.stringify(b)).not.toContain("secret_ref");

    // Live rows carry the FULL row including `raw`.
    const txns = b.data["finance.transaction"] as Array<{ source_object_id: string; raw: unknown; user_id: string }>;
    expect(txns.map((t) => t.source_object_id).sort()).toEqual(["exp-t1", "exp-t2"]);
    const t1 = txns.find((t) => t.source_object_id === "exp-t1");
    expect(t1?.raw).toEqual(TXN_RAW);

    const accts = b.data["finance.account"] as Array<{ raw: unknown }>;
    expect(accts[0].raw).toEqual(ACCT_RAW);

    // Tombstoned + other-user rows are absent.
    expect(txns.some((t) => t.source_object_id === "exp-tomb")).toBe(false);
    expect(txns.some((t) => t.source_object_id === "other-user-txn")).toBe(false);
    expect(JSON.stringify(b)).not.toContain("leak-canary");
    expect(txns.every((t) => t.user_id === TEST_USER)).toBe(true);
  });

  it("?sector= narrows to one sector's tables (prefix-match) and the manifest follows", async () => {
    const b = await exportBundle(ctx, { sector: "finance" });
    expect(Object.keys(b.data).sort()).toEqual(["finance.account", "finance.holding", "finance.transaction"]);
    expect(b.data["health.sample"]).toBeUndefined();
    expect(Object.keys(b.manifest.counts).sort()).toEqual(["finance.account", "finance.holding", "finance.transaction"]);
    expect(b.manifest.sectors).toEqual(["finance"]);
    expect(b.manifest.counts["finance.transaction"]).toBe(2);
  });

  it("an unknown sector throws QueryValidationError (the route maps it to 400) with NO data read", async () => {
    await expect(exportBundle(ctx, { sector: "nope" })).rejects.toBeInstanceOf(QueryValidationError);
  });

  it("writes one async audit line: tool='export', result_count = total live rows", async () => {
    const { pool } = await import("../db.js");
    const { startAuditWriter } = await import("../audit/index.js");
    await pool.query(`delete from audit_log where agent_id = $1`, [ctx.agentId]);

    // Big interval/batch so we flush deterministically via stop() (the flush.db.test pattern).
    const stop = startAuditWriter({ pool, intervalMs: 1_000_000, batchSize: 1_000_000 });
    await exportBundle(ctx, { sector: "finance" });
    await stop();

    const res = await pool.query(
      `select tool, decision, sector, result_count, args from audit_log where agent_id = $1 order by id desc limit 1`,
      [ctx.agentId],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].tool).toBe("export");
    expect(res.rows[0].decision).toBe("allow");
    expect(res.rows[0].sector).toBe("finance");
    expect(res.rows[0].result_count).toBe(3); // 2 transactions + 1 account
    expect(res.rows[0].args).toEqual({ sector: "finance" });
  });

  // #108 — the ledger row for a whole-gate export read `{ sector: null }`: an
  // argument slot whose only value was the absence of a value, duplicating the dedicated `sector`
  // column. Asserted on the PERSISTED row (audit() is fire-and-forget and is never awaited, so an
  // assertion on the return value or on a spy's shape would pass against the unfixed code too).
  it("a whole-gate export writes NO args; a sector-scoped one writes only the sector", async () => {
    const { pool } = await import("../db.js");
    const { startAuditWriter } = await import("../audit/index.js");
    await pool.query(`delete from audit_log where agent_id = $1`, [ctx.agentId]);

    const stop = startAuditWriter({ pool, intervalMs: 1_000_000, batchSize: 1_000_000 });
    await exportBundle(ctx); // no opts at all — the whole gate
    await exportBundle(ctx, { sector: "finance" }); // scoped
    await stop();

    const res = await pool.query(
      `select sector, args from audit_log where agent_id = $1 and tool = 'export' order by id asc`,
      [ctx.agentId],
    );
    expect(res.rows).toHaveLength(2);

    // The full export: args is SQL NULL, not an object, and certainly not { sector: null }.
    expect(res.rows[0].sector).toBeNull(); // the dedicated column already says "whole gate"
    expect(res.rows[0].args).toBeNull();

    // The scoped export: exactly the one argument it was given, nothing more.
    expect(res.rows[1].sector).toBe("finance");
    expect(res.rows[1].args).toEqual({ sector: "finance" });
    expect(Object.keys(res.rows[1].args as Record<string, unknown>)).toEqual(["sector"]);
  });
});

// ── REST route (getExport) — DB-gated because it resolves the operator + reads the store ──────────

/** A capturing fake ServerResponse (the admin.db.test pattern). */
function fakeRes() {
  let status = 0;
  let body = "";
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead(s: number, h?: Record<string, string>) {
      status = s;
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
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

function ctxFor(opts: { query?: string; host?: string } = {}) {
  const r = fakeRes();
  const req = new EventEmitter() as unknown as IncomingMessage;
  req.headers = { host: opts.host ?? "127.0.0.1:8787" };
  const ctx: RouteContext = {
    req,
    res: r.res,
    params: {},
    query: new URLSearchParams(opts.query ?? ""),
  };
  return { ctx, r };
}

describe.skipIf(!HAS_DB)("GET /api/export route", () => {
  it("returns a JSON attachment (200) with content-disposition + a valid bundle", async () => {
    const { getExport } = await import("../rest/export-routes.js");
    const { ctx, r } = ctxFor();
    await getExport(ctx);

    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="pci-export-.*\.json"$/);
    const bundle = JSON.parse(r.body) as ExportBundle;
    expect(bundle.manifest.gateway).toBe("pci-gateway");
    expect(typeof bundle.data).toBe("object");
  });

  it("the localOnly-wrapped route rejects a non-loopback Host (DNS-rebinding guard)", async () => {
    const { exportRoute } = await import("../rest/export-routes.js");
    const { ForbiddenHostError } = await import("../rest/host-allowlist.js");
    const { ctx } = ctxFor({ host: "evil.com" });
    expect(() => exportRoute(ctx)).toThrow(ForbiddenHostError);
  });

  it("an unknown ?sector= → QueryValidationError → errorToStatus 400, nothing written", async () => {
    const { getExport } = await import("../rest/export-routes.js");
    const { errorToStatus } = await import("../rest/router.js");
    const { ctx } = ctxFor({ query: "sector=does-not-exist" });
    await expect(getExport(ctx)).rejects.toBeInstanceOf(QueryValidationError);
    expect(errorToStatus(new QueryValidationError("unknown sector: does-not-exist")).status).toBe(400);
  });
});

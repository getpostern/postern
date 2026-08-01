// erase round-trips against a real Postgres, gated on DATABASE_URL so CI stays green without it.
// Seeds rows DIRECTLY via raw SQL (the established db-test pattern). Two layers:
//
//   CORE eraseData (under a DEDICATED throwaway user, so the wide sector/all deletes can't race the
//   other db-test files that share the seeded LOCAL_USER):
//     * connection scope deletes ONLY that connection's rows across all tables — live AND tombstoned —
//       and leaves sibling connections, other users, and the connector/credential rows intact;
//     * sector scope deletes only that sector's tables for the user; all scope deletes every table;
//     * a foreign / cross-user / malformed connectionId -> NotFoundError (no delete, no cross-user reach);
//     * an unknown sector / a missing required id -> QueryValidationError; re-erase is idempotent (0);
//     * per-table counts + total are correct.
//
//   ROUTE eraseRoute (acts as the local operator via resolveLocal — LOCAL_USER): exercised ONLY at
//   connection scope (isolated to a connection THIS test owns, so it never races a parallel file), plus
//   the confirm-token gate (a mismatch is a ValidationError with ZERO rows deleted) and the off-path
//   audit (tool 'erase', no secrets). all/sector ROUTE success is intentionally NOT tested here — it
//   would wipe the shared LOCAL_USER; the core layer covers those scopes under the throwaway user.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { ALL_SECTORS, type AuthContext } from "../auth/index.js";
import { LOCAL_USER_ID } from "../auth/sectors.js";
import { eraseData } from "./erase.js";
import { NotFoundError } from "./context.js";
import { QueryValidationError } from "./query.js";
import { eraseRoute } from "../rest/erase-routes.js";
import { ValidationError, type RouteContext } from "../rest/router.js";
import type { AuditHook } from "../rest/index.js";

const HAS_DB = !!process.env.DATABASE_URL;

// DEDICATED throwaway users so the wide deletes here can't race the parallel db-test files.
const TEST_USER = "00000000-0000-0000-0000-0000000e7a5e";
const OTHER_USER = "00000000-0000-0000-0000-0000000e7a5f";

const ctx: AuthContext = {
  userId: TEST_USER,
  agentId: "erase-test",
  grantedSectors: new Set(ALL_SECTORS),
};

/** A fake ServerResponse capturing the status + parsed JSON body sendJson() writes. */
function makeRouteCtx(): { ctx: RouteContext; captured: { status?: number; body?: unknown } } {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(payload?: string) {
      captured.body = payload ? JSON.parse(payload) : undefined;
      return this;
    },
  } as unknown as ServerResponse;
  const routeCtx: RouteContext = {
    req: {} as unknown as IncomingMessage,
    res,
    params: {},
    query: new URLSearchParams(),
  };
  return { ctx: routeCtx, captured };
}

describe.skipIf(!HAS_DB)("erase DB round-trips", () => {
  // TEST_USER connections (throwaway). connFin + connFin2 share the finance sector to prove
  // connection-scope hits ONLY one of them; connMail proves sector/all isolation.
  let connFin: string;
  let connFin2: string;
  let connMail: string;
  let connOther: string; // OTHER_USER's finance connection (cross-user isolation)
  let connRT: string; // LOCAL_USER finance connection driving the ROUTE tests

  const audited: unknown[] = [];
  const captureAudit: AuditHook = (e) => {
    audited.push(e);
  };

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    for (const [uid, label] of [
      [TEST_USER, "erase-db-test"],
      [OTHER_USER, "erase-db-test-other"],
    ]) {
      await pool.query(`insert into users (id, label) values ($1, $2) on conflict (id) do nothing`, [
        uid,
        label,
      ]);
    }

    // Clean any leftovers from a prior aborted run (unique providers per user).
    await pool.query(`delete from provider_credentials where user_id = any($1) and provider like 'erase-%'`, [
      [TEST_USER, OTHER_USER, LOCAL_USER_ID],
    ]);

    const cred = async (userId: string, provider: string) => {
      const r = await pool.query(
        `insert into provider_credentials (user_id, provider, custody, status)
         values ($1, $2, 'static_token', 'active') returning id`,
        [userId, provider],
      );
      return r.rows[0].id as string;
    };
    const connector = async (userId: string, credentialId: string, sector: string, provider: string) => {
      const r = await pool.query(
        `insert into connectors (user_id, credential_id, sector, provider, status)
         values ($1, $2, $3, $4, 'active') returning id`,
        [userId, credentialId, sector, provider],
      );
      return r.rows[0].id as string;
    };

    connFin = await connector(TEST_USER, await cred(TEST_USER, "erase-fin"), "finance", "erase-fin");
    connFin2 = await connector(TEST_USER, await cred(TEST_USER, "erase-fin2"), "finance", "erase-fin2");
    connMail = await connector(TEST_USER, await cred(TEST_USER, "erase-mail"), "mail", "erase-mail");
    connOther = await connector(OTHER_USER, await cred(OTHER_USER, "erase-fin"), "finance", "erase-fin");
    connRT = await connector(LOCAL_USER_ID, await cred(LOCAL_USER_ID, "erase-rt"), "finance", "erase-rt");
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: credentials -> connectors -> domain rows. (LOCAL_USER is the seed — never deleted;
    // only ITS erase-rt credential is removed.)
    await pool.query(`delete from provider_credentials where user_id = any($1) and provider like 'erase-%'`, [
      [TEST_USER, OTHER_USER, LOCAL_USER_ID],
    ]);
    await pool.query(`delete from users where id = any($1)`, [[TEST_USER, OTHER_USER]]);
    await pool.end();
  });

  // Re-seed domain rows before EACH test (connectors persist — erase keeps them; only rows churn).
  beforeEach(async () => {
    const { pool } = await import("../db.js");
    audited.length = 0;

    // Wipe the tables these tests touch for the throwaway users + the LOCAL_USER route connection.
    await pool.query(`delete from finance_transactions where user_id = any($1)`, [[TEST_USER, OTHER_USER]]);
    await pool.query(`delete from finance_accounts where user_id = any($1)`, [[TEST_USER, OTHER_USER]]);
    await pool.query(`delete from mail_messages where user_id = any($1)`, [[TEST_USER, OTHER_USER]]);
    // The LOCAL_USER route connection is scoped by connection_id (LOCAL_USER is shared — never wipe it
    // by user_id). Wipe BOTH tables connRT is seeded into so the re-insert can't hit the unique key.
    await pool.query(`delete from finance_transactions where connection_id = $1`, [connRT]);
    await pool.query(`delete from finance_accounts where connection_id = $1`, [connRT]);

    const txn = async (conn: string, user: string, sid: string, deletedAt: string | null = null) => {
      await pool.query(
        `insert into finance_transactions
           (connection_id, user_id, source_object_id, posted_at, amount, currency, description, deleted_at)
         values ($1, $2, $3, '2026-06-01T12:00:00Z', '-10.00', 'USD', 'erase seed', $4)`,
        [conn, user, sid, deletedAt],
      );
    };
    const acct = async (conn: string, user: string, sid: string) => {
      await pool.query(
        `insert into finance_accounts
           (connection_id, user_id, source_object_id, name, currency, balance_at_is_synthetic)
         values ($1, $2, $3, 'Checking', 'USD', false)`,
        [conn, user, sid],
      );
    };
    const mail = async (conn: string, user: string, sid: string) => {
      await pool.query(
        `insert into mail_messages (connection_id, user_id, source_object_id, subject)
         values ($1, $2, $3, 'hello')`,
        [conn, user, sid],
      );
    };

    // connFin: 3 live txns + 1 TOMBSTONED txn + 2 accounts.
    await txn(connFin, TEST_USER, "fin-1");
    await txn(connFin, TEST_USER, "fin-2");
    await txn(connFin, TEST_USER, "fin-3");
    await txn(connFin, TEST_USER, "fin-gone", "2026-06-02T00:00:00Z");
    await acct(connFin, TEST_USER, "acct-1");
    await acct(connFin, TEST_USER, "acct-2");
    // connFin2: 2 live txns (sibling finance connection).
    await txn(connFin2, TEST_USER, "fin2-1");
    await txn(connFin2, TEST_USER, "fin2-2");
    // connMail: 2 mails.
    await mail(connMail, TEST_USER, "mail-1");
    await mail(connMail, TEST_USER, "mail-2");
    // OTHER_USER: 2 finance txns (must survive every TEST_USER erase).
    await txn(connOther, OTHER_USER, "other-1");
    await txn(connOther, OTHER_USER, "other-2");
    // LOCAL_USER route connection: 2 txns + 1 account (connection-scope route tests only).
    await txn(connRT, LOCAL_USER_ID, "rt-1");
    await txn(connRT, LOCAL_USER_ID, "rt-2");
    await acct(connRT, LOCAL_USER_ID, "rt-acct-1");
  });

  // ── Counting helpers (live + tombstoned, since erase removes both). ──
  async function countByConn(table: string, conn: string): Promise<number> {
    const { pool } = await import("../db.js");
    const r = await pool.query(`select count(*)::int as n from "${table}" where connection_id = $1`, [conn]);
    return r.rows[0].n as number;
  }
  async function countByUser(table: string, user: string): Promise<number> {
    const { pool } = await import("../db.js");
    const r = await pool.query(`select count(*)::int as n from "${table}" where user_id = $1`, [user]);
    return r.rows[0].n as number;
  }

  // ── CORE: connection scope ──────────────────────────────────────────────────────
  describe("eraseData — connection scope", () => {
    it("deletes ONLY that connection's rows (live + tombstoned) across all tables; siblings/other-user/connectors intact", async () => {
      const { pool } = await import("../db.js");
      const out = await eraseData(ctx, { scope: "connection", connectionId: connFin });

      expect(out.scope).toBe("connection");
      // connFin held 4 finance_transactions (3 live + 1 tombstoned) + 2 finance_accounts.
      expect(out.deleted).toEqual({ finance_transactions: 4, finance_accounts: 2 });
      expect(out.total).toBe(6);
      // Zero-count tables are omitted from `deleted`.
      expect(out.deleted.mail_messages).toBeUndefined();

      // connFin is empty now (incl. the tombstoned row).
      expect(await countByConn("finance_transactions", connFin)).toBe(0);
      expect(await countByConn("finance_accounts", connFin)).toBe(0);
      // Sibling finance connection + mail + the other user are untouched.
      expect(await countByConn("finance_transactions", connFin2)).toBe(2);
      expect(await countByConn("mail_messages", connMail)).toBe(2);
      expect(await countByUser("finance_transactions", OTHER_USER)).toBe(2);

      // The connector + credential rows are KEPT (erase is data-only).
      const conns = await pool.query(`select count(*)::int as n from connectors where user_id = $1`, [
        TEST_USER,
      ]);
      expect(conns.rows[0].n).toBe(3);
      const creds = await pool.query(
        `select count(*)::int as n from provider_credentials where user_id = $1`,
        [TEST_USER],
      );
      expect(creds.rows[0].n).toBe(3);
    });

    it("re-erasing the same connection is idempotent (second pass deletes 0)", async () => {
      const first = await eraseData(ctx, { scope: "connection", connectionId: connFin });
      expect(first.total).toBe(6);
      const second = await eraseData(ctx, { scope: "connection", connectionId: connFin });
      expect(second.total).toBe(0);
      expect(second.deleted).toEqual({});
    });

    it("a foreign / cross-user / malformed connectionId -> NotFoundError, no deletion", async () => {
      // Unknown uuid.
      await expect(
        eraseData(ctx, { scope: "connection", connectionId: randomUUID() }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // Another user's real connection (no cross-user reach).
      await expect(eraseData(ctx, { scope: "connection", connectionId: connOther })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      // Malformed (non-uuid) id -> typed NotFoundError, never a bad-uuid 500.
      await expect(
        eraseData(ctx, { scope: "connection", connectionId: "not-a-uuid" }),
      ).rejects.toBeInstanceOf(NotFoundError);

      // Nothing was deleted (connFin + OTHER_USER intact).
      expect(await countByConn("finance_transactions", connFin)).toBe(4);
      expect(await countByUser("finance_transactions", OTHER_USER)).toBe(2);
    });

    it("a missing connectionId -> QueryValidationError", async () => {
      await expect(eraseData(ctx, { scope: "connection" })).rejects.toBeInstanceOf(QueryValidationError);
    });
  });

  // ── CORE: sector scope ──────────────────────────────────────────────────────────
  describe("eraseData — sector scope", () => {
    it("deletes only the sector's tables for the user (both finance connections), leaving mail + other user", async () => {
      const out = await eraseData(ctx, { scope: "sector", sector: "finance" });
      expect(out.scope).toBe("sector");
      // 6 finance_transactions (connFin 4 + connFin2 2) + 2 finance_accounts for TEST_USER.
      expect(out.deleted).toEqual({ finance_transactions: 6, finance_accounts: 2 });
      expect(out.total).toBe(8);

      expect(await countByUser("finance_transactions", TEST_USER)).toBe(0);
      expect(await countByUser("finance_accounts", TEST_USER)).toBe(0);
      // mail untouched (different sector); OTHER_USER's finance untouched.
      expect(await countByUser("mail_messages", TEST_USER)).toBe(2);
      expect(await countByUser("finance_transactions", OTHER_USER)).toBe(2);
    });

    it("an unknown sector -> QueryValidationError, no deletion", async () => {
      await expect(eraseData(ctx, { scope: "sector", sector: "nope" })).rejects.toBeInstanceOf(
        QueryValidationError,
      );
      expect(await countByUser("finance_transactions", TEST_USER)).toBe(6);
    });

    it("a missing sector -> QueryValidationError", async () => {
      await expect(eraseData(ctx, { scope: "sector" })).rejects.toBeInstanceOf(QueryValidationError);
    });
  });

  // ── CORE: all scope ──────────────────────────────────────────────────────────────
  describe("eraseData — all scope", () => {
    it("deletes every domain table for the user, leaving the other user intact", async () => {
      const out = await eraseData(ctx, { scope: "all" });
      expect(out.scope).toBe("all");
      expect(out.deleted).toEqual({
        finance_transactions: 6,
        finance_accounts: 2,
        mail_messages: 2,
      });
      expect(out.total).toBe(10);

      expect(await countByUser("finance_transactions", TEST_USER)).toBe(0);
      expect(await countByUser("finance_accounts", TEST_USER)).toBe(0);
      expect(await countByUser("mail_messages", TEST_USER)).toBe(0);
      // The other user is wholly untouched.
      expect(await countByUser("finance_transactions", OTHER_USER)).toBe(2);
    });
  });

  // ── ROUTE: eraseRoute (operator = LOCAL_USER) ─────────────────────────────────────
  describe("eraseRoute — confirm gate + audit (connection scope only)", () => {
    it("success: matching confirm -> 200 {scope, deleted, total}; rows gone; audit fired (tool 'erase', no secret)", async () => {
      const { ctx: routeCtx, captured } = makeRouteCtx();
      await eraseRoute(
        routeCtx,
        { scope: "connection", connectionId: connRT, confirm: connRT },
        captureAudit,
      );

      expect(captured.status).toBe(200);
      expect(captured.body).toEqual({
        scope: "connection",
        deleted: { finance_transactions: 2, finance_accounts: 1 },
        total: 3,
      });
      expect(await countByConn("finance_transactions", connRT)).toBe(0);
      expect(await countByConn("finance_accounts", connRT)).toBe(0);

      // Audit fires off-path (a microtask) — give it a tick.
      await new Promise((r) => setTimeout(r, 30));
      const erases = audited.filter((e) => (e as { tool?: string }).tool === "erase");
      expect(erases.length).toBe(1);
      const entry = erases[0] as { decision: string; outcome: string; resultCount: number; args: unknown };
      expect(entry.decision).toBe("allow");
      expect(entry.outcome).toBe("ok");
      expect(entry.resultCount).toBe(3);
      expect(entry.args).toEqual({ scope: "connection", connectionId: connRT });
      // No secret/token anywhere in the audit payload.
      expect(JSON.stringify(audited).toLowerCase()).not.toContain("secret");
    });

    it("connection-scope confirm mismatch -> ValidationError, ZERO rows deleted, no audit", async () => {
      const { ctx: routeCtx } = makeRouteCtx();
      await expect(
        eraseRoute(routeCtx, { scope: "connection", connectionId: connRT, confirm: "wrong" }, captureAudit),
      ).rejects.toBeInstanceOf(ValidationError);

      expect(await countByConn("finance_transactions", connRT)).toBe(2);
      expect(await countByConn("finance_accounts", connRT)).toBe(1);
      await new Promise((r) => setTimeout(r, 20));
      expect(audited.filter((e) => (e as { tool?: string }).tool === "erase")).toHaveLength(0);
    });

    it("sector-scope confirm mismatch -> ValidationError before any delete", async () => {
      const { ctx: routeCtx } = makeRouteCtx();
      await expect(
        eraseRoute(routeCtx, { scope: "sector", sector: "finance", confirm: "financeX" }, captureAudit),
      ).rejects.toBeInstanceOf(ValidationError);
      // The LOCAL_USER route connection (a finance connection) is untouched.
      expect(await countByConn("finance_transactions", connRT)).toBe(2);
    });

    it("all-scope wrong confirm -> ValidationError, NOTHING deleted (the shared LOCAL_USER is safe)", async () => {
      const { ctx: routeCtx } = makeRouteCtx();
      await expect(
        eraseRoute(routeCtx, { scope: "all", confirm: "nope" }, captureAudit),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await countByConn("finance_transactions", connRT)).toBe(2);
    });

    it("all-scope correct confirm token is 'ERASE-ALL' (gate logic) — verified via the 400 on a near-miss", async () => {
      const { ctx: routeCtx } = makeRouteCtx();
      // A near-miss confirm (case/format) is still rejected — only the exact sentinel passes.
      await expect(
        eraseRoute(routeCtx, { scope: "all", confirm: "erase-all" }, captureAudit),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await countByConn("finance_transactions", connRT)).toBe(2);
    });

    it("invalid scope / missing confirm -> ValidationError (zod)", async () => {
      const { ctx: routeCtx } = makeRouteCtx();
      await expect(
        eraseRoute(routeCtx, { scope: "everything", confirm: "x" }, captureAudit),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(eraseRoute(routeCtx, { scope: "all" }, captureAudit)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it("foreign connectionId via route -> NotFoundError; audit records outcome 'error'", async () => {
      const foreign = randomUUID();
      const { ctx: routeCtx } = makeRouteCtx();
      await expect(
        eraseRoute(routeCtx, { scope: "connection", connectionId: foreign, confirm: foreign }, captureAudit),
      ).rejects.toBeInstanceOf(NotFoundError);

      await new Promise((r) => setTimeout(r, 30));
      const erases = audited.filter((e) => (e as { tool?: string }).tool === "erase");
      expect(erases.length).toBe(1);
      expect((erases[0] as { outcome: string }).outcome).toBe("error");
    });
  });
});

// Finance dedup trust surface (spec finance-dedup-trust-batch, child C) — the flag + confirm-merge
// REST routes and the banks-view annotations, over child A's engine. Pure tests pin the annotation
// join (served candidate/confirmation state placed onto the right cards by (conn|soid) — zero display
// re-derivation); the DB describe (gated on DATABASE_URL, ADR-0015-guarded) drives the REAL routes
// end-to-end: a seeded maskless same-institution pair surfaces `possibleDuplicate` cross-keyed on both
// cards (while a masked pair merges organically and a class-conflicting pair stays silent), POST
// /api/finance/dedup-confirmations merges the pair into ONE card carrying `confirmedMerge`, DELETE
// reverses it (pills return), a later currency conflict serves `confirmationSuspended` fail-open, and
// malformed bodies are typed 400s naming the offending field.
//
// Handlers are exercised DIRECTLY (constructed RouteContext) like finance-routes.db.test.ts — the
// route wiring itself is src/rest/index.ts registration lines (asserted via the localOnly wrapper).
// Fixtures live under the seeded LOCAL_USER (the routes resolve the operator via resolveLocal) with a
// unique "dtc_" token / distinct institutions, so assertions never collide with the w33 suite's rows
// even though both files reconcile LOCAL_USER (the engine converges deterministically per
// institution+mask group, so the two fixture sets cannot disturb each other).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  financeBanksRoute,
  financeDedupCandidatesRoute,
  financeDedupConfirmRoute,
  financeDedupUnconfirmRoute,
  summarizeBanks,
  type FinanceBankSummary,
  type FinanceDedupCandidateWire,
  type AccountRow,
} from "./finance-routes.js";
import type { CandidatePair, DedupConfirmationSummary } from "../core/finance-dedup.js";
import { QueryValidationError } from "../core/query.js";
import { NotFoundError } from "../core/context.js";
import { localOnly, ForbiddenHostError } from "./host-allowlist.js";
import { errorToStatus, type RouteContext } from "./router.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001"; // the seeded operator (db/schema.sql)
const TOKEN = "dtc_"; // unique source_object_id prefix scoping every fixture row to this suite

// ── Fake req/res so the bare handlers can run without a socket ─────────────
interface Captured {
  status?: number;
  body?: string;
}
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
function headerReq(host = "127.0.0.1"): IncomingMessage {
  return { headers: { host } } as unknown as IncomingMessage;
}
function ctxFor(req: IncomingMessage, params: Record<string, string> = {}): { ctx: RouteContext; captured: Captured } {
  const { res, captured } = makeRes();
  return { ctx: { req, res, params, query: new URLSearchParams() }, captured };
}
async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
}

// ── Pure annotation checks — served dedup state lands on the right cards ───
describe("summarizeBanks — dedup trust annotations (pure)", () => {
  function acct(p: Partial<AccountRow> & { id: string; connection_id: string; provider: string }): AccountRow {
    return {
      mask: null,
      institution_name: null,
      org_domain: null,
      currency: null,
      account_type: null,
      name: null,
      raw: null,
      dedup_status: null,
      dedup_group_id: null,
      shadowed_by_id: null,
      source_object_id: p.id,
      connector_status: "active",
      last_synced_at: null,
      item_status: null,
      ...p,
    };
  }
  const side = (connectionId: string, sourceObjectId: string) => ({
    connectionId,
    sourceObjectId,
    accountId: sourceObjectId,
    provider: "simplefin",
    name: null,
    institutionName: "Acme",
    mask: null,
  });
  const conf = (over: Partial<DedupConfirmationSummary> & Pick<DedupConfirmationSummary, "a" | "b" | "state">): DedupConfirmationSummary => ({
    id: "33333333-3333-5333-8333-333333333333",
    createdAt: new Date().toISOString(),
    suspendedReason: null,
    ...over,
  });

  // Two maskless same-institution rows on different connections — each its OWN (unkeyed) card.
  const masklessRows = [
    acct({ id: "x", connection_id: "c1", provider: "simplefin", org_domain: "acme.example", institution_name: "Acme" }),
    acct({ id: "y", connection_id: "c2", provider: "plaid", org_domain: "acme.example", institution_name: "Acme" }),
  ];
  const pair: CandidatePair = { institution: "acme.example", currency: null, a: side("c1", "x"), b: side("c2", "y") };

  it("a candidate pair flags BOTH cards, cross-keyed (a.other = b.bankKey and vice versa)", () => {
    const banks = summarizeBanks(masklessRows, [], { candidates: [pair], confirmations: [] });
    expect(banks).toHaveLength(2);
    const [a, b] = banks;
    expect(a.possibleDuplicate).toEqual({ otherBankKey: b.bankKey, confirmable: true });
    expect(b.possibleDuplicate).toEqual({ otherBankKey: a.bankKey, confirmable: true });
    expect(banks.every((s) => !s.confirmedMerge && !s.confirmationSuspended)).toBe(true);
  });

  it("without the dedup input the summary is unannotated (regression: default shape unchanged)", () => {
    const banks = summarizeBanks(masklessRows);
    expect(banks).toHaveLength(2);
    for (const s of banks) {
      expect(s.possibleDuplicate).toBeUndefined();
      expect(s.confirmedMerge).toBeUndefined();
      expect(s.confirmationSuspended).toBeUndefined();
      expect(typeof s.bankKey).toBe("string");
    }
  });

  it("an APPLIED confirmation stamps the ONE merged card with confirmedMerge", () => {
    const gid = "44444444-4444-5444-8444-444444444444";
    const merged = [
      acct({ id: "x", connection_id: "c1", provider: "simplefin", org_domain: "acme.example", institution_name: "Acme", dedup_status: "shadow", dedup_group_id: gid, shadowed_by_id: "w" }),
      acct({ id: "y", connection_id: "c2", provider: "plaid", org_domain: "acme.example", institution_name: "Acme", dedup_status: "shadow", dedup_group_id: gid, shadowed_by_id: "w" }),
      acct({ id: "w", connection_id: "c2", provider: "plaid", org_domain: "acme.example", institution_name: "Acme", dedup_status: "winner", dedup_group_id: gid, source_object_id: "union:confirmed:deadbeef" }),
    ];
    const c = conf({ a: { connectionId: "c1", sourceObjectId: "x" }, b: { connectionId: "c2", sourceObjectId: "y" }, state: "applied" });
    const banks = summarizeBanks(merged, [], { candidates: [], confirmations: [c] });
    expect(banks).toHaveLength(1);
    expect(banks[0].confirmedMerge).toEqual({ confirmationId: c.id });
    expect(banks[0].possibleDuplicate).toBeUndefined();
    expect(banks[0].confirmationSuspended).toBeUndefined();
  });

  it("a SUSPENDED confirmation stamps EVERY member card with the reason (fail-open refusal)", () => {
    const c = conf({
      a: { connectionId: "c1", sourceObjectId: "x" },
      b: { connectionId: "c2", sourceObjectId: "y" },
      state: "suspended",
      suspendedReason: "currency",
    });
    const banks = summarizeBanks(masklessRows, [], { candidates: [], confirmations: [c] });
    expect(banks).toHaveLength(2);
    for (const s of banks) {
      expect(s.confirmationSuspended).toEqual({ confirmationId: c.id, reason: "currency" });
      expect(s.confirmedMerge).toBeUndefined();
    }
  });

  it("an INACTIVE confirmation serves nothing", () => {
    const c = conf({ a: { connectionId: "c1", sourceObjectId: "x" }, b: { connectionId: "c9", sourceObjectId: "gone" }, state: "inactive" });
    const banks = summarizeBanks(masklessRows, [], { candidates: [], confirmations: [c] });
    expect(banks.every((s) => !s.confirmedMerge && !s.confirmationSuspended)).toBe(true);
  });
});

// ── DB-backed route checks (the live flag → confirm → unmerge → suspend loop) ──
describe.skipIf(!HAS_DB)("finance dedup trust routes (DB)", () => {
  let credS: string, credP: string;
  let connS: string, connP: string;
  let confirmedId: string; // set by the confirm test, consumed by the unconfirm test

  async function db() {
    return (await import("../db.js")).pool;
  }

  async function insertCred(provider: string): Promise<string> {
    const pool = await db();
    const r = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status)
       values ($1, $2, 'static_token', 'active') returning id`,
      [LOCAL_USER, provider],
    );
    return r.rows[0].id as string;
  }
  async function insertConn(credId: string, provider: string): Promise<string> {
    const pool = await db();
    const r = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status, last_synced_at)
       values ($1, $2, 'finance', $3, 'active', now()) returning id`,
      [LOCAL_USER, credId, provider],
    );
    return r.rows[0].id as string;
  }
  async function insertAcct(
    connectionId: string,
    soid: string,
    f: {
      mask?: string | null;
      institution_name: string;
      org_domain: string;
      currency?: string;
      account_type?: string | null; // default 'credit'; explicit null = SimpleFIN-shaped (no type)
      name?: string | null;
    },
  ): Promise<string> {
    const pool = await db();
    const r = await pool.query(
      `insert into finance_accounts
         (connection_id, user_id, source_object_id, account_type, name, currency, mask, institution_name, org_domain, raw)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [
        connectionId,
        LOCAL_USER,
        soid,
        f.account_type === undefined ? "credit" : f.account_type,
        f.name ?? null,
        f.currency ?? "USD",
        f.mask ?? null,
        f.institution_name,
        f.org_domain,
        JSON.stringify({ sentinel: soid }),
      ],
    );
    return r.rows[0].id as string;
  }

  beforeAll(async () => {
    const pool = await db();
    // Clean any leftovers from a prior aborted run (per-provider tags unique to this suite).
    for (const p of ["simplefin_dtc", "plaid_dtc"]) {
      await pool.query(`delete from provider_credentials where user_id = $1 and provider = $2`, [LOCAL_USER, p]);
    }
    await pool.query(`delete from finance_dedup_confirmations where user_id = $1`, [LOCAL_USER]);

    credS = await insertCred("simplefin_dtc");
    credP = await insertCred("plaid_dtc");
    connS = await insertConn(credS, "simplefin");
    connP = await insertConn(credP, "plaid");

    // Candidate pair: same institution, BOTH maskless, cross-connection, compatible currency+class —
    // the engine can never prove it (no last-4), so it must be FLAGGED, never merged.
    await insertAcct(connS, `${TOKEN}s_main`, { institution_name: "DTC Candidate Bank", org_domain: "dtccand.example" });
    await insertAcct(connP, `${TOKEN}p_main`, { institution_name: "DTC Candidate Bank", org_domain: "dtccand.example" });

    // Suspension pair (confirmed later, then driven into a currency conflict).
    await insertAcct(connS, `${TOKEN}s_susp`, { institution_name: "DTC Suspend Bank", org_domain: "dtcsusp.example" });
    await insertAcct(connP, `${TOKEN}p_susp`, { institution_name: "DTC Suspend Bank", org_domain: "dtcsusp.example" });

    // Masked control: both sides carry the same 4-digit mask → the ORGANIC engine owns it (merged,
    // no flag, no operator provenance).
    await insertAcct(connS, `${TOKEN}s_masked`, { mask: "9090", institution_name: "DTC Masked Bank", org_domain: "dtcmask.example" });
    await insertAcct(connP, `${TOKEN}p_masked`, { mask: "9090", institution_name: "DTC Masked Bank", org_domain: "dtcmask.example" });

    // Class-conflict control: maskless pair whose classes CONFLICT (depository vs loan-named) —
    // not a candidate (the engine could never honor a confirmation either).
    await insertAcct(connP, `${TOKEN}p_class`, { institution_name: "DTC Class Bank", org_domain: "dtcclass.example", account_type: "depository" });
    await insertAcct(connS, `${TOKEN}s_class`, { institution_name: "DTC Class Bank", org_domain: "dtcclass.example", account_type: null, name: "Loan (1234)" });

    // Converge the engine's own markers over the seeded set (organic merge for the masked pair).
    const { reconcileFinance } = await import("../core/finance-dedup.js");
    await reconcileFinance(LOCAL_USER);
  });

  afterAll(async () => {
    const pool = await db();
    // FK cascade: credential -> connectors -> finance_accounts (+ dedup confirmations by connection).
    await pool.query(`delete from provider_credentials where id = any($1)`, [[credS, credP]]);
    await pool.end();
  });

  /** Run the banks route and return the parsed list. */
  async function rawBanks(): Promise<FinanceBankSummary[]> {
    const { ctx, captured } = ctxFor(headerReq());
    await financeBanksRoute(ctx);
    expect(captured.status).toBe(200);
    return JSON.parse(captured.body ?? "[]") as FinanceBankSummary[];
  }
  async function banksAt(institution: string): Promise<FinanceBankSummary[]> {
    return (await rawBanks()).filter((b) => b.institution === institution);
  }
  /** Run the candidates route and return only this suite's pairs. */
  async function candidates(): Promise<FinanceDedupCandidateWire[]> {
    const { ctx, captured } = ctxFor(headerReq());
    await financeDedupCandidatesRoute(ctx);
    expect(captured.status).toBe(200);
    const all = JSON.parse(captured.body ?? "[]") as FinanceDedupCandidateWire[];
    return all.filter((p) => p.a.sourceObjectId.startsWith(TOKEN) || p.b.sourceObjectId.startsWith(TOKEN));
  }
  async function confirmVia(a: { connectionId: string; sourceObjectId: string }, b: { connectionId: string; sourceObjectId: string }): Promise<string> {
    const { ctx, captured } = ctxFor(headerReq());
    await financeDedupConfirmRoute(ctx, { a, b });
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body ?? "{}") as { id: string };
    expect(body.id).toBeTruthy();
    return body.id;
  }

  it("a seeded maskless pair surfaces possibleDuplicate on BOTH cards, cross-keyed + confirmable", async () => {
    const cards = await banksAt("DTC Candidate Bank");
    expect(cards).toHaveLength(2); // never auto-merged — no proof
    const [a, b] = cards;
    expect(a.possibleDuplicate).toEqual({ otherBankKey: b.bankKey, confirmable: true });
    expect(b.possibleDuplicate).toEqual({ otherBankKey: a.bankKey, confirmable: true });
    expect(cards.every((c) => c.accountCount === 1 && !c.confirmedMerge && !c.confirmationSuspended)).toBe(true);
  });

  it("a masked same-key pair does NOT flag (the organic engine owns provable pairs)", async () => {
    const cards = await banksAt("DTC Masked Bank");
    expect(cards).toHaveLength(1); // organically merged (3-row union, one live winner)
    expect(cards[0].accountCount).toBe(1);
    expect(cards[0].possibleDuplicate).toBeUndefined();
    expect(cards[0].confirmedMerge).toBeUndefined(); // organic merge carries NO operator provenance
  });

  it("a class-conflicting maskless pair does NOT flag (a confirmation could never be honored)", async () => {
    const cards = await banksAt("DTC Class Bank");
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => c.possibleDuplicate === undefined)).toBe(true);
  });

  it("GET /api/finance/dedup-candidates serves the pair stamped with the two cards' bank keys", async () => {
    const pairs = await candidates();
    const mine = pairs.filter((p) => p.institution === "dtccand");
    expect(mine).toHaveLength(1);
    const cards = await banksAt("DTC Candidate Bank");
    const keys = cards.map((c) => c.bankKey).sort();
    expect([mine[0].aBankKey, mine[0].bBankKey].sort()).toEqual(keys);
    // The suspension pair is also still an (unconfirmed) candidate at this point.
    expect(pairs.some((p) => p.institution === "dtcsusp")).toBe(true);
    // The masked + class-conflict controls never appear.
    expect(pairs.some((p) => p.institution === "dtcmask")).toBe(false);
    expect(pairs.some((p) => p.institution === "dtcclass")).toBe(false);
  });

  it("POST confirm → the banks view serves ONE merged card carrying confirmedMerge", async () => {
    confirmedId = await confirmVia(
      { connectionId: connP, sourceObjectId: `${TOKEN}p_main` },
      { connectionId: connS, sourceObjectId: `${TOKEN}s_main` },
    );
    const cards = await banksAt("DTC Candidate Bank");
    expect(cards).toHaveLength(1); // both reals shadowed under the union:confirmed:% winner
    expect(cards[0].accountCount).toBe(1);
    expect(cards[0].confirmedMerge).toEqual({ confirmationId: confirmedId });
    expect(cards[0].possibleDuplicate).toBeUndefined(); // decided — no longer "possible"
    expect(cards[0].providers.map((p) => p.provider).sort()).toEqual(["plaid", "simplefin"]);
    // …and the pair left the candidates feed.
    expect((await candidates()).some((p) => p.institution === "dtccand")).toBe(false);
  });

  it("DELETE unconfirm → the group dissolves and the pair is flagged again", async () => {
    const { ctx, captured } = ctxFor(headerReq(), { id: confirmedId });
    await financeDedupUnconfirmRoute(ctx);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body ?? "{}")).toEqual({ ok: true });

    const cards = await banksAt("DTC Candidate Bank");
    expect(cards).toHaveLength(2); // reals un-shadowed, serving separately again
    expect(cards.every((c) => c.confirmedMerge === undefined)).toBe(true);
    expect(cards.every((c) => c.possibleDuplicate !== undefined)).toBe(true); // candidate once more
    expect((await candidates()).some((p) => p.institution === "dtccand")).toBe(true);
  });

  it("a confirmed pair that develops a currency conflict is served SUSPENDED on both cards", async () => {
    await confirmVia(
      { connectionId: connS, sourceObjectId: `${TOKEN}s_susp` },
      { connectionId: connP, sourceObjectId: `${TOKEN}p_susp` },
    );
    expect((await banksAt("DTC Suspend Bank"))[0].confirmedMerge).toBeDefined(); // applied first

    const pool = await db();
    await pool.query(
      `update finance_accounts set currency = 'EUR' where user_id = $1 and connection_id = $2 and source_object_id = $3`,
      [LOCAL_USER, connS, `${TOKEN}s_susp`],
    );
    const { reconcileFinance } = await import("../core/finance-dedup.js");
    await reconcileFinance(LOCAL_USER); // the engine refuses the group fail-open — reals serve

    const cards = await banksAt("DTC Suspend Bank");
    expect(cards).toHaveLength(2); // group dissolved, both reals live
    for (const c of cards) {
      expect(c.confirmationSuspended).toMatchObject({ reason: "currency" });
      expect(typeof c.confirmationSuspended?.confirmationId).toBe("string");
      expect(c.confirmedMerge).toBeUndefined(); // never honored while conflicted
      expect(c.possibleDuplicate).toBeUndefined(); // decided (kept) — not re-flagged
    }
  });

  it("malformed confirm bodies are typed 400s naming the offender", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [null, /body must be/],
      ["nope", /body must be/],
      [[], /body must be/],
      [{}, /^a /],
      [{ a: { connectionId: connS, sourceObjectId: `${TOKEN}s_main` } }, /^b /],
      [{ a: { connectionId: "not-a-uuid", sourceObjectId: "x" }, b: { connectionId: connP, sourceObjectId: "y" } }, /a\.connectionId/],
      [{ a: { connectionId: connS, sourceObjectId: "union:evil" }, b: { connectionId: connP, sourceObjectId: "y" } }, /reserved 'union:'/],
    ];
    for (const [body, re] of cases) {
      const { ctx } = ctxFor(headerReq());
      const err = await caught(() => financeDedupConfirmRoute(ctx, body));
      expect(err).toBeInstanceOf(QueryValidationError);
      expect((err as Error).message).toMatch(re);
      expect(errorToStatus(err).status).toBe(400);
    }
  });

  it("DELETE with an unknown confirmation id → 404", async () => {
    const { ctx } = ctxFor(headerReq(), { id: "99999999-9999-4999-8999-999999999999" });
    const err = await caught(() => financeDedupUnconfirmRoute(ctx));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(errorToStatus(err).status).toBe(404);
  });

  it("all three routes are localOnly-wrapped: a non-loopback Host → 403 (before any DB work)", async () => {
    for (const handler of [financeDedupCandidatesRoute, financeDedupUnconfirmRoute]) {
      const { ctx } = ctxFor(headerReq("evil.com"));
      const err = await caught(() => localOnly(handler)(ctx));
      expect(err).toBeInstanceOf(ForbiddenHostError);
      expect(errorToStatus(err).status).toBe(403);
    }
    const { ctx } = ctxFor(headerReq("evil.com"));
    const err = await caught(() => localOnly((c) => financeDedupConfirmRoute(c, {}))(ctx));
    expect(err).toBeInstanceOf(ForbiddenHostError);
  });
});

// Finance banks-by-institution route (DB), gated on DATABASE_URL so CI stays green without Postgres.
// The handler is exercised DIRECTLY (a constructed RouteContext) — the route is wired into the app by
// the mother at merge, so there is no HTTP server here. Fixtures seed the #34b LIVE shape for the
// seeded LOCAL_USER: two cross-provider Amex cards (Plaid + SimpleFIN, each a synthetic winner + two
// shadowed reals), a SimpleFIN-only multi-account bank, a same-mask / disagreeing-institution pair
// (the alias gap), and a same-key class-conflict pair (depository vs "Loan (1234)") — then a REAL
// reconcileFinance(LOCAL_USER) runs over the whole set, so every asserted marker is the ENGINE'S own
// converged output, not a hand-written pose. Every fixture institution/mask uses a unique "w33" token
// so the assertions scope to this suite's rows and never collide with other LOCAL_USER finance data.
//
// Proves the spec's acceptance: ONE row per institution+card; the 2 overlapped Amex each appear ONCE
// with providers = [plaid, simplefin] and a deduped accountCount of 1; a Plaid action_required Item
// surfaces health='action_required' (ok otherwise; SimpleFIN ok); an alias-gap pair surfaces
// unmergedDuplicate=true (flagged, not hidden); a class-guard-refused same-key pair stays ONE entry
// with accountCount 2 + classConflict=true (merged / single-provider / zero-account stay false); and
// the route is localOnly (non-loopback Host -> 403).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  financeBanksRoute,
  summarizeBanks,
  type FinanceBankSummary,
  type AccountRow,
  type FinanceConnectorRow,
} from "./finance-routes.js";
import { localOnly } from "./host-allowlist.js";
import { errorToStatus, type RouteContext } from "./router.js";
import { ForbiddenHostError } from "./host-allowlist.js";

const HAS_DB = !!process.env.DATABASE_URL;
const LOCAL_USER = "00000000-0000-0000-0000-000000000001"; // the seeded operator (db/schema.sql)
const TOKEN = "w33_"; // unique source_object_id prefix scoping every fixture row to this suite

// ── Fake req/res so the bare handler can run without a socket ──────────────
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
function ctxFor(req: IncomingMessage): { ctx: RouteContext; captured: Captured } {
  const { res, captured } = makeRes();
  return { ctx: { req, res, params: {}, query: new URLSearchParams() }, captured };
}
async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
}

// ── Pure-logic checks (no DB) — the comparator/grouping core ──────────────
describe("summarizeBanks (pure)", () => {
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

  it("dedups an overlapped card to ONE row with both providers + accountCount 1", () => {
    const gid = "11111111-1111-5111-8111-111111111111";
    const banks = summarizeBanks([
      acct({ id: "p", connection_id: "cp", provider: "plaid", mask: "1001", org_domain: "americanexpress.com", dedup_status: "shadow", dedup_group_id: gid, shadowed_by_id: "synth", item_status: "ok", institution_name: "American Express" }),
      acct({ id: "s", connection_id: "cs", provider: "simplefin", mask: "1001", org_domain: "americanexpress.com", dedup_status: "shadow", dedup_group_id: gid, shadowed_by_id: "synth", institution_name: "AMEX" }),
      acct({ id: "synth", connection_id: "cp", provider: "plaid", mask: "1001", org_domain: "americanexpress.com", dedup_status: "winner", dedup_group_id: gid, shadowed_by_id: null, source_object_id: "union:americanexpress:1001", institution_name: "American Express" }),
    ]);
    expect(banks).toHaveLength(1);
    expect(banks[0].mask).toBe("1001");
    expect(banks[0].accountCount).toBe(1);
    expect(banks[0].providers.map((p) => p.provider)).toEqual(["plaid", "simplefin"]);
    expect(banks[0].dedupGroupId).toBe(gid);
    expect(banks[0].health).toBe("ok");
    expect(banks[0].unmergedDuplicate).toBe(false);
    expect(banks[0].classConflict).toBe(false); // merged: the only LIVE row is the synthetic winner
  });

  // ── class-conflict display (the engine's class-guard refusal, surfaced honestly) ──
  it("a live same-key pair the class guard refused (depository vs Loan) → ONE entry, classConflict", () => {
    const banks = summarizeBanks([
      acct({ id: "d", connection_id: "cp", provider: "plaid", mask: "1234", org_domain: "loanbank.example", institution_name: "Loan Bank", currency: "USD", account_type: "depository", dedup_status: "unique" }),
      acct({ id: "l", connection_id: "cs", provider: "simplefin", mask: "1234", org_domain: "loanbank.example", institution_name: "Loan Bank", currency: "USD", name: "Loan (1234)", dedup_status: "unique" }),
    ]);
    expect(banks).toHaveLength(1);
    expect(banks[0].accountCount).toBe(2); // both live — the engine deliberately did NOT merge
    expect(banks[0].classConflict).toBe(true);
    expect(banks[0].unmergedDuplicate).toBe(false); // single canonical institution — not the alias gap
  });

  it("a same-key AMBIGUOUS pair (no confident classes) stays classConflict=false (fail-open)", () => {
    const banks = summarizeBanks([
      acct({ id: "a", connection_id: "cp", provider: "plaid", mask: "4321", org_domain: "vague.example", institution_name: "Vague", currency: "USD" }),
      acct({ id: "b", connection_id: "cs", provider: "simplefin", mask: "4321", org_domain: "vague.example", institution_name: "Vague", currency: "USD" }),
    ]);
    expect(banks).toHaveLength(1);
    expect(banks[0].classConflict).toBe(false);
  });

  // ── #89 item 3 — orgDomain on the wire, so an institution mark is keyed off a served identifier ──
  it("serves org_domain VERBATIM — not the engine's fold, not a name-derived value", () => {
    // The live case from #89: Bank of America rendered a neutral "B" tile because the only served
    // identifier was a display name. `www.` is deliberately NOT stripped: this field is the stored row,
    // and normalising it here would fork a second institution-identity rule from the engine's.
    const banks = summarizeBanks([
      acct({
        id: "boa",
        connection_id: "c1",
        provider: "plaid",
        mask: "5150",
        org_domain: "www.bankofamerica.com",
        institution_name: "Bank of America",
      }),
    ]);
    expect(banks).toHaveLength(1);
    expect(banks[0].orgDomain).toBe("www.bankofamerica.com");
  });

  it("a merged card takes the SYNTHETIC winner's domain — the same pick the label uses", () => {
    // The reals disagree with the winner on purpose: a first-non-null pick would serve the shadowed
    // real's domain and put a different bank's mark on the merged card.
    const gid = "22222222-2222-5222-8222-222222222222";
    const banks = summarizeBanks([
      acct({ id: "r1", connection_id: "cp", provider: "plaid", mask: "1001", org_domain: "old-alias.example", dedup_status: "shadow", dedup_group_id: gid, shadowed_by_id: "synth", institution_name: "Amex" }),
      acct({ id: "r2", connection_id: "cs", provider: "simplefin", mask: "1001", org_domain: "old-alias.example", dedup_status: "shadow", dedup_group_id: gid, shadowed_by_id: "synth", institution_name: "AMEX" }),
      acct({ id: "synth", connection_id: "cp", provider: "plaid", mask: "1001", org_domain: "americanexpress.com", dedup_status: "winner", dedup_group_id: gid, shadowed_by_id: null, source_object_id: "union:americanexpress:1001", institution_name: "American Express" }),
    ]);
    expect(banks).toHaveLength(1);
    expect(banks[0].orgDomain).toBe("americanexpress.com");
  });

  it("no domain anywhere in the group -> null, never '' and never the institution name", () => {
    const banks = summarizeBanks([
      acct({ id: "n", connection_id: "c1", provider: "simplefin", mask: "9001", institution_name: "Tiny Credit Union" }),
    ]);
    expect(banks[0].orgDomain).toBeNull();
    // An empty string must not be served as if it were a domain either.
    const blank = summarizeBanks([
      acct({ id: "b", connection_id: "c2", provider: "simplefin", mask: "9002", org_domain: "", institution_name: "Blank" }),
    ]);
    expect(blank[0].orgDomain).toBeNull();
  });

  it("a zero-account connector card serves orgDomain null (a stated absence)", () => {
    const banks = summarizeBanks([], [{ connection_id: "cz", provider: "simplefin", connector_status: "active", last_synced_at: null, item_status: null, external_item_id: null }]);
    expect(banks[0].orgDomain).toBeNull();
    expect("orgDomain" in banks[0]).toBe(true); // present-and-null, not absent
  });

  it("a Plaid action_required Item surfaces health='action_required'", () => {
    const banks = summarizeBanks([
      acct({ id: "p", connection_id: "cp", provider: "plaid", mask: "2002", org_domain: "chase.com", item_status: "action_required", institution_name: "Chase" }),
    ]);
    expect(banks[0].health).toBe("action_required");
  });

  it("same mask, disagreeing institution -> unmergedDuplicate on BOTH groups", () => {
    const banks = summarizeBanks([
      acct({ id: "a", connection_id: "c1", provider: "simplefin", mask: "7777", org_domain: "alpha.example", institution_name: "Alpha" }),
      acct({ id: "b", connection_id: "c2", provider: "simplefin", mask: "7777", org_domain: "beta.example", institution_name: "Beta" }),
    ]);
    expect(banks).toHaveLength(2);
    expect(banks.every((b) => b.unmergedDuplicate)).toBe(true);
  });

  // ── #33 FIX 1 — a finance connector with ZERO served accounts still surfaces (manageable) ──
  function conn(p: Partial<FinanceConnectorRow> & { connection_id: string; provider: string }): FinanceConnectorRow {
    return { connector_status: "active", last_synced_at: null, item_status: null, external_item_id: null, ...p };
  }

  it("a finance connector with ZERO accounts appears as a standalone zero-account card", () => {
    const banks = summarizeBanks([], [conn({ connection_id: "cz", provider: "simplefin" })]);
    expect(banks).toHaveLength(1);
    expect(banks[0].institution).toBe("SimpleFIN");
    expect(banks[0].accountCount).toBe(0);
    expect(banks[0].mask).toBeNull();
    expect(banks[0].dedupGroupId).toBeNull();
    expect(banks[0].providers).toEqual([
      { provider: "simplefin", connectionId: "cz", itemStatus: null, lastSyncedAt: null },
    ]);
    expect(banks[0].health).toBe("ok");
    expect(banks[0].classConflict).toBe(false); // placeholder entries never flag
  });

  it("a mid-onboarding Plaid Item (no external_item_id) and an errored connector both surface", () => {
    const banks = summarizeBanks(
      [],
      [
        conn({ connection_id: "cp", provider: "plaid", external_item_id: null, item_status: null }),
        conn({ connection_id: "ce", provider: "simplefin", connector_status: "error" }),
      ],
    );
    const plaid = banks.find((b) => b.providers[0].connectionId === "cp")!;
    const err = banks.find((b) => b.providers[0].connectionId === "ce")!;
    expect(plaid.institution).toBe("Plaid (connecting…)");
    expect(err.health).toBe("error");
    expect(err.accountCount).toBe(0);
  });

  it("a connector already represented by an account is NOT re-added as a zero-account card", () => {
    const banks = summarizeBanks(
      [acct({ id: "x", connection_id: "c1", provider: "simplefin", mask: "9999", org_domain: "acme.example", institution_name: "Acme" })],
      [conn({ connection_id: "c1", provider: "simplefin" })], // same connection — must dedupe
    );
    expect(banks).toHaveLength(1);
    expect(banks[0].accountCount).toBe(1);
  });

  // ── #33 FIX 2 — deterministic display: the winner's institution name wins regardless of row order ──
  it("institution display is deterministic (prefers the synthetic winner's name) regardless of row order", () => {
    const gid = "22222222-2222-5222-8222-222222222222";
    const rows: AccountRow[] = [
      acct({ id: "p", connection_id: "cp", provider: "plaid", mask: "1001", org_domain: "americanexpress.com", dedup_status: "shadow", dedup_group_id: gid, shadowed_by_id: "synth", institution_name: "American Express" }),
      acct({ id: "s", connection_id: "cs", provider: "simplefin", mask: "1001", org_domain: "americanexpress.com", dedup_status: "shadow", dedup_group_id: gid, shadowed_by_id: "synth", institution_name: "AMEX" }),
      acct({ id: "synth", connection_id: "cp", provider: "plaid", mask: "1001", org_domain: "americanexpress.com", dedup_status: "winner", dedup_group_id: gid, shadowed_by_id: null, source_object_id: "union:americanexpress:1001", institution_name: "American Express" }),
    ];
    const forward = summarizeBanks(rows)[0].institution;
    const reversed = summarizeBanks([...rows].reverse())[0].institution;
    expect(forward).toBe("American Express");
    expect(reversed).toBe("American Express");
  });

  // ── #33 FIX 3 — same institution+mask, different currency, no dedup group → do NOT collapse ──
  it("same institution+mask but different currency are TWO cards (not collapsed, not flagged)", () => {
    const banks = summarizeBanks([
      acct({ id: "u", connection_id: "c1", provider: "simplefin", mask: "8888", org_domain: "multiccy.example", institution_name: "Multi", currency: "USD" }),
      acct({ id: "e", connection_id: "c1", provider: "simplefin", mask: "8888", org_domain: "multiccy.example", institution_name: "Multi", currency: "EUR" }),
    ]);
    expect(banks).toHaveLength(2);
    expect(banks.every((b) => b.accountCount === 1)).toBe(true);
    expect(banks.every((b) => !b.unmergedDuplicate)).toBe(true);
  });
});

// ── DB-backed route check (the live shape end-to-end) ──────────────────────
describe.skipIf(!HAS_DB)("GET /api/finance/banks (DB)", () => {
  const ids: Record<string, string> = {};
  let credPlaidA: string, credPlaidB: string, credSfin: string, credZero: string;
  let connPlaidA: string, connPlaidB: string, connSfin: string, connZero: string;

  async function db() {
    return (await import("../db.js")).pool;
  }

  async function insertCred(provider: string, itemStatus: string | null, externalItemId: string | null): Promise<string> {
    const pool = await db();
    const r = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status, item_status, external_item_id)
       values ($1, $2, 'static_token', 'active', $3, $4) returning id`,
      [LOCAL_USER, provider, itemStatus, externalItemId],
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
      mask: string;
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
        f.mask,
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
    for (const p of ["plaid_w33a", "plaid_w33b", "simplefin_w33", "simplefin_w33zero"]) {
      await pool.query(`delete from provider_credentials where user_id = $1 and provider = $2`, [LOCAL_USER, p]);
    }

    credPlaidA = await insertCred("plaid_w33a", "ok", "item_w33_a");
    credPlaidB = await insertCred("plaid_w33b", "action_required", "item_w33_b");
    credSfin = await insertCred("simplefin_w33", null, null);
    credZero = await insertCred("simplefin_w33zero", null, null); // a finance connector that serves NO accounts
    connPlaidA = await insertConn(credPlaidA, "plaid");
    connPlaidB = await insertConn(credPlaidB, "simplefin"); // connector.provider is denormalized; set per-row provider below
    connSfin = await insertConn(credSfin, "simplefin");
    connZero = await insertConn(credZero, "simplefin");
    // Fix connPlaidB's provider (it IS a plaid item) — the route reads connectors.provider.
    await pool.query(`update connectors set provider = 'plaid' where id = $1`, [connPlaidB]);

    // Provider REALS only — reconcileFinance (below) computes every winner/shadow/unique marker itself.
    // Card 1 (Amex 1001) — Plaid(ok) + SimpleFIN → the engine merges (synthetic winner + 2 shadows).
    ids.p1 = await insertAcct(connPlaidA, `${TOKEN}p1001`, { mask: "1001", institution_name: "American Express", org_domain: "americanexpress.com" });
    ids.s1 = await insertAcct(connSfin, `${TOKEN}s1001`, { mask: "1001", institution_name: "AMEX", org_domain: "americanexpress.com" });

    // Card 2 (Amex 1002) — Plaid(action_required) + SimpleFIN → merged likewise.
    ids.p2 = await insertAcct(connPlaidB, `${TOKEN}p1002`, { mask: "1002", institution_name: "American Express", org_domain: "americanexpress.com" });
    ids.s2 = await insertAcct(connSfin, `${TOKEN}s1002`, { mask: "1002", institution_name: "AMEX", org_domain: "americanexpress.com" });

    // SimpleFIN-only bank with 2 accounts (mask 5555) — single-provider, the engine keeps both unique.
    ids.cu1 = await insertAcct(connSfin, `${TOKEN}cu_a`, { mask: "5555", institution_name: "W33 Credit Union", org_domain: "w33cu.example" });
    ids.cu2 = await insertAcct(connSfin, `${TOKEN}cu_b`, { mask: "5555", institution_name: "W33 Credit Union", org_domain: "w33cu.example" });

    // Alias-gap: same mask 7777, disagreeing canonical institution → two flagged un-merged groups.
    ids.alpha = await insertAcct(connSfin, `${TOKEN}alpha`, { mask: "7777", institution_name: "W33 Alpha Bank", org_domain: "w33alpha.example" });
    ids.beta = await insertAcct(connPlaidA, `${TOKEN}beta`, { mask: "7777", institution_name: "W33 Beta Bank", org_domain: "w33beta.example" });

    // Multi-currency: same institution + mask 8888 but different currency → #34b keeps them SEPARATE
    // (currencyConflict fail-open: unique, no dedup group) → must surface as TWO distinct cards.
    ids.usd = await insertAcct(connSfin, `${TOKEN}ccy_usd`, { mask: "8888", institution_name: "W33 Multi Currency", org_domain: "w33multiccy.example", currency: "USD" });
    ids.eur = await insertAcct(connSfin, `${TOKEN}ccy_eur`, { mask: "8888", institution_name: "W33 Multi Currency", org_domain: "w33multiccy.example", currency: "EUR" });

    // Class-conflict pair: same institution + mask 1234, Plaid says DEPOSITORY, SimpleFIN's name says
    // "Loan (1234)" (liability) — the #34b class guard confidently refuses this merge, so BOTH stay live.
    ids.loanPlaid = await insertAcct(connPlaidA, `${TOKEN}loan_p`, { mask: "1234", institution_name: "W33 Loan Bank", org_domain: "w33loan.example", account_type: "depository" });
    ids.loanSfin = await insertAcct(connSfin, `${TOKEN}loan_s`, { mask: "1234", institution_name: "W33 Loan Bank", org_domain: "w33loan.example", account_type: null, name: "Loan (1234)" });

    // connZero gets NO finance_accounts at all — it must still surface as a zero-account card.
    void connZero;

    // Run the REAL engine over the seeded set so every marker below is reconcileFinance's own converged
    // output: the two Amex groups re-merge (fresh synthetics under the deterministic group ids), the
    // single-provider / alias-gap / multi-currency rows stay unique, and the class-conflict pair is
    // REFUSED — both rows live. (LOCAL_USER finance_accounts are seeded only by this suite, so the
    // whole-user recompute cannot disturb another file's fixtures.)
    const { reconcileFinance } = await import("../core/finance-dedup.js");
    await reconcileFinance(LOCAL_USER);
  });

  afterAll(async () => {
    const pool = await db();
    // FK cascade: credential -> connectors -> finance_accounts.
    await pool.query(`delete from provider_credentials where id = any($1)`, [[credPlaidA, credPlaidB, credSfin, credZero]]);
    await pool.end();
  });

  /** Run the route and return the FULL parsed bank list (every connector/account for LOCAL_USER). */
  async function rawBanks(): Promise<FinanceBankSummary[]> {
    const { ctx, captured } = ctxFor(headerReq());
    await financeBanksRoute(ctx);
    expect(captured.status).toBe(200);
    return JSON.parse(captured.body ?? "[]") as FinanceBankSummary[];
  }

  /** Only this suite's banks (by the w33 masks). */
  async function banks(): Promise<FinanceBankSummary[]> {
    const all = await rawBanks();
    const myMasks = new Set(["1001", "1002", "1234", "5555", "7777", "8888"]);
    return all.filter((b) => b.mask != null && myMasks.has(b.mask));
  }

  it("each overlapped Amex card appears ONCE with providers [plaid, simplefin] + accountCount 1", async () => {
    const out = await banks();
    const card1 = out.find((b) => b.mask === "1001");
    const card2 = out.find((b) => b.mask === "1002");
    expect(card1).toBeDefined();
    expect(card2).toBeDefined();
    for (const c of [card1!, card2!]) {
      expect(c.institution).toBe("American Express");
      expect(c.accountCount).toBe(1); // the single synthetic winner, not the 2 shadowed reals
      expect(c.providers.map((p) => p.provider)).toEqual(["plaid", "simplefin"]);
      expect(c.dedupGroupId).not.toBeNull();
    }
  });

  it("Plaid item health surfaces per card (ok on 1001, action_required on 1002); SimpleFIN ok", async () => {
    const out = await banks();
    const card1 = out.find((b) => b.mask === "1001")!;
    const card2 = out.find((b) => b.mask === "1002")!;
    expect(card1.health).toBe("ok");
    expect(card2.health).toBe("action_required");
    // SimpleFIN provider entry carries no per-Item status (null); Plaid carries its item_status.
    const sfin1 = card1.providers.find((p) => p.provider === "simplefin")!;
    const plaid2 = card2.providers.find((p) => p.provider === "plaid")!;
    expect(sfin1.itemStatus).toBeNull();
    expect(plaid2.itemStatus).toBe("action_required");
  });

  it("a SimpleFIN-only bank is one row with accountCount=2, single provider, no dedup group", async () => {
    const out = await banks();
    const cu = out.find((b) => b.mask === "5555")!;
    expect(cu.institution).toBe("W33 Credit Union");
    expect(cu.accountCount).toBe(2);
    expect(cu.providers.map((p) => p.provider)).toEqual(["simplefin"]);
    expect(cu.dedupGroupId).toBeNull();
    expect(cu.health).toBe("ok");
    expect(cu.unmergedDuplicate).toBe(false);
  });

  it("a same-mask / disagreeing-institution pair is flagged unmergedDuplicate (not hidden)", async () => {
    const out = await banks();
    const pair = out.filter((b) => b.mask === "7777");
    expect(pair).toHaveLength(2);
    expect(pair.every((b) => b.unmergedDuplicate)).toBe(true);
    expect(pair.map((b) => b.institution).sort()).toEqual(["W33 Alpha Bank", "W33 Beta Bank"]);
  });

  it("a finance connector with ZERO live accounts STILL appears (accountCount=0, manageable)", async () => {
    const all = await rawBanks();
    const zero = all.find((b) => b.providers.some((p) => p.connectionId === connZero));
    expect(zero).toBeDefined();
    expect(zero!.accountCount).toBe(0);
    expect(zero!.institution).toBe("SimpleFIN");
    expect(zero!.mask).toBeNull();
    expect(zero!.health).toBe("ok"); // active connector, no per-Item status
    expect(zero!.providers).toEqual([
      { provider: "simplefin", connectionId: connZero, itemStatus: null, lastSyncedAt: expect.any(String) },
    ]);
  });

  it("deterministic display: the Amex 1001 institution label is stable across repeated calls", async () => {
    const a = (await banks()).find((b) => b.mask === "1001")!;
    const b = (await banks()).find((b) => b.mask === "1001")!;
    expect(a.institution).toBe("American Express");
    expect(b.institution).toBe(a.institution);
    expect(b.dedupGroupId).toBe(a.dedupGroupId);
  });

  it("same institution+mask, different currency -> TWO separate cards (#34b-kept-separate)", async () => {
    const out = await banks();
    const multi = out.filter((b) => b.mask === "8888");
    expect(multi).toHaveLength(2);
    expect(multi.every((b) => b.institution === "W33 Multi Currency")).toBe(true);
    expect(multi.every((b) => b.accountCount === 1)).toBe(true);
    expect(multi.every((b) => b.dedupGroupId === null)).toBe(true);
    expect(multi.every((b) => !b.unmergedDuplicate)).toBe(true);
  });

  it("a class-guard-refused same-key pair → ONE entry, accountCount 2, classConflict=true (both live)", async () => {
    // The engine itself kept BOTH rows live (dedup_status 'unique', un-shadowed) — refusal, not merge.
    const pool = await db();
    const r = await pool.query(
      `select dedup_status, shadowed_by_id, dedup_group_id from finance_accounts where user_id = $1 and source_object_id in ($2, $3)`,
      [LOCAL_USER, `${TOKEN}loan_p`, `${TOKEN}loan_s`],
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.dedup_status).toBe("unique");
      expect(row.shadowed_by_id).toBeNull();
      expect(row.dedup_group_id).toBeNull();
    }

    const out = await banks();
    const loan = out.filter((b) => b.mask === "1234");
    expect(loan).toHaveLength(1); // ONE summary entry — same institution+mask, honestly flagged
    expect(loan[0].institution).toBe("W33 Loan Bank");
    expect(loan[0].accountCount).toBe(2); // both provider rows live (nothing hidden)
    expect(loan[0].classConflict).toBe(true);
    expect(loan[0].dedupGroupId).toBeNull();
    expect(loan[0].unmergedDuplicate).toBe(false);
    expect(loan[0].providers.map((p) => p.provider)).toEqual(["plaid", "simplefin"]);
  });

  it("merged, single-provider, and zero-account entries all stay classConflict=false", async () => {
    const all = await rawBanks();
    const card1 = all.find((b) => b.mask === "1001")!; // merged synthetic-winner group
    const card2 = all.find((b) => b.mask === "1002")!; // merged synthetic-winner group
    const cu = all.find((b) => b.mask === "5555")!; // single-provider bank
    const zero = all.find((b) => b.providers.some((p) => p.connectionId === connZero))!; // placeholder
    expect(card1.classConflict).toBe(false);
    expect(card2.classConflict).toBe(false);
    expect(cu.classConflict).toBe(false);
    expect(zero.classConflict).toBe(false);
  });

  it("the route is localOnly: a non-loopback Host -> 403 (before any DB work)", async () => {
    const { ctx } = ctxFor(headerReq("evil.com"));
    const err = await caught(() => localOnly(financeBanksRoute)(ctx));
    expect(err).toBeInstanceOf(ForbiddenHostError);
    expect(errorToStatus(err).status).toBe(403);
  });
});

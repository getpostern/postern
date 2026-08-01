// Cross-provider finance dedup engine (#34b) — DB round-trips against a real Postgres (gated on
// DATABASE_URL, which the ADR-0015 guard forces to a *_test DB). Seeds provider rows DIRECTLY via raw
// SQL (the established direct-insert pattern — no connector code) under a DEDICATED throwaway user so
// parallel test files can't contend. Proves the acceptance criteria: the 3-row synthetic-union shape,
// no double-count, sign + balance-tuple coherence, the class/currency/mask guards, ±1-day txn matching,
// N-to-N count-reconcile, reversibility, truthful drill, single-provider untouched, the lockstep
// invariant, total-order determinism, and idempotency — plus the #36 holdings pass (symbol-keyed
// within account groups: tuple co-selection, the empty-symbol/intra-connection guards, out-of-group
// rows untouched, reversibility) and the review-fold regressions (spec finance-holding): the COMPOSED
// sweep-vs-synthetic case (the BLOCK), zombie resurrect via the UPSERT, and the tombstone-inclusive
// marker reset — plus the #37 hardening batch (spec dedup-hardening-flake-batch): tombstone-inclusive
// txn + accounts marker resets and the dissolved-tombstoned-synthetic GC on all three passes.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  reconcileFinance,
  canonicalInstitution,
  ENRICHED_COLUMNS,
  PROVIDER_RANK,
  listDedupCandidates,
  confirmDedupPair,
  unconfirmDedupPair,
  listDedupConfirmations,
  confirmationPairHash,
} from "./finance-dedup.js";
import { reconcileObjectSnapshot, buildUpsert } from "../sync/runner.js";
import { registerConnector, ingestRecords } from "../sync/index.js";
import { query, QueryValidationError } from "./query.js";
import { getRecord, NotFoundError } from "./context.js";
import { disconnectConnection } from "./lifecycle.js";
import { ALL_SECTORS, type AuthContext } from "../auth/index.js";
import { queue } from "../audit/queue.js";
import type { AuditEntry } from "../audit/index.js";
import type { Connector, RawRecord, SyncPolicy } from "../connectors/types.js";

const HAS_DB = !!process.env.DATABASE_URL;
const TEST_USER = "00000000-0000-0000-0000-0000000034b0";

const ctx: AuthContext = {
  userId: TEST_USER,
  agentId: "finance-dedup-test",
  grantedSectors: new Set(ALL_SECTORS),
};

// Lazily imported pool (so the file loads even when the DB suite is skipped).
let pool: typeof import("../db.js").pool;

/** Insert a connector for a provider; returns its connection_id. A fresh credential per connector. An
 *  optional itemId keys the credential's external_item_id (so two Plaid Items of one provider coexist —
 *  the user/provider-with-no-item unique index forbids two NULL-item creds for the same provider). */
async function makeConn(provider: string, itemId?: string): Promise<string> {
  const cred = await pool.query(
    `insert into provider_credentials (user_id, provider, custody, status, external_item_id)
     values ($1, $2, 'static_token', 'active', $3) returning id`,
    [TEST_USER, provider, itemId ?? null],
  );
  const conn = await pool.query(
    `insert into connectors (user_id, credential_id, sector, provider, status)
     values ($1, $2, 'finance', $3, 'active') returning id`,
    [TEST_USER, cred.rows[0].id, provider],
  );
  return conn.rows[0].id as string;
}

interface AcctInput {
  sid: string;
  name?: string | null;
  account_type?: string | null;
  currency?: string | null;
  current_balance?: string | null;
  available_balance?: string | null;
  balance_at?: string | null;
  balance_at_is_synthetic?: boolean;
  institution_name?: string | null;
  mask?: string | null;
  org_domain?: string | null;
  raw?: unknown;
}

async function insAccount(connId: string, a: AcctInput): Promise<string> {
  const r = await pool.query(
    `insert into finance_accounts
       (connection_id, user_id, source_object_id, name, account_type, currency, current_balance,
        available_balance, balance_at, balance_at_is_synthetic, institution_name, mask, org_domain, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [
      connId,
      TEST_USER,
      a.sid,
      a.name ?? null,
      a.account_type ?? null,
      a.currency ?? "USD",
      a.current_balance ?? null,
      a.available_balance ?? null,
      a.balance_at ?? "2026-06-20T00:00:00Z",
      a.balance_at_is_synthetic ?? false,
      a.institution_name ?? null,
      a.mask ?? null,
      a.org_domain ?? null,
      a.raw === undefined ? JSON.stringify({ sid: a.sid }) : a.raw === null ? null : JSON.stringify(a.raw),
    ],
  );
  return r.rows[0].id as string;
}

interface TxnInput {
  sid: string;
  account_source_id: string;
  posted_at: string;
  amount: string;
  currency?: string | null;
  description?: string | null;
  merchant?: string | null;
  pending?: boolean;
  category?: string | null;
}

async function insTxn(connId: string, t: TxnInput): Promise<string> {
  const r = await pool.query(
    `insert into finance_transactions
       (connection_id, user_id, source_object_id, account_source_id, posted_at, amount, currency,
        description, merchant, pending, category, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [
      connId,
      TEST_USER,
      t.sid,
      t.account_source_id,
      t.posted_at,
      t.amount,
      t.currency ?? "USD",
      t.description ?? null,
      t.merchant ?? null,
      t.pending ?? false,
      t.category ?? null,
      JSON.stringify({ sid: t.sid }),
    ],
  );
  return r.rows[0].id as string;
}

interface HoldingInput {
  sid: string;
  account_source_id: string;
  symbol?: string | null;
  name?: string | null;
  security_type?: string | null;
  quantity?: string | null;
  market_value?: string | null;
  cost_basis?: string | null;
  currency?: string | null;
  as_of?: string | null;
}

async function insHolding(connId: string, h: HoldingInput): Promise<string> {
  const r = await pool.query(
    `insert into finance_holdings
       (connection_id, user_id, source_object_id, account_source_id, symbol, name, security_type,
        quantity, market_value, cost_basis, currency, as_of, raw)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [
      connId,
      TEST_USER,
      h.sid,
      h.account_source_id,
      h.symbol ?? null,
      h.name ?? null,
      h.security_type ?? null,
      h.quantity ?? null,
      h.market_value ?? null,
      h.cost_basis ?? null,
      h.currency ?? null,
      h.as_of ?? "2026-06-20T00:00:00Z",
      JSON.stringify({ sid: h.sid }),
    ],
  );
  return r.rows[0].id as string;
}

/** All finance_accounts rows for the user (raw select, unfiltered). */
async function allAccounts(): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(
    `select * from finance_accounts where user_id = $1 order by dedup_status nulls first, source_object_id`,
    [TEST_USER],
  );
  return r.rows;
}
async function allTxns(): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(`select * from finance_transactions where user_id = $1`, [TEST_USER]);
  return r.rows;
}
async function allHoldings(): Promise<Array<Record<string, unknown>>> {
  const r = await pool.query(
    `select * from finance_holdings where user_id = $1 order by dedup_status nulls first, source_object_id`,
    [TEST_USER],
  );
  return r.rows;
}

describe.skipIf(!HAS_DB)("finance dedup engine (#34b)", () => {
  beforeAll(async () => {
    pool = (await import("../db.js")).pool;
    await pool.query(`insert into users (id, label) values ($1, 'dedup-34b-test') on conflict (id) do nothing`, [
      TEST_USER,
    ]);
  });

  afterAll(async () => {
    await pool.query(`delete from finance_transactions where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from finance_holdings where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from finance_accounts where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from connectors where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from provider_credentials where user_id = $1`, [TEST_USER]);
  });

  beforeEach(async () => {
    // Order matters: txns/holdings + accounts reference connectors; connectors reference credentials.
    await pool.query(`delete from finance_transactions where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from finance_holdings where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from finance_accounts where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from connectors where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from provider_credentials where user_id = $1`, [TEST_USER]);
  });

  // ── canonicalInstitution (pure) ─────────────────────────────────────────────
  it("canonicalInstitution: org.domain primary, name-fold + alias fallback", () => {
    expect(canonicalInstitution("americanexpress.com", "American Express")).toBe("americanexpress");
    expect(canonicalInstitution("client.schwab.com", null)).toBe("schwab");
    expect(canonicalInstitution("card.apple.com", null)).toBe("apple");
    expect(canonicalInstitution("www.chase.com", null)).toBe("chase");
    // domain absent → name-fold; the alias map merges Amex ↔ American Express
    expect(canonicalInstitution(null, "American Express")).toBe("americanexpress");
    expect(canonicalInstitution(null, "Amex")).toBe("americanexpress");
    expect(canonicalInstitution(null, null)).toBeNull();
  });

  // ── Two-provider overlap shape + no double-count + sign + balance tuple ──────────────
  it("the two-provider Amex overlap dedups to one synthetic per card + per txn pair; reals shadowed + pristine", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");

    // 2 Amex cards in BOTH providers. Plaid: synthetic balance_at; SimpleFIN: real balance_at + domain.
    await insAccount(plaid, { sid: "p-4318", name: "Platinum Card", account_type: "credit", current_balance: "-742.19", available_balance: "20000", balance_at: "2026-06-25T10:00:00Z", balance_at_is_synthetic: true, institution_name: "American Express", mask: "4318", org_domain: null, raw: { mask: "4318" } });
    await insAccount(sfin, { sid: "s-4318", name: "Platinum Card (4318)", account_type: null, current_balance: "-742.19", available_balance: "0", balance_at: "2026-06-20T08:00:00Z", balance_at_is_synthetic: false, institution_name: "American Express", mask: "4318", org_domain: "americanexpress.com", raw: { org: { domain: "americanexpress.com" } } });
    await insAccount(plaid, { sid: "p-4327", name: "Blue Cash", account_type: "credit", current_balance: "-1264.50", available_balance: "15000", balance_at: "2026-06-25T10:00:00Z", balance_at_is_synthetic: true, institution_name: "American Express", mask: "4327", org_domain: null });
    await insAccount(sfin, { sid: "s-4327", name: "Blue Cash (4327)", account_type: null, current_balance: "-1264.50", available_balance: "0", balance_at: "2026-06-20T08:00:00Z", balance_at_is_synthetic: false, institution_name: "American Express", mask: "4327", org_domain: "americanexpress.com" });

    // Card 4318 txns: 5 matched pairs (same amount, same/±1 day) + 3 plaid-only leading-edge (unique amounts).
    for (let i = 0; i < 5; i++) {
      const amt = `-${10 + i}.00`;
      await insTxn(sfin, { sid: `s-t${i}`, account_source_id: "s-4318", posted_at: `2026-06-1${i}T00:00:00Z`, amount: amt });
      await insTxn(plaid, { sid: `p-t${i}`, account_source_id: "p-4318", posted_at: `2026-06-1${i}T12:00:00Z`, amount: amt, category: "FOOD_AND_DRINK" });
    }
    for (let i = 0; i < 3; i++) {
      await insTxn(plaid, { sid: `p-lead${i}`, account_source_id: "p-4318", posted_at: `2026-06-2${i}T12:00:00Z`, amount: `-${500 + i}.00` });
    }

    const res = await reconcileFinance(TEST_USER);
    expect(res.accountGroups).toBe(2);
    expect(res.syntheticAccounts).toBe(2);
    expect(res.created).toBeGreaterThan(0);

    const accts = await allAccounts();
    const winners = accts.filter((a) => a.dedup_status === "winner");
    const shadows = accts.filter((a) => a.dedup_status === "shadow");
    expect(winners).toHaveLength(2);
    expect(shadows).toHaveLength(4);
    // Synthetic identity: union source_object_id + null raw; every real stays pristine (its own raw).
    for (const w of winners) {
      expect(String(w.source_object_id)).toMatch(/^union:americanexpress:(4318|4327)$/);
      expect(w.raw).toBeNull();
      expect(w.shadowed_by_id).toBeNull();
    }
    for (const s of shadows) {
      expect(s.shadowed_by_id).not.toBeNull();
      expect(s.raw).not.toBeNull(); // pristine — its own provider raw
    }

    // Txns: 5 synthetic winners (one per matched pair), 10 reals shadowed, 3 plaid-only LIVE 'pending'.
    const txns = await allTxns();
    expect(txns.filter((t) => t.dedup_status === "winner")).toHaveLength(5);
    expect(txns.filter((t) => t.dedup_status === "shadow")).toHaveLength(10);
    expect(txns.filter((t) => t.dedup_status === "pending")).toHaveLength(3);

    // query() serves only winners + LIVE rows (no double-count): 2 accounts, 8 txns (5 synth + 3 pending).
    const accountRows = await query(ctx, { sector: "finance.account" });
    expect(accountRows.count).toBe(2);
    const txnRows = await query(ctx, { sector: "finance.transaction", limit: 500 });
    expect(txnRows.count).toBe(8);

    // No double-count: sum(current_balance) over served accounts = the two signed balances exactly once.
    const balSum = (await query(ctx, { sector: "finance.account", aggregate: { fn: "sum", field: "current_balance" } })) as { groups: Array<{ value: unknown }> };
    expect(Number(balSum.groups[0].value)).toBeCloseTo(-742.19 + -1264.5, 2);

    // Sign coherence (#34a): the 4318 synthetic serves the single signed −742.19, not ~0.
    const w4318 = winners.find((w) => w.source_object_id === "union:americanexpress:4318")!;
    expect(Number(w4318.current_balance)).toBeCloseTo(-742.19, 2);

    // Balance-tuple coherence: the synthetic serves SimpleFIN's (balance, REAL as-of) co-selected together,
    // flag=false; AND Plaid's account_type 'credit' (enrichment, rule 2); plus its own union id.
    expect(w4318.balance_at_is_synthetic).toBe(false);
    expect(new Date(w4318.balance_at as string).toISOString()).toBe("2026-06-20T08:00:00.000Z");
    expect(w4318.account_type).toBe("credit");
    // available_balance per-type: a credit card trusts Plaid (limit-derived), never SimpleFIN's garbage 0.
    expect(Number(w4318.available_balance)).toBeCloseTo(20000, 2);
  });

  // ── Truthful drill: both reals drillable verbatim; synthetic raw null ────────
  it("getRecord drills both reals verbatim (own raw + markers); the synthetic raw is null", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    const pid = await insAccount(plaid, { sid: "p-x", name: "Card", account_type: "credit", current_balance: "-5.00", institution_name: "American Express", mask: "4242", raw: { mask: "4242", provider: "plaid" } });
    const sid = await insAccount(sfin, { sid: "s-x", name: "Card (4242)", current_balance: "-5.00", institution_name: "American Express", mask: "4242", org_domain: "americanexpress.com", raw: { org: { domain: "americanexpress.com" } } });
    await reconcileFinance(TEST_USER);

    const pReal = await getRecord(ctx, "finance.account", pid);
    const sReal = await getRecord(ctx, "finance.account", sid);
    expect((pReal as Record<string, unknown>).dedup_status).toBe("shadow");
    expect((pReal as Record<string, unknown>).shadowed_by_id).not.toBeNull();
    expect((pReal as { raw: { provider?: string } }).raw.provider).toBe("plaid"); // OWN verbatim raw
    expect((sReal as { raw: { org?: { domain?: string } } }).raw.org?.domain).toBe("americanexpress.com");

    const winnerId = (pReal as Record<string, unknown>).shadowed_by_id as string;
    const synth = await getRecord(ctx, "finance.account", winnerId);
    expect((synth as Record<string, unknown>).dedup_status).toBe("winner");
    expect((synth as Record<string, unknown>).raw).toBeNull();
  });

  // ── Class guard ─────────────────────────────────────────────────────────────
  it("class guard: a $0 paid-off card still dedups; a confident card↔checking conflict refuses", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    // $0 paid-off card (no balance sign signal) — SimpleFIN inferred liability via the 'card' name keyword.
    await insAccount(plaid, { sid: "p-card", name: "Card", account_type: "credit", current_balance: "0", institution_name: "American Express", mask: "7178", raw: { mask: "7178" } });
    await insAccount(sfin, { sid: "s-card", name: "Paid Card (7178)", current_balance: "0", institution_name: "American Express", mask: "7178", org_domain: "americanexpress.com" });
    const r1 = await reconcileFinance(TEST_USER);
    expect(r1.accountGroups).toBe(1); // dedups despite $0

    // A CONFIDENT class conflict: plaid 'depository' (asset) vs simplefin 'loan' name (liability) → no merge.
    await pool.query(`delete from finance_accounts where user_id = $1`, [TEST_USER]);
    await insAccount(plaid, { sid: "p-chk", name: "Checking", account_type: "depository", current_balance: "100", institution_name: "American Express", mask: "9999", raw: { mask: "9999" } });
    await insAccount(sfin, { sid: "s-loan", name: "Auto Loan (9999)", current_balance: "-100", institution_name: "American Express", mask: "9999", org_domain: "americanexpress.com" });
    const r2 = await reconcileFinance(TEST_USER);
    expect(r2.accountGroups).toBe(0);
    const accts = await allAccounts();
    expect(accts.filter((a) => a.dedup_status === "unique")).toHaveLength(2);
    expect(accts.filter((a) => a.dedup_status === "winner")).toHaveLength(0);
  });

  // ── Currency match + exactly-4-digit mask ──────────────────────────────────
  it("currency mismatch and a non-4-digit mask both refuse the merge", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    // Same mask + institution but different currency → no merge.
    await insAccount(plaid, { sid: "p-usd", name: "Card", account_type: "credit", currency: "USD", institution_name: "American Express", mask: "1111", raw: { mask: "1111" } });
    await insAccount(sfin, { sid: "s-eur", name: "Card (1111)", currency: "EUR", institution_name: "American Express", mask: "1111", org_domain: "americanexpress.com" });
    const r1 = await reconcileFinance(TEST_USER);
    expect(r1.accountGroups).toBe(0);

    await pool.query(`delete from finance_accounts where user_id = $1`, [TEST_USER]);
    // A short/alpha mask on one side → no key → no merge.
    await insAccount(plaid, { sid: "p-alpha", name: "Card", account_type: "credit", institution_name: "American Express", mask: "2AW9", raw: { mask: "2AW9" } });
    await insAccount(sfin, { sid: "s-noms", name: "401k", institution_name: "American Express", mask: null, org_domain: "americanexpress.com" });
    const r2 = await reconcileFinance(TEST_USER);
    expect(r2.accountGroups).toBe(0);
  });

  // ── ±1-day tolerance + N-to-N count reconcile ──────────────────────────────
  it("±1-day txn tolerance pairs across a UTC boundary; N-to-N leaves a leftover LIVE ambiguous", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-a", name: "Card", account_type: "credit", institution_name: "American Express", mask: "3333", raw: { mask: "3333" } });
    await insAccount(sfin, { sid: "s-a", name: "Card (3333)", institution_name: "American Express", mask: "3333", org_domain: "americanexpress.com" });

    // ±1-day: SimpleFIN posted one calendar day before Plaid date, same amount → still pairs.
    await insTxn(sfin, { sid: "s-day", account_source_id: "s-a", posted_at: "2026-06-09T23:00:00Z", amount: "-42.00" });
    await insTxn(plaid, { sid: "p-day", account_source_id: "p-a", posted_at: "2026-06-10T01:00:00Z", amount: "-42.00" });

    // N-to-N: SimpleFIN 3×$30, Plaid 2×$30 (same day) → 2 synthetic pairs + 1 leftover LIVE 'ambiguous'.
    for (let i = 0; i < 3; i++) await insTxn(sfin, { sid: `s-30-${i}`, account_source_id: "s-a", posted_at: "2026-06-15T00:00:00Z", amount: "-30.00" });
    for (let i = 0; i < 2; i++) await insTxn(plaid, { sid: `p-30-${i}`, account_source_id: "p-a", posted_at: "2026-06-15T00:00:00Z", amount: "-30.00" });

    await reconcileFinance(TEST_USER);
    const txns = await allTxns();
    // 1 (day pair) + 2 ($30 pairs) = 3 synthetic winners; 6 reals shadowed; 1 leftover ambiguous.
    expect(txns.filter((t) => t.dedup_status === "winner")).toHaveLength(3);
    expect(txns.filter((t) => t.dedup_status === "shadow")).toHaveLength(6);
    expect(txns.filter((t) => t.dedup_status === "ambiguous")).toHaveLength(1);
    // Money is never dropped/merged: the served txns = 3 winners + 1 ambiguous = 4 (no double-count of pairs).
    const served = await query(ctx, { sector: "finance.transaction", limit: 500 });
    expect(served.count).toBe(4);
  });

  // ── Same-provider double-count (two Plaid Items, one card) ─────────────────
  it("two Plaid Items reporting the SAME charge on one card collapse to ONE served txn (no double-count)", async () => {
    // The card is connected via TWO distinct Plaid Items (two connectors, same provider) — the account pass
    // already merges them (mask+institution, ≥2 connection_ids). The txn pass must collapse the duplicate
    // charge too, not leave both LIVE in b.plaid (the #34b same-provider double-count bug).
    const plaidA = await makeConn("plaid", "item-A");
    const plaidB = await makeConn("plaid", "item-B");
    await insAccount(plaidA, { sid: "pa-acct", name: "Card", account_type: "credit", current_balance: "-9.99", institution_name: "American Express", mask: "4040", raw: { mask: "4040", item: "A" } });
    await insAccount(plaidB, { sid: "pb-acct", name: "Card", account_type: "credit", current_balance: "-9.99", institution_name: "American Express", mask: "4040", raw: { mask: "4040", item: "B" } });

    // The SAME real −9.99 charge on the same card, reported by BOTH Plaid Items on the same day.
    await insTxn(plaidA, { sid: "pa-t", account_source_id: "pa-acct", posted_at: "2026-06-12T00:00:00Z", amount: "-9.99" });
    await insTxn(plaidB, { sid: "pb-t", account_source_id: "pb-acct", posted_at: "2026-06-12T00:00:00Z", amount: "-9.99" });

    const res = await reconcileFinance(TEST_USER);
    expect(res.accountGroups).toBe(1); // the two Items merge into one account group

    const txns = await allTxns();
    // Exactly ONE synthetic winner; BOTH reals shadowed; none left LIVE.
    expect(txns.filter((t) => t.dedup_status === "winner")).toHaveLength(1);
    expect(txns.filter((t) => t.dedup_status === "shadow")).toHaveLength(2);
    expect(txns.filter((t) => t.dedup_status === "pending")).toHaveLength(0);
    expect(txns.filter((t) => t.dedup_status === "ambiguous")).toHaveLength(0);

    // query() serves exactly ONE −9.99 txn — sum(amount) = −9.99, NOT −19.98 (the bug).
    const served = await query(ctx, { sector: "finance.transaction", limit: 500 });
    expect(served.count).toBe(1);
    const amtSum = (await query(ctx, { sector: "finance.transaction", aggregate: { fn: "sum", field: "amount" } })) as { groups: Array<{ value: unknown }> };
    expect(Number(amtSum.groups[0].value)).toBeCloseTo(-9.99, 2);
  });

  // ── Reversibility: provider disconnected ───────────────────────────────────
  it("reversibility: disconnecting one provider drops the synthetic and the survivor un-shadows + serves", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-rev", name: "Card", account_type: "credit", current_balance: "-9.00", institution_name: "American Express", mask: "5555", raw: { mask: "5555" } });
    await insAccount(sfin, { sid: "s-rev", name: "Card (5555)", current_balance: "-9.00", institution_name: "American Express", mask: "5555", org_domain: "americanexpress.com" });
    await reconcileFinance(TEST_USER);
    expect((await allAccounts()).filter((a) => a.dedup_status === "winner")).toHaveLength(1);

    // Disconnect the Plaid connection (hard-removes its rows AND runs reconcile in the disconnect path).
    await disconnectConnection(ctx, plaid, { confirmToken: plaid });

    const accts = await allAccounts();
    expect(accts.filter((a) => a.dedup_status === "winner")).toHaveLength(0); // synthetic dropped
    const survivor = accts.find((a) => a.source_object_id === "s-rev")!;
    expect(survivor.shadowed_by_id).toBeNull(); // un-shadowed
    // The survivor serves immediately (no waiting for a sync).
    const served = await query(ctx, { sector: "finance.account" });
    expect(served.count).toBe(1);
    expect((served.rows as Array<Record<string, unknown>>)[0].source_object_id).toBe("s-rev");
  });

  // ── Idempotency + total-order determinism ──────────────────────────────────
  it("re-running on a converged state is a NO-OP (created=recomputed=dropped=0)", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-id", name: "Card", account_type: "credit", current_balance: "-1.00", institution_name: "American Express", mask: "8888", raw: { mask: "8888" } });
    await insAccount(sfin, { sid: "s-id", name: "Card (8888)", current_balance: "-1.00", institution_name: "American Express", mask: "8888", org_domain: "americanexpress.com" });
    await insTxn(sfin, { sid: "s-id-t", account_source_id: "s-id", posted_at: "2026-06-10T00:00:00Z", amount: "-7.00" });
    await insTxn(plaid, { sid: "p-id-t", account_source_id: "p-id", posted_at: "2026-06-10T00:00:00Z", amount: "-7.00" });

    const first = await reconcileFinance(TEST_USER);
    expect(first.created).toBeGreaterThan(0);
    const synthIdBefore = (await allAccounts()).find((a) => a.dedup_status === "winner")!.id;

    const second = await reconcileFinance(TEST_USER);
    expect(second.created).toBe(0);
    expect(second.recomputed).toBe(0);
    expect(second.dropped).toBe(0);
    // The synthetic id is STABLE across runs (UPDATE preserves it) — deterministic, no flapping.
    const synthIdAfter = (await allAccounts()).find((a) => a.dedup_status === "winner")!.id;
    expect(synthIdAfter).toBe(synthIdBefore);
  });

  // ── Single-provider untouched ──────────────────────────────────────────────
  it("a single-provider account is never given a synthetic and serves verbatim", async () => {
    const sfin = await makeConn("simplefin");
    await insAccount(sfin, { sid: "solo", name: "Solo Checking", current_balance: "123.45", institution_name: "Chase", mask: "0001", org_domain: "chase.com" });
    const r = await reconcileFinance(TEST_USER);
    expect(r.accountGroups).toBe(0);
    expect(r.created).toBe(0);
    const accts = await allAccounts();
    expect(accts).toHaveLength(1);
    expect(accts[0].dedup_status).toBe("unique");
    expect(accts[0].shadowed_by_id).toBeNull();
    const served = await query(ctx, { sector: "finance.account" });
    expect(served.count).toBe(1);
    expect(Number((served.rows as Array<Record<string, unknown>>)[0].current_balance)).toBeCloseTo(123.45, 2);
  });

  // ── Holdings pass (#36): symbol-keyed dedup anchored on the account groups ──
  it("holdings: two-provider CTSO → ONE served row; tuple co-selected from the fresher as_of; reals pristine", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    // The same Fidelity brokerage via both providers → an account dedup group (the holdings anchor).
    await insAccount(plaid, { sid: "p-brok", name: "Brokerage", account_type: "investment", current_balance: "3000", institution_name: "Fidelity", mask: "4444", raw: { mask: "4444" } });
    await insAccount(sfin, { sid: "s-brok", name: "Brokerage (4444)", current_balance: "3000", institution_name: "Fidelity", mask: "4444", org_domain: "fidelity.com" });

    // SimpleFIN is the FRESHER snapshot (as_of 06-26): the winner tuple must come from IT, not provider
    // rank. Its raw symbol is 'ctso ' (lowercase + space) to prove uppercase-trim key normalization.
    const pHold = await insHolding(plaid, { sid: "p-brok:sec-ctso", account_source_id: "p-brok", symbol: "CTSO", name: "Contoso Semiconductor Inc", security_type: "equity", quantity: "10", market_value: "2000", cost_basis: "1500", currency: "USD", as_of: "2026-06-25T00:00:00Z" });
    const sHold = await insHolding(sfin, { sid: "HOL-ctso", account_source_id: "s-brok", symbol: "ctso ", name: "CONTOSO SEMICONDUCTOR INC", quantity: "10", market_value: "1990", currency: "USD", as_of: "2026-06-26T00:00:00Z" });

    const res = await reconcileFinance(TEST_USER);
    expect(res.accountGroups).toBe(1);
    expect(res.syntheticHoldings).toBe(1);
    expect(res.holdingsShadowed).toBe(2);

    const holds = await allHoldings();
    const winner = holds.find((h) => h.dedup_status === "winner")!;
    const shadows = holds.filter((h) => h.dedup_status === "shadow");
    expect(shadows).toHaveLength(2);
    // Synthetic identity: deterministic union soid over the group key + NORMALIZED symbol; raw null.
    expect(winner.source_object_id).toBe("union:holding:fidelity:4444:CTSO");
    expect(winner.raw).toBeNull();
    expect(winner.symbol).toBe("CTSO");
    // The tuple is co-selected as ONE snapshot from the freshest-as_of member (SimpleFIN): its
    // market_value/as_of serve together, and cost_basis is the tuple's NULL — never Plaid's 1500
    // mixed in (best-per-field across members would fabricate a snapshot that never existed).
    expect(Number(winner.market_value)).toBeCloseTo(1990, 2);
    expect(winner.cost_basis).toBeNull();
    expect(new Date(winner.as_of as string).toISOString()).toBe("2026-06-26T00:00:00.000Z");
    // name/security_type/currency stay best-per-field: security_type from Plaid (the only non-null side).
    expect(winner.security_type).toBe("equity");
    // The winner-tuple provider anchors the synthetic (connection + parent-account link stay coherent).
    expect(winner.connection_id).toBe(sfin);
    expect(winner.account_source_id).toBe("s-brok");

    // Both reals shadowed + drillable PRISTINE (their own raw, untouched).
    for (const s of shadows) {
      expect(s.shadowed_by_id).toBe(winner.id);
      expect(s.raw).not.toBeNull();
    }
    expect(((await getRecord(ctx, "finance.holding", pHold)) as { raw: { sid?: string } }).raw.sid).toBe("p-brok:sec-ctso");
    expect(((await getRecord(ctx, "finance.holding", sHold)) as { raw: { sid?: string } }).raw.sid).toBe("HOL-ctso");

    // query() serves ONE row; sum(market_value) counts the position ONCE (1990, never 3990).
    const served = await query(ctx, { sector: "finance.holding" });
    expect(served.count).toBe(1);
    const mvSum = (await query(ctx, { sector: "finance.holding", aggregate: { fn: "sum", field: "market_value" } })) as { groups: Array<{ value: unknown }> };
    expect(Number(mvSum.groups[0].value)).toBeCloseTo(1990, 2);

    // Idempotent: a converged re-run writes nothing.
    const second = await reconcileFinance(TEST_USER);
    expect(second.created).toBe(0);
    expect(second.recomputed).toBe(0);
    expect(second.dropped).toBe(0);
  });

  it("holdings: empty-symbol cash rows NEVER merge (fail-open) — both stay LIVE", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-brok", name: "Brokerage", account_type: "investment", current_balance: "500", institution_name: "Fidelity", mask: "4444", raw: { mask: "4444" } });
    await insAccount(sfin, { sid: "s-brok", name: "Brokerage (4444)", current_balance: "500", institution_name: "Fidelity", mask: "4444", org_domain: "fidelity.com" });
    // SimpleFIN CASH rows carry an EMPTY symbol; Plaid cash may carry none either — no key, no merge.
    await insHolding(plaid, { sid: "p-cash", account_source_id: "p-brok", symbol: null, name: "US Dollar", market_value: "500" });
    await insHolding(sfin, { sid: "HOL-cash", account_source_id: "s-brok", symbol: "", name: "CASH", market_value: "500" });

    const res = await reconcileFinance(TEST_USER);
    expect(res.syntheticHoldings).toBe(0);

    const holds = await allHoldings();
    expect(holds.filter((h) => h.dedup_status === "winner")).toHaveLength(0);
    expect(holds.filter((h) => h.dedup_status === "unique")).toHaveLength(2); // fail-open visible dupes
    const served = await query(ctx, { sector: "finance.holding", limit: 50 });
    expect(served.count).toBe(2); // both LIVE — an honest dupe beats a wrong merge
  });

  it("holdings: a same-symbol intra-connection duplicate marks the bucket ambiguous — all LIVE, no synthetic", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-brok", name: "Brokerage", account_type: "investment", current_balance: "900", institution_name: "Fidelity", mask: "4444", raw: { mask: "4444" } });
    await insAccount(sfin, { sid: "s-brok", name: "Brokerage (4444)", current_balance: "900", institution_name: "Fidelity", mask: "4444", org_domain: "fidelity.com" });
    // SimpleFIN reports VTI TWICE within one connection (duplicate share classes / lots under one ticker).
    await insHolding(sfin, { sid: "HOL-vti-1", account_source_id: "s-brok", symbol: "VTI", market_value: "300" });
    await insHolding(sfin, { sid: "HOL-vti-2", account_source_id: "s-brok", symbol: "VTI", market_value: "300" });
    await insHolding(plaid, { sid: "p-vti", account_source_id: "p-brok", symbol: "VTI", market_value: "600" });

    const res = await reconcileFinance(TEST_USER);
    expect(res.syntheticHoldings).toBe(0);

    const holds = await allHoldings();
    expect(holds.filter((h) => h.dedup_status === "winner")).toHaveLength(0);
    expect(holds.filter((h) => h.dedup_status === "ambiguous")).toHaveLength(3); // the whole bucket, flagged
    const served = await query(ctx, { sector: "finance.holding", limit: 50 });
    expect(served.count).toBe(3); // positions are never dropped
  });

  it("holdings: rows whose parent account is OUTSIDE any dedup group are never touched", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    // The grouped brokerage pair (CTSO merges within it) …
    await insAccount(plaid, { sid: "p-brok", name: "Brokerage", account_type: "investment", current_balance: "2000", institution_name: "Fidelity", mask: "4444", raw: { mask: "4444" } });
    await insAccount(sfin, { sid: "s-brok", name: "Brokerage (4444)", current_balance: "2000", institution_name: "Fidelity", mask: "4444", org_domain: "fidelity.com" });
    await insHolding(plaid, { sid: "p-ctso", account_source_id: "p-brok", symbol: "CTSO", market_value: "2000", as_of: "2026-06-25T00:00:00Z" });
    await insHolding(sfin, { sid: "HOL-ctso", account_source_id: "s-brok", symbol: "CTSO", market_value: "1990", as_of: "2026-06-26T00:00:00Z" });
    // … plus a single-provider Schwab account holding the SAME ticker — outside every group.
    await insAccount(sfin, { sid: "s-solo", name: "Solo Brokerage (9876)", current_balance: "700", institution_name: "Schwab", mask: "9876", org_domain: "schwab.com" });
    const soloHold = await insHolding(sfin, { sid: "HOL-solo-ctso", account_source_id: "s-solo", symbol: "CTSO", market_value: "700" });

    const res = await reconcileFinance(TEST_USER);
    expect(res.accountGroups).toBe(1);
    expect(res.syntheticHoldings).toBe(1); // only the in-group pair merged

    // The solo holding is UNTOUCHED — no marker at all — and still serves alongside the winner.
    const solo = (await allHoldings()).find((h) => h.id === soloHold)!;
    expect(solo.dedup_status).toBeNull();
    expect(solo.shadowed_by_id).toBeNull();
    const served = await query(ctx, { sector: "finance.holding", limit: 50 });
    expect(served.count).toBe(2); // the synthetic winner + the solo row
  });

  it("holdings reversibility: disconnecting one provider drops the synthetic; the survivor un-shadows + serves", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-brok", name: "Brokerage", account_type: "investment", current_balance: "2000", institution_name: "Fidelity", mask: "4444", raw: { mask: "4444" } });
    await insAccount(sfin, { sid: "s-brok", name: "Brokerage (4444)", current_balance: "2000", institution_name: "Fidelity", mask: "4444", org_domain: "fidelity.com" });
    await insHolding(plaid, { sid: "p-ctso", account_source_id: "p-brok", symbol: "CTSO", market_value: "2000", as_of: "2026-06-25T00:00:00Z" });
    await insHolding(sfin, { sid: "HOL-ctso", account_source_id: "s-brok", symbol: "CTSO", market_value: "1990", as_of: "2026-06-26T00:00:00Z" });
    await reconcileFinance(TEST_USER);
    expect((await allHoldings()).filter((h) => h.dedup_status === "winner")).toHaveLength(1);

    // Disconnect Plaid. The synthetic is anchored on the SURVIVOR's connection (SimpleFIN held the
    // fresher tuple), so this exercises the ENGINE's drop path, not the FK cascade.
    await disconnectConnection(ctx, plaid, { confirmToken: plaid });

    const holds = await allHoldings();
    expect(holds.filter((h) => h.dedup_status === "winner")).toHaveLength(0); // synthetic dropped
    const survivor = holds.find((h) => h.source_object_id === "HOL-ctso")!;
    expect(survivor.shadowed_by_id).toBeNull(); // un-shadowed
    expect(survivor.dedup_status).toBeNull(); // marker fully reset — back to an untouched row
    const served = await query(ctx, { sector: "finance.holding" });
    expect(served.count).toBe(1);
    expect((served.rows as Array<Record<string, unknown>>)[0].source_object_id).toBe("HOL-ctso");
    expect(Number((served.rows as Array<Record<string, unknown>>)[0].market_value)).toBeCloseTo(1990, 2);
  });

  // ── Review-fold regressions (spec finance-holding, BLOCK ×3) ────────────────

  /** Seed the two-provider Fidelity brokerage + CTSO on both sides and converge the dedup.
   *  Returns the ids/handles the composed regressions drill into. SimpleFIN holds the fresher
   *  as_of, so ITS connection anchors the synthetic — the anchor whose next sync used to kill it. */
  async function convergeCtsoPair(): Promise<{ plaid: string; sfin: string; winnerId: string }> {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-brok", name: "Brokerage", account_type: "investment", current_balance: "2000", institution_name: "Fidelity", mask: "4444", raw: { mask: "4444" } });
    await insAccount(sfin, { sid: "s-brok", name: "Brokerage (4444)", current_balance: "2000", institution_name: "Fidelity", mask: "4444", org_domain: "fidelity.com" });
    await insHolding(plaid, { sid: "p-ctso", account_source_id: "p-brok", symbol: "CTSO", market_value: "2000", as_of: "2026-06-25T00:00:00Z" });
    await insHolding(sfin, { sid: "HOL-ctso", account_source_id: "s-brok", symbol: "CTSO", market_value: "1990", as_of: "2026-06-26T00:00:00Z" });
    await reconcileFinance(TEST_USER);
    const winner = (await allHoldings()).find((h) => h.dedup_status === "winner")!;
    expect(winner.source_object_id).toBe("union:holding:fidelity:4444:CTSO");
    expect(winner.connection_id).toBe(sfin); // the fresher-tuple provider anchors the synthetic
    return { plaid, sfin, winnerId: winner.id as string };
  }

  it("THE COMPOSED CASE (the BLOCK): the anchor connection's next full sync never tombstones the synthetic; the next reconcile is a clean no-op", async () => {
    const { sfin, winnerId } = await convergeCtsoPair();

    // The anchor connection's NEXT full sync: the connector re-upserts its REAL holdings fresh
    // (the runner's exact live-write — ingested_at >= the new startedAt, deleted_at = null) and then
    // sweeps with exactly the source-reported ids. The synthetic ('union:…', anchored on THIS
    // connection, ingested before startedAt, never source-reported) used to be tombstoned here.
    const startedAt = new Date();
    const { sql, values } = buildUpsert("finance_holdings", {
      connection_id: sfin,
      user_id: TEST_USER,
      source_object_id: "HOL-ctso",
      account_source_id: "s-brok",
      symbol: "CTSO",
      market_value: "1990",
      as_of: "2026-06-26T00:00:00Z",
      raw: JSON.stringify({ sid: "HOL-ctso" }),
      ingested_at: new Date(),
      deleted_at: null,
    });
    await pool.query(sql, values);
    const swept = await reconcileObjectSnapshot(sfin, "finance", "holding", new Set(["HOL-ctso"]), startedAt);

    // The sweep touches NOTHING: the real is fresh + source-reported; the synthetic is engine-owned
    // ('union:%' — reserved namespace, excluded from the predicate AND from the returned count).
    expect(swept).toBe(0);
    const winner = (await allHoldings()).find((h) => h.id === winnerId)!;
    expect(winner.deleted_at).toBeNull(); // the synthetic SURVIVES its anchor's sync

    // query() still serves the position exactly ONCE.
    const served = await query(ctx, { sector: "finance.holding", limit: 50 });
    expect(served.count).toBe(1);
    expect((served.rows as Array<Record<string, unknown>>)[0].source_object_id).toBe("union:holding:fidelity:4444:CTSO");

    // The subsequent reconcile completes WITHOUT the unique-key throw and is a converged NO-OP —
    // dedup never freezes (the old failure: zombie collision → rollback → best-effort swallow → frozen).
    const after = await reconcileFinance(TEST_USER);
    expect(after.created).toBe(0);
    expect(after.recomputed).toBe(0);
    expect(after.dropped).toBe(0);
    expect(after.syntheticHoldings).toBe(1);
    expect((await query(ctx, { sector: "finance.holding", limit: 50 })).count).toBe(1);
  });

  it("zombie resurrect: a hand-tombstoned union row is resurrected + recomputed IN PLACE by the UPSERT (no throw, same id)", async () => {
    const { winnerId } = await convergeCtsoPair();

    // Force the pre-fix wedge state: the union row tombstoned (live, before the sweep exemption,
    // the anchor's sync did exactly this) while both reals still form a valid group.
    await pool.query(`update finance_holdings set deleted_at = now() where id = $1`, [winnerId]);

    // The old CREATE branch blind-INSERTed the same soid here (the zombie is invisible to the
    // existing-synth diff, which filters deleted_at is null) → unique-key collision → the WHOLE
    // reconcile transaction rolled back. The UPSERT resurrects/recomputes instead.
    const res = await reconcileFinance(TEST_USER);
    expect(res.created).toBe(1); // took the CREATE path — as an upsert onto the zombie

    const winner = (await allHoldings()).find((h) => h.dedup_status === "winner")!;
    expect(winner.id).toBe(winnerId); // resurrected IN PLACE — the shadows' pointers stay coherent
    expect(winner.deleted_at).toBeNull();
    expect(winner.raw).toBeNull();
    expect(Number(winner.market_value)).toBeCloseTo(1990, 2); // fully recomputed from the live group

    // Served rows correct: the position exactly once, both reals still shadowed at the same winner.
    const served = await query(ctx, { sector: "finance.holding", limit: 50 });
    expect(served.count).toBe(1);
    const shadows = (await allHoldings()).filter((h) => h.dedup_status === "shadow");
    expect(shadows).toHaveLength(2);
    for (const s of shadows) expect(s.shadowed_by_id).toBe(winnerId);

    // And the run after THAT is a converged no-op (no flapping).
    const again = await reconcileFinance(TEST_USER);
    expect(again.created).toBe(0);
    expect(again.recomputed).toBe(0);
    expect(again.dropped).toBe(0);
  });

  it("marker reset includes TOMBSTONED reals: a shadowed holding tombstoned while its group persists sheds its stale markers", async () => {
    const { plaid, sfin, winnerId } = await convergeCtsoPair();

    // The plaid real vanishes from its provider's snapshot → tombstoned (its parent account group
    // PERSISTS — both accounts stay live). The old reset filtered it out (deleted_at is null via the
    // candidate load), so it kept dedup_status='shadow' + a dangling group id forever.
    await pool.query(
      `update finance_holdings set deleted_at = now() where connection_id = $1 and source_object_id = 'p-ctso'`,
      [plaid],
    );
    await reconcileFinance(TEST_USER);

    const holds = await allHoldings();
    const tombstoned = holds.find((h) => h.source_object_id === "p-ctso")!;
    expect(tombstoned.deleted_at).not.toBeNull();
    expect(tombstoned.dedup_status).toBeNull(); // stale markers cleared
    expect(tombstoned.shadowed_by_id).toBeNull();
    expect(tombstoned.dedup_group_id).toBeNull();

    // With one live member left, the bucket falls below 2 connections: the synthetic drops and the
    // survivor un-shadows + serves (reversibility holds under tombstoning, not just disconnect).
    expect(holds.find((h) => h.id === winnerId)).toBeUndefined();
    const survivor = holds.find((h) => h.source_object_id === "HOL-ctso")!;
    expect(survivor.connection_id).toBe(sfin);
    expect(survivor.shadowed_by_id).toBeNull();
    const served = await query(ctx, { sector: "finance.holding", limit: 50 });
    expect(served.count).toBe(1);
    expect((served.rows as Array<Record<string, unknown>>)[0].source_object_id).toBe("HOL-ctso");
  });

  // ── Hardening batch (#37): tombstone-inclusive resets + dissolved-synthetic GC ──

  it("txn marker reset includes TOMBSTONED reals: a shadowed txn tombstoned while its account group persists sheds its stale markers", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-a", name: "Card", account_type: "credit", current_balance: "-30.00", institution_name: "American Express", mask: "4646", raw: { mask: "4646" } });
    await insAccount(sfin, { sid: "s-a", name: "Card (4646)", current_balance: "-30.00", institution_name: "American Express", mask: "4646", org_domain: "americanexpress.com" });
    // Two matched pairs: pair A (−10) loses its plaid side to a tombstone; pair B (−20) persists.
    await insTxn(plaid, { sid: "p-A", account_source_id: "p-a", posted_at: "2026-06-10T00:00:00Z", amount: "-10.00" });
    await insTxn(sfin, { sid: "s-A", account_source_id: "s-a", posted_at: "2026-06-10T00:00:00Z", amount: "-10.00" });
    await insTxn(plaid, { sid: "p-B", account_source_id: "p-a", posted_at: "2026-06-11T00:00:00Z", amount: "-20.00" });
    await insTxn(sfin, { sid: "s-B", account_source_id: "s-a", posted_at: "2026-06-11T00:00:00Z", amount: "-20.00" });
    await reconcileFinance(TEST_USER);
    let txns = await allTxns();
    expect(txns.filter((t) => t.dedup_status === "winner")).toHaveLength(2);
    const winnerB = txns.find((t) => t.dedup_status === "winner" && Number(t.amount) === -20)!;

    // p-A vanishes from its provider → tombstoned while its ACCOUNT group persists (both accounts
    // live). The old reset (no tombstone clause — the candidate load filters deleted_at is null)
    // left its shadow markers forever.
    await pool.query(
      `update finance_transactions set deleted_at = now() where connection_id = $1 and source_object_id = 'p-A'`,
      [plaid],
    );
    await reconcileFinance(TEST_USER);

    txns = await allTxns();
    const tombstoned = txns.find((t) => t.source_object_id === "p-A")!;
    expect(tombstoned.deleted_at).not.toBeNull();
    expect(tombstoned.dedup_status).toBeNull(); // stale markers cleared
    expect(tombstoned.shadowed_by_id).toBeNull();

    // Pair A dissolves per existing semantics (synthetic dropped, the survivor a live leftover) while
    // pair B — and the account group — stay converged, its live rows and synthetic untouched.
    const survivorA = txns.find((t) => t.source_object_id === "s-A")!;
    expect(survivorA.dedup_status).toBe("pending");
    expect(survivorA.shadowed_by_id).toBeNull();
    const winnersAfter = txns.filter((t) => t.dedup_status === "winner");
    expect(winnersAfter).toHaveLength(1);
    expect(winnersAfter[0].id).toBe(winnerB.id); // pair B's synthetic untouched, same id
    const shadowsAfter = txns.filter((t) => t.dedup_status === "shadow");
    expect(shadowsAfter).toHaveLength(2); // p-B + s-B, still at winner B
    for (const s of shadowsAfter) expect(s.shadowed_by_id).toBe(winnerB.id);
    expect((await allAccounts()).filter((a) => a.dedup_status === "winner")).toHaveLength(1);

    // A second run is a converged no-op.
    const again = await reconcileFinance(TEST_USER);
    expect(again.created).toBe(0);
    expect(again.recomputed).toBe(0);
    expect(again.dropped).toBe(0);
  });

  it("accounts marker reset includes TOMBSTONED reals: a shadowed account tombstoned sheds all three markers", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-rev", name: "Card", account_type: "credit", current_balance: "-9.00", institution_name: "American Express", mask: "5757", raw: { mask: "5757" } });
    await insAccount(sfin, { sid: "s-rev", name: "Card (5757)", current_balance: "-9.00", institution_name: "American Express", mask: "5757", org_domain: "americanexpress.com" });
    await reconcileFinance(TEST_USER);
    expect((await allAccounts()).filter((a) => a.dedup_status === "winner")).toHaveLength(1);

    // The plaid real vanishes from its provider's snapshot → tombstoned. The accounts pass had NO
    // reset at all, so it kept dedup_status='shadow' + a dangling group id forever.
    await pool.query(
      `update finance_accounts set deleted_at = now() where connection_id = $1 and source_object_id = 'p-rev'`,
      [plaid],
    );
    await reconcileFinance(TEST_USER);

    const accts = await allAccounts();
    const tombstoned = accts.find((a) => a.source_object_id === "p-rev")!;
    expect(tombstoned.deleted_at).not.toBeNull();
    expect(tombstoned.dedup_status).toBeNull(); // all three markers cleared
    expect(tombstoned.dedup_group_id).toBeNull();
    expect(tombstoned.shadowed_by_id).toBeNull();

    // Group-dissolution side effects per existing semantics: synthetic dropped, survivor un-shadowed.
    expect(accts.filter((a) => a.dedup_status === "winner")).toHaveLength(0);
    const survivor = accts.find((a) => a.source_object_id === "s-rev")!;
    expect(survivor.dedup_status).toBe("unique");
    expect(survivor.shadowed_by_id).toBeNull();
    const served = await query(ctx, { sector: "finance.account" });
    expect(served.count).toBe(1);

    // A second run is a converged no-op.
    const again = await reconcileFinance(TEST_USER);
    expect(again.created).toBe(0);
    expect(again.recomputed).toBe(0);
    expect(again.dropped).toBe(0);
  });

  it("GC composed case: a tombstoned union winner whose group dissolved in the same breath is HARD-deleted; re-seeding rebuilds fresh", async () => {
    const { plaid, winnerId } = await convergeCtsoPair();

    // The wedge: the union winner is tombstoned AND its group stops being desired in the SAME window
    // (the plaid member vanishes). The zombie is invisible to the existing-synth diff (deleted_at is
    // null), so the DROP diff can't reap it — only the GC sweep can.
    await pool.query(`update finance_holdings set deleted_at = now() where id = $1`, [winnerId]);
    await pool.query(
      `update finance_holdings set deleted_at = now() where connection_id = $1 and source_object_id = 'p-ctso'`,
      [plaid],
    );
    const res = await reconcileFinance(TEST_USER);
    expect(res.dropped).toBe(1); // the GC'd union row counts into dropped

    // HARD-deleted — a raw select finds no row at all (not even a tombstone).
    const holds = await allHoldings();
    expect(holds.find((h) => h.id === winnerId)).toBeUndefined();
    expect(holds.filter((h) => String(h.source_object_id).startsWith("union:"))).toHaveLength(0);
    // Every pointer at it is gone (FK on delete set null + the tombstone-inclusive reset).
    for (const h of holds) expect(h.shadowed_by_id).toBeNull();
    const survivor = holds.find((h) => h.source_object_id === "HOL-ctso")!;
    expect(survivor.dedup_status).toBe("unique");

    // Re-seed the group (the plaid member returns) → a FRESH working synthetic.
    await pool.query(
      `update finance_holdings set deleted_at = null where connection_id = $1 and source_object_id = 'p-ctso'`,
      [plaid],
    );
    const rebuilt = await reconcileFinance(TEST_USER);
    expect(rebuilt.created).toBe(1);
    const holds2 = await allHoldings();
    const fresh = holds2.find((h) => h.dedup_status === "winner")!;
    expect(fresh.source_object_id).toBe("union:holding:fidelity:4444:CTSO");
    expect(fresh.id).not.toBe(winnerId);
    expect(fresh.deleted_at).toBeNull();
    const freshShadows = holds2.filter((h) => h.dedup_status === "shadow");
    expect(freshShadows).toHaveLength(2);
    for (const s of freshShadows) expect(s.shadowed_by_id).toBe(fresh.id);
    const served = await query(ctx, { sector: "finance.holding", limit: 50 });
    expect(served.count).toBe(1);
  });

  it("GC composed case (accounts + txns): tombstoned union winners of dissolved groups are hard-deleted, both counted into dropped", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-a", name: "Card", account_type: "credit", current_balance: "-30.00", institution_name: "American Express", mask: "6868", raw: { mask: "6868" } });
    await insAccount(sfin, { sid: "s-a", name: "Card (6868)", current_balance: "-30.00", institution_name: "American Express", mask: "6868", org_domain: "americanexpress.com" });
    await insTxn(plaid, { sid: "p-t", account_source_id: "p-a", posted_at: "2026-06-12T00:00:00Z", amount: "-30.00" });
    await insTxn(sfin, { sid: "s-t", account_source_id: "s-a", posted_at: "2026-06-12T00:00:00Z", amount: "-30.00" });
    await reconcileFinance(TEST_USER);
    const acctWinner = (await allAccounts()).find((a) => a.dedup_status === "winner")!;
    const txnWinner = (await allTxns()).find((t) => t.dedup_status === "winner")!;

    // Tombstone BOTH union winners AND dissolve both groups in the same breath (the plaid side vanishes).
    await pool.query(`update finance_accounts set deleted_at = now() where id = $1`, [acctWinner.id]);
    await pool.query(`update finance_transactions set deleted_at = now() where id = $1`, [txnWinner.id]);
    await pool.query(
      `update finance_accounts set deleted_at = now() where connection_id = $1 and source_object_id = 'p-a'`,
      [plaid],
    );
    await pool.query(
      `update finance_transactions set deleted_at = now() where connection_id = $1 and source_object_id = 'p-t'`,
      [plaid],
    );
    const res = await reconcileFinance(TEST_USER);
    expect(res.dropped).toBe(2); // one account union + one txn union, both GC'd

    const accts = await allAccounts();
    const txns = await allTxns();
    expect(accts.find((a) => a.id === acctWinner.id)).toBeUndefined(); // hard-deleted
    expect(txns.find((t) => t.id === txnWinner.id)).toBeUndefined();
    expect(accts.filter((a) => String(a.source_object_id).startsWith("union:"))).toHaveLength(0);
    expect(txns.filter((t) => String(t.source_object_id).startsWith("union:"))).toHaveLength(0);
    for (const r of [...accts, ...txns]) expect(r.shadowed_by_id).toBeNull();

    // The survivors serve exactly once each.
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(1);
    expect((await query(ctx, { sector: "finance.transaction", limit: 50 })).count).toBe(1);
  });

  it("GC does NOT fire on a LIVE dissolved synthetic — the DROP diff reaps it, counted exactly once", async () => {
    const { plaid, winnerId } = await convergeCtsoPair();
    // Dissolve the bucket (the plaid member vanishes) but leave the union winner LIVE: the DROP
    // diff's territory. (The other GC non-target — a tombstoned synth whose group is STILL desired —
    // is the zombie-resurrect test above: upsertSynthetic reclaims it in place, GC must not race it.)
    await pool.query(
      `update finance_holdings set deleted_at = now() where connection_id = $1 and source_object_id = 'p-ctso'`,
      [plaid],
    );
    const res = await reconcileFinance(TEST_USER);
    expect(res.dropped).toBe(1); // the DROP diff's delete — never double-counted by the GC
    expect((await allHoldings()).find((h) => h.id === winnerId)).toBeUndefined();
  });

  // ── Lockstep INSERT/diff invariant ─────────────────────────────────────────
  it("lockstep: the synthetic winner's computed column set == ENRICHED_COLUMNS for all three objects", async () => {
    // The materialization derives the INSERT column list AND the RECOMPUTE diff from ENRICHED_COLUMNS;
    // assert the two enumerations are internally consistent (a desync would silently stale a synthetic).
    expect([...ENRICHED_COLUMNS.account].sort()).toEqual(
      [
        "account_type",
        "available_balance",
        "balance_at",
        "balance_at_is_synthetic",
        "current_balance",
        "currency",
        "institution_name",
        "mask",
        "name",
        "org_domain",
      ].sort(),
    );
    expect([...ENRICHED_COLUMNS.transaction].sort()).toEqual(
      [
        "amount",
        "authorized_at",
        "category",
        "currency",
        "description",
        "location_city",
        "location_region",
        "merchant",
        "payment_channel",
        "pending",
        "posted_at",
      ].sort(),
    );
    expect([...ENRICHED_COLUMNS.holding].sort()).toEqual(
      [
        "as_of",
        "cost_basis",
        "currency",
        "market_value",
        "name",
        "quantity",
        "security_type",
        "symbol",
      ].sort(),
    );
    expect(PROVIDER_RANK.plaid).toBeLessThan(PROVIDER_RANK.simplefin);
  });
});

// ── finance-dedup-trust-batch (child A): confirmed merges + pair-keyed GC ──────────────────────────

describe.skipIf(!HAS_DB)("finance dedup trust batch — confirmed merges + pair-keyed GC", () => {
  beforeAll(async () => {
    pool = (await import("../db.js")).pool;
    await pool.query(`insert into users (id, label) values ($1, 'dedup-34b-test') on conflict (id) do nothing`, [
      TEST_USER,
    ]);
  });

  afterAll(async () => {
    // finance_dedup_confirmations cascades with connectors; order matters for the FK chain.
    await pool.query(`delete from finance_transactions where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from finance_holdings where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from finance_accounts where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from connectors where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from provider_credentials where user_id = $1`, [TEST_USER]);
  });

  beforeEach(async () => {
    await pool.query(`delete from finance_transactions where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from finance_holdings where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from finance_accounts where user_id = $1`, [TEST_USER]);
    await pool.query(`delete from connectors where user_id = $1`, [TEST_USER]); // cascades confirmations
    await pool.query(`delete from provider_credentials where user_id = $1`, [TEST_USER]);
  });

  /** The canonical maskless-pair fixture: the same Amex card via both providers, but NO usable last-4
   *  on either side — the organic mask gate can never prove it, so both serve as visible dupes until
   *  the operator confirms. Returns the connections + refs. */
  async function seedMasklessPair(): Promise<{
    plaid: string;
    sfin: string;
    refA: { connectionId: string; sourceObjectId: string };
    refB: { connectionId: string; sourceObjectId: string };
  }> {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-nomask", name: "Platinum Card", account_type: "credit", current_balance: "-100.00", institution_name: "American Express", mask: null, raw: { provider: "plaid" } });
    await insAccount(sfin, { sid: "s-nomask", name: "Platinum Card", current_balance: "-100.00", institution_name: "American Express", mask: null, org_domain: "americanexpress.com", raw: { org: { domain: "americanexpress.com" } } });
    return {
      plaid,
      sfin,
      refA: { connectionId: plaid, sourceObjectId: "p-nomask" },
      refB: { connectionId: sfin, sourceObjectId: "s-nomask" },
    };
  }

  function auditBuf(): AuditEntry[] {
    return (queue as unknown as { buf: AuditEntry[] }).buf;
  }

  // ── Flag pass: listDedupCandidates ──────────────────────────────────────────
  it("candidates: a maskless same-institution pair is flagged; masked (organic) and class-conflicting pairs are NOT", async () => {
    const { plaid, sfin } = await seedMasklessPair();
    // A MASKED pair — the organic engine owns it (merges it), so it must never be a candidate.
    await insAccount(plaid, { sid: "p-masked", name: "Gold Card", account_type: "credit", current_balance: "-50.00", institution_name: "American Express", mask: "4318", raw: { mask: "4318" } });
    await insAccount(sfin, { sid: "s-masked", name: "Gold Card (4318)", current_balance: "-50.00", institution_name: "American Express", mask: "4318", org_domain: "americanexpress.com" });
    // A class-CONFLICTING maskless pair (checking vs loan) — never a candidate.
    await insAccount(plaid, { sid: "p-chk", name: "Checking", account_type: "depository", current_balance: "100.00", institution_name: "Chase", mask: null, raw: {} });
    await insAccount(sfin, { sid: "s-loan", name: "Auto Loan", current_balance: "-100.00", institution_name: "Chase", mask: null, org_domain: "chase.com" });

    await reconcileFinance(TEST_USER);
    const candidates = await listDedupCandidates(TEST_USER);

    // Exactly ONE candidate: the maskless compatible Amex pair (masked pair is winner/shadow by now;
    // the Chase pair class-conflicts). Note the Chase checking vs the Amex sides differ by institution.
    expect(candidates).toHaveLength(1);
    const c = candidates[0];
    expect(c.institution).toBe("americanexpress");
    const soids = [c.a.sourceObjectId, c.b.sourceObjectId].sort();
    expect(soids).toEqual(["p-nomask", "s-nomask"]);
    // Canonical order: a < b bytewise on 'conn|soid'.
    expect(`${c.a.connectionId}|${c.a.sourceObjectId}` < `${c.b.connectionId}|${c.b.sourceObjectId}`).toBe(true);
    // Both sides carry display context for the Console pill.
    expect(c.a.provider).toMatch(/plaid|simplefin/);
    expect(c.a.name).not.toBeNull();
  });

  it("candidates: a currency-conflicting maskless pair is NOT flagged", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-usd", name: "Card", account_type: "credit", currency: "USD", institution_name: "American Express", mask: null, raw: {} });
    await insAccount(sfin, { sid: "s-eur", name: "Card", currency: "EUR", institution_name: "American Express", mask: null, org_domain: "americanexpress.com" });
    await reconcileFinance(TEST_USER);
    expect(await listDedupCandidates(TEST_USER)).toHaveLength(0);
  });

  // ── Confirm: group formation + audit + idempotency ──────────────────────────
  it("confirm: forms the 'confirmed:' group — both reals shadowed, winner union:confirmed:% served once, audited, idempotent", async () => {
    const { refA, refB } = await seedMasklessPair();
    await reconcileFinance(TEST_USER);
    // Before confirmation: two visible dupes, double-counted (the honest fail-open state).
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(2);

    // Confirm with the refs DELIBERATELY in non-canonical order — the API canonicalizes.
    const confirmation = await confirmDedupPair(TEST_USER, refB, refA);
    expect(confirmation.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(`${confirmation.a.connectionId}|${confirmation.a.sourceObjectId}` < `${confirmation.b.connectionId}|${confirmation.b.sourceObjectId}`).toBe(true);

    // The reconcile ran inside confirm: 3-row union shape, winner in the union:confirmed:% sub-namespace.
    const accts = await allAccounts();
    const winner = accts.find((a) => a.dedup_status === "winner")!;
    expect(winner.source_object_id).toBe(`union:confirmed:${confirmationPairHash(refA, refB)}`);
    expect(winner.raw).toBeNull();
    const shadows = accts.filter((a) => a.dedup_status === "shadow");
    expect(shadows).toHaveLength(2);
    for (const s of shadows) {
      expect(s.shadowed_by_id).toBe(winner.id);
      expect(s.raw).not.toBeNull(); // pristine
    }

    // Net-worth double-count GONE: one served row, sum = the single signed balance.
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(1);
    const balSum = (await query(ctx, { sector: "finance.account", aggregate: { fn: "sum", field: "current_balance" } })) as { groups: Array<{ value: unknown }> };
    expect(Number(balSum.groups[0].value)).toBeCloseTo(-100, 2);

    // Audited via the standard async writer (fire-and-forget queue).
    const line = auditBuf().find(
      (e) => String(e.tool) === "finance.dedup.confirm" && (e.args as { confirmationId?: string })?.confirmationId === confirmation.id,
    );
    expect(line).toBeTruthy();
    expect(line!.decision).toBe("allow");
    expect(line!.userId).toBe(TEST_USER);

    // The pair is decided — no longer a candidate; the summary reports it APPLIED.
    expect(await listDedupCandidates(TEST_USER)).toHaveLength(0);
    const summaries = await listDedupConfirmations(TEST_USER);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].state).toBe("applied");
    expect(summaries[0].suspendedReason).toBeNull();

    // Idempotent: re-confirming (either order) returns the SAME confirmation.
    const again = await confirmDedupPair(TEST_USER, refA, refB);
    expect(again.id).toBe(confirmation.id);
    expect((await listDedupConfirmations(TEST_USER))).toHaveLength(1);
  });

  // ── Downstream passes consume the confirmed group organically ───────────────
  it("txns follow a confirmed (credit) group: the same charge via both providers collapses to one served txn", async () => {
    const { plaid, sfin, refA, refB } = await seedMasklessPair();
    await insTxn(plaid, { sid: "p-t1", account_source_id: "p-nomask", posted_at: "2026-06-12T00:00:00Z", amount: "-25.00" });
    await insTxn(sfin, { sid: "s-t1", account_source_id: "s-nomask", posted_at: "2026-06-12T12:00:00Z", amount: "-25.00" });
    await reconcileFinance(TEST_USER);
    // Unconfirmed: no account group → both txns untouched, double-counted.
    expect((await query(ctx, { sector: "finance.transaction", limit: 50 })).count).toBe(2);

    await confirmDedupPair(TEST_USER, refA, refB);

    const txns = await allTxns();
    expect(txns.filter((t) => t.dedup_status === "winner")).toHaveLength(1);
    expect(txns.filter((t) => t.dedup_status === "shadow")).toHaveLength(2);
    const served = await query(ctx, { sector: "finance.transaction", limit: 50 });
    expect(served.count).toBe(1);
    const amtSum = (await query(ctx, { sector: "finance.transaction", aggregate: { fn: "sum", field: "amount" } })) as { groups: Array<{ value: unknown }> };
    expect(Number(amtSum.groups[0].value)).toBeCloseTo(-25, 2);
  });

  it("holdings follow a confirmed (investment) group: symbol-keyed union under union:holding:confirmed:%", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    // The same maskless brokerage via both providers (no last-4 → organic can't prove it).
    await insAccount(plaid, { sid: "p-brok", name: "Brokerage", account_type: "investment", current_balance: "2000", institution_name: "Fidelity", mask: null, raw: {} });
    await insAccount(sfin, { sid: "s-brok", name: "Brokerage", current_balance: "2000", institution_name: "Fidelity", mask: null, org_domain: "fidelity.com" });
    await insHolding(plaid, { sid: "p-ctso", account_source_id: "p-brok", symbol: "CTSO", market_value: "2000", as_of: "2026-06-25T00:00:00Z" });
    await insHolding(sfin, { sid: "HOL-ctso", account_source_id: "s-brok", symbol: "CTSO", market_value: "1990", as_of: "2026-06-26T00:00:00Z" });
    await reconcileFinance(TEST_USER);
    expect((await query(ctx, { sector: "finance.holding", limit: 50 })).count).toBe(2); // honest dupes

    const refA = { connectionId: plaid, sourceObjectId: "p-brok" };
    const refB = { connectionId: sfin, sourceObjectId: "s-brok" };
    await confirmDedupPair(TEST_USER, refA, refB);

    const holds = await allHoldings();
    const winner = holds.find((h) => h.dedup_status === "winner")!;
    expect(winner.source_object_id).toBe(`union:holding:confirmed:${confirmationPairHash(refA, refB)}:CTSO`);
    expect(winner.raw).toBeNull();
    expect(Number(winner.market_value)).toBeCloseTo(1990, 2); // freshest tuple (SimpleFIN)
    expect(holds.filter((h) => h.dedup_status === "shadow")).toHaveLength(2);
    expect((await query(ctx, { sector: "finance.holding", limit: 50 })).count).toBe(1);
  });

  // ── Survival: re-sync + full marker recompute ───────────────────────────────
  it("a confirmation survives a re-sync (fresh provider upserts) AND a full marker recompute", async () => {
    const { plaid, sfin, refA, refB } = await seedMasklessPair();
    await confirmDedupPair(TEST_USER, refA, refB);
    const winnerId = (await allAccounts()).find((a) => a.dedup_status === "winner")!.id;

    // A provider re-sync: both reals re-upserted fresh (the runner's exact live-write shape).
    for (const [conn, sid, name] of [
      [plaid, "p-nomask", "Platinum Card"],
      [sfin, "s-nomask", "Platinum Card"],
    ] as const) {
      const { sql, values } = buildUpsert("finance_accounts", {
        connection_id: conn,
        user_id: TEST_USER,
        source_object_id: sid,
        name,
        current_balance: "-100.00",
        institution_name: "American Express",
        raw: JSON.stringify({ resynced: true }),
        ingested_at: new Date(),
        deleted_at: null,
      });
      await pool.query(sql, values);
    }
    const afterSync = await reconcileFinance(TEST_USER);
    expect(afterSync.accountGroups).toBe(1); // the confirmed group re-forms every run
    expect((await allAccounts()).find((a) => a.dedup_status === "winner")!.id).toBe(winnerId); // stable

    // A FULL marker recompute: wipe every marker on the reals; the confirmation (own table) re-applies.
    await pool.query(
      `update finance_accounts set dedup_status = null, shadowed_by_id = null, dedup_group_id = null
        where user_id = $1 and source_object_id not like 'union:%'`,
      [TEST_USER],
    );
    await reconcileFinance(TEST_USER);
    const accts = await allAccounts();
    expect(accts.filter((a) => a.dedup_status === "shadow")).toHaveLength(2);
    expect(accts.find((a) => a.dedup_status === "winner")!.id).toBe(winnerId);
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(1);
    expect((await listDedupConfirmations(TEST_USER))[0].state).toBe("applied");
  });

  // ── Disconnect: FK cascade cleans the confirmation up ───────────────────────
  it("disconnecting either connection cascade-deletes the confirmation; the survivor un-shadows + serves", async () => {
    const { plaid, refA, refB } = await seedMasklessPair();
    await confirmDedupPair(TEST_USER, refA, refB);
    expect((await pool.query(`select count(*)::int as n from finance_dedup_confirmations where user_id = $1`, [TEST_USER])).rows[0].n).toBe(1);

    await disconnectConnection(ctx, plaid, { confirmToken: plaid });

    // The confirmation row is GONE (FK on delete cascade) — not orphaned, not resurrectable.
    expect((await pool.query(`select count(*)::int as n from finance_dedup_confirmations where user_id = $1`, [TEST_USER])).rows[0].n).toBe(0);
    const accts = await allAccounts();
    expect(accts.filter((a) => a.dedup_status === "winner")).toHaveLength(0);
    const survivor = accts.find((a) => a.source_object_id === "s-nomask")!;
    expect(survivor.shadowed_by_id).toBeNull();
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(1);
    expect(await listDedupConfirmations(TEST_USER)).toHaveLength(0);
  });

  // ── Suspension: a later conflict is refused FAIL-OPEN, never honored, never deleted ──
  it("a confirmed pair that develops a CURRENCY conflict is SUSPENDED: group dissolves, reals serve, row kept; fixing it re-applies", async () => {
    const { sfin, refA, refB } = await seedMasklessPair();
    await confirmDedupPair(TEST_USER, refA, refB);
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(1);

    // The SimpleFIN side flips to EUR (provider data change on a later sync).
    await pool.query(`update finance_accounts set currency = 'EUR' where connection_id = $1 and source_object_id = 's-nomask'`, [sfin]);
    await reconcileFinance(TEST_USER);

    // SUSPENDED fail-open: no winner, both reals LIVE and served (an honest dupe beats a wrong merge).
    const accts = await allAccounts();
    expect(accts.filter((a) => a.dedup_status === "winner")).toHaveLength(0);
    expect(accts.filter((a) => a.dedup_status === "unique")).toHaveLength(2);
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(2);
    // The confirmation row is KEPT — never honored, never silently deleted — and reported suspended.
    const summaries = await listDedupConfirmations(TEST_USER);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].state).toBe("suspended");
    expect(summaries[0].suspendedReason).toBe("currency");

    // The conflict resolves (currency back to USD) → the confirmation re-applies on the next run.
    await pool.query(`update finance_accounts set currency = 'USD' where connection_id = $1 and source_object_id = 's-nomask'`, [sfin]);
    await reconcileFinance(TEST_USER);
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(1);
    expect((await listDedupConfirmations(TEST_USER))[0].state).toBe("applied");
  });

  it("a confirmed pair that develops a CLASS conflict is SUSPENDED with reason 'class'", async () => {
    const { plaid, refA, refB } = await seedMasklessPair();
    await confirmDedupPair(TEST_USER, refA, refB);

    // The Plaid side re-identifies as a depository CHECKING account → confident class conflict with
    // the SimpleFIN 'Platinum Card' (liability by name keyword).
    await pool.query(
      `update finance_accounts set account_type = 'depository', name = 'Checking' where connection_id = $1 and source_object_id = 'p-nomask'`,
      [plaid],
    );
    await reconcileFinance(TEST_USER);

    expect((await allAccounts()).filter((a) => a.dedup_status === "winner")).toHaveLength(0);
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(2);
    const summaries = await listDedupConfirmations(TEST_USER);
    expect(summaries[0].state).toBe("suspended");
    expect(summaries[0].suspendedReason).toBe("class");
  });

  // ── Unconfirm: the existing dissolution diff reverses everything ─────────────
  it("unconfirm: DELETE dissolves the group — synthetic dropped, reals un-shadowed, pair flagged again, audited", async () => {
    const { refA, refB } = await seedMasklessPair();
    const confirmation = await confirmDedupPair(TEST_USER, refA, refB);
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(1);

    await unconfirmDedupPair(TEST_USER, confirmation.id);

    const accts = await allAccounts();
    expect(accts.filter((a) => a.dedup_status === "winner")).toHaveLength(0);
    expect(accts.filter((a) => a.dedup_status === "unique")).toHaveLength(2);
    for (const a of accts) expect(a.shadowed_by_id).toBeNull();
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(2);
    expect(await listDedupConfirmations(TEST_USER)).toHaveLength(0);
    // The pair is undecided again → back on the candidate list.
    expect(await listDedupCandidates(TEST_USER)).toHaveLength(1);
    // Audited.
    const line = auditBuf().find(
      (e) => String(e.tool) === "finance.dedup.unconfirm" && (e.args as { confirmationId?: string })?.confirmationId === confirmation.id,
    );
    expect(line).toBeTruthy();

    // Unknown/foreign id → typed NotFoundError (never a silent no-op).
    await expect(unconfirmDedupPair(TEST_USER, confirmation.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(unconfirmDedupPair(TEST_USER, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
  });

  // ── Ownership: a confirmation can never reach across users ──────────────────
  it("cross-user confirm is REJECTED: another user's connection/account is a NotFoundError, nothing persisted", async () => {
    const OTHER_USER = "00000000-0000-0000-0000-0000000034b1";
    await pool.query(`insert into users (id, label) values ($1, 'dedup-trust-other') on conflict (id) do nothing`, [OTHER_USER]);
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status) values ($1, 'simplefin', 'static_token', 'active') returning id`,
      [OTHER_USER],
    );
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status) values ($1, $2, 'finance', 'simplefin', 'active') returning id`,
      [OTHER_USER, cred.rows[0].id],
    );
    const otherConn = conn.rows[0].id as string;
    await pool.query(
      `insert into finance_accounts (connection_id, user_id, source_object_id, name, currency, institution_name, raw)
       values ($1, $2, 'other-acct', 'Card', 'USD', 'American Express', '{}')`,
      [otherConn, OTHER_USER],
    );
    const { refA, refB } = await seedMasklessPair();

    try {
      // Foreign connection on one side → NotFoundError (the connection is not the caller's).
      await expect(
        confirmDedupPair(TEST_USER, refA, { connectionId: otherConn, sourceObjectId: "other-acct" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // An OWN (different) connection but a soid that does not exist on finance_accounts → NotFoundError too.
      await expect(
        confirmDedupPair(TEST_USER, refA, { connectionId: refB.connectionId, sourceObjectId: "ghost" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // Nothing persisted for either user; the other user's data untouched. Scope the count to THIS
      // test's two users (#43 C) — a parallel finance-dedup-routes fork races its own LOCAL_USER
      // confirmation into this shared table, so an unscoped count would see a foreign row.
      expect(
        (
          await pool.query(`select count(*)::int as n from finance_dedup_confirmations where user_id = any($1)`, [
            [TEST_USER, OTHER_USER],
          ])
        ).rows[0].n,
      ).toBe(0);
      const otherRows = await pool.query(`select dedup_status, shadowed_by_id from finance_accounts where user_id = $1`, [OTHER_USER]);
      expect(otherRows.rows[0].dedup_status).toBeNull();
      expect(otherRows.rows[0].shadowed_by_id).toBeNull();
    } finally {
      await pool.query(`delete from finance_accounts where user_id = $1`, [OTHER_USER]);
      await pool.query(`delete from connectors where user_id = $1`, [OTHER_USER]);
      await pool.query(`delete from provider_credentials where user_id = $1`, [OTHER_USER]);
    }
  });

  // ── Reserved namespace stays sealed ─────────────────────────────────────────
  it("union:% guards intact: confirm rejects reserved soids; a provider record can't plant 'union:confirmed:%' via ingest", async () => {
    const { refA } = await seedMasklessPair();
    // The confirm surface: a ref inside the reserved namespace is a typed 400 — synthetics are never confirmable.
    await expect(
      confirmDedupPair(TEST_USER, refA, { connectionId: refA.connectionId, sourceObjectId: "union:confirmed:deadbeef" }),
    ).rejects.toBeInstanceOf(QueryValidationError);

    // The ingest surface (#37, unchanged by this unit): a connector normalizing into the reserved
    // namespace — including the NEW union:confirmed: sub-namespace — is rejected fail-closed.
    const POLICY: SyncPolicy = { mode: "poll", defaultIntervalSec: 3600, freshnessToleranceSec: 3600, supportsIncremental: true };
    const fake: Connector = {
      provider: "uniontrustprov",
      sector: "finance",
      objectType: "account",
      policy: POLICY,
      actions: [],
      async *sync(): AsyncIterable<RawRecord> {
        // unused — this test drives ingestRecords directly
      },
      normalize(raw: RawRecord): Record<string, unknown> {
        return { source_object_id: raw.externalId, name: "Forged" };
      },
      strongKeys() {
        return {};
      },
      async execute() {
        return { ok: true as const };
      },
    };
    registerConnector(fake);
    const conn = await makeConn("uniontrustprov");
    const res = await ingestRecords(conn, [{ externalId: "union:confirmed:deadbeef", raw: {} }]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("reserved 'union:' namespace");
    const landed = await pool.query(
      `select count(*)::int as n from finance_accounts where connection_id = $1`,
      [conn],
    );
    expect(landed.rows[0].n).toBe(0);
  });

  // ── Pair-keyed GC: the ADR 0022 non-anchor zombie, all three sweeps ──────────
  it("accounts GC reaps a tombstoned winner squatting on a NON-anchor connection (live group id!); live winner survives; rerun clean", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-z", name: "Card", account_type: "credit", current_balance: "-5.00", institution_name: "American Express", mask: "1234", raw: { mask: "1234" } });
    await insAccount(sfin, { sid: "s-z", name: "Card (1234)", current_balance: "-5.00", institution_name: "American Express", mask: "1234", org_domain: "americanexpress.com" });
    await reconcileFinance(TEST_USER);
    const winner = (await allAccounts()).find((a) => a.dedup_status === "winner")!;
    expect(winner.connection_id).toBe(plaid); // provider-rank anchor

    // The manufactured ADR 0022 zombie: the SAME union soid, tombstoned, on the NON-anchor connection,
    // still carrying the LIVE group id — the old group-keyed GC kept it forever.
    const zres = await pool.query(
      `insert into finance_accounts (connection_id, user_id, source_object_id, currency, dedup_status, dedup_group_id, raw, deleted_at)
       values ($1, $2, $3, 'USD', 'winner', $4, null, now()) returning id`,
      [sfin, TEST_USER, winner.source_object_id, winner.dedup_group_id],
    );
    const zombieId = zres.rows[0].id as string;

    const res = await reconcileFinance(TEST_USER);
    expect(res.dropped).toBe(1); // the reaped zombie counts into dropped
    const accts = await allAccounts();
    expect(accts.find((a) => a.id === zombieId)).toBeUndefined(); // hard-deleted
    const live = accts.find((a) => a.dedup_status === "winner")!;
    expect(live.id).toBe(winner.id); // the live winner SURVIVES untouched
    expect(live.deleted_at).toBeNull();
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(1);

    // Rerun: converged no-op — the collision freeze is impossible.
    const again = await reconcileFinance(TEST_USER);
    expect(again.created).toBe(0);
    expect(again.recomputed).toBe(0);
    expect(again.dropped).toBe(0);
  });

  it("txn GC reaps a tombstoned winner on a NON-anchor connection whose soid is still desired; rerun clean", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-a", name: "Card", account_type: "credit", current_balance: "-10.00", institution_name: "American Express", mask: "2345", raw: { mask: "2345" } });
    await insAccount(sfin, { sid: "s-a", name: "Card (2345)", current_balance: "-10.00", institution_name: "American Express", mask: "2345", org_domain: "americanexpress.com" });
    await insTxn(plaid, { sid: "p-t", account_source_id: "p-a", posted_at: "2026-06-12T00:00:00Z", amount: "-10.00" });
    await insTxn(sfin, { sid: "s-t", account_source_id: "s-a", posted_at: "2026-06-12T00:00:00Z", amount: "-10.00" });
    await reconcileFinance(TEST_USER);
    const winner = (await allTxns()).find((t) => t.dedup_status === "winner")!;
    expect(winner.connection_id).toBe(plaid); // provider-rank anchor

    // The zombie: same DESIRED soid (the old soid-keyed `<> all` kept it), non-anchor connection, tombstoned.
    const zres = await pool.query(
      `insert into finance_transactions (connection_id, user_id, source_object_id, amount, currency, dedup_status, raw, deleted_at)
       values ($1, $2, $3, '-10.00', 'USD', 'winner', null, now()) returning id`,
      [sfin, TEST_USER, winner.source_object_id],
    );
    const zombieId = zres.rows[0].id as string;

    const res = await reconcileFinance(TEST_USER);
    expect(res.dropped).toBe(1);
    const txns = await allTxns();
    expect(txns.find((t) => t.id === zombieId)).toBeUndefined(); // reaped
    expect(txns.find((t) => t.dedup_status === "winner")!.id).toBe(winner.id); // live winner survives
    expect((await query(ctx, { sector: "finance.transaction", limit: 50 })).count).toBe(1);

    const again = await reconcileFinance(TEST_USER);
    expect(again.created).toBe(0);
    expect(again.recomputed).toBe(0);
    expect(again.dropped).toBe(0);
  });

  it("holdings GC reaps the non-anchor zombie BEFORE an anchor flip lands on its pair — the previously-fatal recompute collision cannot occur", async () => {
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-brok", name: "Brokerage", account_type: "investment", current_balance: "2000", institution_name: "Fidelity", mask: "4444", raw: { mask: "4444" } });
    await insAccount(sfin, { sid: "s-brok", name: "Brokerage (4444)", current_balance: "2000", institution_name: "Fidelity", mask: "4444", org_domain: "fidelity.com" });
    await insHolding(plaid, { sid: "p-ctso", account_source_id: "p-brok", symbol: "CTSO", market_value: "2000", as_of: "2026-06-25T00:00:00Z" });
    await insHolding(sfin, { sid: "HOL-ctso", account_source_id: "s-brok", symbol: "CTSO", market_value: "1990", as_of: "2026-06-26T00:00:00Z" });
    await reconcileFinance(TEST_USER);
    const winner = (await allHoldings()).find((h) => h.dedup_status === "winner")!;
    expect(winner.connection_id).toBe(sfin); // the fresher tuple anchors

    // The zombie squats on the PLAID pair — exactly where a later anchor flip will move the winner.
    // Old soid-keyed GC kept it (its soid is still desired) → the flip's UPDATE hit its unique key →
    // collision → whole-transaction rollback → best-effort swallow → dedup frozen. Pair-keyed GC
    // reaps it NOW, while its pair is not the desired anchor.
    const zres = await pool.query(
      `insert into finance_holdings (connection_id, user_id, source_object_id, symbol, dedup_status, raw, deleted_at)
       values ($1, $2, $3, 'CTSO', 'winner', null, now()) returning id`,
      [plaid, TEST_USER, winner.source_object_id],
    );
    const zombieId = zres.rows[0].id as string;

    const res = await reconcileFinance(TEST_USER);
    expect(res.dropped).toBe(1); // reaped by the pair-keyed sweep
    expect((await allHoldings()).find((h) => h.id === zombieId)).toBeUndefined();
    expect((await allHoldings()).find((h) => h.dedup_status === "winner")!.id).toBe(winner.id); // survives

    // NOW the anchor flips: Plaid becomes the freshest tuple → the RECOMPUTE moves the winner onto
    // the exact (connection, soid) pair the zombie held. With the zombie reaped this is clean.
    await pool.query(
      `update finance_holdings set as_of = '2026-06-27T00:00:00Z' where connection_id = $1 and source_object_id = 'p-ctso'`,
      [plaid],
    );
    const flip = await reconcileFinance(TEST_USER); // the old failure mode: unique-key throw HERE
    expect(flip.recomputed).toBe(1);
    const moved = (await allHoldings()).find((h) => h.dedup_status === "winner")!;
    expect(moved.id).toBe(winner.id); // same synthetic, moved in place
    expect(moved.connection_id).toBe(plaid);
    expect(Number(moved.market_value)).toBeCloseTo(2000, 2);
    expect((await query(ctx, { sector: "finance.holding", limit: 50 })).count).toBe(1);

    const again = await reconcileFinance(TEST_USER);
    expect(again.created).toBe(0);
    expect(again.recomputed).toBe(0);
    expect(again.dropped).toBe(0);
  });

  it("pair-keyed GC still KEEPS a tombstoned-but-DESIRED synth for the resurrect path (sweeps stay separate from the diff)", async () => {
    // The regression guard for the sweep/resurrect boundary: pair-keying must not widen into
    // reaping the zombie that upsertSynthetic is about to resurrect IN PLACE (same pair).
    const plaid = await makeConn("plaid");
    const sfin = await makeConn("simplefin");
    await insAccount(plaid, { sid: "p-r", name: "Card", account_type: "credit", current_balance: "-3.00", institution_name: "American Express", mask: "3456", raw: { mask: "3456" } });
    await insAccount(sfin, { sid: "s-r", name: "Card (3456)", current_balance: "-3.00", institution_name: "American Express", mask: "3456", org_domain: "americanexpress.com" });
    await reconcileFinance(TEST_USER);
    const winner = (await allAccounts()).find((a) => a.dedup_status === "winner")!;

    // Tombstone the winner IN PLACE (desired pair unchanged) — the resurrect territory, not GC's.
    await pool.query(`update finance_accounts set deleted_at = now() where id = $1`, [winner.id]);
    const res = await reconcileFinance(TEST_USER);
    expect(res.created).toBe(1); // the CREATE path upserted onto the zombie
    const resurrected = (await allAccounts()).find((a) => a.dedup_status === "winner")!;
    expect(resurrected.id).toBe(winner.id); // SAME row — resurrected, not reaped-and-recreated
    expect(resurrected.deleted_at).toBeNull();
    expect((await query(ctx, { sector: "finance.account" })).count).toBe(1);
  });
});

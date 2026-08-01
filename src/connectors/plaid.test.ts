// Plaid unit tests — DB-free, network mocked. Covers: the declared shape, normalize (negate-on-write
// for a debit AND a credit, PFC category, enrichment columns, synthetic balance, datetime-preferred /
// date-fallback), strongKeys, the /transactions/sync has_more DRAIN + per-record routing (cursor +
// dedup + removed→deletion-records with per-id LAST-WINS reconciliation + best-effort institution
// name), the holdings gate + securities join + snapshot-reconcile discipline (#36), and the thin
// client's secret-free errors.
//
// The pure normalize/strongKeys assertions construct RawRecords directly and need NO env/creds. The
// sync + client tests set DUMMY PLAID_* env (fetch is mocked — never a real Plaid call).

import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from "vitest";
import type { RawRecord, SyncContext } from "./types.js";
import {
  PlaidConnector,
  linkTokenCreate,
  hostedLinkCreate,
  linkTokenGet,
  relinkTokenCreate,
  PLAID_LINK_CLIENT_NAME,
  exchangePublicToken,
  transactionsSync,
  itemGet,
  accountsBalanceGet,
  investmentsHoldingsGet,
  type AccountRow,
  type TransactionRow,
  type HoldingRow,
  type PlaidSyncPage,
} from "./plaid.js";
import { reconcileObjectSnapshot } from "../sync/runner.js";
import { lockTestResource } from "../test-support/advisory-lock.js";

// The holdings snapshot reconcile (#36) writes through the shared runner helper — spy it out so the
// sync tests stay DB-free AND its call/no-call discipline (complete enumeration ONLY) is assertable.
// Everything else in the runner module stays real (importOriginal spread).
vi.mock("../sync/runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sync/runner.js")>();
  return { ...actual, reconcileObjectSnapshot: vi.fn(async () => 0) };
});
const reconcileMock = vi.mocked(reconcileObjectSnapshot);
import {
  SYNC_PAGE_1,
  SYNC_PAGE_2,
  RAW_ACCOUNT,
  RAW_ACCOUNT_CREDIT,
  RAW_ACCOUNT_CREDIT_SECOND,
  RAW_ACCOUNT_DEPOSITORY_742,
  RAW_TXN_DEBIT,
  RAW_TXN_CREDIT,
  RAW_TXN_MODIFIED,
  ITEM_GET_RESPONSE,
  INSTITUTIONS_GET_RESPONSE,
} from "./plaid.fixtures.js";
import { SimpleFinConnector, type AccountRow as SimpleFinAccountRow } from "./simplefin.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// plaidConfig is now table-first (it reads plaid_app), so the client/sync tests touch the pool under
// test:db. Close it once after the whole file so the worker exits cleanly.
afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const { pool } = await import("../db.js");
  await pool.end();
});

async function collect(it: AsyncIterable<RawRecord>): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

function acctRec(raw: unknown): RawRecord {
  return { object: "account", externalId: (raw as { account_id: string }).account_id, raw };
}
function txnRec(raw: unknown): RawRecord {
  return { object: "transaction", externalId: (raw as { transaction_id: string }).transaction_id, raw };
}

// ── Declared shape ────────────────────────────────────────────────────────────────────────────────

describe("PlaidConnector — declared shape", () => {
  const c = new PlaidConnector();
  it("is plaid, finance, read-only, poll @ 6h, incremental", () => {
    expect(c.provider).toBe("plaid");
    expect(c.sector).toBe("finance");
    expect(c.objectType).toBe("transaction");
    expect(c.actions).toEqual([]);
    expect(c.policy).toEqual({
      mode: "poll",
      defaultIntervalSec: 21600,
      minIntervalSec: 900, // ADR 0025 — the cadence floor (per-Item subscription billing; 50/min limit)
      freshnessToleranceSec: 21600,
      supportsIncremental: true,
    });
  });
  it("execute() throws (finance is read-only)", async () => {
    await expect(c.execute()).rejects.toThrow(/read-only/);
  });
});

// ── normalize ─────────────────────────────────────────────────────────────────────────────────────

describe("PlaidConnector.normalize — account", () => {
  const c = new PlaidConnector();

  it("maps enrichment columns, synthetic balance, exact decimals, threaded institution name", () => {
    const row = c.normalize(acctRec({ ...RAW_ACCOUNT, institution_name: "First Platypus Bank" })) as AccountRow;
    expect(row.source_object_id).toBe("plaid-acct-checking-001");
    expect(row.name).toBe("Plaid Checking");
    expect(row.account_type).toBe("depository"); // enrichment (SimpleFIN leaves null)
    expect(row.currency).toBe("USD");
    expect(row.current_balance).toBe("110"); // exact
    expect(row.available_balance).toBe("100.25"); // enrichment, exact
    expect(row.balance_at_is_synthetic).toBe(true);
    expect(row.balance_at).not.toBeNull(); // Plaid has no balance timestamp → synthesized
    expect(typeof row.balance_at).toBe("string");
    expect(row.institution_name).toBe("First Platypus Bank");
  });

  it("institution name absent → null", () => {
    const row = c.normalize(acctRec(RAW_ACCOUNT)) as AccountRow;
    expect(row.institution_name).toBeNull();
  });
});

describe("PlaidConnector.normalize — balance sign (#34a)", () => {
  const c = new PlaidConnector();

  it("a CREDIT account's positive-magnitude owed balance is stored NEGATIVE (742.19 → -742.19); available-credit UNCHANGED", () => {
    const row = c.normalize(acctRec(RAW_ACCOUNT_CREDIT)) as AccountRow;
    expect(row.account_type).toBe("credit"); // top-level Plaid `type`, not subtype "credit card"
    expect(row.current_balance).toBe("-742.19"); // owed = NEGATIVE (matches SimpleFIN + amount<0=out)
    expect(row.available_balance).toBe("19150"); // available-credit passes through UNCHANGED (no nulling)
  });

  it("a second CREDIT card 1264.50 → -1264.5", () => {
    const row = c.normalize(acctRec(RAW_ACCOUNT_CREDIT_SECOND)) as AccountRow;
    expect(row.current_balance).toBe("-1264.5");
  });

  it("a DEPOSITORY account with the SAME magnitude (742.19) stays POSITIVE (assets are not negated)", () => {
    const row = c.normalize(acctRec(RAW_ACCOUNT_DEPOSITORY_742)) as AccountRow;
    expect(row.account_type).toBe("depository");
    expect(row.current_balance).toBe("742.19"); // asset → positive (sign fix keys off type, not magnitude)
  });

  it("the same card agrees in sign+magnitude with SimpleFIN after BOTH connectors' normalize", () => {
    // ONE card through BOTH normalize paths, so both halves name the same issuer — `RAW_ACCOUNT_CREDIT`
    // is the Plaid side of the First Platypus card (`INSTITUTIONS_GET_RESPONSE` in plaid.fixtures.ts),
    // and the raw below is the SimpleFIN side of it. Two halves naming two institutions would read as
    // an agreement between different cards, which is not the property.
    //
    // Plaid reports the owed balance as a POSITIVE magnitude (negate-on-write must fire); SimpleFIN
    // reports it NATIVELY NEGATIVE as a raw decimal string (must pass through as-is). Comparing the two
    // OUTPUTS (no hardcoded expected literal) fails if EITHER provider's sign handling regresses; the
    // shared owed=NEGATIVE convention is pinned separately so a mirrored double-regression can't sneak
    // an agreement at the wrong sign.
    const plaid = c.normalize(acctRec(RAW_ACCOUNT_CREDIT)) as AccountRow;
    const simplefin = new SimpleFinConnector().normalize({
      object: "account",
      externalId: "ACT-card-platinum-742",
      raw: {
        org: { domain: "firstplatypus.example", name: "First Platypus Bank" },
        id: "ACT-card-platinum-742",
        name: "Platinum Rewards Card (4318)",
        currency: "USD",
        balance: "-742.19", // SimpleFIN raw: liability owed, natively signed-negative
        "balance-date": 1735689600,
      },
    }) as SimpleFinAccountRow;

    expect(plaid.current_balance).not.toBeNull();
    expect(simplefin.current_balance).not.toBeNull();
    expect(Number(plaid.current_balance)).toBe(Number(simplefin.current_balance)); // sign + magnitude agree
    expect(Number(simplefin.current_balance)).toBeLessThan(0); // owed = NEGATIVE everywhere (#34a)
  });

  it("a null balance stays null (the finite-guard holds for liability and asset alike)", () => {
    const credit = c.normalize(
      acctRec({ ...RAW_ACCOUNT_CREDIT, balances: { ...RAW_ACCOUNT_CREDIT.balances, current: null } }),
    ) as AccountRow;
    expect(credit.current_balance).toBeNull();
  });
});

describe("PlaidConnector.normalize — transaction (negate-on-write)", () => {
  const c = new PlaidConnector();

  it("a DEBIT (Plaid positive=out) is stored NEGATIVE, with PFC + full enrichment", () => {
    const row = c.normalize(txnRec(RAW_TXN_DEBIT)) as TransactionRow;
    expect(row.source_object_id).toBe("plaid-txn-coffee-001");
    expect(row.account_source_id).toBe("plaid-acct-checking-001");
    expect(row.amount).toBe("-5.4"); // 5.4 (out) → negated
    expect(Number(row.amount)).toBeLessThan(0);
    expect(row.currency).toBe("USD");
    expect(row.description).toBe("Starbucks");
    expect(row.merchant).toBe("Starbucks"); // enrichment
    expect(row.pending).toBe(false);
    expect(row.category).toBe("FOOD_AND_DRINK"); // PFC primary
    expect(row.payment_channel).toBe("in store"); // enrichment
    expect(row.location_city).toBe("San Francisco");
    expect(row.location_region).toBe("CA");
    // datetime preferred over date; authorized_datetime preferred over authorized_date.
    expect(row.posted_at).toBe(new Date("2025-01-10T08:15:00Z").toISOString());
    expect(row.authorized_at).toBe(new Date("2025-01-09T20:00:00Z").toISOString());
  });

  it("a CREDIT (Plaid negative=in) is stored POSITIVE; merchant null; date fallback; no authorized_at", () => {
    const row = c.normalize(txnRec(RAW_TXN_CREDIT)) as TransactionRow;
    expect(row.amount).toBe("1500"); // -1500 (in) → negated to +1500
    expect(Number(row.amount)).toBeGreaterThan(0);
    expect(row.merchant).toBeNull();
    expect(row.category).toBe("INCOME");
    expect(row.payment_channel).toBe("other");
    // No `datetime` → posted_at falls back to `date` at UTC midnight.
    expect(row.posted_at).toBe(new Date("2025-01-01T00:00:00Z").toISOString());
    // No authorized_date/datetime → null.
    expect(row.authorized_at).toBeNull();
  });

  it("a MODIFIED txn carries pending=true and the negated amount", () => {
    const row = c.normalize(txnRec(RAW_TXN_MODIFIED)) as TransactionRow;
    expect(row.pending).toBe(true);
    expect(row.amount).toBe("-42.1");
  });
});

describe("PlaidConnector.strongKeys", () => {
  const c = new PlaidConnector();
  it("account -> { account_id }, transaction -> { txn_id }", () => {
    expect(c.strongKeys(acctRec(RAW_ACCOUNT))).toEqual({ account_id: "plaid-acct-checking-001" });
    expect(c.strongKeys(txnRec(RAW_TXN_DEBIT))).toEqual({ txn_id: "plaid-txn-coffee-001" });
  });
});

// ── holdings (#36) — fixtures inline (plaid.fixtures.ts carries the account/txn surface) ───────────

/** The securities[] entries /investments/holdings/get returns alongside holdings[]. */
const RAW_SECURITY_CTSO = {
  security_id: "sec-ctso",
  ticker_symbol: "CTSO",
  name: "Contoso Semiconductor Inc.",
  type: "equity",
  iso_currency_code: "USD",
  isin: "US11135F1012",
  close_price: 170.1,
} as const;
const RAW_SECURITY_CASH = {
  security_id: "sec-cash-usd",
  ticker_symbol: "CUR:USD",
  name: "US Dollar",
  type: "cash",
  is_cash_equivalent: true,
} as const;

/** holdings[] entries: CTSO carries both price stamps; the cash row carries neither (sync-time fallback). */
const RAW_HOLDING_CTSO = {
  account_id: "plaid-acct-invest-001",
  security_id: "sec-ctso",
  quantity: 12.5,
  institution_price: 170.1,
  institution_price_as_of: "2026-06-30",
  institution_price_datetime: "2026-06-30T20:00:00Z", // preferred over institution_price_as_of
  institution_value: 2126.25,
  cost_basis: 1500.5,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
} as const;
const RAW_HOLDING_CASH = {
  account_id: "plaid-acct-invest-001",
  security_id: "sec-cash-usd",
  quantity: 200,
  institution_value: 200,
  cost_basis: null,
  iso_currency_code: "USD",
  institution_price_as_of: null, // no datetime either → as_of falls back to the sync time
} as const;

/** An investment-type account — flips the per-Item holdings gate TRUE. */
const RAW_ACCOUNT_INVESTMENT = {
  account_id: "plaid-acct-invest-001",
  name: "Plaid IRA",
  type: "investment",
  subtype: "ira",
  balances: { current: 2326.25, iso_currency_code: "USD" },
} as const;

/** The /investments/holdings/get 200 body (holdings[] + securities[] + the account echo). */
const HOLDINGS_GET_RESPONSE = {
  accounts: [RAW_ACCOUNT_INVESTMENT],
  holdings: [RAW_HOLDING_CTSO, RAW_HOLDING_CASH],
  securities: [RAW_SECURITY_CTSO, RAW_SECURITY_CASH],
  item: { item_id: "item-abc" },
};

/** Build a holding RawRecord as sync() emits it: security joined under __pci_security. */
function holdRec(holding: Record<string, unknown>, security: Record<string, unknown> | null): RawRecord {
  return {
    object: "holding",
    externalId: `${holding.account_id}:${holding.security_id}`,
    raw: { ...holding, __pci_security: security },
  };
}

describe("PlaidConnector.normalize — holding (#36)", () => {
  const c = new PlaidConnector();

  it("maps the securities join (symbol/name/security_type), exact decimals, datetime-preferred as_of", () => {
    const row = c.normalize(holdRec(RAW_HOLDING_CTSO, RAW_SECURITY_CTSO)) as HoldingRow;
    expect(row.source_object_id).toBe("plaid-acct-invest-001:sec-ctso"); // the pair IS the identity
    expect(row.account_source_id).toBe("plaid-acct-invest-001");
    expect(row.symbol).toBe("CTSO"); // securities.ticker_symbol
    expect(row.name).toBe("Contoso Semiconductor Inc."); // securities.name
    expect(row.security_type).toBe("equity"); // enrichment (SimpleFIN leaves null)
    expect(row.quantity).toBe("12.5");
    expect(row.market_value).toBe("2126.25"); // institution_value
    expect(row.cost_basis).toBe("1500.5");
    expect(row.currency).toBe("USD");
    // institution_price_datetime preferred over institution_price_as_of.
    expect(row.as_of).toBe(new Date("2026-06-30T20:00:00Z").toISOString());
  });

  it("falls back to institution_price_as_of at UTC midnight when no datetime", () => {
    const { institution_price_datetime: _drop, ...noDatetime } = RAW_HOLDING_CTSO;
    const row = c.normalize(holdRec(noDatetime, RAW_SECURITY_CTSO)) as HoldingRow;
    expect(row.as_of).toBe(new Date("2026-06-30T00:00:00Z").toISOString());
  });

  it("falls back to the sync time when the holding carries NEITHER price stamp (the cash row)", () => {
    const before = Date.now();
    const row = c.normalize(holdRec(RAW_HOLDING_CASH, RAW_SECURITY_CASH)) as HoldingRow;
    const after = Date.now();
    const t = new Date(row.as_of).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 5);
    expect(t).toBeLessThanOrEqual(after + 5);
    expect(row.cost_basis).toBeNull(); // null passes through (faithful — no fabricated zero)
    expect(row.symbol).toBe("CUR:USD");
    expect(row.security_type).toBe("cash");
  });

  it("a missing securities join → symbol/name/security_type null, the holding columns still map", () => {
    const row = c.normalize(holdRec(RAW_HOLDING_CTSO, null)) as HoldingRow;
    expect(row.symbol).toBeNull();
    expect(row.name).toBeNull();
    expect(row.security_type).toBeNull();
    expect(row.quantity).toBe("12.5");
    expect(row.market_value).toBe("2126.25");
  });

  it("strongKeys: holding -> { account_id, security_id }", () => {
    expect(c.strongKeys(holdRec(RAW_HOLDING_CTSO, RAW_SECURITY_CTSO))).toEqual({
      account_id: "plaid-acct-invest-001",
      security_id: "sec-ctso",
    });
  });
});

// ── sync (drain + routing) — dummy env, fetch mocked by URL ─────────────────────────────────────────

describe("PlaidConnector.sync — has_more drain + per-record routing", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.PLAID_CLIENT_ID = "test-client-id";
    process.env.PLAID_SECRET = "test-secret";
    process.env.PLAID_ENV = "sandbox";
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  function ctx(over: Partial<SyncContext> = {}): SyncContext {
    return {
      userId: "00000000-0000-0000-0000-000000000001",
      connectionId: "11111111-1111-1111-1111-111111111111",
      secretRef: "sec_x",
      secret: "access-token-SECRET",
      ...over,
    };
  }

  /** A fetch mock that routes by Plaid endpoint; /transactions/sync returns PAGE_1 then PAGE_2. */
  function mockPlaid() {
    let syncCalls = 0;
    // Record the URL alongside each parsed body: sync() now also fires /item/get (health) up front, so
    // a /transactions/sync body must be selected by URL, not just "has an access_token".
    const bodies: Array<{ url: string; body: { cursor?: string; [k: string]: unknown } | undefined }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("/transactions/sync")) {
        const page = syncCalls++ === 0 ? SYNC_PAGE_1 : SYNC_PAGE_2;
        return new Response(JSON.stringify(page), { status: 200 });
      }
      if (url.includes("/item/get")) return new Response(JSON.stringify(ITEM_GET_RESPONSE), { status: 200 });
      if (url.includes("/institutions/get_by_id"))
        return new Response(JSON.stringify(INSTITUTIONS_GET_RESPONSE), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    return { fetchMock, bodies, syncCalls: () => syncCalls };
  }

  it("drains has_more, dedups accounts/txns, tags object, carries the final cursor, resolves institution", async () => {
    const { fetchMock, bodies } = mockPlaid();
    const c = new PlaidConnector();
    const recs = await collect(c.sync(ctx()));

    const accounts = recs.filter((r) => r.object === "account");
    const txns = recs.filter((r) => r.object === "transaction" && r.deleted !== true);
    expect(accounts.map((r) => r.externalId)).toEqual(["plaid-acct-checking-001"]); // deduped across pages
    expect(txns.map((r) => r.externalId).sort()).toEqual([
      "plaid-txn-coffee-001",
      "plaid-txn-grocery-003",
      "plaid-txn-payroll-002",
    ]);

    // Every record carries the FINAL next_cursor (page 2's).
    const cursors = new Set(recs.map((r) => r.cursor));
    expect(cursors.size).toBe(1);
    expect([...cursors][0]).toBe("cursor-after-page-2");

    // The account raw is threaded with the resolved institution name → normalize reads it.
    const acct = accounts[0];
    const acctRow = c.normalize(acct) as AccountRow;
    expect(acctRow.institution_name).toBe("First Platypus Bank");

    // Drain: /transactions/sync called exactly twice (page1 has_more → page2).
    const syncUrls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/transactions/sync"));
    expect(syncUrls.length).toBe(2);

    // First sync call sends NO cursor; the second passes page 1's next_cursor. (Selected by URL —
    // /item/get also carries an access_token, so filtering on that alone would mis-index.)
    const syncBodies = bodies.filter((b) => b.url.includes("/transactions/sync")).map((b) => b.body);
    expect(syncBodies[0]?.cursor).toBeUndefined();
    expect(syncBodies[1]?.cursor).toBe("cursor-after-page-1");

    // pending_transaction_id rides through on raw (pending→posted is remove-old-id + add-new-id; the
    // full Plaid payload — incl. pending_transaction_id — is preserved on the stored row's `raw`).
    const grocery = txns.find((r) => r.externalId === "plaid-txn-grocery-003");
    expect((grocery?.raw as { pending_transaction_id?: string }).pending_transaction_id).toBe("plaid-txn-pending-003");
  });

  it("removed ids yield deletion records carrying the FINAL cursor (after all live records)", async () => {
    mockPlaid();
    const recs = await collect(new PlaidConnector().sync(ctx()));

    // The removed id appears EXACTLY once, as a deletion record — never as a live transaction.
    const dels = recs.filter((r) => r.deleted === true);
    expect(dels).toEqual([
      {
        object: "transaction",
        externalId: "plaid-txn-removed-099",
        deleted: true,
        raw: { transaction_id: "plaid-txn-removed-099" },
        cursor: "cursor-after-page-2",
      },
    ]);
    // Deletion records come after every live yield (accounts, then txns, then deletions).
    expect(recs[recs.length - 1].deleted).toBe(true);
  });

  /** A fetch mock that feeds /transactions/sync an arbitrary page sequence (last-wins fixtures). */
  function mockPlaidSyncPages(pages: PlaidSyncPage[]) {
    let syncCalls = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes("/transactions/sync")) {
        return new Response(JSON.stringify(pages[syncCalls++]), { status: 200 });
      }
      if (url.includes("/item/get")) return new Response(JSON.stringify(ITEM_GET_RESPONSE), { status: 200 });
      if (url.includes("/institutions/get_by_id"))
        return new Response(JSON.stringify(INSTITUTIONS_GET_RESPONSE), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;
  }

  /** A minimal sync page; one drain can then stage added/removed for the same id in either order. */
  function page(over: Partial<PlaidSyncPage>, next: string, hasMore: boolean): PlaidSyncPage {
    return { accounts: [], added: [], modified: [], removed: [], ...over, next_cursor: next, has_more: hasMore };
  }
  const FLIP_TXN = {
    transaction_id: "plaid-txn-flip-001",
    account_id: "plaid-acct-checking-001",
    amount: 9.99,
    iso_currency_code: "USD",
    name: "Flip Mart",
    date: "2025-01-15",
  } as PlaidSyncPage["added"][number];

  it("LAST-WINS: added (page 1) then removed (page 3) → ONE deletion record, no live yield", async () => {
    mockPlaidSyncPages([
      page({ added: [FLIP_TXN] }, "flip-c1", true),
      page({}, "flip-c2", true),
      page({ removed: [{ transaction_id: "plaid-txn-flip-001" }] }, "flip-c3", false),
    ]);
    const recs = await collect(new PlaidConnector().sync(ctx()));

    const forId = recs.filter((r) => r.externalId === "plaid-txn-flip-001");
    expect(forId).toHaveLength(1);
    expect(forId[0].deleted).toBe(true);
    expect(forId[0].cursor).toBe("flip-c3"); // deletion records carry finalCursor too
  });

  it("LAST-WINS: removed (page 1) then added (page 3) → ONE live record, no deletion record", async () => {
    mockPlaidSyncPages([
      page({ removed: [{ transaction_id: "plaid-txn-flip-001" }] }, "flip-c1", true),
      page({}, "flip-c2", true),
      page({ added: [FLIP_TXN] }, "flip-c3", false),
    ]);
    const recs = await collect(new PlaidConnector().sync(ctx()));

    const forId = recs.filter((r) => r.externalId === "plaid-txn-flip-001");
    expect(forId).toHaveLength(1);
    expect(forId[0].deleted).toBeUndefined();
    expect(forId[0].raw).toEqual(FLIP_TXN);
    expect(recs.some((r) => r.deleted === true)).toBe(false);
  });

  it("a cursor present → passed as the starting cursor on the first call", async () => {
    const { bodies } = mockPlaid();
    await collect(new PlaidConnector().sync(ctx({ cursor: "prior-cursor" })));
    const firstSyncBody = bodies.find((b) => b.url.includes("/transactions/sync"))?.body;
    expect(firstSyncBody?.cursor).toBe("prior-cursor");
  });

  it("throws (missing access token) when ctx.secret is absent", async () => {
    process.env.PLAID_CLIENT_ID = "test-client-id";
    process.env.PLAID_SECRET = "test-secret";
    await expect(collect(new PlaidConnector().sync(ctx({ secret: null })))).rejects.toThrow(
      /missing access token/,
    );
  });
});

// ── sync — holdings gate + snapshot-reconcile discipline (#36) ─────────────────────────────────────

describe("PlaidConnector.sync — holdings gate + snapshot reconcile (#36)", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.PLAID_CLIENT_ID = "test-client-id";
    process.env.PLAID_SECRET = "test-secret";
    process.env.PLAID_ENV = "sandbox";
    reconcileMock.mockClear();
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
  function ctx(): SyncContext {
    return {
      userId: "00000000-0000-0000-0000-000000000001",
      connectionId: CONNECTION_ID,
      secretRef: "sec_x",
      secret: "access-token-SECRET",
    };
  }

  /**
   * URL-routed fetch mock: one /transactions/sync page whose accounts control the gate, plus a
   * configurable /investments/holdings/get response (200 snapshot by default).
   */
  function mockPlaidHoldings(opts: { accounts?: unknown[]; holdingsStatus?: number; holdingsBody?: unknown } = {}) {
    const page: PlaidSyncPage = {
      accounts: (opts.accounts ?? [RAW_ACCOUNT_INVESTMENT]) as PlaidSyncPage["accounts"],
      added: [RAW_TXN_DEBIT as unknown as PlaidSyncPage["added"][number]],
      modified: [],
      removed: [],
      next_cursor: "cursor-invest-1",
      has_more: false,
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/transactions/sync")) return new Response(JSON.stringify(page), { status: 200 });
      if (url.includes("/investments/holdings/get"))
        return new Response(JSON.stringify(opts.holdingsBody ?? HOLDINGS_GET_RESPONSE), {
          status: opts.holdingsStatus ?? 200,
        });
      if (url.includes("/item/get")) return new Response(JSON.stringify(ITEM_GET_RESPONSE), { status: 200 });
      if (url.includes("/institutions/get_by_id"))
        return new Response(JSON.stringify(INSTITUTIONS_GET_RESPONSE), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    return fetchMock;
  }

  const holdingsCalls = (fetchMock: { mock: { calls: unknown[][] } }) =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes("/investments/holdings/get")).length;

  it("an investment account gates ONE holdings call; records join securities; reconcile fires with the emitted ids", async () => {
    const fetchMock = mockPlaidHoldings();
    const before = new Date();
    const c = new PlaidConnector();
    const recs = await collect(c.sync(ctx()));

    expect(holdingsCalls(fetchMock)).toBe(1);
    const holds = recs.filter((r) => r.object === "holding");
    expect(holds.map((r) => r.externalId).sort()).toEqual([
      "plaid-acct-invest-001:sec-cash-usd",
      "plaid-acct-invest-001:sec-ctso",
    ]);
    // Holdings carry the same batch-final cursor as every other record.
    expect(new Set(holds.map((r) => r.cursor))).toEqual(new Set(["cursor-invest-1"]));
    // The security rides the record under __pci_security → normalize fills the join columns.
    const ctso = holds.find((r) => r.externalId === "plaid-acct-invest-001:sec-ctso");
    const row = c.normalize(ctso as RawRecord) as HoldingRow;
    expect(row.symbol).toBe("CTSO");
    expect(row.security_type).toBe("equity");
    expect((ctso?.raw as { __pci_security?: { name?: string } }).__pci_security?.name).toBe("Contoso Semiconductor Inc.");
    // Accounts + transactions still flow alongside holdings.
    expect(recs.some((r) => r.object === "account")).toBe(true);
    expect(recs.some((r) => r.object === "transaction")).toBe(true);

    // Snapshot reconcile: ONCE, after the complete enumeration, with exactly the emitted ids.
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const [connId, sector, object, liveIds, startedAt] = reconcileMock.mock.calls[0];
    expect(connId).toBe(CONNECTION_ID);
    expect(sector).toBe("finance");
    expect(object).toBe("holding");
    expect(liveIds).toEqual(new Set(["plaid-acct-invest-001:sec-ctso", "plaid-acct-invest-001:sec-cash-usd"]));
    expect(startedAt).toBeInstanceOf(Date);
    expect(startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("an Item with NO investment accounts makes NO holdings call; gate-false → truthful EMPTY-set reconcile", async () => {
    const fetchMock = mockPlaidHoldings({ accounts: [RAW_ACCOUNT] }); // depository only
    const recs = await collect(new PlaidConnector().sync(ctx()));

    expect(holdingsCalls(fetchMock)).toBe(0); // the billing gate: no investment account, no call
    expect(recs.some((r) => r.object === "holding")).toBe(false);
    // The gate evaluated FALSE on a successful NON-EMPTY accounts snapshot and no fetch was attempted:
    // the Item genuinely has no investment accounts → previously-cached positions are truthfully gone
    // (an empty-set reconcile; a no-op for Items that never held any).
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const [, , object, liveIds] = reconcileMock.mock.calls[0];
    expect(object).toBe("holding");
    expect(liveIds).toEqual(new Set());
  });

  it("a QUIET zero-account drain (broken Item syncs as empty arrays) performs NO reconcile", async () => {
    const fetchMock = mockPlaidHoldings({ accounts: [] });
    await collect(new PlaidConnector().sync(ctx()));
    expect(holdingsCalls(fetchMock)).toBe(0);
    expect(reconcileMock).not.toHaveBeenCalled(); // indeterminate snapshot — never mass-tombstone
  });

  it.each(["PRODUCTS_NOT_SUPPORTED", "NO_INVESTMENT_ACCOUNTS", "PRODUCT_NOT_READY"] as const)(
    "%s is a BENIGN per-Item skip: no throw, other objects still sync, NO holdings, NO reconcile",
    async (code) => {
      mockPlaidHoldings({ holdingsStatus: 400, holdingsBody: { error_code: code, error_message: "x" } });
      // No throw → syncConnection would keep the connection healthy (status flips only on a throw).
      const recs = await collect(new PlaidConnector().sync(ctx()));
      expect(recs.filter((r) => r.object === "account").map((r) => r.externalId)).toEqual([
        "plaid-acct-invest-001",
      ]);
      expect(recs.filter((r) => r.object === "transaction" && r.deleted !== true)).toHaveLength(1);
      expect(recs.some((r) => r.object === "holding")).toBe(false);
      expect(reconcileMock).not.toHaveBeenCalled(); // a SKIPPED fetch never reconciles
    },
  );

  it("a NON-benign holdings failure throws (fails the sync loudly) and performs NO reconcile", async () => {
    mockPlaidHoldings({ holdingsStatus: 500, holdingsBody: { error_code: "INTERNAL_SERVER_ERROR" } });
    await expect(collect(new PlaidConnector().sync(ctx()))).rejects.toThrow(
      /investments_holdings_get failed: 500/,
    );
    expect(reconcileMock).not.toHaveBeenCalled(); // a FAILED fetch never reconciles
  });

  it("investmentsHoldingsGet hits /investments/holdings/get and returns holdings + securities", async () => {
    const fetchMock = vi.fn(
      async (_url: string) => new Response(JSON.stringify(HOLDINGS_GET_RESPONSE), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const snap = await investmentsHoldingsGet("access-tok");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/investments/holdings/get");
    expect(snap.holdings).toHaveLength(2);
    expect(snap.securities.map((s) => s.security_id).sort()).toEqual(["sec-cash-usd", "sec-ctso"]);
  });
});

// ── thin client — secret-free errors ────────────────────────────────────────────────────────────────

describe("Plaid thin client", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.PLAID_CLIENT_ID = "test-client-id";
    process.env.PLAID_SECRET = "test-secret";
    process.env.PLAID_ENV = "sandbox";
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("linkTokenCreate returns the link_token and requests a 365-day transactions backfill", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ link_token: "link-sandbox-123" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    expect(await linkTokenCreate()).toBe("link-sandbox-123");

    // The /link/token/create body must request 365 days so Plaid's backfill matches SimpleFIN (wave 10D).
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      transactions?: { days_requested?: number };
    };
    expect(body.transactions?.days_requested).toBe(365);
  });

  it("exchangePublicToken returns { accessToken, itemId }", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "access-xyz", item_id: "item-1" }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    expect(await exchangePublicToken("public-token-abc")).toEqual({
      accessToken: "access-xyz",
      itemId: "item-1",
    });
  });

  it("a non-2xx throws with status + error_code, and NEVER leaks the access token", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error_code: "INVALID_ACCESS_TOKEN", error_message: "bad" }), {
          status: 400,
        }),
    ) as unknown as typeof globalThis.fetch;

    const ACCESS = "super-secret-access-token";
    await expect(transactionsSync(ACCESS)).rejects.toThrow(/transactions_sync failed: 400 INVALID_ACCESS_TOKEN/);
    try {
      await transactionsSync(ACCESS);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain(ACCESS);
    }
  });

  it(
    "fails loud when PLAID_CLIENT_ID / PLAID_SECRET are unset (and no plaid_app row)",
    async () => {
      delete process.env.PLAID_CLIENT_ID;
      delete process.env.PLAID_SECRET;
      // Serialize with the plaid_app-centric suites (#38): our `delete` + the no-row assertion race
      // their writes across vitest forks. Held around ONLY this test — the rest of the file is
      // contention-tolerant and stays parallel. lockTestResource no-ops on a DB-free run.
      const release = await lockTestResource("plaid_app");
      try {
        // plaidConfig is table-first: ensure no plaid_app row shadows the env fallback under test:db.
        try {
          const { pool } = await import("../db.js");
          await pool.query("delete from plaid_app");
        } catch {
          // DB-free run — the env fallback is the only path anyway.
        }
        await expect(linkTokenCreate()).rejects.toThrow(/not configured/);
      } finally {
        await release();
      }
    },
    60_000,
  );

  it("hostedLinkCreate requests a single-item hosted link (no multi-item) and reads the top-level hosted_link_url", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        // The hosted URL is the TOP-LEVEL hosted_link_url (verified live; #31).
        new Response(
          JSON.stringify({ link_token: "link-hosted-1", hosted_link_url: "https://secure.plaid.com/hl/abc" }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    expect(await hostedLinkCreate()).toEqual({
      linkToken: "link-hosted-1",
      hostedLinkUrl: "https://secure.plaid.com/hl/abc",
    });
    // No /user/create call (Plaid won't issue us a user_token), and NO enable_multi_item_link.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/user/create"))).toBe(false);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as {
      enable_multi_item_link?: boolean;
      hosted_link?: { url_lifetime_seconds?: number };
      transactions?: { days_requested?: number };
    };
    expect(body.enable_multi_item_link).toBeUndefined();
    expect(body.transactions?.days_requested).toBe(730);
    expect(body.hosted_link?.url_lifetime_seconds).toBe(10800);
  });

  it("linkTokenGet collects public_tokens from link_sessions[].results.item_add_results (complete when finished_at set)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            link_sessions: [
              {
                finished_at: "2026-06-21T20:00:00Z",
                results: { item_add_results: [{ public_token: "pt-1" }, { public_token: "pt-2" }] },
              },
            ],
          }),
          { status: 200 },
        ),
    ) as unknown as typeof globalThis.fetch;
    expect(await linkTokenGet("link-1")).toEqual({
      items: [{ publicToken: "pt-1" }, { publicToken: "pt-2" }],
      complete: true,
    });
  });

  it("linkTokenGet with an unfinished session (finished_at null) → empty + not complete", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ link_sessions: [{ finished_at: null, results: {} }] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;
    expect(await linkTokenGet("link-1")).toEqual({ items: [], complete: false });
  });

  it("relinkTokenCreate (update mode) carries the stored access_token, NO products field", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ link_token: "link-update-1", hosted_link_url: "https://link.plaid.com/h/upd" }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const ACCESS = "access-token-for-relink";
    expect(await relinkTokenCreate(ACCESS)).toEqual({
      linkToken: "link-update-1",
      hostedLinkUrl: "https://link.plaid.com/h/upd",
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string) as { access_token?: string; products?: unknown };
    expect(body.access_token).toBe(ACCESS); // update mode
    expect(body.products).toBeUndefined();
  });

  it("itemGet surfaces an item.error error_code + consent clock on a 200 (no throw)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            item: {
              institution_id: "ins_1",
              error: { error_code: "ITEM_LOGIN_REQUIRED" },
              consent_expiration_time: "2030-01-01T00:00:00Z",
              update_type: "background",
            },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof globalThis.fetch;
    const r = await itemGet("access-tok");
    expect(r.errorCode).toBe("ITEM_LOGIN_REQUIRED");
    expect(r.institutionId).toBe("ins_1");
    expect(r.consentExpirationTime).toBe("2030-01-01T00:00:00Z");
    expect(r.updateType).toBe("background");
    expect(r.httpStatus).toBe(200);
  });

  it("itemGet does NOT throw on a 429 quota — it returns the error_code + status, no token leak", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error_code: "CREDITS_EXHAUSTED" }), { status: 429 }),
    ) as unknown as typeof globalThis.fetch;
    const ACCESS = "super-secret-access-token";
    const r = await itemGet(ACCESS);
    expect(r.errorCode).toBe("CREDITS_EXHAUSTED");
    expect(r.httpStatus).toBe(429);
  });

  it("accountsBalanceGet (billed) sends account_ids and returns accounts", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ accounts: [{ account_id: "acc-1", balances: { current: 5 } }] }), {
          status: 200,
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const accts = await accountsBalanceGet("access-tok", ["acc-1"]);
    expect(accts.map((a) => a.account_id)).toEqual(["acc-1"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/accounts/balance/get");
    const body = JSON.parse((init as RequestInit).body as string) as { options?: { account_ids?: string[] } };
    expect(body.options?.account_ids).toEqual(["acc-1"]);
  });
});

// ── Branding: the name Plaid Link displays while the user hands over bank credentials (#109) ────────
//
// `client_name` is a literal WE send on every /link/token/create (never read from anyone's Plaid
// dashboard), so it is the same string for every Postern user on earth. These tests assert the REQUEST
// BODY WE ACTUALLY SEND for each of the three minting paths — deliberately NOT a repo grep: a grep goes
// green the moment one occurrence is renamed while another call site still ships the old name (this repo
// has already been bitten by exactly that, a rename that looked applied because only one of two tables
// changed).

describe("Plaid Link client_name (#109)", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.PLAID_CLIENT_ID = "test-client-id";
    process.env.PLAID_SECRET = "test-secret";
    process.env.PLAID_ENV = "sandbox";
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  // Every path that mints a /link/token/create: the widget token, the hosted-Link token, and the
  // update-mode (re-consent) token. Plaid renders client_name in ALL THREE, so all three are scanned.
  const minters: Array<[string, () => Promise<unknown>]> = [
    ["linkTokenCreate", () => linkTokenCreate()],
    ["hostedLinkCreate", () => hostedLinkCreate()],
    ["relinkTokenCreate (update mode)", () => relinkTokenCreate("access-token-for-relink")],
  ];

  /** Run one minting path against a mocked Plaid and return the /link/token/create body we sent. */
  async function linkTokenBody(
    call: () => Promise<unknown>,
  ): Promise<{ raw: string; parsed: { client_name?: unknown } }> {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ link_token: "link-1", hosted_link_url: "https://secure.plaid.com/hl/abc" }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    await call();
    const req = fetchMock.mock.calls.find(([u]) => String(u).includes("/link/token/create"));
    expect(req, "no /link/token/create request was sent").toBeDefined();
    const raw = (req![1] as RequestInit).body as string;
    return { raw, parsed: JSON.parse(raw) as { client_name?: unknown } };
  }

  it.each(minters)("%s displays the locked product name to the user", async (_label, call) => {
    const { parsed } = await linkTokenBody(call);
    // Asserted as a LITERAL as well as against the constant: POSTERN is operator-locked
    // (docs/design/naming-2026.md 🔒), so changing the constant's VALUE must also go red — the constant
    // exists to keep the three call sites in step, not to make the name editable.
    expect(parsed.client_name).toBe("Postern");
    expect(parsed.client_name).toBe(PLAID_LINK_CLIENT_NAME);
  });

  it.each(minters)("%s carries no trace of the retired product name", async (_label, call) => {
    const { raw } = await linkTokenBody(call);
    expect(raw).not.toContain("Personal Context Gateway");
    expect(raw).not.toContain("Context Gateway");
  });

  it("all three link-token paths send the SAME name (one constant, not three literals that drift)", async () => {
    const names: unknown[] = [];
    for (const [, call] of minters) names.push((await linkTokenBody(call)).parsed.client_name);
    expect(names).toEqual(["Postern", "Postern", "Postern"]);
    expect(new Set(names).size).toBe(1); // a rename applied to only some call sites fails here
  });
});

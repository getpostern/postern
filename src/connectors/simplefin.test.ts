// SimpleFIN unit tests — DB-free, network mocked. Covers: the setup-token claim (base64 decode +
// empty POST + clean error on failure, NEVER leaking the token/URL), normalize (account + txn,
// sign preserved, currency inherited, exact decimals, posted=0 fallback), per-record routing (sync
// tags object:'account'|'transaction'|'holding' with the parent linkage threaded into the txn/holding
// raw), the first-sync backfill windowing (<=90-day contiguous chunks over a year), and the holdings
// snapshot fan-out (#36: 3 holdings incl. a CASH row -> 3 records, account raw.holdings untouched,
// snapshot reconcile with exactly the emitted ids, NO reconcile on a failed fetch OR on a payload
// with non-empty errors[] — a partially-failing bridge = incomplete enumeration, review fold).
//
// reconcileObjectSnapshot is module-mocked (it is the runner's DB helper; this suite stays DB-free) —
// the mock doubles as the spy proving WHEN the connector calls it and with WHAT.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { RawRecord, SyncContext } from "./types.js";
import { SimpleFinConnector, claimSetupToken, type AccountRow, type TransactionRow, type HoldingRow } from "./simplefin.js";
import { ACCOUNTS_FIXTURE } from "./simplefin.fixtures.js";
import { reconcileObjectSnapshot } from "../sync/runner.js";

// DB-free: replace the runner module (simplefin.ts imports only reconcileObjectSnapshot from it).
vi.mock("../sync/runner.js", () => ({
  reconcileObjectSnapshot: vi.fn(async () => 0),
}));
const reconcileMock = vi.mocked(reconcileObjectSnapshot);

const realFetch = globalThis.fetch;
beforeEach(() => {
  reconcileMock.mockClear();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

async function collect(it: AsyncIterable<RawRecord>): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

function ctx(over: Partial<SyncContext> = {}): SyncContext {
  return {
    userId: "00000000-0000-0000-0000-000000000001",
    connectionId: "11111111-1111-1111-1111-111111111111",
    secretRef: "sec_x",
    secret: "https://demo:demo@beta-bridge.simplefin.org/simplefin",
    ...over,
  };
}

describe("claimSetupToken", () => {
  it("base64-decodes the token, POSTs an empty body to the claim URL, returns the access URL", async () => {
    const CLAIM_URL = "https://beta-bridge.simplefin.org/simplefin/claim/DEMOTOKEN";
    const ACCESS_URL = "https://user-abc:pw-xyz@beta-bridge.simplefin.org/simplefin";
    const setupToken = Buffer.from(CLAIM_URL, "utf8").toString("base64");

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(`${ACCESS_URL}\n`, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const accessUrl = await claimSetupToken(setupToken);
    expect(accessUrl).toBe(ACCESS_URL); // trimmed

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(CLAIM_URL); // honors the host inside the decoded token
    expect(init?.method).toBe("POST");
    expect(init?.body == null).toBe(true); // empty body
  });

  it("a 403 throws a clean error with NO token or URL in the message", async () => {
    const CLAIM_URL = "https://beta-bridge.simplefin.org/simplefin/claim/SECRET123";
    const setupToken = Buffer.from(CLAIM_URL, "utf8").toString("base64");
    globalThis.fetch = vi.fn(async () => new Response("forbidden", { status: 403 })) as unknown as typeof globalThis.fetch;

    await expect(claimSetupToken(setupToken)).rejects.toThrow("simplefin claim failed");
    try {
      await claimSetupToken(setupToken);
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toBe("simplefin claim failed"); // fixed, secret-free string
      // No secret material (the token, the decoded claim URL, or its secret path) leaks.
      expect(msg).not.toContain(setupToken);
      expect(msg).not.toContain(CLAIM_URL);
      expect(msg).not.toContain("SECRET123");
    }
  });

  it("a network failure throws a clean, secret-free error", async () => {
    const setupToken = Buffer.from("https://host/simplefin/claim/T", "utf8").toString("base64");
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED 1.2.3.4");
    }) as unknown as typeof globalThis.fetch;
    await expect(claimSetupToken(setupToken)).rejects.toThrow("simplefin claim failed");
  });

  it("a non-https decoded token is rejected without any network call", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const bad = Buffer.from("ftp://host/claim", "utf8").toString("base64");
    await expect(claimSetupToken(bad)).rejects.toThrow("simplefin claim failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SimpleFinConnector — declared shape", () => {
  const c = new SimpleFinConnector();
  it("is finance, read-only, poll @ 6h, incremental", () => {
    expect(c.provider).toBe("simplefin");
    expect(c.sector).toBe("finance");
    expect(c.objectType).toBe("transaction");
    expect(c.actions).toEqual([]);
    expect(c.policy).toEqual({
      mode: "poll",
      defaultIntervalSec: 21600,
      minIntervalSec: 7200, // ADR 0025 — the cadence floor (12/day: half the bridge's ≤24/day budget stays free for sync-now/fetch_live)
      freshnessToleranceSec: 21600,
      supportsIncremental: true,
    });
  });
  it("execute() throws (finance is read-only)", async () => {
    await expect(c.execute()).rejects.toThrow(/read-only/);
  });
});

describe("SimpleFinConnector.sync — per-record routing", () => {
  it("tags accounts and transactions, threads parent linkage into the txn raw, carries the window cursor", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(ACCOUNTS_FIXTURE), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    const c = new SimpleFinConnector();

    // Incremental (cursor present) -> a single window -> a single fetch.
    const recs = await collect(c.sync(ctx({ cursor: String(1735000000) })));

    const accounts = recs.filter((r) => r.object === "account");
    const txns = recs.filter((r) => r.object === "transaction");
    expect(accounts.map((r) => r.externalId).sort()).toEqual(["ACT-checking-001", "ACT-savings-002"]);
    expect(txns.map((r) => r.externalId).sort()).toEqual([
      "TXN-coffee-002",
      "TXN-paycheck-001",
      "TXN-postedzero-003",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The fetched URL hits /accounts on the access-URL host with the basic-auth lifted into an
    // Authorization HEADER — credentials must NOT be in the URL (Node's fetch rejects credentials-in-URL).
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toContain("https://beta-bridge.simplefin.org/simplefin/accounts?");
    expect(calledUrl).not.toContain("@"); // no embedded credentials in the URL
    const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
    expect(authHeader).toBe("Basic " + Buffer.from("demo:demo").toString("base64"));
    expect(calledUrl).toContain("start-date=");
    expect(calledUrl).toContain("end-date=");
    expect(calledUrl).not.toContain("pending=1");

    // Every record carries the same window-end cursor (a numeric epoch string).
    const cursors = new Set(recs.map((r) => r.cursor));
    expect(cursors.size).toBe(1);
    expect(String([...cursors][0])).toMatch(/^\d+$/);

    // The account raw is stripped of its embedded transactions; txn raw carries the parent linkage.
    const checking = accounts.find((r) => r.externalId === "ACT-checking-001")!;
    expect((checking.raw as Record<string, unknown>).transactions).toBeUndefined();
    const coffee = txns.find((r) => r.externalId === "TXN-coffee-002")!;
    const parent = (coffee.raw as { __pci_parent: { account_id: string; currency: string } }).__pci_parent;
    expect(parent.account_id).toBe("ACT-checking-001");
    expect(parent.currency).toBe("USD");
  });

  it("first sync (no cursor) backfills ~1 year in contiguous, <=90-day windows with no gaps", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ errors: [], accounts: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await collect(new SimpleFinConnector().sync(ctx({ cursor: undefined })));

    const windows = urls.map((u) => {
      const q = new URLSearchParams(u.slice(u.indexOf("?") + 1));
      return { start: Number(q.get("start-date")), end: Number(q.get("end-date")) };
    });
    expect(windows.length).toBeGreaterThanOrEqual(5); // 365 / 90 -> 5 chunks

    const DAY = 86_400;
    for (const w of windows) {
      expect(w.end - w.start).toBeLessThanOrEqual(90 * DAY);
      expect(w.end).toBeGreaterThan(w.start);
    }
    // Edge-to-edge: each window starts where the previous ended (no gaps, no overlaps).
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].start).toBe(windows[i - 1].end);
    }
    // Total coverage is exactly one year.
    expect(windows[windows.length - 1].end - windows[0].start).toBe(365 * DAY);
  });

  it("throws (no secret) when ctx.secret is missing", async () => {
    await expect(collect(new SimpleFinConnector().sync(ctx({ secret: null })))).rejects.toThrow(
      /missing access URL/,
    );
  });
});

// A brokerage account carrying 3 holdings — the spec's SimpleFIN acceptance fixture (#36): two
// equities (one with a padded symbol -> trimmed) and a CASH row with EMPTY symbol/currency (-> nulls).
// Mirrors the prod-captured live shape: decimals as strings, `created` in epoch seconds.
const HOLDINGS_FIXTURE = {
  errors: [],
  accounts: [
    {
      org: { domain: "client.schwab.com", name: "Charles Schwab" },
      id: "ACT-brokerage-003",
      name: "Brokerage (4321)",
      currency: "USD",
      balance: "8094.20",
      "balance-date": 1735689600,
      transactions: [],
      holdings: [
        {
          id: "HOL-ctso-001",
          created: 1735603200,
          currency: "USD",
          cost_basis: "1000.00",
          description: "CONTOSO SEMICONDUCTOR INC",
          market_value: "2470.00",
          purchase_price: "100.00",
          shares: "10.000000",
          symbol: "CTSO",
        },
        {
          id: "HOL-voo-002",
          created: 1735603200,
          currency: "USD",
          cost_basis: "0.00", // SimpleFIN's junk cost_basis — stored as reported (agent interprets)
          description: "VANGUARD S&P 500 ETF",
          market_value: "5500.75",
          purchase_price: "400.00",
          shares: "10.5",
          symbol: " VOO ", // padded -> normalize trims
        },
        {
          id: "HOL-cash-003",
          created: 1735603200,
          currency: "", // CASH row: empty currency -> null
          cost_basis: "0.00",
          description: "CASH",
          market_value: "123.45",
          purchase_price: "1.00",
          shares: "123.45",
          symbol: "", // CASH row: empty symbol -> null (the dedup fail-open guard key)
        },
      ],
    },
  ],
};

describe("SimpleFinConnector.sync — holdings snapshot fan-out (#36)", () => {
  const c = new SimpleFinConnector();

  it("emits one holding record per raw.holdings[] entry; the account raw keeps holdings untouched", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(HOLDINGS_FIXTURE), { status: 200 })) as unknown as typeof globalThis.fetch;
    const recs = await collect(c.sync(ctx({ cursor: String(1735000000) })));

    const holdings = recs.filter((r) => r.object === "holding");
    expect(holdings.map((r) => r.externalId).sort()).toEqual(["HOL-cash-003", "HOL-ctso-001", "HOL-voo-002"]);

    // The account record's raw is byte-faithful INCLUDING holdings[] (fan-out, not derivation).
    const acct = recs.find((r) => r.object === "account")!;
    expect((acct.raw as { holdings?: unknown }).holdings).toEqual(HOLDINGS_FIXTURE.accounts[0].holdings);

    // Each holding raw = the holding object verbatim + the synthetic __pci_parent threading.
    for (const h of holdings) {
      const raw = h.raw as Record<string, unknown> & { __pci_parent: { account_id: string } };
      expect(raw.__pci_parent).toEqual({ account_id: "ACT-brokerage-003" });
      const original = HOLDINGS_FIXTURE.accounts[0].holdings.find((x) => x.id === h.externalId)!;
      const { __pci_parent: _p, ...rest } = raw;
      expect(rest).toEqual(original); // original fields untouched
      expect(h.cursor).toMatch(/^\d+$/); // carries the window-end cursor like accounts/txns
    }
  });

  it("normalize maps a holding: exact decimals, trimmed symbol, description->name, created->as_of, SimpleFIN enrichment nulls", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(HOLDINGS_FIXTURE), { status: 200 })) as unknown as typeof globalThis.fetch;
    const recs = await collect(c.sync(ctx({ cursor: String(1735000000) })));

    const ctso = c.normalize(recs.find((r) => r.externalId === "HOL-ctso-001")!) as HoldingRow;
    expect(ctso).toEqual({
      source_object_id: "HOL-ctso-001",
      account_source_id: "ACT-brokerage-003",
      symbol: "CTSO",
      name: "CONTOSO SEMICONDUCTOR INC",
      security_type: null, // SimpleFIN enrichment-null — the agent infers; Plaid fills
      quantity: "10.000000", // exact string — no float drift
      market_value: "2470.00",
      cost_basis: "1000.00",
      currency: "USD",
      as_of: new Date(1735603200 * 1000).toISOString(),
    });

    const voo = c.normalize(recs.find((r) => r.externalId === "HOL-voo-002")!) as HoldingRow;
    expect(voo.symbol).toBe("VOO"); // padded symbol trimmed
    expect(voo.cost_basis).toBe("0.00"); // junk cost_basis stored as reported
  });

  it("a CASH row (empty symbol/currency) normalizes with nulls", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(HOLDINGS_FIXTURE), { status: 200 })) as unknown as typeof globalThis.fetch;
    const recs = await collect(c.sync(ctx({ cursor: String(1735000000) })));

    const cash = c.normalize(recs.find((r) => r.externalId === "HOL-cash-003")!) as HoldingRow;
    expect(cash.symbol).toBeNull();
    expect(cash.currency).toBeNull();
    expect(cash.name).toBe("CASH");
    expect(cash.quantity).toBe("123.45");
    expect(cash.market_value).toBe("123.45");
  });

  it("a successful sync ends with ONE snapshot reconcile carrying exactly the emitted holding ids", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(HOLDINGS_FIXTURE), { status: 200 })) as unknown as typeof globalThis.fetch;
    const before = new Date();
    await collect(c.sync(ctx({ cursor: String(1735000000) })));

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const [connectionId, sector, object, liveIds, startedAt] = reconcileMock.mock.calls[0];
    expect(connectionId).toBe("11111111-1111-1111-1111-111111111111"); // ctx.connectionId
    expect(sector).toBe("finance");
    expect(object).toBe("holding");
    expect(liveIds).toEqual(new Set(["HOL-ctso-001", "HOL-voo-002", "HOL-cash-003"]));
    // The fence is captured at sync START (before any fetch), so in-sync upserts survive it.
    expect(startedAt).toBeInstanceOf(Date);
    expect(startedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(startedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("a multi-window first sync reconciles ONCE with the deduped id set", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(HOLDINGS_FIXTURE), { status: 200 })) as unknown as typeof globalThis.fetch;
    const recs = await collect(c.sync(ctx({ cursor: undefined }))); // backfill -> 5 windows

    expect(recs.filter((r) => r.object === "holding").length).toBeGreaterThanOrEqual(15); // 3 per window
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(reconcileMock.mock.calls[0][3]).toEqual(new Set(["HOL-ctso-001", "HOL-voo-002", "HOL-cash-003"]));
  });

  it("accounts without holdings contribute none — a successful sync still reconciles with an EMPTY set", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(ACCOUNTS_FIXTURE), { status: 200 })) as unknown as typeof globalThis.fetch;
    const recs = await collect(c.sync(ctx({ cursor: String(1735000000) })));

    expect(recs.filter((r) => r.object === "holding")).toEqual([]);
    // The enumeration COMPLETED, so a genuinely-empty snapshot reconciles (positions gone = truthful).
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(reconcileMock.mock.calls[0][3]).toEqual(new Set());
  });

  it("a payload with non-empty errors[] EMITS its records but performs NO reconcile (incomplete enumeration)", async () => {
    // A partially-failing bridge: per-institution error strings alongside the accounts that DID
    // return. Reconciling on this partial payload would mass-tombstone the failing institution's
    // holdings (review fold, spec finance-holding) — so the sweep is skipped; the data is kept.
    const partial = {
      ...HOLDINGS_FIXTURE,
      errors: ["Connection to Fidelity may need attention"],
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(partial), { status: 200 })) as unknown as typeof globalThis.fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recs = await collect(c.sync(ctx({ cursor: String(1735000000) })));

    // Emission still happens — every account/txn/holding record is yielded (keep the data) …
    expect(recs.filter((r) => r.object === "holding").map((r) => r.externalId).sort()).toEqual([
      "HOL-cash-003",
      "HOL-ctso-001",
      "HOL-voo-002",
    ]);
    expect(recs.filter((r) => r.object === "account")).toHaveLength(1);
    // … but the snapshot sweep NEVER runs (the spy stays uncalled).
    expect(reconcileMock).not.toHaveBeenCalled();
    // The bridge-authored message is surfaced (never the access URL).
    expect(warn).toHaveBeenCalledWith("simplefin: Connection to Fidelity may need attention");
  });

  it("errors[] in ANY backfill window skips the reconcile even when the other windows are clean", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      // Window 2 of the 5-window backfill reports a per-institution error; the rest are clean.
      const body = calls === 2 ? { ...HOLDINGS_FIXTURE, errors: ["MFA required at Fidelity"] } : HOLDINGS_FIXTURE;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recs = await collect(c.sync(ctx({ cursor: undefined })));

    expect(calls).toBeGreaterThanOrEqual(5);
    expect(recs.filter((r) => r.object === "holding").length).toBeGreaterThanOrEqual(15); // all windows emitted
    expect(reconcileMock).not.toHaveBeenCalled(); // one dirty window taints the whole enumeration
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a FAILED fetch performs NO reconcile (a transient miss never mass-tombstones)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof globalThis.fetch;
    await expect(collect(c.sync(ctx({ cursor: String(1735000000) })))).rejects.toThrow(/500/);
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("a MID-BACKFILL failure (window 2 of 5) performs NO reconcile", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls >= 2) throw new Error("ECONNRESET");
      return new Response(JSON.stringify(HOLDINGS_FIXTURE), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await expect(collect(c.sync(ctx({ cursor: undefined })))).rejects.toThrow(/fetch failed/);
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});

describe("SimpleFinConnector.normalize", () => {
  const c = new SimpleFinConnector();

  async function syncedRecords(): Promise<RawRecord[]> {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(ACCOUNTS_FIXTURE), { status: 200 })) as unknown as typeof globalThis.fetch;
    return collect(c.sync(ctx({ cursor: String(1735000000) })));
  }

  it("maps an account: institution_name from org.name, exact decimals, available-balance, balance_at", async () => {
    const recs = await syncedRecords();
    const checking = recs.find((r) => r.externalId === "ACT-checking-001")!;
    const row = c.normalize(checking) as AccountRow;
    expect(row.source_object_id).toBe("ACT-checking-001");
    expect(row.name).toBe("Everyday Checking");
    expect(row.account_type).toBeNull(); // SimpleFIN has none
    expect(row.currency).toBe("USD");
    expect(row.current_balance).toBe("114545.51"); // exact string — no float drift
    expect(row.available_balance).toBe("114000.00");
    expect(row.balance_at).toBe(new Date(1735689600 * 1000).toISOString());
    expect(row.balance_at_is_synthetic).toBe(false);
    expect(row.institution_name).toBe("My Bank");
  });

  it("an account with no available-balance -> available_balance null", async () => {
    const recs = await syncedRecords();
    const savings = recs.find((r) => r.externalId === "ACT-savings-002")!;
    const row = c.normalize(savings) as AccountRow;
    expect(row.available_balance).toBeNull();
    expect(row.current_balance).toBe("5000.25");
    expect(row.institution_name).toBe("Demo Credit Union");
  });

  it("maps a paycheck (+) and a spend (-): sign preserved, currency inherited, merchant=payee", async () => {
    const recs = await syncedRecords();
    const paycheck = c.normalize(recs.find((r) => r.externalId === "TXN-paycheck-001")!) as TransactionRow;
    expect(paycheck.amount).toBe("1960.00"); // money IN, positive, exact
    expect(paycheck.currency).toBe("USD"); // inherited from the parent account
    expect(paycheck.account_source_id).toBe("ACT-checking-001");
    expect(paycheck.merchant).toBe("ACME Corp");
    expect(paycheck.pending).toBe(false);
    expect(paycheck.category).toBeNull();

    const coffee = c.normalize(recs.find((r) => r.externalId === "TXN-coffee-002")!) as TransactionRow;
    expect(coffee.amount).toBe("-20.00"); // money OUT, negative = out
    expect(Number(coffee.amount)).toBeLessThan(0);
  });

  it("posted=0 falls back to transacted_at for posted_at", async () => {
    const recs = await syncedRecords();
    const zero = c.normalize(recs.find((r) => r.externalId === "TXN-postedzero-003")!) as TransactionRow;
    expect(zero.posted_at).toBe(new Date(1735500000 * 1000).toISOString());
  });
});

describe("SimpleFinConnector.strongKeys", () => {
  const c = new SimpleFinConnector();
  it("account -> { account_id }, transaction -> { txn_id }, holding -> { holding_id }", () => {
    expect(c.strongKeys({ object: "account", externalId: "A1", raw: { id: "A1" } })).toEqual({
      account_id: "A1",
    });
    expect(c.strongKeys({ object: "transaction", externalId: "T1", raw: { id: "T1" } })).toEqual({
      txn_id: "T1",
    });
    expect(c.strongKeys({ object: "holding", externalId: "H1", raw: { id: "H1" } })).toEqual({
      holding_id: "H1",
    });
  });
});

// Captured Plaid /transactions/sync pages for fixture-based unit tests (DB-free, network-free).
//
// Two pages exercise the has_more drain:
//   PAGE_1 (has_more:true): one account snapshot + one debit (positive amount → must store NEGATIVE).
//   PAGE_2 (has_more:false): the same account snapshot (dedup by account_id) + an income credit
//          (negative amount → must store POSITIVE) + one MODIFIED txn + one REMOVED entry.
//
// Covers the spec assertions: negate-on-write (debit positive→negative, credit negative→positive),
// category from personal_finance_category.primary, enrichment columns (merchant_name, payment_channel,
// authorized_date/datetime, location, account type, available balance), exact decimals, the
// datetime-preferred-over-date rule, and the removed-logged-not-applied path.

import type { PlaidSyncPage } from "./plaid.js";

/** The single account snapshot Plaid repeats on every page. */
const ACCOUNT = {
  account_id: "plaid-acct-checking-001",
  name: "Plaid Checking",
  official_name: "Plaid Gold Standard 0% Interest Checking",
  type: "depository",
  subtype: "checking",
  balances: {
    current: 110.0,
    available: 100.25,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
  },
} as const;

/** A debit: Plaid amount is POSITIVE (money out) → normalize must store it NEGATIVE. */
const TXN_DEBIT = {
  transaction_id: "plaid-txn-coffee-001",
  account_id: "plaid-acct-checking-001",
  amount: 5.4, // POSITIVE = money OUT (Plaid) → store "-5.4"
  iso_currency_code: "USD",
  name: "Starbucks",
  merchant_name: "Starbucks",
  pending: false,
  date: "2025-01-10",
  datetime: "2025-01-10T08:15:00Z", // preferred over `date`
  authorized_date: "2025-01-09",
  authorized_datetime: "2025-01-09T20:00:00Z",
  payment_channel: "in store",
  personal_finance_category: {
    primary: "FOOD_AND_DRINK",
    detailed: "FOOD_AND_DRINK_COFFEE",
    confidence_level: "VERY_HIGH",
  },
  location: { city: "San Francisco", region: "CA" },
  counterparties: [{ name: "Starbucks", type: "merchant" }],
  logo_url: "https://logos.example/starbucks.png",
  website: "starbucks.com",
} as const;

/** A credit/income: Plaid amount is NEGATIVE (money in) → normalize must store it POSITIVE. */
const TXN_CREDIT = {
  transaction_id: "plaid-txn-payroll-002",
  account_id: "plaid-acct-checking-001",
  amount: -1500.0, // NEGATIVE = money IN (Plaid) → store "1500"
  iso_currency_code: "USD",
  name: "ACME PAYROLL",
  merchant_name: null,
  pending: false,
  date: "2025-01-01",
  // no datetime → posted_at must fall back to `date` at UTC midnight
  payment_channel: "other",
  personal_finance_category: { primary: "INCOME", detailed: "INCOME_WAGES" },
  location: { city: null, region: null },
} as const;

/** A modified txn (still PENDING) — proves modified is upserted and `pending` maps through. Carries a
 *  pending_transaction_id (Plaid's link from a posted txn to its pending ghost) preserved verbatim in raw. */
const TXN_MODIFIED = {
  transaction_id: "plaid-txn-grocery-003",
  account_id: "plaid-acct-checking-001",
  amount: 42.1, // positive → store "-42.1"
  iso_currency_code: "USD",
  name: "Whole Foods Market",
  merchant_name: "Whole Foods",
  pending: true,
  pending_transaction_id: "plaid-txn-pending-003",
  date: "2025-01-12",
  datetime: "2025-01-12T17:30:00Z",
  payment_channel: "in store",
  personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES" },
  location: { city: "Oakland", region: "CA" },
} as const;

export const SYNC_PAGE_1: PlaidSyncPage = {
  accounts: [ACCOUNT as unknown as PlaidSyncPage["accounts"][number]],
  added: [TXN_DEBIT as unknown as PlaidSyncPage["added"][number]],
  modified: [],
  removed: [],
  next_cursor: "cursor-after-page-1",
  has_more: true,
};

export const SYNC_PAGE_2: PlaidSyncPage = {
  accounts: [ACCOUNT as unknown as PlaidSyncPage["accounts"][number]],
  added: [TXN_CREDIT as unknown as PlaidSyncPage["added"][number]],
  modified: [TXN_MODIFIED as unknown as PlaidSyncPage["modified"][number]],
  removed: [{ transaction_id: "plaid-txn-removed-099" }],
  next_cursor: "cursor-after-page-2",
  has_more: false,
};

/**
 * A CREDIT card snapshot (#34a balance-sign): Plaid reports `current` as a POSITIVE magnitude OWED,
 * even for liabilities. normalize() must store it NEGATIVE (owed = negative everywhere). The card
 * case: current 742.19 → "-742.19"; available-CREDIT (19150) passes through UNCHANGED.
 */
const ACCOUNT_CREDIT = {
  account_id: "plaid-acct-credit-001",
  name: "Plaid Platinum",
  official_name: "Plaid Platinum Rewards Card",
  type: "credit",
  subtype: "credit card",
  balances: {
    current: 742.19, // POSITIVE magnitude OWED (Plaid) → store "-742.19"
    available: 19150, // available CREDIT (limit − owed) → passes through UNCHANGED
    iso_currency_code: "USD",
    unofficial_currency_code: null,
  },
} as const;

/** A second CREDIT card: current 1264.50 → "-1264.5" (the trailing zero is not preserved). */
const ACCOUNT_CREDIT_SECOND = {
  account_id: "plaid-acct-credit-002",
  name: "Plaid Everyday",
  official_name: "Plaid Everyday Cashback Card",
  type: "credit",
  subtype: "credit card",
  balances: {
    current: 1264.5, // POSITIVE magnitude OWED (Plaid) → store "-1264.5"
    available: 3600,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
  },
} as const;

/**
 * A DEPOSITORY account with the SAME magnitude as the credit card (742.19) — an ASSET stays POSITIVE
 * (proves the sign fix keys off `account_type`, not the magnitude).
 */
const ACCOUNT_DEPOSITORY_742 = {
  account_id: "plaid-acct-checking-742",
  name: "Plaid Checking 742",
  official_name: "Plaid Gold Standard 0% Interest Checking",
  type: "depository",
  subtype: "checking",
  balances: {
    current: 742.19, // ASSET → stays POSITIVE "742.19"
    available: 800.0,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
  },
} as const;

/** The raw account/txn objects, for direct (sync-free) normalize() assertions. */
export const RAW_ACCOUNT = ACCOUNT;
export const RAW_ACCOUNT_CREDIT = ACCOUNT_CREDIT;
export const RAW_ACCOUNT_CREDIT_SECOND = ACCOUNT_CREDIT_SECOND;
export const RAW_ACCOUNT_DEPOSITORY_742 = ACCOUNT_DEPOSITORY_742;
export const RAW_TXN_DEBIT = TXN_DEBIT;
export const RAW_TXN_CREDIT = TXN_CREDIT;
export const RAW_TXN_MODIFIED = TXN_MODIFIED;

/** Item + institution lookups the sync drain performs after paging (best-effort enrichment). */
export const ITEM_GET_RESPONSE = { item: { item_id: "item-abc", institution_id: "ins_109508" } };
export const INSTITUTIONS_GET_RESPONSE = { institution: { name: "First Platypus Bank" } };

// SimpleFIN conformance fixtures — representative RawRecords as sync() would emit them (an account
// with its embedded transactions stripped into `raw`, a transaction whose `raw` carries the
// synthetic __pci_parent threading, and a holding (#36) fanned out of raw.holdings[] with the same
// __pci_parent threading). Finance deletion is ACCEPTED-NONE → no deletion records (holdings
// deletion is the connector-driven snapshot reconcile, not a deletion RawRecord).

import type { ConformanceFixtures } from "../sdk/index.js";
import { ACCOUNTS_FIXTURE } from "./simplefin.fixtures.js";

const acct = ACCOUNTS_FIXTURE.accounts[0];
const { transactions, ...accountRest } = acct; // sync stores the account MINUS its embedded txns
const txn = acct.transactions[0];

// A holding as sync() emits it (the prod-captured live shape + the parent threading). The shared
// ACCOUNTS_FIXTURE carries no holdings, so the representative record is composed here.
const holding = {
  id: "HOL-conformance-001",
  created: 1735603200,
  currency: "USD",
  cost_basis: "1000.00",
  description: "CONTOSO SEMICONDUCTOR INC",
  market_value: "2470.00",
  purchase_price: "100.00",
  shares: "10.000000",
  symbol: "CTSO",
  __pci_parent: { account_id: acct.id },
};

export const SIMPLEFIN_CONFORMANCE: ConformanceFixtures = {
  sectors: ["finance"],
  live: [
    { object: "account", externalId: acct.id, raw: accountRest, cursor: "1735689600" },
    {
      object: "transaction",
      externalId: txn.id,
      raw: { ...txn, __pci_parent: { account_id: acct.id, currency: acct.currency } },
      cursor: "1735689600",
    },
    { object: "holding", externalId: holding.id, raw: holding, cursor: "1735689600" },
  ],
  deletions: [],
  deletionPairs: [],
};

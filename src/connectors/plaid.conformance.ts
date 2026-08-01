// Plaid conformance fixtures — an account (with the threaded institution_name, as sync() enriches it),
// a transaction, and a holding (#36 — the /investments/holdings/get entry with its security joined
// under __pci_security, as sync() nests it), plus a deletion record for the SAME transaction id (the
// /transactions/sync `removed` path). The deletionPair proves the tombstone externalId == the live
// source_object_id.

import type { ConformanceFixtures } from "../sdk/index.js";
import { RAW_ACCOUNT, RAW_TXN_DEBIT } from "./plaid.fixtures.js";

/** A holding raw as sync() emits it: the holdings[] entry + its securities[] join under __pci_security. */
const RAW_HOLDING = {
  account_id: "plaid-acct-invest-001",
  security_id: "plaid-sec-ctso-001",
  quantity: 12.5,
  institution_price: 170.1,
  institution_price_as_of: "2026-06-30",
  institution_value: 2126.25,
  cost_basis: 1500.5,
  iso_currency_code: "USD",
  unofficial_currency_code: null,
  __pci_security: {
    security_id: "plaid-sec-ctso-001",
    ticker_symbol: "CTSO",
    name: "Contoso Semiconductor Inc.",
    type: "equity",
    iso_currency_code: "USD",
  },
};

export const PLAID_CONFORMANCE: ConformanceFixtures = {
  sectors: ["finance"],
  live: [
    {
      object: "account",
      externalId: RAW_ACCOUNT.account_id,
      raw: { ...RAW_ACCOUNT, institution_name: "First Platypus Bank" },
      cursor: "cursor-after-page-2",
    },
    {
      object: "transaction",
      externalId: RAW_TXN_DEBIT.transaction_id,
      raw: RAW_TXN_DEBIT,
      cursor: "cursor-after-page-2",
    },
    {
      object: "holding",
      externalId: `${RAW_HOLDING.account_id}:${RAW_HOLDING.security_id}`, // the (account, security) pair IS the identity
      raw: RAW_HOLDING,
      cursor: "cursor-after-page-2",
    },
  ],
  deletions: [
    {
      object: "transaction",
      deleted: true,
      externalId: RAW_TXN_DEBIT.transaction_id,
      raw: { transaction_id: RAW_TXN_DEBIT.transaction_id },
      cursor: "cursor-after-page-2",
    },
  ],
  deletionPairs: [
    { sourceObjectId: RAW_TXN_DEBIT.transaction_id, externalId: RAW_TXN_DEBIT.transaction_id },
  ],
};

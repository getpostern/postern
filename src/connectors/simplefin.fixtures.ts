// A captured SimpleFIN /accounts response (v1 shape) for fixture-based unit + DB-round-trip tests.
// Two accounts (one with org.name, available-balance, and three transactions; one bare savings
// account with no transactions). Decimals are STRINGS (exact precision); times are epoch SECONDS.
//
// Covers the assertions in the spec: institution_name from org.name, an exact decimal balance
// ("114545.51"), a paycheck (+) and a spend (-) for sign preservation, a posted=0 txn that must
// fall back to transacted_at, and an account with no available-balance (-> null).

export const ACCOUNTS_FIXTURE = {
  errors: [],
  accounts: [
    {
      org: {
        domain: "mybank.example",
        name: "My Bank",
        "sfin-url": "https://beta-bridge.simplefin.org/simplefin",
      },
      id: "ACT-checking-001",
      name: "Everyday Checking",
      currency: "USD",
      balance: "114545.51",
      "available-balance": "114000.00",
      "balance-date": 1735689600, // 2025-01-01T00:00:00Z
      transactions: [
        {
          id: "TXN-paycheck-001",
          posted: 1735603200, // 2024-12-31
          transacted_at: 1735603200,
          amount: "1960.00", // money IN (positive)
          description: "ACME PAYROLL DIRECT DEP",
          payee: "ACME Corp",
          memo: "Salary",
        },
        {
          id: "TXN-coffee-002",
          posted: 1735612345,
          transacted_at: 1735612000,
          amount: "-20.00", // money OUT (negative)
          description: "BLUE BOTTLE COFFEE",
          payee: "Blue Bottle",
          memo: "",
        },
        {
          id: "TXN-postedzero-003",
          posted: 0, // not yet posted -> must fall back to transacted_at
          transacted_at: 1735500000,
          amount: "-5.50",
          description: "CORNER STORE",
          payee: "Corner Store",
        },
      ],
      holdings: [],
      extra: { "account-open-date": 1600000000 },
    },
    {
      org: { name: "Demo Credit Union" },
      id: "ACT-savings-002",
      name: "Rainy Day Savings",
      currency: "USD",
      balance: "5000.25",
      // no available-balance -> available_balance must be null
      "balance-date": 1735689600,
      transactions: [],
    },
  ],
} as const;

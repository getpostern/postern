// The ONE money rendering the inspector uses — list cell and record drill both.
//
// It exists as its own module because the drill already had it (`record.ts`'s private `money()`)
// and the list did not: the list sent Balance / Amount / Value through `formatNum`, which yields
// "-87.32" — an ASCII hyphen and no currency — one click away from the drill's "−$87.32" with a
// true U+2212. Two renderings of the same fact, one screen apart (#100 item 3). `record.ts` now
// imports `moneyOrNull` from here, so a future change cannot drift them apart again.
//
// Currency handling is the drill's, unchanged and deliberate: "USD" → "$"; any other non-empty
// string → the code plus a space ("EUR 42.00"); ABSENT/EMPTY → no symbol at all. Never default to
// "$" — a EUR account and a null-currency SimpleFIN cash row (src/core/schema.ts: finance.holding
// `currency` is nullable) must not be dressed as dollars.

/** "−$6.50" / "$1,204.00" / "EUR 42.00"; null when the amount is absent or non-numeric. */
export function moneyOrNull(amount: unknown, currency: unknown): string | null {
  if (amount == null || amount === "") return null;
  const n = Number(amount);
  if (Number.isNaN(n)) return null;
  const sym = currency === "USD" ? "$" : typeof currency === "string" && currency ? `${currency} ` : "";
  const body = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // U+2212 MINUS SIGN, never the ASCII hyphen `toLocaleString` would produce on its own.
  return `${n < 0 ? "−" : ""}${sym}${body}`;
}

/** The list-cell rendering: "—" when absent, the raw string when non-numeric, else `moneyOrNull`. */
export function formatMoney(amount: unknown, currency: unknown): string {
  if (amount == null || amount === "") return "—";
  // A non-numeric value is echoed VERBATIM rather than swallowed: the cache is a faithful mirror,
  // and a value we cannot parse is still a value the source served.
  return moneyOrNull(amount, currency) ?? String(amount);
}

// The inspector table's list state — ONE pure function, seven mutually-exclusive answers.
//
// THE BUG this exists to kill (#100 item 1): `ObjectTable` had no `isError` branch at all. It chose
// between two zero states on `storeTotal === 0`, and a FAILED `query()` leaves `rows = []` with
// `storeTotal = undefined` — so an outage rendered as "Nothing matches that filter" over an empty
// `<code></code>`, with "Total not served" beneath it. The Console told the operator *"you have no
// data"* when what actually happened was *"we could not read it"*, and offered no retry because
// there was no state to hang one on.
//
// The precedence below IS the contract, and two of its rungs carry the whole finding:
//   - `isError` outranks everything. A failed read is a failed read even when a stale count survives
//     in the query cache.
//   - `counting` exists because `storeTotal === undefined` is NOT `storeTotal === 0`. Claiming
//     "nothing matches" before the count lands is the same lie in miniature.

/** Which of the seven mutually-exclusive list states the inspector table is in. */
export type ListState =
  | "error" // the rows read FAILED — an outage, not an empty store
  | "loading" // the rows read is still in flight
  | "rows" // rows came back
  | "counting" // rows are empty and the store total has not landed — claim nothing yet
  | "store-empty" // the store total is 0 — nothing has ever synced for this object
  | "filter-empty" // a filter is set and matched nothing
  | "page-empty"; // no filter, the store holds rows, but THIS page came back empty

export interface ListStateInput {
  isError: boolean;
  isPending: boolean;
  rowCount: number;
  /** The served store-total count aggregate; `undefined` = not landed yet. */
  storeTotal: number | undefined;
  /** The DEBOUNCED, trimmed filter string ("" = no filter). */
  filter: string;
}

export function listState(i: ListStateInput): ListState {
  if (i.isError) return "error";
  if (i.isPending) return "loading";
  if (i.rowCount > 0) return "rows";
  if (i.storeTotal === undefined) return "counting";
  if (i.storeTotal === 0) return "store-empty";
  if (i.filter !== "") return "filter-empty";
  return "page-empty";
}

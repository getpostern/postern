// The seven list states, pinned. Each test names the MUTATION it catches — the recorded failure
// mode here is a test that agrees with the defect (defect-catalog entry 12).

import { describe, expect, it } from "vitest";
import { listState, type ListStateInput } from "./liststate";

function input(over: Partial<ListStateInput> = {}): ListStateInput {
  return { isError: false, isPending: false, rowCount: 0, storeTotal: 0, filter: "", ...over };
}

describe("listState — a failed read is never an empty store (#100 item 1)", () => {
  it("a failed read is 'error' even when a stale store total is still in the cache", () => {
    // Catches: putting the isError check BELOW the storeTotal checks, which sends an outage back
    // into a zero-state. A react-query cache legitimately keeps the previous count across a failed
    // refetch, so `storeTotal` is often a real number at exactly the moment the read broke.
    expect(listState(input({ isError: true, storeTotal: 2481, filter: "" }))).toBe("error");
    expect(listState(input({ isError: true, storeTotal: 0 }))).toBe("error");
    expect(listState(input({ isError: true, storeTotal: undefined, filter: "zzz" }))).toBe("error");
    // …and even with rows already on screen from the previous page.
    expect(listState(input({ isError: true, rowCount: 25, storeTotal: 2481 }))).toBe("error");
  });

  it("a pending read never claims a state about the store", () => {
    // Catches: rendering a zero-state during the first paint, before anything has been read.
    expect(listState(input({ isPending: true, storeTotal: undefined }))).toBe("loading");
    expect(listState(input({ isPending: true, storeTotal: 0 }))).toBe("loading");
  });

  it("rows present outrank every empty branch", () => {
    // Catches: a stale/disagreeing count blanking a table that demonstrably has rows.
    expect(listState(input({ rowCount: 3, storeTotal: 0 }))).toBe("rows");
    expect(listState(input({ rowCount: 3, storeTotal: undefined, filter: "abc" }))).toBe("rows");
  });

  it("an unlanded store total claims nothing — not 'nothing matches'", () => {
    // Catches: the exact undefined-vs-0 conflation this finding is about. `undefined` is "we have
    // not counted yet"; `0` is "the store is empty". They are different sentences.
    expect(listState(input({ rowCount: 0, storeTotal: undefined, filter: "" }))).toBe("counting");
    expect(listState(input({ rowCount: 0, storeTotal: undefined, filter: "abc" }))).toBe("counting");
  });

  it("a zero store total is the unconnected state, filter or no filter", () => {
    expect(listState(input({ storeTotal: 0, filter: "" }))).toBe("store-empty");
    expect(listState(input({ storeTotal: 0, filter: "abc" }))).toBe("store-empty");
  });

  it("a filter that matched nothing is distinct from an empty page", () => {
    // Catches: collapsing the two, which is what renders the empty <code></code> — the filtered
    // zero state interpolates the filter string, and with no filter that string is "".
    expect(listState(input({ storeTotal: 500, filter: "zzz" }))).toBe("filter-empty");
    expect(listState(input({ storeTotal: 500, filter: "" }))).toBe("page-empty");
  });
});

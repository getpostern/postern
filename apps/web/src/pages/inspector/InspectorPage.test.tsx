// InspectorPage render behaviour a static artboard can't show: the finance-only includeShadowed
// reveal (#82), object tabs for multi-object sectors only, the SOURCE column's provenance (#65/#122),
// and — since `GET /api/operator/schema` landed — the "as an agent sees it" peek as a control that
// WORKS rather than one drawn struck-through (#82: the operator asked "why is this even here").

import "../../api/test-dom"; // jsdom global before React/testing-library load
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { QueryBody, QueryResult, Row } from "../../api/types";

/**
 * The failure the fixtures never produced (#100 item 1). `mode` lets one harness serve the four
 * conditions the page must tell apart — a healthy read, a FAILED read, an empty store, and a filter
 * that matched nothing — because the defect was precisely that three of them rendered the same.
 */
let mode: "ok" | "throw" | "throw-nonerror" | "store-empty" | "has-store" = "ok";

function countResult(object: string, value: number): QueryResult {
  return { sector: object, object, aggregate: { fn: "count" }, count: 1, groups: [{ group: {}, value }] };
}

// One stubbed client: aggregate bodies answer a count, everything else answers rows.
const queryData = vi.fn(async (object: string, body: QueryBody = {}): Promise<QueryResult> => {
  if (mode === "throw") throw new Error("gateway unreachable");
  // A rejection that is NOT an Error — a thrown string is what a bad `fetch` shim or a rejected
  // non-Error promise produces, and `String(e)`/`e.message` handling is what turns it into
  // "[object Object]" on screen.
  if (mode === "throw-nonerror") throw "kaput";
  if (mode === "store-empty") {
    if (body.aggregate) return countResult(object, 0);
    return { sector: object, object, count: 0, rows: [] };
  }
  if (mode === "has-store") {
    // The store holds rows; the FILTERED read (the one carrying a `where`) matches none of them.
    if (body.aggregate) return countResult(object, body.where ? 0 : 500);
    return { sector: object, object, count: 0, rows: [] };
  }
  if (body.aggregate) {
    return { sector: object, object, aggregate: { fn: "count" }, count: 1, groups: [{ group: {}, value: 2 }] };
  }
  // `__provenance` on every row is what the route serves BY DEFAULT in rows mode (data-routes.ts) —
  // the fixture carries it because a fixture without it cannot see the #122 defect at all.
  const rows: Row[] = [
    { id: "r1", source_object_id: "union:g1", __provenance: { connection_id: null, provider: null, merged: true }, merchant: "Whole Foods", category: "GROCERIES", account_source_id: "a1", amount: "-87.32", posted_at: "2026-02-13T00:00:00.000Z" },
    { id: "r2", source_object_id: "sfin_2", __provenance: { connection_id: "c-sfin", provider: "simplefin", merged: false }, merchant: "Blue Bottle", category: "FOOD_AND_DRINK", account_source_id: "a2", amount: "-6.50", posted_at: "2026-02-14T00:00:00.000Z" },
  ];
  return { sector: object, object, count: rows.length, rows };
});

/** `GET /api/operator/schema` — `mode` also drives this, so the four schema outcomes are reachable. */
let schemaMode: "ok" | "no-route" | "throw" | "absent" = "ok";
class FakeNotServed extends Error {
  override name = "NotServedError";
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}
const getSchema = vi.fn(async (sector: string) => {
  if (schemaMode === "no-route") {
    throw new FakeNotServed("no_route", "Not served — this gateway has no route for the published read schema yet.");
  }
  if (schemaMode === "throw") throw new Error("schema read failed");
  if (schemaMode === "absent") return {};
  return {
    [`${sector}.transaction`]: {
      object: "transaction",
      table: "finance_transactions",
      primaryTime: "posted_at",
      fields: { id: "uuid", merchant: "text", amount: "numeric" },
    },
    [sector]: {
      object: sector,
      table: `${sector}_rows`,
      primaryTime: "received_at",
      fields: { id: "uuid", subject: "text" },
    },
  };
});

const fetchLive = vi.fn();

vi.mock("../../api/client", () => ({
  GATEWAY_URL: "http://localhost:8787",
  NotServedError: FakeNotServed,
  api: {
    queryData: (o: string, b?: QueryBody) => queryData(o, b),
    getSchema: (s: string) => getSchema(s),
    fetchLive: (s: string, o?: { id?: string }) => fetchLive(s, o),
  },
}));

// Import AFTER the mock is registered.
const { InspectorPage } = await import("./InspectorPage");

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/sectors/:sector/inspect" element={<InspectorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  queryData.mockClear();
  getSchema.mockClear();
  fetchLive.mockClear();
  mode = "ok";
  schemaMode = "ok";
});

const schemaBtn = () => screen.getByRole("button", { name: /as an agent sees it/i });

describe("InspectorPage", () => {
  it("finance shows object tabs, the SOURCE union marker, and the includeShadowed reveal", async () => {
    renderAt("/sectors/finance/inspect");

    // multi-object sector → tabs
    expect(screen.getByRole("tab", { name: "Accounts" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Transactions" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Holdings" })).toBeTruthy();

    // the served union marker on the synthetic winner row
    expect(await screen.findByText("union")).toBeTruthy();

    // #82 — finance-only reveal of the provider rows behind a merge
    expect(screen.getByText("Show provider rows behind merges")).toBeTruthy();
  });

  // #122 — the complaint that opened it: "still no source on contacts". The record DRILL had
  // provenance; the LIST rendered identical rows. These assert the
  // rendered CELL, not the column's existence: a header with a dash under it is the defect.
  it("every list carries the served per-row source — not just finance (#65/#122)", async () => {
    for (const sector of ["contacts", "calendar", "mail"]) {
      const view = renderAt(`/sectors/${sector}/inspect`);
      // The header lane…
      expect(
        await screen.findByRole("columnheader", { name: "Source" }),
        `${sector} has no Source column`,
      ).toBeTruthy();
      // …and the VALUE in it, humanised from the served slug by the one shared rule.
      expect(await screen.findByText("SimpleFIN"), `${sector} renders no provenance value`).toBeTruthy();
      view.unmount();
      cleanup();
    }
  });

  it("a row whose provenance the wire did not carry says 'not served', never 'unknown'", async () => {
    // A gateway older than #65/#122. "Not served" is a fact about the wire; "unknown source" is an
    // answer the gateway gave. Neither may be rendered as the other (api/notserved.test.ts).
    queryData.mockImplementationOnce(async (object: string) => ({
      sector: object,
      object,
      count: 1,
      rows: [{ id: "r1", display_name: "Priya", primary_email: "p@example.com" }],
    }));
    renderAt("/sectors/contacts/inspect");
    expect(await screen.findByText("not served")).toBeTruthy();
    expect(screen.queryByText("unknown source")).toBeNull();
  });

  it("the schema peek is a control that WORKS — pressed, it shows the served field list", async () => {
    // #82. The old version was struck through and `disabled`, with a reason written in this repo's
    // vocabulary ("the published read schema is on the bearer-gated agent mirror"). The operator asked
    // "why is this even here". `get_schema` is served to the loopback Console now, so the answer is to
    // make it press — and a dead-control regression is caught by the `disabled` assertion below.
    renderAt("/sectors/finance/inspect");
    const btn = schemaBtn() as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    // Nothing is asked for until it is opened — a schema nobody looked at is not worth a round trip.
    expect(getSchema).not.toHaveBeenCalled();
    fireEvent.click(btn);

    // The served fields, on screen, for the object actually on screen (default tab = Accounts →
    // finance.account, which this fixture does not carry, so the honest "no field list" branch shows).
    await waitFor(() => expect(getSchema).toHaveBeenCalledWith("finance"));

    // Switch to the object the fixture DOES describe and the fields render.
    fireEvent.click(screen.getByRole("tab", { name: "Transactions" }));
    fireEvent.click(schemaBtn());
    expect(await screen.findByText("merchant")).toBeTruthy();
    expect(screen.getByText("numeric")).toBeTruthy();
    expect(screen.getByText("finance_transactions")).toBeTruthy();

    // …and the sentence that made #106 an issue is gone from the whole page.
    expect(screen.queryByText(/bearer-gated/i)).toBeNull();
    expect(screen.queryByText(/agent key/i)).toBeNull();
  });

  it("a gateway with no schema route says so in PLAIN words — never 'no route for get_schema'", async () => {
    schemaMode = "no-route";
    renderAt("/sectors/finance/inspect");
    fireEvent.click(schemaBtn());
    expect(await screen.findByText(/from before it could show the Console what an agent sees/i)).toBeTruthy();
    // #106's anti-pattern, by name: no repo vocabulary in a sentence written for a person.
    const panel = screen.getByText(/update the gate/i).textContent ?? "";
    for (const jargon of ["bearer", "mirror", "route", "get_schema", "endpoint", "loopback"]) {
      expect(panel.toLowerCase(), `the reason says "${jargon}"`).not.toContain(jargon);
    }
  });

  it("a FAILED schema read is not the same sentence as an absent route, and invents no cause", async () => {
    schemaMode = "throw";
    const failed = renderAt("/sectors/finance/inspect");
    fireEvent.click(schemaBtn());
    expect(await screen.findByText(/could not answer/i)).toBeTruthy();
    expect(screen.getByText(/schema read failed/)).toBeTruthy();
    expect(failed.container.textContent).not.toMatch(/from before it could show/i);
  });

  it("an answer with nothing for this object says THAT, rather than drawing an empty schema", async () => {
    // `{}` from the route is a real answer ("nothing here for you"), not a failure — and not a schema
    // with zero fields either, which is what a bare `Object.entries(...)` render would show.
    schemaMode = "absent";
    renderAt("/sectors/finance/inspect");
    fireEvent.click(schemaBtn());
    expect(await screen.findByText(/returned no field list/i)).toBeTruthy();
    expect(screen.queryByText(/could not answer/i)).toBeNull();
  });

  it("a single-object sector (mail) shows no tabs and no includeShadowed control", async () => {
    renderAt("/sectors/mail/inspect");
    await screen.findByText(/envelopes/); // count line landed
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("Show provider rows behind merges")).toBeNull();
  });

  it("the count line reflects the served aggregate, not a row-length guess", async () => {
    renderAt("/sectors/finance/inspect");
    // 2 from the mocked count aggregate — a real query() total (default tab = Accounts).
    expect(await screen.findByText("2 accounts")).toBeTruthy();
  });

  it("an unknown sector route degrades to a not-found line, not a crash", () => {
    renderAt("/sectors/nonsense/inspect");
    expect(screen.getByText(/Unknown sector/)).toBeTruthy();
  });
});

// The tabs declared role="tablist"/"tab"/aria-selected and the tree contained ZERO role="tabpanel"
// and zero aria-controls, so AT announced "tab, 1 of 3, selected" with nowhere to move — a promise
// the DOM could not keep.
describe("InspectorPage — the object tabs keep the promise the role makes", () => {
  it("each object tab controls a labelled tabpanel", () => {
    renderAt("/sectors/finance/inspect");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBe(3);

    const panel = screen.getByRole("tabpanel");
    const selected = tabs.find((t) => t.getAttribute("aria-selected") === "true")!;
    expect(selected).toBeTruthy();
    // the selected tab points AT the panel, and the panel names that tab back
    expect(selected.getAttribute("aria-controls")).toBe(panel.getAttribute("id"));
    expect(panel.getAttribute("aria-labelledby")).toBe(selected.getAttribute("id"));
    // Every `aria-controls` must RESOLVE to a real element. Asserting the attribute is merely
    // non-empty is what let the first version ship with a dangling IDREF on 2 of 3 tabs: only the
    // selected object's panel is rendered, so any unselected tab pointing at its own panel id
    // points at nothing. An unselected tab therefore carries no aria-controls at all — an absent
    // relationship is honest; a broken one is a promise the DOM cannot keep.
    for (const t of tabs) {
      expect(t.getAttribute("id")).toBeTruthy();
      const target = t.getAttribute("aria-controls");
      if (t.getAttribute("aria-selected") === "true") {
        expect(target).toBeTruthy();
        expect(document.getElementById(target!)).not.toBeNull();
      } else {
        expect(target).toBeNull();
      }
    }
  });

  it("the tablist is ONE tab stop — a roving tabindex, not three", () => {
    renderAt("/sectors/finance/inspect");
    const tabs = screen.getAllByRole("tab");
    const tabbable = tabs.filter((t) => t.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute("aria-selected")).toBe("true");
    for (const t of tabs.filter((t) => t !== tabbable[0])) {
      expect(t.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("arrow keys move focus but do NOT select — activation stays manual", () => {
    renderAt("/sectors/finance/inspect");
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    // focus moved…
    expect(document.activeElement).toBe(tabs[1]);
    // …but nothing was selected, so no second object's three query() reads were fired.
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    // Enter/Space is what selects — the button's own click.
    fireEvent.click(tabs[1]);
    expect(screen.getAllByRole("tab")[1].getAttribute("aria-selected")).toBe("true");
  });

  it("a single-object sector draws no tabpanel — there is no tab to label it", () => {
    renderAt("/sectors/mail/inspect");
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });
});

// #100 item 1 — the page had NO `isError` branch anywhere. A failed `query()` leaves rows=[] and
// storeTotal=undefined, so an OUTAGE fell through to the filtered zero state: "Nothing matches that
// filter" over an empty <code></code>, with "Total not served" beneath. The Console said *"you have
// no data"* for *"we could not read it"*, and there was no retry because there was no state to hang
// one on. Every assertion here is negative as well as positive: the finding is not "an error shows
// something", it is "an error must NOT show the two things it used to show".
describe("#100 item 1 — a failed read is an outage, not an empty store", () => {
  const ERROR_HEADLINE = /The records could not be read/;

  it("a failed query renders an outage, NOT an empty store and NOT a filtered-empty", async () => {
    mode = "throw";
    renderAt("/sectors/mail/inspect");
    expect(await screen.findByText(ERROR_HEADLINE)).toBeTruthy();
    // All three at once: an implementation that pushes the error node into LedgerTable's `empty`
    // slot while leaving the ZeroState fallback reachable passes the first assertion and fails these.
    expect(screen.queryByText("Nothing matches that filter")).toBeNull();
    expect(screen.queryByText(/cached yet/)).toBeNull();
    // The filtered-empty state's own total line, whatever it says: it reads "N held in total" when the
    // count landed and "The gate didn’t say how many…" when it did not (#106 §2d retired the old
    // "Total not served"). Matching BOTH halves is what keeps this negative from going deaf the next
    // time that copy moves — a rename must not be able to make this assertion pass by accident.
    expect(screen.queryByText(/held here in total|held in total/)).toBeNull();
    // …and it announces itself as a failure region, not as a quiet status line.
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("the outage REPLACES the table — it is not an error node inside the table's empty slot", async () => {
    // WHERE, not just WHAT. Every other assertion in this block is satisfied by the implementation
    // the spec explicitly REJECTED: pass the error node into `LedgerTable`'s `empty` prop and the
    // headline, the retry, the served message and all three negatives still pass — while the page
    // renders column headers as furniture above an outage and nests role="alert" inside
    // role="table", which is invalid ARIA. The table's absence is the only assertable difference.
    mode = "throw";
    renderAt("/sectors/mail/inspect");
    const alert = await screen.findByRole("alert");
    expect(screen.queryByRole("table")).toBeNull();
    expect(alert.closest('[role="table"]')).toBeNull();
    expect(screen.queryByRole("columnheader")).toBeNull();
  });

  it("only the outage offers a retry", async () => {
    const retry = { name: /try again/i } as const;

    mode = "throw";
    const outage = renderAt("/sectors/mail/inspect");
    expect(await screen.findByRole("button", retry)).toBeTruthy();
    outage.unmount();
    cleanup();

    // An empty store has nothing to retry — there was no failure. Hanging a retry on every zero
    // state erases the distinction the whole finding is about.
    mode = "store-empty";
    const emptyStore = renderAt("/sectors/mail/inspect");
    expect(await screen.findByText(/No envelopes cached yet/)).toBeTruthy();
    expect(screen.queryByRole("button", retry)).toBeNull();
    emptyStore.unmount();
    cleanup();

    mode = "has-store";
    renderAt("/sectors/mail/inspect");
    fireEvent.change(screen.getByLabelText("Filter envelopes…"), { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("Nothing matches that filter")).toBeTruthy(), {
      timeout: 3000,
    });
    expect(screen.queryByRole("button", retry)).toBeNull();
    // …and it quotes what the store still holds. This is the obligation the `filtered` kind exists to
    // enforce (build-notes §14.1e): nobody may say "nothing matches" without also saying how much is
    // there, because that pair is what stops a filter reading as data loss. It is also what keeps the
    // outage block's negative on this line honest — with no positive assertion anywhere, a ZeroState
    // that had stopped rendering the total would satisfy both.
    expect(screen.getByText(/500 held in total/)).toBeTruthy();
  });

  it("the retry actually re-reads — it is not a decorative button", async () => {
    mode = "throw";
    renderAt("/sectors/mail/inspect");
    const btn = await screen.findByRole("button", { name: /try again/i });
    const before = queryData.mock.calls.length;
    fireEvent.click(btn);
    // This repo has shipped a button wired to nothing before (item 5 of this very issue), so the
    // assertion is on the CALL COUNT, not on the button existing.
    await waitFor(() => expect(queryData.mock.calls.length).toBeGreaterThan(before));
  });

  it("the served failure text is shown, and no message is invented when there is none", async () => {
    mode = "throw";
    const withMessage = renderAt("/sectors/mail/inspect");
    expect(await screen.findByText("gateway unreachable")).toBeTruthy();
    // Capture the WHOLE alert while it is still mounted, so the no-message case can be compared
    // against it rather than against a list of strings we happened to think of.
    const withMessageAlert = screen.getByRole("alert").textContent ?? "";
    withMessage.unmount();
    cleanup();
    queryData.mockClear();

    mode = "throw-nonerror";
    renderAt("/sectors/mail/inspect");
    expect(await screen.findByText(ERROR_HEADLINE)).toBeTruthy();
    // No `String(e)` fallback: neither the stringified throw nor an object stringification.
    expect(screen.queryByText(/kaput/)).toBeNull();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();

    // STRENGTHENED (mother, 2026-07-25, adversarial-review BLOCKER 1). Asserting that two strings we
    // guessed are absent cannot catch the mutation this test is named for. Replacing `msgOf`'s null
    // branch with a HARDCODED FAKE REASON ("the gateway did not answer") left all 644 apps/web tests
    // green while the Console presented a fabricated cause as if the gateway had reported it — the
    // same class of lie as the empty store this whole item replaces.
    //
    // So compare the two alerts directly: with no served message, the alert must be EXACTLY the
    // served-message alert minus that message. Any invented sentence — whatever its wording — breaks
    // this, because it can only ever ADD text.
    const noMessageAlert = screen.getByRole("alert").textContent ?? "";
    expect(noMessageAlert).toBe(withMessageAlert.replace("gateway unreachable", ""));
  });

  it("the count cell says the count is unavailable rather than ticking '…' forever", async () => {
    mode = "throw";
    const { container } = renderAt("/sectors/mail/inspect");
    await screen.findByText(ERROR_HEADLINE);
    expect(screen.getByText("count unavailable")).toBeTruthy();
    // "…" over a read that already failed is a permanent loading lie.
    expect(container.textContent).not.toContain("…");
  });

  it("an outage draws no pager and no schema-preview notice", async () => {
    mode = "throw";
    renderAt("/sectors/mail/inspect");
    await screen.findByText(ERROR_HEADLINE);
    // Two "not available" notices stacked bury the one that matters.
    expect(screen.queryByText(/Older/)).toBeNull();
    expect(screen.queryByText(/View schema/)).toBeNull();
    expect(screen.queryByText(/as an agent sees it/i)).toBeNull();
    // The toolbar STAYS — the filter keeps the user's context so a retry needs no re-typing.
    expect(screen.getByLabelText("Filter envelopes…")).toBeTruthy();
  });

  it("the three empty branches stay three different sentences", async () => {
    mode = "store-empty";
    const emptyStore = renderAt("/sectors/mail/inspect");
    expect(await screen.findByText(/No envelopes cached yet/)).toBeTruthy();
    expect(screen.queryByText("Nothing matches that filter")).toBeNull();
    emptyStore.unmount();
    cleanup();

    // No filter, a stocked store, an empty page: this is the branch that used to render the
    // filtered zero state with an EMPTY <code></code> interpolated from the empty filter string.
    mode = "has-store";
    const { container } = renderAt("/sectors/mail/inspect");
    expect(await screen.findByText("Nothing on this page")).toBeTruthy();
    expect(screen.queryByText("Nothing matches that filter")).toBeNull();
    expect(container.querySelector("code")).toBeNull();
  });
});

// #100 item 2 — the mail masthead read "Open a message to fetch its body and attachments live from
// the source." One click below, the drill draws that button PERMANENTLY DISABLED with its own
// reason. The fix is removing the promise; the real fetch rides #89.
describe("#100 item 2 — no subtitle promises a fetch the Console cannot perform", () => {
  /**
   * "Live" and a retrieval verb co-occurring, IN EITHER ORDER and ACROSS SENTENCES.
   *
   * The first version of this guard was `/fetch[^.]*\blive\b/i`, which is two mutations wide of the
   * shape it claims to catch: `[^.]*` cannot cross a sentence boundary (the original defect put the
   * promise and its subject in one sentence purely by luck), and requiring `fetch` BEFORE `live`
   * means the equally-false "Open a message for a live fetch of its detail" sails through. Both
   * orders and the whole string, or the guard only catches the one wording that has already been
   * removed.
   *
   * `\blive\b` alone would be wrong the other way: Home's subtitle legitimately says "Live state per
   * entity" about the CACHED value, and that is not a promise to go and get anything.
   */
  const VERB = "fetch|pull|retriev\\w*|load";
  const PROMISES_A_LIVE_FETCH = new RegExp(
    `\\blive\\b[\\s\\S]*\\b(?:${VERB})|\\b(?:${VERB})[\\s\\S]*\\blive\\b`,
    "i",
  );

  it("the guard itself matches a live-fetch promise written either way round", () => {
    // The guard is a regex, and a regex that cannot match its target is this repo's recorded failure
    // mode (defect-catalog 12). Pin it against the ACTUAL removed sentence and against the order the
    // old pattern could not see, plus the sentence Home is allowed to keep.
    expect(
      "The raw cache — envelopes only. Open a message to fetch its body and attachments live from the source.",
    ).toMatch(PROMISES_A_LIVE_FETCH);
    expect("Open a message for a live fetch of its detail.").toMatch(PROMISES_A_LIVE_FETCH);
    expect("Envelopes are cached. Bodies are fetched live.").toMatch(PROMISES_A_LIVE_FETCH);
    expect("Live state per entity; reachable devices show their value.").not.toMatch(
      PROMISES_A_LIVE_FETCH,
    );
  });

  it("no sector subtitle promises a live fetch the Console cannot perform", async () => {
    const { SECTORS } = await import("./registry");
    // Every sector, not just mail: a bare `not.toContain("Open a message…")` would pass against ANY
    // rewrite including a worse one, and would not notice a future sector re-adding the promise.
    for (const [sector, def] of Object.entries(SECTORS)) {
      expect(def.subtitle, `${sector} subtitle promises a live fetch`).not.toMatch(
        PROMISES_A_LIVE_FETCH,
      );
    }

    renderAt("/sectors/mail/inspect");
    expect(screen.getByText(/bodies and attachments stay at the source/i)).toBeTruthy();
  });
});

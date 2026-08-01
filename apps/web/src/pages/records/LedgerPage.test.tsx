// The ledger, rendered (#61 + #78). Proves the third decision state reaches the screen (an
// allowed-but-errored call renders "Errored", never "Admitted"), the per-row drill opens with the
// full record, the SECTOR filter reaches the wire, and the keyset pager walks history on the served
// paging headers rather than on a row count.
//
// Every cell here stubs `api.auditPage`, the header-reading method — the page no longer uses the
// rows-only `api.audit`, because that one cannot tell a caller whether older rows exist.

import "../../api/test-dom";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { AuditFilters, AuditPage, AuditRow } from "../../api/types";
import { LedgerPage } from "./LedgerPage";

function row(over: Partial<AuditRow>): AuditRow {
  return {
    id: Math.random().toString(36).slice(2),
    agent_id: "myclaw",
    tool: "query",
    sector: "mail",
    decision: "allow",
    deny_reason: null,
    args: null,
    result_count: null,
    outcome: "ok",
    request_id: "req",
    created_at: "2026-07-23T14:22:06.000Z",
    ...over,
  };
}

/** A page with the SERVED paging facts spelled out — `hasMore` is never defaulted by these helpers. */
function page(rows: AuditRow[], hasMore: boolean | undefined, nextCursor: string | null = null): AuditPage {
  return { rows, hasMore, nextCursor };
}

/** The one page every "just render it" cell wants: these rows, and the gate says that is all of them. */
function only(rows: AuditRow[]) {
  return vi.spyOn(api, "auditPage").mockResolvedValue(page(rows, false));
}

function renderLedger() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LedgerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(api, "listAgents").mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("#78 — the three decision states reach the screen", () => {
  const rows: AuditRow[] = [
    row({ id: "ok", tool: "query", decision: "allow", outcome: "ok", request_id: "req_ok" }),
    row({
      id: "deny",
      tool: "invoke_action",
      sector: "home",
      decision: "deny",
      deny_reason: "home not granted",
      outcome: null,
      request_id: "req_deny",
    }),
    row({
      id: "err",
      tool: "fetch_live",
      sector: "calendar",
      decision: "allow",
      outcome: "error",
      args: { sync: true },
      request_id: "req_err",
    }),
  ];

  it("prints no decision word on an admitted row while denied and errored stand alone", async () => {
    only(rows);
    renderLedger();
    // Scope to the table — "Admitted"/"Denied" also label the decision-filter toggle.
    const table = await screen.findByRole("table");
    expect(await within(table).findByText("Errored")).toBeTruthy();
    expect(within(table).getByText("Denied")).toBeTruthy();
    // §17.5: the column read ADMITTED on five of seven rows. A column whose value is the same on
    // ~95% of rows carries no information and buries the two that matter, so the admitted rows now
    // print nothing at all and the two exceptions sit alone in an otherwise empty lane. The errored
    // row still must NOT be counted as an admission — that distinction is #78 and it is what the
    // Errored assertion above proves.
    expect(within(table).queryAllByText("Admitted")).toHaveLength(0);
  });

  // #106 §4 — what a Console export's own ledger row rendered as: `just now / operator / export /
  // { sector: null }`.
  // Two of the three defects were on this page, and neither was in the DATA: the column headed "Agent"
  // over a null `agent_id`, and a key with nothing in it printed beside a Sector column that already
  // said the same thing correctly.
  it("heads the actor column 'Who' — a Console export is not an agent", async () => {
    only([row({ agent_id: null, tool: "export", sector: null, args: { sector: null } })]);
    renderLedger();
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Who" })).toBeTruthy();
    // MUTATION: put the header back to "Agent" → RED. The negative is scoped to the table because
    // "All agents" is a legitimate filter label on this very page.
    expect(within(table).queryByRole("columnheader", { name: "Agent" })).toBeNull();
  });

  it("prints no empty-keyed args — the row already states the sector in its own column", async () => {
    only([row({ agent_id: null, tool: "export", sector: null, args: { sector: null } })]);
    renderLedger();
    const table = await screen.findByRole("table");
    await within(table).findByText("export");
    // The exact shape the operator read back, matched loosely enough to catch either rendering
    // (`{"sector":null}` here, `{ sector: null }` on the Gatehouse glance).
    expect(table.textContent).not.toMatch(/sector["']?\s*:\s*null/i);
    // …and the args cell falls back to the same em-dash the Sector column uses, so BOTH cells are the
    // dash rather than one of them being a JSON fragment.
    expect(within(table).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("still prints args that carry a value", async () => {
    // The half that must not be swept away with the empty keys: a real argument is the point of the
    // column. Without this, dropping the cell entirely would pass the assertions above.
    only([row({ tool: "query", args: { sector: null, limit: 50 } })]);
    renderLedger();
    const table = await screen.findByRole("table");
    expect(await within(table).findByText('{"limit":50}')).toBeTruthy();
  });

  it("keeps the Admitted filter chip", async () => {
    // A FILTER is a query the API serves (`decision=allow`), which is a different thing from a
    // LABEL repeated down a page. Removing the row cells must not take the chip with them.
    only(rows);
    renderLedger();
    const group = screen.getByRole("group", { name: "Filter by decision" });
    expect(within(group).getByRole("button", { name: "Admitted" })).toBeTruthy();
  });

  it("#78 drill — activating the errored row shows the full record (request id, outcome)", async () => {
    only(rows);
    renderLedger();
    const table = await screen.findByRole("table");
    const toolCell = await within(table).findByText("fetch_live");
    const rowEl = toolCell.closest('[role="row"]');
    expect(rowEl).toBeTruthy();
    fireEvent.click(rowEl as Element);

    expect(await screen.findByText("Ledger entry")).toBeTruthy();
    // request_id printed verbatim; outcome shown as the connector-reported "error".
    expect(screen.getByText("req_err")).toBeTruthy();
    const detail = screen.getByRole("region", { name: "Ledger entry" });
    expect(detail.textContent).toContain("error");
    expect(detail.textContent).toContain("Request id");
  });

  it("the denied row's drill surfaces the deny reason", async () => {
    only(rows);
    renderLedger();
    const table = await screen.findByRole("table");
    const toolCell = await within(table).findByText("invoke_action");
    fireEvent.click(toolCell.closest('[role="row"]') as Element);
    const detail = await screen.findByRole("region", { name: "Ledger entry" });
    expect(detail.textContent).toContain("Deny reason");
    expect(detail.textContent).toContain("home not granted");
  });
});

// ── #61 part 1 — the SECTOR filter ────────────────────────────────────────────────────────────────
//
// This page deliberately drew NO sector control for weeks: `?sector=` was not read by the route, and a
// control the API silently ignores is worse than no control. The route matches it now, so the absence
// became the lie. The cell that used to assert `queryByLabelText(/sector/i)` is NULL is inverted below —
// deliberately, and it is the whole finding.
describe("#61 part 1 — the sector filter is drawn and reaches the wire", () => {
  it("the control exists, is keyboard-operable, and offers the six sectors", async () => {
    only([row({ tool: "get_record" })]);
    renderLedger();
    await within(await screen.findByRole("table")).findByText("get_record");

    const select = screen.getByLabelText("Filter by sector") as HTMLSelectElement;
    // A native <select> is in the tab order and inherits base.css's one :focus-visible ring — no
    // negative tabindex, not disabled, no custom listbox to mishandle.
    expect(select.tagName).toBe("SELECT");
    expect(select.disabled).toBe(false);
    expect(select.getAttribute("tabindex")).toBeNull();
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(["", "finance", "mail", "calendar", "contacts", "health", "home"]);
    // …and the neighbours are still there, so this was an addition and not a swap.
    expect(screen.getByLabelText("Filter by agent")).toBeTruthy();
    expect(screen.getByLabelText("Filter by tool")).toBeTruthy();
  });

  it("choosing a sector sends `sector` on the wire and narrows the view", async () => {
    // The defect this catches is a drawn control bound to nothing: the page would look filtered and the
    // request would carry no `sector`, so the whole ledger would sit under a sector heading.
    const spy = vi.spyOn(api, "auditPage").mockImplementation((f?: AuditFilters) =>
      Promise.resolve(
        f?.sector === "finance"
          ? page([row({ id: "fin", tool: "query", sector: "finance", request_id: "req_fin" })], false)
          : page(
              [
                row({ id: "fin", tool: "query", sector: "finance", request_id: "req_fin" }),
                row({ id: "mail", tool: "get_record", sector: "mail", request_id: "req_mail" }),
              ],
              false,
            ),
      ),
    );
    renderLedger();
    const table = await screen.findByRole("table");
    await within(table).findByText("get_record");

    fireEvent.change(screen.getByLabelText("Filter by sector"), { target: { value: "finance" } });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ sector: "finance" })));
    // the excluded row leaves the screen — the request really narrowed
    await waitFor(() => expect(within(table).queryByText("get_record")).toBeNull());
    expect(within(table).getByText("query")).toBeTruthy();
  });

  it("no sector chosen sends NO `sector` key — `?sector=` and absent must stay the same request", async () => {
    // `getAudit` reads every filter with a truthiness check, so an empty string would be ignored
    // server-side; sending one anyway would make the URL claim a filter the server does not apply.
    const spy = only([row({})]);
    renderLedger();
    await within(await screen.findByRole("table")).findByText("query");
    for (const call of spy.mock.calls) {
      expect(call[0] && "sector" in call[0]).toBe(false);
    }
  });

  it("says, once, that a sector filter leaves the gate-wide calls out", async () => {
    // SQL equality never matches NULL, so `describe_context` / `get_schema` / a refused handshake fall
    // out of a sector-filtered ledger. True, invisible, and on the one oversight surface — so it is
    // printed rather than left to be noticed.
    only([row({})]);
    renderLedger();
    await within(await screen.findByRole("table")).findByText("query");
    expect(screen.queryByText(/belonged to no sector/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("Filter by sector"), { target: { value: "home" } });
    expect(await screen.findByText(/belonged to no sector/i)).toBeTruthy();
  });
});

// ── #61 part 2 — the keyset pager ─────────────────────────────────────────────────────────────────
//
// What this replaces: a ladder that raised `limit` 100 → 250 → 500 → 1,000 and then told the reader
// "anything older cannot be reached from here". The gateway mints a cursor now, so it can be.
describe("#61 part 2 — the pager walks the served cursor", () => {
  const CURSOR = "2026-07-26T10:00:00.123456Z|9012";

  it("Load more sends the cursor back VERBATIM as `before`, and the rows accumulate", async () => {
    // Byte-for-byte matters: `created_at` on the wire is millisecond-precision, so a cursor rebuilt from
    // a row lands up to 999µs off and silently drops every row inside that window — and the writer
    // batch-inserts, so those neighbours are routine. The µs digits below cannot be reconstructed from
    // any row this test serves, so a page-2 request carrying anything else fails here.
    const spy = vi.spyOn(api, "auditPage").mockImplementation((f?: AuditFilters) =>
      Promise.resolve(
        f?.before === CURSOR
          ? page([row({ id: "p2", tool: "get_schema", request_id: "req_older" })], false)
          : page([row({ id: "p1", tool: "query", request_id: "req_newer" })], true, CURSOR),
      ),
    );
    renderLedger();

    const table = await screen.findByRole("table");
    await within(table).findByText("query");
    // page 1 asked for no cursor at all
    expect(spy).toHaveBeenCalledWith(expect.not.objectContaining({ before: expect.anything() }));

    fireEvent.click(await screen.findByRole("button", { name: "Load more ↓" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ before: CURSOR })));

    // BOTH pages are on screen: the walk grows the view, it does not replace it — which is what keeps
    // "the export is this view" true while the view reaches the whole trail.
    expect(await within(table).findByText("get_schema")).toBeTruthy();
    expect(within(table).getByText("query")).toBeTruthy();
    expect(screen.getByText(/showing 2/)).toBeTruthy();
    // …and the walk has now been served an end, so the control goes dead rather than dangling.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Load more ↓" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(screen.getByText(/the end of the trail/)).toBeTruthy();
  });

  it("reaching the end does not yank the control out from under the keyboard", async () => {
    // A "Load more" that unmounts on the last page drops focus to <body> mid-task — the user is
    // mid-keyboard-walk of the one oversight surface and loses their place. It stays, disabled, with the
    // count line as its reason (`aria-describedby`), which is also Paper's own grammar for a direction
    // you cannot travel: `2YK-0` fades "← Newer", it does not delete it.
    const spy = vi.spyOn(api, "auditPage").mockImplementation((f?: AuditFilters) =>
      Promise.resolve(
        f?.before === CURSOR
          ? page([row({ id: "p2" })], false)
          : page([row({ id: "p1" })], true, CURSOR),
      ),
    );
    renderLedger();
    await within(await screen.findByRole("table")).findByText("query");

    const btn = screen.getByRole("button", { name: "Load more ↓" }) as HTMLButtonElement;
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ before: CURSOR })));
    await waitFor(() => expect(btn.disabled).toBe(true));

    // The SAME node is still there and still focused — not a re-render of a replacement.
    expect(btn.isConnected).toBe(true);
    expect(document.activeElement).toBe(btn);
    // …and it carries the reason it is dead, for AT as well as for the eye.
    const reason = document.getElementById(btn.getAttribute("aria-describedby") as string);
    expect(reason?.textContent).toMatch(/the end of the trail/);
  });

  it("an EXACTLY-FULL final page draws Load more DEAD, never live — the header wins over counting rows", async () => {
    // THE TRAP. 100 rows back from a limit of 100 with `hasMore: false` is the LAST page: the route
    // decides with a limit+1 probe row, the rule `src/core/query.ts` states. The old ladder read
    // `rows.length >= limit` and would have offered a Load more that returns nothing, forever.
    vi.spyOn(api, "auditPage").mockResolvedValue(
      page(Array.from({ length: 100 }, (_, i) => row({ id: `r${i}` })), false),
    );
    renderLedger();
    // findAll — a hundred rows all carry the same tool, and that is the point of the cell.
    expect(await within(await screen.findByRole("table")).findAllByText("query")).toHaveLength(100);

    expect(screen.getByText(/showing 100/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Load more ↓" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/the end of the trail/)).toBeTruthy();
    const note = document.getElementById("ledger-export-note");
    expect(note?.textContent).toContain("every one these filters match");
  });

  it("changing a filter restarts the walk from the newest page", async () => {
    // A cursor is anchored to a row in ONE filtered history. Replaying page 1's cursor under a new
    // filter would walk a history the reader never asked for; the filters are the whole query key, so
    // the second walk starts with no `before` at all.
    // Distinct ids per page: a real keyset walk never serves the same row twice, and a stub that did
    // would only be testing React's key warning.
    const spy = vi.spyOn(api, "auditPage").mockImplementation((f?: AuditFilters) =>
      Promise.resolve(
        f?.before === CURSOR
          ? page([row({ id: "p2a" }), row({ id: "p2b" })], true, `${CURSOR}3`)
          : page([row({ id: "p1a" }), row({ id: "p1b" })], true, CURSOR),
      ),
    );
    renderLedger();
    await within(await screen.findByRole("table")).findAllByText("query");
    fireEvent.click(await screen.findByRole("button", { name: "Load more ↓" }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ before: CURSOR })));

    spy.mockClear();
    fireEvent.change(screen.getByLabelText("Filter by tool"), { target: { value: "invoke_action" } });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    for (const call of spy.mock.calls) {
      expect(call[0]?.tool).toBe("invoke_action");
      expect(call[0]?.before).toBeUndefined();
    }
  });

  it("a gateway that sends NO has-more header gets a disabled control WITH ITS REASON", async () => {
    // `hasMore: undefined` is not `false`. Hiding the control would read as "there is nothing more",
    // which is the claim nobody can make here; enabling it would hand the reader a button with nowhere
    // to go. So it is drawn, disabled, and the reason is printed — and the reason refuses the
    // end-of-history reading out loud.
    vi.spyOn(api, "auditPage").mockResolvedValue(page([row({})], undefined));
    renderLedger();
    await within(await screen.findByRole("table")).findByText("query");

    const btn = (await screen.findByRole("button", { name: "Load more ↓" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const reason = document.getElementById(btn.getAttribute("aria-describedby") as string);
    expect(reason?.textContent).toMatch(/not the same as having reached the end/i);
    // and the page must NOT print the served end anywhere
    expect(screen.queryByText(/the end of the trail/)).toBeNull();
    // …nor let the file claim completeness
    const note = document.getElementById("ledger-export-note");
    expect(note?.textContent).toMatch(/did not say whether anything older exists/);
    expect(note?.textContent).not.toContain("every one these filters match");
  });

  it("the pager asks for one page at a time, at the server's own default", async () => {
    // A ladder that raised `limit` is gone: reaching further back is the cursor's job now, and asking
    // for 1,000 rows to read the newest 20 was only ever a workaround for not having one.
    const spy = only([row({})]);
    renderLedger();
    await within(await screen.findByRole("table")).findByText("query");
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    for (const call of spy.mock.calls) {
      expect(call[0]?.limit).toBe(100);
    }
  });
});

// #78 (third sub-finding) — the ledger had NO export. The page carried exactly two controls: the
// decision chips and Load more. These cells assert the CONTENT of the downloaded file, never that "a
// download happened" — a cell that only proves a Blob reached the browser cannot fail for this defect.
describe("#78 — the export is of the FILTERED view", () => {
  const admitted = row({
    id: "adm",
    tool: "query",
    decision: "allow",
    outcome: "ok",
    request_id: "req_admitted",
  });
  const denied = row({
    id: "den",
    tool: "invoke_action",
    sector: "home",
    decision: "deny",
    deny_reason: "home not granted",
    outcome: null,
    request_id: "req_denied",
  });

  /** Capture what the download path hands the browser. jsdom has no object-URL store. */
  function captureDownloads(): Blob[] {
    const blobs: Blob[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      value: (b: Blob) => {
        blobs.push(b);
        return "blob:x";
      },
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });
    return blobs;
  }

  it("exports the rows the filter narrowed to, and NOT the row it excluded", async () => {
    // The served `decision` filter is the narrowing: with `decision=deny` the gate returns the denied
    // row alone. An export built from a second, unfiltered read would carry both — that is the #74
    // "Export dumps everything" complaint, and it is what this asserts against.
    vi.spyOn(api, "auditPage").mockImplementation((f?: AuditFilters) =>
      Promise.resolve(f?.decision === "deny" ? page([denied], false) : page([admitted, denied], false)),
    );
    const blobs = captureDownloads();
    renderLedger();

    const table = await screen.findByRole("table");
    await within(table).findByText("invoke_action");
    // both rows are on screen before the filter
    expect(within(table).getByText("query")).toBeTruthy();

    const group = screen.getByRole("group", { name: "Filter by decision" });
    fireEvent.click(within(group).getByRole("button", { name: "Denied" }));
    await waitFor(() => expect(within(table).queryByText("query")).toBeNull());
    // The pager (count · Load more · export) is not drawn while the narrowed read is in flight, so
    // wait for the control to come back rather than grabbing a stale render.
    fireEvent.click(await screen.findByRole("button", { name: /Export CSV/ }));

    expect(blobs).toHaveLength(1);
    const text = await blobs[0].text();
    expect(text).toContain("req_denied");
    expect(text).toContain("home not granted");
    // The excluded row must not be in the file — the whole finding.
    expect(text).not.toContain("req_admitted");
  });

  it("the file is a CSV of the ledger's own fields, headers first", async () => {
    only([admitted]);
    const blobs = captureDownloads();
    renderLedger();
    await within(await screen.findByRole("table")).findByText("query");
    fireEvent.click(screen.getByRole("button", { name: /Export CSV/ }));

    const text = await blobs[0].text();
    expect(text.split("\r\n")[0]).toContain('"request_id"');
    expect(blobs[0].type).toBe("text/csv;charset=utf-8");
  });

  it("the control is a real, enabled button that inherits the one focus ring", async () => {
    // Keyboard reachability is a DOM fact, not a style: a <button> with no negative tabindex and no
    // `disabled` is in the tab order, and `base.css` owns the single `:focus-visible` ring it inherits
    // (records.guards.test.ts asserts this stylesheet never re-declares one).
    only([admitted]);
    renderLedger();
    await within(await screen.findByRole("table")).findByText("query");
    const btn = screen.getByRole("button", { name: /Export CSV/ }) as HTMLButtonElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("tabindex")).toBeNull();
  });

  it("says where the person clicks that the file is this view, not the whole trail", async () => {
    // The honest-cap requirement. A screen-reader user must be told too, so the sentence is wired to
    // the button by `aria-describedby` rather than merely sitting near it.
    only([admitted, denied]);
    renderLedger();
    await within(await screen.findByRole("table")).findByText("query");

    const btn = screen.getByRole("button", { name: /Export CSV/ });
    const noteId = btn.getAttribute("aria-describedby");
    expect(noteId).toBeTruthy();
    const note = document.getElementById(noteId as string);
    expect(note?.textContent).toContain("The file is this view exactly");
    expect(note?.textContent).toContain("2 entries");
  });

  it("mid-walk the note says the file stops where the view stops, and the export stays reachable", async () => {
    // The caveat SHRINKS as the walk reaches the end rather than the export growing a second mechanism:
    // Export CSV never pages behind the reader's back, so while `hasMore` is true the file is honestly
    // "nothing beyond what is loaded" — and it is still a live control, because a partial view is a
    // caveat, not a lockout.
    vi.spyOn(api, "auditPage").mockResolvedValue(
      page([admitted, denied], true, "2026-07-26T10:00:00.123456Z|9012"),
    );
    renderLedger();
    await within(await screen.findByRole("table")).findByText("query");

    const btn = (await screen.findByRole("button", { name: /Export CSV/ })) as HTMLButtonElement;
    const note = document.getElementById(btn.getAttribute("aria-describedby") as string);
    expect(note?.textContent).toContain("nothing beyond what is loaded");
    expect(note?.textContent).not.toContain("every one these filters match");
    expect(btn.disabled).toBe(false);
  });

  it("the file holds every page the walk loaded, not just the last one", async () => {
    // The export is the VIEW, and after a Load more the view is two pages. A file holding only the
    // newest page would silently drop what the reader had deliberately fetched.
    const CURSOR = "2026-07-26T10:00:00.123456Z|9012";
    vi.spyOn(api, "auditPage").mockImplementation((f?: AuditFilters) =>
      Promise.resolve(
        f?.before === CURSOR
          ? page([row({ id: "old", request_id: "req_older" })], false)
          : page([row({ id: "new", request_id: "req_newer" })], true, CURSOR),
      ),
    );
    const blobs = captureDownloads();
    renderLedger();
    await within(await screen.findByRole("table")).findByText("query");
    fireEvent.click(await screen.findByRole("button", { name: "Load more ↓" }));
    await waitFor(() => expect(screen.getByText(/showing 2/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Export CSV/ }));
    const text = await blobs[0].text();
    expect(text).toContain("req_newer");
    expect(text).toContain("req_older");
  });

  it("no export control is drawn when there is nothing to export", async () => {
    // An empty file is a promise of a record that does not exist. The pager (count · Load more ·
    // export) is drawn only once rows are on screen.
    only([]);
    renderLedger();
    await screen.findByText(/Nothing has come through the gate yet/);
    expect(screen.queryByRole("button", { name: /Export CSV/ })).toBeNull();
  });
});

// #100 item 9 — the Time column printed the clock only, so on a trail spanning more than one day a
// row's date was recoverable only from the drill. The half-fix this guards against is adding
// `ledgerStamp` and then rendering only its `time`.
describe("#100 item 9 — every ledger row carries its date", () => {
  it("every ledger row shows its date, not only its clock time", async () => {
    // Local Date constructors so the expected strings hold in any timezone.
    const dayOne = new Date(2026, 6, 23, 14, 22, 6);
    const dayTwo = new Date(2026, 6, 24, 9, 5, 1);
    only([
      row({ id: "r1", tool: "fetch_live", created_at: dayOne.toISOString() }),
      row({ id: "r2", tool: "get_record", created_at: dayTwo.toISOString() }),
    ]);
    renderLedger();

    const table = await screen.findByRole("table");
    await within(table).findByText("fetch_live");
    const cellFor = (tool: string): HTMLElement => {
      const rowEl = within(table).getByText(tool).closest('[role="row"]')!;
      return within(rowEl as HTMLElement).getAllByRole("cell")[0] as HTMLElement;
    };

    // Each row's Time cell carries BOTH halves — the date AND the clock, together, in one cell.
    const one = cellFor("fetch_live");
    expect(one.textContent).toContain("07-23");
    expect(one.textContent).toContain(dayOne.toLocaleTimeString(undefined, { hour12: false }));

    const two = cellFor("get_record");
    expect(two.textContent).toContain("07-24");
    expect(two.textContent).toContain(dayTwo.toLocaleTimeString(undefined, { hour12: false }));

    // …and the two rows genuinely differ, so a constant date string cannot pass.
    expect(one.textContent).not.toBe(two.textContent);
  });
});

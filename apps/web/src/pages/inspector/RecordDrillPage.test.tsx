// #57 — the per-record live drill, now that `POST /api/operator/fetch_live` is served to the loopback
// Console. Two halves, and the second is the one the issue is actually about:
//
//   1. THE CONTROL MUST WORK. It shipped drawn-and-`disabled` with the reason "fetching live from the
//      source is on the bearer-gated agent mirror, and the Console carries no agent key" — our
//      vocabulary, and a button that could never be pressed. #82's ruling ("why is this even here")
//      applies to it too: the answer to an unpressable control is to make it press.
//   2. A LIVE FETCH MUST NEVER BE PRESENTABLE AS A CACHE REFETCH. That mislabelling is half of #57.
//      So: the drill asks for THIS record by id, what comes back is rendered in its OWN labelled
//      block, the cached blocks are untouched, the cached record is NOT re-read, and a gateway that
//      answers with a whole-sector SYNC is reported as a failure rather than dressed as "live".

import "../../api/test-dom"; // jsdom global before React / testing-library load
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLiveResult, Row } from "../../api/types";

/** The cached row the drill mirrors. `raw` is the provider payload the store already holds. */
const CACHED: Row = {
  id: "11111111-2222-3333-4444-555555555555",
  connection_id: "c-gmail",
  source_object_id: "gmail_abc",
  subject: "Quarterly numbers",
  from_name: "Priya Anand",
  received_at: "2026-02-14T09:00:00.000Z",
  ingested_at: "2026-02-14T09:05:00.000Z",
  deleted_at: null,
  raw: { id: "gmail_abc", snippet: "THE CACHED SNIPPET" },
};

const getRecord = vi.fn(async () => ({ record: CACHED }));
const listConnectors = vi.fn(async () => [
  { connectionId: "c-gmail", provider: "gmail", sector: "mail" },
]);

class FakeNotServed extends Error {
  override name = "NotServedError";
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

const fetchLive = vi.fn<(sector: string, opts?: { id?: string }) => Promise<FetchLiveResult>>();

vi.mock("../../api/client", () => ({
  GATEWAY_URL: "http://localhost:8787",
  NotServedError: FakeNotServed,
  api: {
    getRecord: () => getRecord(),
    listConnectors: () => listConnectors(),
    fetchLive: (sector: string, opts?: { id?: string }) => fetchLive(sector, opts),
  },
}));

const { RecordDrillPage } = await import("./RecordDrillPage");

const ID = String(CACHED.id);

function renderDrill(objectKey = "mail", sector = "mail") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/sectors/${sector}/inspect/${ID}?object=${objectKey}`]}>
        <Routes>
          <Route path="/sectors/:sector/inspect/:id" element={<RecordDrillPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const liveBtn = () => screen.getByRole("button", { name: /fetch/i }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  getRecord.mockClear();
  listConnectors.mockClear();
  fetchLive.mockReset();
});

describe("#57 — the live drill is a control that can be pressed", () => {
  it("the button is live, not drawn-and-disabled, and carries no bearer-mirror reason", async () => {
    fetchLive.mockResolvedValue({ sector: "mail", mode: "record", id: ID, record: {} });
    const { container } = renderDrill();
    await screen.findByRole("button", { name: /fetch/i });
    // The drill really did render the cached record (not an error state that happens to have a button).
    expect(screen.getByRole("heading", { name: "Quarterly numbers" })).toBeTruthy();

    expect(liveBtn().disabled).toBe(false);
    // The sentence #106 names as the anti-pattern, gone.
    expect(container.textContent).not.toMatch(/bearer-gated/i);
    expect(container.textContent).not.toMatch(/agent key/i);
    expect(container.textContent).not.toMatch(/not served to the console/i);
  });

  it("it asks for THIS record by id — a drill, never a whole-sector sync request", async () => {
    fetchLive.mockResolvedValue({ sector: "mail", mode: "record", id: ID, record: { body: "x" } });
    renderDrill();
    await screen.findByRole("button", { name: /fetch/i });
    fireEvent.click(liveBtn());

    // `id` present is what makes it a record drill server-side; the object KEY is what core requires
    // (a bare multi-object sector is a typed 400). Both, or the call means something else.
    await waitFor(() => expect(fetchLive).toHaveBeenCalledWith("mail", { id: ID }));
  });

  it("the object key is the drill's key, not the bare sector (finance would 400)", async () => {
    fetchLive.mockResolvedValue({
      sector: "finance.transaction",
      mode: "record",
      id: ID,
      record: {},
    });
    renderDrill("finance.transaction", "finance");
    await screen.findByRole("button", { name: /fetch/i });
    fireEvent.click(liveBtn());
    await waitFor(() => expect(fetchLive).toHaveBeenCalledWith("finance.transaction", { id: ID }));
  });
});

describe("#57 — a live fetch is never presentable as a cache refetch", () => {
  it("the live payload lands in its OWN labelled block and the cached one survives untouched", async () => {
    fetchLive.mockResolvedValue({
      sector: "mail",
      mode: "record",
      id: ID,
      record: { id: "gmail_abc", body: "THE LIVE BODY" },
    });
    renderDrill();
    await screen.findByRole("button", { name: /fetch/i });
    // The cached payload is on screen first.
    expect(screen.getByText(/THE CACHED SNIPPET/)).toBeTruthy();

    fireEvent.click(liveBtn());

    // The live answer arrives under a label that says where it came from…
    expect(await screen.findByText(/straight from the source/i)).toBeTruthy();
    expect(screen.getByText(/THE LIVE BODY/)).toBeTruthy();
    // …and the cached block is STILL THERE, unreplaced. Overwriting it is how a live fetch becomes
    // indistinguishable from a cache read one refresh later.
    expect(screen.getByText(/THE CACHED SNIPPET/)).toBeTruthy();
    expect(screen.getByText(/as the provider returned it/i)).toBeTruthy();
  });

  it("it does NOT re-read the cached record — that would be the refetch it must not be", async () => {
    fetchLive.mockResolvedValue({ sector: "mail", mode: "record", id: ID, record: { body: "live" } });
    renderDrill();
    await screen.findByRole("button", { name: /fetch/i });
    const before = getRecord.mock.calls.length;

    fireEvent.click(liveBtn());
    await screen.findByText(/straight from the source/i);

    // Invalidating `useRecord` here would make the drill look like it worked while showing the cache
    // — the exact mislabelling. Record-mode fetch_live writes nothing server-side, so there is also
    // nothing to re-read.
    expect(getRecord.mock.calls.length).toBe(before);
  });

  it("a SYNC answer is reported as a failure, never as this record fetched live", async () => {
    // The route body is `.strict()`, so a dropped `id` is a 400 today. This pins the page's own
    // refusal to relabel: if the gateway ever answers sync mode here, the surface must not keep the
    // "live" label on a whole-sector cache refresh.
    fetchLive.mockResolvedValue({
      sector: "mail",
      mode: "sync",
      synced: true,
      timed_out: false,
      last_synced_at: "2026-02-14T10:00:00.000Z",
      connections: [],
    });
    const { container } = renderDrill();
    await screen.findByRole("button", { name: /fetch/i });
    fireEvent.click(liveBtn());

    expect(await screen.findByText(/ran a whole-sector sync instead/i)).toBeTruthy();
    expect(container.textContent).not.toMatch(/straight from the source/i);
  });
});

describe("#57 — every way it can fail says something true, in plain words", () => {
  it("a gateway older than the route says so WITHOUT this repo's vocabulary", async () => {
    fetchLive.mockRejectedValue(
      new FakeNotServed("no_route", "Not served — this gateway has no route for fetching live from the source yet."),
    );
    renderDrill();
    await screen.findByRole("button", { name: /fetch/i });
    fireEvent.click(liveBtn());

    const said = (await screen.findByText(/update the gate/i)).textContent ?? "";
    for (const jargon of ["bearer", "mirror", "route", "loopback", "endpoint", "fetch_live"]) {
      expect(said.toLowerCase(), `the reason says "${jargon}"`).not.toContain(jargon);
    }
  });

  it("a provider that cannot do it shows the gateway's OWN served refusal, verbatim", async () => {
    // core answers `live record fetch not supported for <provider>` (a typed 400) when the connector
    // has no `fetchRecordLive`. That names the real limit; inventing a friendlier sentence would hide
    // which provider refused.
    fetchLive.mockRejectedValue(new Error("live record fetch not supported for simplefin"));
    renderDrill();
    await screen.findByRole("button", { name: /fetch/i });
    fireEvent.click(liveBtn());
    expect(await screen.findByText("live record fetch not supported for simplefin")).toBeTruthy();
  });

  it("a failure with no served message invents no cause", async () => {
    fetchLive.mockRejectedValue(new Error(""));
    const { container } = renderDrill();
    await screen.findByRole("button", { name: /fetch/i });
    fireEvent.click(liveBtn());
    expect(await screen.findByText("The source did not answer.")).toBeTruthy();
    // No stringified throw, no object stringification, no guessed reason.
    expect(container.textContent).not.toMatch(/\[object Object\]/);
    expect(container.textContent).not.toMatch(/Error/);
  });

  it("`record: null` is the source saying it is GONE — not an empty live payload", async () => {
    fetchLive.mockResolvedValue({ sector: "mail", mode: "record", id: ID, record: null });
    renderDrill();
    await screen.findByRole("button", { name: /fetch/i });
    fireEvent.click(liveBtn());
    expect(await screen.findByText(/no longer exists/i)).toBeTruthy();
    // …and it still does not touch the cached copy, which is what Postern genuinely still holds.
    expect(screen.getByText(/THE CACHED SNIPPET/)).toBeTruthy();
  });
});

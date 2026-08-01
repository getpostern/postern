// The rail is ONE component, and every route lights exactly the right row (console-shell.md Routes).
// `navIdForPath` is the pure mapping; the render test proves the rail marks that row aria-current.

import { dom } from "../api/test-dom";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, navIdForPath } from "./AppShell";
import type { NavId } from "./NavRail";
import { api } from "../api/client";
import { SECTORS } from "../api/types";
// The pages' ONE sector-label table. The rail still holds a private copy (#105 item 5) — this import
// is what keeps the two from drifting until the table moves to `api/types.ts`.
import { SECTOR_LABEL } from "../pages/sources/model";

/** One representative path per route in the §4 table → the rail row it must light. */
const CASES: Array<[string, NavId, string]> = [
  ["/", "gatehouse", "Gatehouse"],
  ["/sectors/finance", "finance", "Finance"],
  ["/sectors/mail/inspect", "mail", "Mail"],
  ["/sectors/calendar/inspect/abc", "calendar", "Calendar"],
  ["/sectors/finance/merges/bank_1", "finance", "Finance"],
  ["/sectors/contacts", "contacts", "Contacts"],
  ["/sectors/health", "health", "Health"],
  ["/sectors/home", "home", "Home"],
  ["/sources", "sources", "Sources"],
  ["/sources/conn_1", "sources", "Sources"],
  ["/connect", "sources", "Sources"],
  ["/connect/plaid", "sources", "Sources"],
  ["/agents", "agents", "Agents & keys"],
  ["/agents/new", "agents", "Agents & keys"],
  ["/agents/connect/hosted", "agents", "Agents & keys"],
  ["/agents/myclaw", "agents", "Agents & keys"],
  ["/ledger", "ledger", "The ledger"],
  ["/settings", "settings", "Settings"],
  ["/settings/erase", "settings", "Settings"],
  ["/nonsense", "gatehouse", "Gatehouse"],
];

beforeEach(() => {
  // Keep the gate-status footer off the network; the value is irrelevant to nav.
  vi.spyOn(api, "healthz").mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("navIdForPath — the route → rail-row mapping", () => {
  it.each(CASES)("%s → %s", (path, expected) => {
    expect(navIdForPath(path)).toBe(expected);
  });
});

describe("NavRail active state renders on every route", () => {
  function renderAt(path: string) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <AppShell>
            <div>body</div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it.each(CASES)("%s lights the %s row (aria-current=page)", (path, _id, label) => {
    renderAt(path);
    const current = screen.getByRole("link", { current: "page" });
    expect(current.textContent).toBe(label);
  });
});

// ── the rail's sector labels are the SAME vocabulary the pages print (#105 item 5 → #91) ──────────
//
// A third private copy of the sector-label map survives in `NavRail.tsx`. The pages consolidated
// theirs into one table (`pages/sources/model.ts` SECTOR_LABEL) after a duplicate display table made
// the `apple` → iCloud rename look applied and not be; the rail was missed. Its right home is
// `api/types.ts`, beside `SECTORS` — the module the shell and the pages BOTH already import, so
// neither has to depend on the other — and moving it was outside the #91 unit's file set.
//
// Until then the duplicate is made inert rather than left to drift: the rail's rendered label must be
// the pages' label, for every sector. A test may reach across a layer the shipped rail should not.
//
// MUTATION: change one entry in either table (rail "Mail" → "Email") and this goes red.
describe("the rail names sectors exactly as the pages do (#105 item 5)", () => {
  it("every sector row's label is the pages' SECTOR_LABEL entry", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/"]}>
          <AppShell>
            <div>body</div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    for (const sector of SECTORS) {
      const row = screen.getByRole("link", { name: SECTOR_LABEL[sector] });
      expect(row.getAttribute("href")).toBe(`/sectors/${sector}`);
    }
    // …and the two tables cover the same keys, so a SEVENTH sector cannot reach the rail unnamed
    // while the pages name it (the failure mode a per-row assertion alone would miss).
    expect(Object.keys(SECTOR_LABEL).sort()).toEqual([...SECTORS].sort());
  });
});

// The shipped Console is SAME-ORIGIN (ADR 0035 §D4): the gate's address IS this page's address.
// The old code parsed the baked origin with `new URL(GATEWAY_URL)`, which THROWS on the same-origin
// "" default — the catch then assigned the empty string and the footer read a dangling "operator · ".
describe("the gate-status footer names an honest address", () => {
  function renderRail() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/"]}>
          <AppShell>
            <div>body</div>
          </AppShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("the rail names the address the browser actually reached the gate on", () => {
    // Landmark: read from the DOM at test time, never a hardcoded literal — an empty host would make
    // the assertion below vacuous (and is the exact pre-fix value).
    const host = window.location.host;
    expect(host).not.toBe("");

    renderRail();
    expect(screen.getByText(`operator · ${host}`)).toBeTruthy();
  });

  it("the gate-status line never trails a dangling separator", () => {
    // Unreachable in a real browser (window.location.host is never empty); the guard exists so no
    // future same-origin path can leave a bare "·" on screen. `location.host` is [Unforgeable] in
    // jsdom — it cannot be redefined — so the empty host is produced the only honest way: a document
    // URL that genuinely has no host. Restored in `finally`, since the DOM is shared module state.
    // `reconfigure` is real on JSDOM but absent from the bundled @types/jsdom, hence the cast.
    const reconfigure = (dom as unknown as { reconfigure(o: { url: string }): void }).reconfigure.bind(
      dom,
    );
    const restoreTo = window.location.href;
    reconfigure({ url: "file:///tmp/postern" });
    try {
      expect(window.location.host).toBe(""); // the stub actually took — otherwise this is vacuous
      renderRail();
      expect(document.body.textContent).toContain("operator"); // landmark: the footer rendered
      for (const el of Array.from(document.querySelectorAll("*"))) {
        expect(el.textContent ?? "").not.toMatch(/·\s*$/);
      }
    } finally {
      reconfigure({ url: restoreTo });
    }
  });
});

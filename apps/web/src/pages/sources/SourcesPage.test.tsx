// SourcesPage render tests — the findings a static model test can't show: #42 finance reaches
// /sources/:id, #73 a broken row's action is the Manage-fallback (never a guessed flow), the
// exceptions-first count.

import "../../api/test-dom";
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../kit";
import type { ConnectorStatus, FinanceBankSummary, Freshness, FreshnessState } from "../../api/types";

const h = vi.hoisted(() => ({
  connectors: [] as ConnectorStatus[],
  /** `/api/connectors` failed. `data` is undefined — which is NOT "the user has nothing". */
  connectorsError: false,
  banks: [] as FinanceBankSummary[],
  /** `/api/finance/banks` failed. The page must SAY so rather than render its absence as zero (§7). */
  banksError: false,
}));

vi.mock("../../api/hooks", () => ({
  useConnectors: () =>
    h.connectorsError
      ? { data: undefined, isLoading: false, isError: true, error: new Error("connections read failed") }
      : { data: h.connectors, isLoading: false, isError: false, error: null },
  // `useFinanceBanks` POLLS (api/hooks.ts refetchInterval), and react-query keeps the last good
  // `data` while flipping `isError` when a REFETCH fails — the commonest way isError is ever true
  // on this page. So the errored shape keeps `h.banks`: leave it `[]` to model the initial-load
  // failure, set it to fixtures to model the failed poll over good cached data.
  useFinanceBanks: () =>
    h.banksError
      ? { data: h.banks, isLoading: false, isError: true, error: new Error("banks read failed") }
      : { data: h.banks, isLoading: false, isError: false, error: null },
  useInvalidateConnectors: () => () => undefined,
  useInvalidateData: () => () => undefined,
}));

// credentialId is served on every list row (core toStatus), so grouping reads it straight off the
// connector — no detail fetch, no resolution race. Two connectors sharing a credentialId are one
// removable credential; two consents for one provider carry DIFFERENT credentialIds and stay apart.
import { SourcesPage } from "./SourcesPage";
import { sourceGroupAnchorId, sourceGroupHref } from "./model";

function fresh(state: FreshnessState, over: Partial<Freshness> = {}): Freshness {
  return { state, last_heard_at: "2026-07-23T12:00:00Z", next_expected_at: null, stream_state: null, error: null, ...over };
}
let n = 0;
function conn(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  n += 1;
  const connectionId = over.connectionId ?? `c${n}`;
  return {
    connectionId,
    // Default: each connection its OWN credential (a flat single-connection group). Fixtures that
    // model a fan-out or two same-provider consents pass a shared/distinct credentialId explicitly.
    credentialId: `cred-${connectionId}`,
    provider: "apple", sector: "mail", status: "active",
    last_synced_at: "2026-07-23T12:00:00Z", last_error: null, last_error_at: null,
    policy_mode: "poll", next_sync_at: null, scopes: [],
    credential: { status: "active", expires_at: null },
    webhook_secret_set_at: null, sync_window_days: null,
    sync_interval_sec: null, min_interval_sec: 300, default_interval_sec: 900,
    cached_count: 10, push_kind: null, freshness: fresh("ok"), ...over,
  };
}

// The ToastProvider is NOT optional here: `useToast()` outside one returns a no-op `show`, so a
// toast assertion would be unfailable — the page could stop announcing entirely and the test would
// still pass. (kit/Toast.tsx:29.)
/** Reads the live router location back out, so an assertion about the URL is a real assertion. */
function LocationProbe(): JSX.Element {
  const { search } = useLocation();
  return <span data-testid="probe-search">{search}</span>;
}

function tree(initialEntries: string[], client: QueryClient): JSX.Element {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <SourcesPage />
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

/** `rerender()` re-runs the SAME tree — the router keeps the location it is on, so it models a
 *  react-query settle (a read erroring, then recovering) rather than a fresh navigation. */
function renderPage(initialEntries: string[] = ["/sources"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(tree(initialEntries, client));
  return { ...r, rerender: () => r.rerender(tree(initialEntries, client)) };
}

afterEach(() => {
  cleanup();
  h.connectors = [];
  h.connectorsError = false;
  h.banks = [];
  h.banksError = false;
});

describe("SourcesPage", () => {
  it("finance connections finally reach /sources/:connectionId (#42), one row per Plaid bank", () => {
    h.connectors = [
      conn({ connectionId: "plaid-chase", provider: "plaid", sector: "finance" }),
      conn({ connectionId: "plaid-fid", provider: "plaid", sector: "finance" }),
    ];
    h.banks = [
      {
        institution: "Chase", mask: "8830", bankKey: "kc", dedupGroupId: null,
        providers: [{ provider: "plaid", connectionId: "plaid-chase", itemStatus: "ok", lastSyncedAt: "2026-07-23T12:00:00Z" }],
        accountCount: 2, health: "ok", unmergedDuplicate: false, classConflict: false,
      },
      {
        institution: "Fidelity", mask: "2207", bankKey: "kf", dedupGroupId: null,
        providers: [{ provider: "plaid", connectionId: "plaid-fid", itemStatus: "ok", lastSyncedAt: "2026-07-23T12:00:00Z" }],
        accountCount: 1, health: "ok", unmergedDuplicate: false, classConflict: false,
      },
    ];
    renderPage();
    expect(screen.getByText("Chase")).toBeTruthy();
    const manageLinks = screen.getAllByRole("link", { name: /Manage/ }).map((l) => l.getAttribute("href"));
    expect(manageLinks).toContain("/sources/plaid-chase");
    expect(manageLinks).toContain("/sources/plaid-fid");
    // there is NO single "Plaid" connection row — the header is the app, banks are the connections.
    expect(screen.getByText("Fidelity")).toBeTruthy();
  });

  it("a lapsed Plaid bank asks to Reconnect but the link falls back to Manage (#73 — never guesses the flow)", () => {
    h.connectors = [conn({ connectionId: "plaid-chase", provider: "plaid", sector: "finance", status: "error", freshness: fresh("error") })];
    h.banks = [
      {
        institution: "Chase", mask: "8830", bankKey: "kc", dedupGroupId: null,
        providers: [{ provider: "plaid", connectionId: "plaid-chase", itemStatus: "action_required", lastSyncedAt: "2026-07-14T12:00:00Z" }],
        accountCount: 2, health: "action_required", unmergedDuplicate: false, classConflict: false,
      },
    ];
    renderPage();
    const link = screen.getByRole("link", { name: /Reconnect/ });
    expect(link.getAttribute("href")).toBe("/sources/plaid-chase");
    expect(screen.getByText("consent lapsed")).toBeTruthy();
  });

  it("a healthy Plaid bank's CADENCE cell holds a schedule, never 'consent ok'", () => {
    // The column heading is a promise about every cell beneath it, and this lane answered
    // `consent ok` on healthy banks while every other row in the same 150px lane held a real
    // schedule (§18.2). Consent now surfaces only when it lapses — as the test above proves.
    h.connectors = [
      conn({
        connectionId: "plaid-chase",
        provider: "plaid",
        sector: "finance",
        sync_interval_sec: 7200,
        min_interval_sec: 7200,
        default_interval_sec: 7200,
      }),
    ];
    h.banks = [
      {
        institution: "Chase", mask: "8830", bankKey: "kc", dedupGroupId: null,
        providers: [{ provider: "plaid", connectionId: "plaid-chase", itemStatus: "ok", lastSyncedAt: "2026-07-23T12:00:00Z" }],
        accountCount: 2, health: "ok", unmergedDuplicate: false, classConflict: false,
      },
    ];
    renderPage();
    expect(screen.getByText("every 2h · poll")).toBeTruthy();
    expect(screen.queryByText("consent ok")).toBeNull();
  });

  it("names the Apple credential iCloud on the group header, the revoke verb and the typed confirmation", () => {
    // One credential was called "iCloud" where you create it and "Apple" where you manage it — and
    // "Apple" already named a different provider on the same list (Apple Health), so a user could
    // not tell which row their new credential became (§18.4.1). The typed confirmation is the
    // load-bearing one: `requireTyped` is the string the operator must literally TYPE to revoke, so
    // the label and the token have to move together or the confirm becomes untypeable.
    h.connectors = [
      conn({ connectionId: "a-mail", provider: "apple", sector: "mail", credentialId: "apple-1" }),
      conn({ connectionId: "a-cal", provider: "apple", sector: "calendar", credentialId: "apple-1" }),
    ];
    renderPage();
    expect(screen.getByText("iCloud")).toBeTruthy();
    expect(screen.queryByText("Apple")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("button", { name: "Revoke iCloud" })).toBeTruthy();
    expect(screen.getByText("Revoke the iCloud credential")).toBeTruthy();
    // the typed token IS the rendered verb's noun — type it and the confirm enables
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "iCloud" } });
    expect((screen.getByRole("button", { name: "Revoke iCloud" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("counts providers as apps the user named and connections as rows, with the exceptions tally", () => {
    h.connectors = [
      conn({ connectionId: "a-mail", provider: "apple", sector: "mail", credentialId: "apple-1" }),
      conn({ connectionId: "a-cal", provider: "apple", sector: "calendar", credentialId: "apple-1" }),
      conn({ connectionId: "m-mail", provider: "microsoft", sector: "mail", credentialId: "ms-1", freshness: fresh("error") }),
    ];
    renderPage();
    expect(screen.getByText(/2 providers · 3 connections/)).toBeTruthy();
    expect(screen.getByText(/1 need you/)).toBeTruthy();
  });

  it("a Microsoft credential whose consent is withdrawn shows 'held' cadence, not a fake schedule", () => {
    h.connectors = [
      conn({ connectionId: "m-mail", provider: "microsoft", sector: "mail", credentialId: "ms-1", status: "error", freshness: fresh("error") }),
      conn({ connectionId: "m-cal", provider: "microsoft", sector: "calendar", credentialId: "ms-1", status: "error", freshness: fresh("error") }),
    ];
    renderPage();
    expect(screen.getAllByText("held").length).toBeGreaterThan(0);
  });

  it("two Microsoft consents are TWO removable groups, not one that hides a live credential (BLOCK 2 / #74)", () => {
    // Two independent Microsoft consents (two credentials), each feeding mail+calendar. The old
    // provider-string grouping merged all four into ONE fan-out whose single Remove revoked only
    // credential A while the ConfirmBar claimed the group — leaving credential B silently live and
    // agent-readable. Grouping on the proven credentialId keeps them apart, each with its own Remove.
    h.connectors = [
      conn({ connectionId: "ms-a-mail", provider: "microsoft", sector: "mail", credentialId: "ms-A" }),
      conn({ connectionId: "ms-a-cal", provider: "microsoft", sector: "calendar", credentialId: "ms-A" }),
      conn({ connectionId: "ms-b-mail", provider: "microsoft", sector: "mail", credentialId: "ms-B" }),
      conn({ connectionId: "ms-b-cal", provider: "microsoft", sector: "calendar", credentialId: "ms-B" }),
    ];
    renderPage();
    // two independent fan-out groups → two Remove buttons (old behaviour rendered exactly one).
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
    // Still ONE provider the user named. The chip goes through the ONE count-with-noun rule now
    // (`plural`, #92), so the singular reads "1 provider" — it printed "1 providers" here, and this
    // fan-out-of-one-credential shape is the ordinary new-user gate, not an edge.
    expect(screen.getByText(/\b1 provider · 4 connections\b/)).toBeTruthy();
    expect(screen.queryByText(/1 providers/)).toBeNull();
  });
});

describe("a revoked connection is GONE from the ledger (#96 §5)", () => {
  it("a revoked connection does not appear on the ledger at all", () => {
    h.connectors = [
      conn({ connectionId: "g1", provider: "gmail", sector: "mail", credentialId: "gmail-1" }),
      conn({
        connectionId: "ms1", provider: "microsoft", sector: "mail", credentialId: "ms-1",
        status: "revoked", freshness: fresh("disconnected"),
      }),
    ];
    renderPage();
    // A name-absence assertion ALONE passes if the whole page failed to render, so the masthead
    // count has to read the smaller number too.
    expect(screen.queryByText("Microsoft")).toBeNull();
    expect(screen.getByText("Gmail")).toBeTruthy();
    expect(screen.getByText(/\b1 provider · 1 connection\b/)).toBeTruthy();
  });

  it("revoking every connection of a credential removes its group and its green dot", () => {
    h.connectors = [
      conn({
        connectionId: "a-mail", provider: "apple", sector: "mail", credentialId: "apple-1",
        status: "revoked", freshness: fresh("disconnected"),
      }),
      conn({
        connectionId: "a-cal", provider: "apple", sector: "calendar", credentialId: "apple-1",
        status: "revoked", freshness: fresh("disconnected"),
      }),
    ];
    renderPage();
    // The ledger is genuinely empty — the removal worked, so the zero-state is the honest surface.
    expect(screen.getByText(/No sources connected yet/)).toBeTruthy();
    expect(screen.queryByText("iCloud")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });
});

describe("landing back from an OAuth consent (#96 §1.5)", () => {
  it("landing back from a consent announces the sectors it activated", async () => {
    h.connectors = [
      conn({ connectionId: "m-mail", provider: "microsoft", sector: "mail", credentialId: "cred-x" }),
      conn({ connectionId: "m-cal", provider: "microsoft", sector: "calendar", credentialId: "cred-x" }),
      // A scope-reduced re-consent PAUSES the sectors it no longer covers — naming a paused sibling
      // would overstate the grant this consent actually gave.
      conn({
        connectionId: "m-con", provider: "microsoft", sector: "contacts", credentialId: "cred-x",
        status: "paused", freshness: fresh("paused"),
      }),
      // …and another credential's connector must not be swept in.
      conn({ connectionId: "g1", provider: "gmail", sector: "mail", credentialId: "other" }),
    ];
    renderPage(["/sources?credential_id=cred-x&provider=microsoft"]);
    const toast = await screen.findByText("Microsoft connected — Mail and Calendar.");
    expect(toast).toBeTruthy();
  });

  it("landing back from a consent that activated nothing says so", async () => {
    // An unknown-scopes-only consent creates ZERO connector rows and still 302s successfully.
    h.connectors = [conn({ connectionId: "g1", provider: "gmail", sector: "mail", credentialId: "other" })];
    renderPage(["/sources?credential_id=cred-none&provider=google"]);
    expect(
      await screen.findByText(
        "Google signed in, but granted no sectors. Check the scopes on your app, then sign in again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Google connected/)).toBeNull();
  });

  it("the consent params are cleared so a re-render cannot announce twice", async () => {
    h.connectors = [
      conn({ connectionId: "m-mail", provider: "microsoft", sector: "mail", credentialId: "cred-x" }),
    ];
    renderPage(["/sources?credential_id=cred-x&provider=microsoft&tab=banks"]);
    await screen.findByText("Microsoft connected — Mail.");
    // The URL itself is the guard against a refresh re-announcing a consent that already landed —
    // and every OTHER param survives the strip.
    await waitFor(() => {
      const search = screen.getByTestId("probe-search").textContent ?? "";
      expect(search).not.toContain("credential_id");
      expect(search).not.toContain("provider=");
      expect(search).toContain("tab=banks");
    });
    // and exactly one announcement, never a stacked pair
    expect(screen.getAllByText("Microsoft connected — Mail.")).toHaveLength(1);
  });

  // A FAILED connectors read is not "the consent granted nothing". `data` is undefined either way,
  // so gating on `isLoading` alone lets an errored read compute zero labels and tell the user to go
  // fix the scopes on an app whose consent SUCCEEDED — while the same page says it couldn't read the
  // connections at all. Two contradictory sentences, and the actionable one is the false one.
  it("a consent that lands while the connections read is failing announces nothing at all", async () => {
    h.connectorsError = true;
    renderPage(["/sources?credential_id=cred-x&provider=google"]);
    // the read failure IS stated…
    expect(screen.getByText(/didn’t answer the connections read/)).toBeTruthy();
    // …and no diagnosis is invented on top of it, in either direction
    await waitFor(() => {
      expect(
        screen.queryByText(
          "Google signed in, but granted no sectors. Check the scopes on your app, then sign in again.",
        ),
      ).toBeNull();
    });
    expect(screen.queryByText(/granted no sectors/)).toBeNull();
    expect(screen.queryByText(/Google connected/)).toBeNull();
  });

  it("a consent whose connections read failed and then recovered still announces the sectors it activated", async () => {
    h.connectorsError = true;
    const { rerender } = renderPage(["/sources?credential_id=cred-x&provider=google"]);
    expect(screen.queryByText(/granted no sectors/)).toBeNull();

    // The read recovers. `announced` must NOT have been set by the errored pass, or the correct
    // announcement is lost forever for this page load and the wrong one is all the user ever gets.
    h.connectorsError = false;
    h.connectors = [
      conn({ connectionId: "g-mail", provider: "gmail", sector: "mail", credentialId: "cred-x" }),
      conn({ connectionId: "g-cal", provider: "gmail", sector: "calendar", credentialId: "cred-x" }),
    ];
    rerender();

    expect(await screen.findByText("Google connected — Mail and Calendar.")).toBeTruthy();
  });
});

describe("a failed finance-banks read is stated, never rendered as zero (#96 §7)", () => {
  it("a failed banks read is stated, not rendered as zero accounts", () => {
    h.banksError = true;
    h.connectors = [
      conn({
        connectionId: "sf1", provider: "simplefin", sector: "finance",
        credentialId: "sf-1", cached_count: 17,
      }),
    ];
    renderPage();
    expect(screen.getByText(/couldn’t read your bank accounts/)).toBeTruthy();
    // The SimpleFIN row falls back to its OWN served row count — a real number from a read that
    // succeeded — never a derived "0 accounts" from one that did not.
    expect(screen.getByText("17 accounts")).toBeTruthy();
    expect(screen.queryByText("0 accounts")).toBeNull();
  });

  it("a failed banks read leaves the Plaid group saying how many connections are still linked", () => {
    h.banksError = true;
    h.connectors = [
      conn({ connectionId: "p1", provider: "plaid", sector: "finance", credentialId: "p-1" }),
      conn({ connectionId: "p2", provider: "plaid", sector: "finance", credentialId: "p-2" }),
    ];
    renderPage();
    expect(
      screen.getByText(/Bank names couldn’t be read\. 2 Plaid connections are still linked/),
    ).toBeTruthy();
    // the header still counts connectors, which came from the read that DID succeed
    expect(screen.getByText(/feeds 2 banks/)).toBeTruthy();
  });

  it("a healthy banks read is untouched by the error branch", () => {
    h.connectors = [
      conn({
        connectionId: "sf1", provider: "simplefin", sector: "finance",
        credentialId: "sf-1", cached_count: 17,
      }),
    ];
    h.banks = [
      {
        institution: "Chase", mask: "8830", bankKey: "kc", dedupGroupId: null,
        providers: [{ provider: "simplefin", connectionId: "sf1", itemStatus: "ok", lastSyncedAt: null }],
        accountCount: 3, health: "ok", unmergedDuplicate: false, classConflict: false,
      },
    ];
    renderPage();
    expect(screen.queryByText(/couldn’t read your bank accounts/)).toBeNull();
    expect(screen.getByText("3 accounts")).toBeTruthy();
  });

  // The banks query POLLS, so the commonest way `isError` is true is a failed REFETCH after a good
  // load — react-query keeps `data`. Keying the branch on `isError` alone then claims "bank names
  // are missing below" directly above the bank names, and swaps the real cached "3 accounts" for the
  // connector's coarser cached_count. Errored-and-empty is the only state that is actually missing.
  it("a failed banks POLL over good cached data says nothing and keeps the cached counts", () => {
    h.banksError = true;
    h.connectors = [
      conn({
        connectionId: "sf1", provider: "simplefin", sector: "finance",
        credentialId: "sf-1", cached_count: 17,
      }),
    ];
    h.banks = [
      {
        institution: "Chase", mask: "8830", bankKey: "kc", dedupGroupId: null,
        providers: [{ provider: "simplefin", connectionId: "sf1", itemStatus: "ok", lastSyncedAt: null }],
        accountCount: 3, health: "ok", unmergedDuplicate: false, classConflict: false,
      },
    ];
    renderPage();
    // no note over data that IS rendered…
    expect(screen.queryByText(/couldn’t read your bank accounts/)).toBeNull();
    // …and the specific cached truth survives, rather than being replaced by the connector's count
    expect(screen.getByText("3 accounts")).toBeTruthy();
    expect(screen.queryByText("17 accounts")).toBeNull();
  });

  it("a failed banks POLL leaves the Plaid bank rows standing, with no missing-names note", () => {
    h.banksError = true;
    h.connectors = [
      conn({ connectionId: "plaid-chase", provider: "plaid", sector: "finance", credentialId: "p-1" }),
    ];
    h.banks = [
      {
        institution: "Chase", mask: "8830", bankKey: "kc", dedupGroupId: null,
        providers: [{ provider: "plaid", connectionId: "plaid-chase", itemStatus: "ok", lastSyncedAt: "2026-07-23T12:00:00Z" }],
        accountCount: 2, health: "ok", unmergedDuplicate: false, classConflict: false,
      },
    ];
    renderPage();
    expect(screen.getByText("Chase")).toBeTruthy();
    expect(screen.queryByText(/Bank names couldn’t be read/)).toBeNull();
    expect(screen.queryByText(/couldn’t read your bank accounts/)).toBeNull();
  });
});

// ── #112: the destination "and N more →" had nowhere to land ───────────────────
//
// Three surfaces linked to a bare `/sources` while being about ONE provider's connections, so a
// reader who clicked a link about SimpleFIN's institutions arrived at a page listing everything with
// no sign of where they came from. The link was never the whole fix: the page's groups carried no
// addressable anchor, so there was nothing to point at. These cells own the DESTINATION half — that
// every group is addressable, by the same rule the linking surfaces key on.
describe("every /sources group is addressable, by the key its links use (#112)", () => {
  /** One of each group shape the page can draw. */
  function everyGroupShape(): ConnectorStatus[] {
    return [
      // a fan-out: one credential, three sectors
      conn({ connectionId: "a-mail", provider: "apple", sector: "mail", credentialId: "apple-1" }),
      conn({ connectionId: "a-cal", provider: "apple", sector: "calendar", credentialId: "apple-1" }),
      conn({ connectionId: "a-con", provider: "apple", sector: "contacts", credentialId: "apple-1" }),
      // the Plaid app: two Items, each its own credential, ONE group
      conn({ connectionId: "p-a", provider: "plaid", sector: "finance", credentialId: "plaid-a" }),
      conn({ connectionId: "p-b", provider: "plaid", sector: "finance", credentialId: "plaid-b" }),
      // two independent consents for one provider — two groups, never merged (#74)
      conn({ connectionId: "ms-a", provider: "microsoft", sector: "mail", credentialId: "ms-A" }),
      conn({ connectionId: "ms-b", provider: "microsoft", sector: "mail", credentialId: "ms-B" }),
      // a flat single
      conn({ connectionId: "wh", provider: "whoop", sector: "health", credentialId: "whoop-1" }),
    ];
  }

  it("the fragment a linking surface builds resolves to an element, for every group shape", () => {
    // MUTATION: drop `id={anchorId}` from any one of the three group components and this goes red for
    // that shape — which is the state the Console shipped in, and the reason the issue says this is
    // not a one-line href fix.
    h.connectors = everyGroupShape();
    renderPage();
    for (const c of h.connectors) {
      const href = sourceGroupHref(c);
      const id = href.slice(href.indexOf("#") + 1);
      const el = document.getElementById(id);
      expect(el, `no element for ${c.connectionId} → ${href}`).not.toBeNull();
      // …and it is the group that connection actually belongs to, not merely SOME element.
      expect(el!.textContent ?? "").toContain(
        c.provider === "plaid" ? "Plaid" : c.provider === "apple" ? "iCloud" : c.provider === "microsoft" ? "Microsoft" : "WHOOP",
      );
    }
  });

  it("two consents for ONE provider are two different landings — never each other's", () => {
    // The wrong-boundary class in miniature: keyed on the provider name, a link about consent B
    // lands on consent A. That is the same mistake as the Remove that revoked one credential while
    // claiming both (#74), wearing navigation instead of destruction.
    h.connectors = everyGroupShape();
    renderPage();
    const a = document.getElementById(sourceGroupAnchorId(h.connectors.find((c) => c.credentialId === "ms-A")!));
    const b = document.getElementById(sourceGroupAnchorId(h.connectors.find((c) => c.credentialId === "ms-B")!));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("two punctuation-differing credential ids render two DISTINCT page ids", () => {
    // The injectivity half, on the page rather than in the model. Collapsing every out-of-charset
    // character to "-" made `"a.b"` and `"a-b"` one id, so two sibling elements carried it, invalid
    // HTML, `getElementById` answered the first, and the arrival marked the wrong group.
    //
    // MUTATION: restore `key.replace(/[^A-Za-z0-9_-]/g, "-")` in `sourceGroupAnchorId` and the id
    // count drops to one.
    h.connectors = [
      conn({ connectionId: "g1", provider: "gmail", sector: "mail", credentialId: "a.b" }),
      conn({ connectionId: "g2", provider: "gmail", sector: "mail", credentialId: "a-b" }),
    ];
    renderPage();
    const ids = [...document.querySelectorAll("[id^='source-']")].map((el) => el.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // …and each connection's link resolves to an element, which is the property the collapse broke
    for (const c of h.connectors) {
      expect(document.getElementById(sourceGroupAnchorId(c))).not.toBeNull();
    }
  });

  /** Spy `scrollIntoView` on Element.prototype for the duration of `body`. jsdom has no layout, so it
   *  does not exist there — the page must not assume it, and stubbing is what lets a cell assert the
   *  CALL (the page found the right element and asked) without a scroll position jsdom cannot have. */
  function withScrollSpy<T>(body: (calls: Element[]) => T): T {
    const calls: Element[] = [];
    const proto = window.Element.prototype as unknown as { scrollIntoView?: () => void };
    const had = "scrollIntoView" in proto;
    proto.scrollIntoView = function spy(this: Element): void {
      calls.push(this);
    };
    try {
      return body(calls);
    } finally {
      if (!had) delete proto.scrollIntoView;
    }
  }

  it("arriving with a group's fragment scrolls that group into view AND focuses it", () => {
    // The scroll alone is invisible to a non-sighted reader: nothing is announced, and a plain <div>
    // is not focusable, so the one thing the page did on arrival reached only the eye. The group is a
    // `tabIndex={-1}` target and takes focus alongside the scroll, with `preventScroll` so the two do
    // not fight over positioning.
    //
    // MUTATION: drop `tabIndex={-1}` from the group root and the focus assertion goes red (focus() on
    // a non-focusable element leaves activeElement on <body>); drop the `el.focus(...)` call and it
    // goes red too.
    h.connectors = everyGroupShape();
    const target = h.connectors.find((c) => c.credentialId === "whoop-1")!;
    const id = sourceGroupAnchorId(target);
    withScrollSpy((calls) => {
      renderPage([`/sources#${id}`]);
      expect(calls.map((el) => el.id)).toContain(id);
      expect((document.activeElement as HTMLElement | null)?.id).toBe(id);
    });
  });

  it("scrolls ONCE per fragment — a change in group count does not yank the reader back", () => {
    // The reported sequence: arrive via "and N more →", scroll off to a different group, then remove a
    // credential. The group count drops, and with `groups.length` in the deps the effect fired again
    // and dragged the viewport back to a fragment the reader had left on purpose.
    //
    // MUTATION: delete the `scrolledTo` ref guard and the second assertion goes red (two calls).
    // The dep itself must STAY — the third assertion is why: the group does not exist on the first
    // run, so an effect that does not re-run never scrolls at all.
    h.connectors = everyGroupShape();
    const target = h.connectors.find((c) => c.credentialId === "whoop-1")!;
    const id = sourceGroupAnchorId(target);
    withScrollSpy((calls) => {
      const { rerender } = renderPage([`/sources#${id}`]);
      expect(calls.filter((el) => el.id === id)).toHaveLength(1);
      // a credential is removed → fewer groups → the effect re-runs, and must do nothing
      h.connectors = h.connectors.filter((c) => c.credentialId !== "ms-A");
      rerender();
      expect(calls.filter((el) => el.id === id)).toHaveLength(1);
    });
  });

  it("still scrolls when the group appears AFTER the first run — the read had not settled", () => {
    // The reason `groups.length` stays in the deps. On the first paint the connections read is in
    // flight, so the fragment names an element that does not exist yet; the arrival must land when it
    // does. MUTATION: remove `groups.length` from the dep list and this goes red.
    h.connectors = [];
    const late = conn({ connectionId: "wh", provider: "whoop", sector: "health", credentialId: "whoop-1" });
    const id = sourceGroupAnchorId(late);
    withScrollSpy((calls) => {
      const { rerender } = renderPage([`/sources#${id}`]);
      expect(calls.filter((el) => el.id === id)).toHaveLength(0);
      h.connectors = [late];
      rerender();
      expect(calls.filter((el) => el.id === id)).toHaveLength(1);
    });
  });

  it("marks the group the reader was sent to, and ONLY that one", () => {
    // The arrival has to be legible or the scroll is a silent jump. This is the half a `:target` rule
    // could not give: jsdom applies no stylesheet, and react-router navigates by `pushState`, whose
    // effect on the document's target element differs across engines — so the mark is a class driven
    // by the router and this cell can actually falsify it.
    //
    // MUTATION: pass `arrived={false}`, or drop the class from the group root, and this goes red.
    h.connectors = everyGroupShape();
    const target = h.connectors.find((c) => c.credentialId === "apple-1")!;
    const id = sourceGroupAnchorId(target);
    renderPage([`/sources#${id}`]);

    const marked = document.querySelectorAll("[class*='arrived']");
    expect(marked).toHaveLength(1);
    expect((marked[0] as HTMLElement).id).toBe(id);
  });

  it("the mark actually PAINTS — the class name is not the affordance", () => {
    // `.arrived` could be emptied to `{}` and every cell above still passes: they assert the class is
    // applied to the right element, which is silent about whether it draws anything. jsdom applies no
    // stylesheet, so the paint is checked where it lives — the same technique the gatehouse card's
    // hover/focus cell uses. Comments are stripped first, so prose about a rule is not the rule.
    //
    // The values are REUSED, not invented: `kit/LedgerTable.module.css` `.clickable:hover` already
    // lifts a row onto the raised paper ground to mark the one a reader is pointing at, and this marks
    // the one they were sent to. A weight, not a glow (build-notes §8).
    //
    // MUTATION: empty the `.arrived` body and the first assertion goes red.
    const rules = (path: string): string =>
      readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const css = rules("./SourcesPage.module.css");
    expect(css).toMatch(/\.arrived\s*\{[^}]*background:\s*var\(--color-paper-raised\)/);
    // the same declaration as the treatment it borrows — if that one changes, this notices
    expect(rules("../../kit/LedgerTable.module.css")).toMatch(
      /\.clickable:hover\s*\{[^}]*background:\s*var\(--color-paper-raised\)/,
    );
  });

  it("arriving with no fragment marks nothing — the ledger is not a highlight reel", () => {
    // The anti-vacuity partner: a class applied unconditionally would satisfy the cell above for the
    // first group and quietly paint every group on an ordinary visit to /sources.
    h.connectors = everyGroupShape();
    renderPage();
    expect(document.querySelectorAll("[class*='arrived']")).toHaveLength(0);
  });

  it("no group renders the bare page as its own anchor — an empty fragment is not a landing", () => {
    h.connectors = everyGroupShape();
    renderPage();
    for (const c of h.connectors) {
      expect(sourceGroupHref(c)).not.toBe("/sources");
      expect(sourceGroupHref(c)).toMatch(/^\/sources#\S+$/);
    }
  });
});

// ── #92: "feeds 1 banks" ──────────────────────────────────────────────────────
//
// Found by the operator on the live-verified deploy. It survived a sweep that reported it FIXED,
// because the verification matched a DIFFERENT string in a different file ("also feeds Calendar and
// Contacts", ConnectionDetail.tsx) — and it survived this 19-cell suite, which builds single-bank
// Plaid fixtures and then only ever asserts the PLURAL case (`/feeds 2 banks/`, above). The witness
// was the missing half: the defect was live and green the whole time.
describe("a count is never printed against the wrong plural (#92)", () => {
  it("ONE connected bank reads 'feeds 1 bank' — the state a new user's gate is in", () => {
    // Reachable today, not hypothetically: `groupConnectors` draws the Plaid group whenever there is
    // at least one Plaid connector, and each Plaid Item is its own credential (one bank = one
    // connection), so a user who has linked their first bank sees this header.
    //
    // MUTATION: put `feeds ${group.connectors.length} banks` back in PlaidGroup → red.
    h.connectors = [conn({ connectionId: "p1", provider: "plaid", sector: "finance" })];
    renderPage();
    expect(screen.getByText(/feeds 1 bank ·/)).toBeTruthy();
    expect(screen.queryByText(/feeds 1 banks/)).toBeNull();
  });

  it("…and the plural is still plural — the guard, not a swapped constant", () => {
    // The anti-vacuity partner: hardcoding the singular satisfies the cell above.
    h.connectors = [
      conn({ connectionId: "p1", provider: "plaid", sector: "finance" }),
      conn({ connectionId: "p2", provider: "plaid", sector: "finance" }),
    ];
    renderPage();
    expect(screen.getByText(/feeds 2 banks ·/)).toBeTruthy();
  });

  it("the unhealthy Plaid branch carries the same guard — it is reachable at one bank too", () => {
    // The second of the two Plaid sites. A single LAPSED bank takes the else branch, so "feeds 1
    // banks" was reachable there as well; the issue cited both lines for that reason.
    h.connectors = [
      conn({
        connectionId: "p1", provider: "plaid", sector: "finance", status: "error",
        freshness: fresh("error", { error: { message: "item login required", since: null } }),
      }),
    ];
    renderPage();
    expect(screen.getByText(/feeds 1 bank · 0 flowing, 1 lapsed/)).toBeTruthy();
  });

  it("a fan-out credential says 'feeds 3 sectors', and its guard no longer depends on the grouping", () => {
    // The other two sites. They read n > 1 only because `groupConnectors` sets kind="fanout" above one
    // sector — safety on loan from a grouping rule, which is exactly how the Plaid header's omission
    // stayed invisible. n = 1 is therefore not renderable here; `api/format.test.ts` owns the rule's
    // own singular case, and this cell pins that the sector clauses go through it.
    h.connectors = [
      conn({ connectionId: "a-mail", provider: "apple", sector: "mail", credentialId: "apple-1" }),
      conn({ connectionId: "a-cal", provider: "apple", sector: "calendar", credentialId: "apple-1" }),
      conn({ connectionId: "a-con", provider: "apple", sector: "contacts", credentialId: "apple-1" }),
    ];
    renderPage();
    expect(screen.getByText(/feeds 3 sectors/)).toBeTruthy();
  });
});

// ── #111: the page said "all N" over far fewer banks ──────────────────────────
//
// Both symptoms have ONE cause: `GET /api/finance/banks` serves one row per institution × last-4 ×
// currency, and the page rendered one thing per ROW — so a three-card issuer took three identical
// rows and the coverage line counted cards under the word "institutions".
//
// EVERY FIXTURE HERE KEEPS THE THREE NUMBERS APART — cards ≠ accounts ≠ institutions — and puts one
// institution under two display strings. A fixture where a bank has one card passes with the bug in
// place, which is precisely how this shipped. Resolution is not pixels: the model tests own the fold,
// these own the sentence.

/** A served bank card. `orgDomain` is the stable identifier both the count and the mark key off. */
function card(over: Partial<FinanceBankSummary>): FinanceBankSummary {
  return {
    institution: "American Express",
    orgDomain: "americanexpress.com",
    mask: "1001",
    bankKey: "cm:amex|1001|USD",
    dedupGroupId: null,
    providers: [{ provider: "simplefin", connectionId: "sf1", itemStatus: null, lastSyncedAt: null }],
    accountCount: 1,
    health: "ok",
    unmergedDuplicate: false,
    classConflict: false,
    ...over,
  };
}

describe("a bank is named once, and the count is the institution count (#111)", () => {
  it("SimpleFIN's coverage line names three banks over six cards and nine accounts", () => {
    // MUTATION: push `bank.institution` per card → "American Express · AMERICAN EXPRESS · Amex · Ally ·
    // Vanguard · Vanguard (Updated Monthly)" and "One link carries all 6". RED on both cells below.
    h.connectors = [
      conn({ connectionId: "sf1", provider: "simplefin", sector: "finance", cached_count: 9 }),
    ];
    h.banks = [
      card({ bankKey: "cm:amex|1001|USD", mask: "1001" }),
      card({ institution: "AMERICAN EXPRESS", orgDomain: "https://www.americanexpress.com/", bankKey: "cm:amex|1002|USD", mask: "1002" }),
      card({ institution: "Amex", bankKey: "cm:amex|1003|USD", mask: "1003", accountCount: 2 }),
      card({ institution: "Ally", orgDomain: "ally.com", bankKey: "cm:ally|2001|USD", mask: "2001" }),
      card({ institution: "Vanguard", orgDomain: null, bankKey: "cm:vg|3001|USD", mask: "3001", accountCount: 3 }),
      card({ institution: "Vanguard (Updated Monthly)", orgDomain: null, bankKey: "cm:vg|3002|USD", mask: "3002" }),
    ];
    renderPage();

    // Each bank once, in served order — the first spelling the gateway sent, not a prettier pick.
    expect(screen.getByText("American Express · Ally · Vanguard")).toBeTruthy();
    // …and the sentence counts INSTITUTIONS while the coverage cell counts ACCOUNTS. Two grains, two
    // numbers, neither one substitutable for the other.
    expect(screen.getByText(/One link carries all 3/)).toBeTruthy();
    expect(screen.getByText("9 accounts")).toBeTruthy();
    expect(screen.queryByText(/One link carries all 6/)).toBeNull();
    expect(screen.queryByText(/all 9/)).toBeNull();
  });

  it("…and one bank in the link reads 'One link carries it' — the guard, not a swapped constant", () => {
    // The anti-vacuity partner: hardcoding "all 3" satisfies the cell above.
    h.connectors = [conn({ connectionId: "sf1", provider: "simplefin", sector: "finance" })];
    h.banks = [card({ institution: "Ally", orgDomain: "ally.com" })];
    renderPage();
    expect(screen.getByText(/One link carries it/)).toBeTruthy();
  });

  it("a SimpleFIN link that has cached nothing yet does not list itself as a bank", () => {
    // `summarizeBanks` appends a zero-account card per finance connector so the link stays visible and
    // manageable; its `institution` is a CONNECTOR label. MUTATION: drop the placeholder guard → the
    // page prints "SimpleFIN (connecting…)" as one of the user's banks and says "One link carries it".
    h.connectors = [conn({ connectionId: "sf1", provider: "simplefin", sector: "finance", cached_count: 0 })];
    h.banks = [
      card({
        institution: "SimpleFIN (connecting…)",
        orgDomain: null,
        mask: null,
        bankKey: "conn:sf1",
        accountCount: 0,
      }),
    ];
    renderPage();
    expect(screen.queryByText(/SimpleFIN \(connecting/)).toBeNull();
    expect(screen.queryByText(/One link carries/)).toBeNull();
  });

  it("one Plaid Item with three cards is ONE bank row, not three", () => {
    // §12.2: a row exists for every connection. Three rows all reading "American Express", each with
    // its own "Manage →" to the SAME connection page, is the operator's finding in the Plaid lane.
    // MUTATION: emit a row per card → three "American Express" rows and three Manage links, red.
    h.connectors = [conn({ connectionId: "plaid-amex", provider: "plaid", sector: "finance" })];
    h.banks = [
      card({ bankKey: "cm:amex|1001|USD", mask: "1001", providers: [{ provider: "plaid", connectionId: "plaid-amex", itemStatus: "ok", lastSyncedAt: "2026-07-23T12:00:00Z" }] }),
      card({ institution: "AMERICAN EXPRESS", orgDomain: "https://www.americanexpress.com/", bankKey: "cm:amex|1002|USD", mask: "1002", providers: [{ provider: "plaid", connectionId: "plaid-amex", itemStatus: "ok", lastSyncedAt: "2026-07-23T12:00:00Z" }] }),
      card({ institution: "Amex", bankKey: "cm:amex|1003|USD", mask: "1003", accountCount: 2, providers: [{ provider: "plaid", connectionId: "plaid-amex", itemStatus: "ok", lastSyncedAt: "2026-07-23T12:00:00Z" }] }),
    ];
    renderPage();

    expect(screen.getAllByText("American Express")).toHaveLength(1);
    expect(screen.queryByText("AMERICAN EXPRESS")).toBeNull();
    expect(screen.queryByText("Amex")).toBeNull();
    // The accounts are summed rather than dropped — the row covers all three cards.
    expect(screen.getByText("4 accounts")).toBeTruthy();
    // …and the last-4 is gone, because the row covers three of them. Printing one would narrow the row
    // to an account it is not.
    expect(screen.queryByText(/••••100/)).toBeNull();
    expect(screen.getAllByText("Manage →")).toHaveLength(1);
  });

  it("the folded Plaid row wears its brand, and only the SERVED DOMAIN can get it there", () => {
    // The row is "Citibank" — the example that made #89's case, a string no alias table knew. Its approved
    // treatment (C on Citi blue) is reachable ONLY from `citi.com`: the display name alone yields the
    // warm-ink initial, and the initial is "C" either way, so the assertion has to be the HEX.
    //
    // Chosen deliberately over an Amex fixture: "American Express" resolves to its tile through the
    // display-name path too, so an Amex row would render identically with the prop deleted — a cell
    // that cannot fail. MUTATION: drop `orgDomain` from `<InstitutionMark>` in SourcesPage, or return
    // null for it out of `plaidBankRows` → the ground becomes the neutral ink, red.
    h.connectors = [conn({ connectionId: "plaid-citi", provider: "plaid", sector: "finance" })];
    const via = [{ provider: "plaid", connectionId: "plaid-citi", itemStatus: "ok", lastSyncedAt: null }];
    h.banks = [
      card({ institution: "Citibank", orgDomain: "citi.com", bankKey: "cm:citi|4001|USD", mask: "4001", providers: via }),
      card({ institution: "CITIBANK N.A.", orgDomain: "https://www.citi.com/", bankKey: "cm:citi|4002|USD", mask: "4002", providers: via }),
    ];
    const { container } = renderPage();

    // One row, so one mark…
    expect(screen.getAllByText("Citibank")).toHaveLength(1);
    const tiles = container.querySelectorAll<HTMLElement>('[style*="--institution-mark-ground"]');
    expect(tiles).toHaveLength(1);
    // …and it is Citi's own blue, not the tile an unknown credit union gets.
    expect(tiles[0].getAttribute("style")).toContain("#056DAE");
    expect(tiles[0].getAttribute("style")).not.toContain("#2A2118");
    expect(tiles[0].textContent).toBe("C");
  });
});

// ── #134: clicking Remove reveals the typed confirm IN VIEW ───────────────────
//
// The confirm host is the LAST child of the page, so on a multi-source gateway the revealed
// ConfirmBar rendered below the fold — the operator clicked Remove and saw nothing happen (live,
// 2026-07-30). The scroll lives in the kit ConfirmBar (reveal = in view); this asserts the page's
// Remove path actually reaches it.
describe("Remove reveals the typed confirm in view (#134)", () => {
  /** The #112 spy pattern: jsdom has no layout so scrollIntoView is absent — stubbing the
   *  prototype lets the test assert the CALL without a scroll position jsdom cannot have. */
  function withScrollSpy<T>(body: (calls: Element[]) => T): T {
    const calls: Element[] = [];
    const proto = window.Element.prototype as unknown as { scrollIntoView?: () => void };
    const had = "scrollIntoView" in proto;
    proto.scrollIntoView = function spy(this: Element): void {
      calls.push(this);
    };
    try {
      return body(calls);
    } finally {
      if (!had) delete proto.scrollIntoView;
    }
  }

  it("clicking a group's Remove scrolls the revealed ConfirmBar into view", () => {
    // MUTATION: delete the mount effect in kit/ConfirmBar.tsx → zero scroll calls here, red.
    h.connectors = [
      conn({ connectionId: "a-mail", provider: "apple", sector: "mail", credentialId: "apple-1" }),
      conn({ connectionId: "a-cal", provider: "apple", sector: "calendar", credentialId: "apple-1" }),
    ];
    withScrollSpy((calls) => {
      renderPage();
      // No fragment on this landing → the #112 arrival effect contributes no calls; the reveal owns
      // whatever lands in the spy.
      expect(calls).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      expect(calls).toHaveLength(1);
      // …and the element that asked to be seen IS the confirm: it carries the typed affordance.
      expect(calls[0].textContent).toContain("Type iCloud to confirm");
    });
  });

  it("RETARGET (adversarial B1): Remove on group B while group A's confirm is open scrolls AGAIN and arrives disarmed", () => {
    // The page renders ONE conditional confirm slot for whichever group is being removed. Unkeyed,
    // switching removeGroup from A to B RE-RENDERS the same ConfirmBar instance: the mount scroll
    // never re-fires (the confirm sits off-screen — the original #134 symptom, verbatim) and a
    // typed token armed for A survives into B's confirm. The slot is keyed by the group's
    // credential identity, so a retarget is a REMOUNT.
    //
    // MUTATION: drop the `key` off the confirmHost div in SourcesPage.tsx → the second-scroll
    // assertion goes red (calls stays 1) AND the disarm assertions go red (typed value survives).
    h.connectors = [
      conn({ connectionId: "a-mail", provider: "apple", sector: "mail", credentialId: "apple-1" }),
      conn({ connectionId: "a-cal", provider: "apple", sector: "calendar", credentialId: "apple-1" }),
      conn({ connectionId: "m-mail", provider: "microsoft", sector: "mail", credentialId: "ms-A" }),
      conn({ connectionId: "m-cal", provider: "microsoft", sector: "calendar", credentialId: "ms-A" }),
    ];
    withScrollSpy((calls) => {
      renderPage();
      const removes = screen.getAllByRole("button", { name: "Remove" });
      expect(removes).toHaveLength(2);

      // Reveal A and ARM it (type the exact token — the seal enables).
      fireEvent.click(removes[0]);
      expect(calls).toHaveLength(1);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "iCloud" } });
      expect(
        (screen.getByRole("button", { name: "Revoke iCloud" }) as HTMLButtonElement).disabled,
      ).toBe(false);

      // Retarget to B: the confirm must scroll into view AGAIN…
      fireEvent.click(removes[1]);
      expect(calls).toHaveLength(2);
      expect(calls[1].textContent).toContain("Type Microsoft to confirm");
      // …and arrive DISARMED with an empty typed box — A's arming must not survive.
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
      expect(
        (screen.getByRole("button", { name: "Revoke Microsoft" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });
  });
});

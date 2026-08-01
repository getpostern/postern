// ConnectionDetail render tests — the mode-adaptive middle and the findings it owns: #74 blast
// radius, #27 reachable ingest URL + no Sync-now for a device push, #1.5 broken banner, the #73/#89
// reconnect degradation on a live stream.

import "../../api/test-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorDetail, ConnectorStatus, Freshness, FreshnessState } from "../../api/types";

const h = vi.hoisted(() => ({
  detail: null as ConnectorDetail | null,
  all: [] as ConnectorStatus[],
  banks: [] as unknown[],
  // The credentialId map the detail wire proves (the list wire lacks it). Keyed by connectionId.
  creds: {} as Record<string, string | undefined>,
  resolved: true,
}));

vi.mock("../../api/hooks", () => ({
  useConnector: () => ({ data: h.detail, isLoading: false, isError: false }),
  useConnectors: () => ({ data: h.all, isLoading: false, isError: false }),
  useFinanceBanks: () => ({ data: h.banks, isLoading: false, isError: false }),
  useInvalidateConnectors: () => () => undefined,
  useInvalidateData: () => () => undefined,
}));

// The credential-resolution seam is stubbed so siblings are computed from a KNOWN credentialId map
// (proven from the detail wire in production), never from the provider string.
vi.mock("./credentials", () => ({
  useConnectorCredentials: () => ({
    credentialIdOf: (id: string) => h.creds[id],
    resolved: h.resolved,
  }),
}));

import { ConnectionDetail, HOME_ASSISTANT_PROVIDER } from "./ConnectionDetail";

function fresh(state: FreshnessState, over: Partial<Freshness> = {}): Freshness {
  return { state, last_heard_at: "2026-07-23T12:00:00Z", next_expected_at: null, stream_state: null, error: null, ...over };
}
function detail(over: Partial<ConnectorDetail>): ConnectorDetail {
  return {
    connectionId: "c1", provider: "apple", sector: "mail", status: "active",
    last_synced_at: "2026-07-23T12:00:00Z", last_error: null, last_error_at: null,
    policy_mode: "poll", next_sync_at: null, scopes: [],
    credential: { status: "active", expires_at: null },
    webhook_secret_set_at: null, sync_window_days: 180,
    sync_interval_sec: null, min_interval_sec: 300, default_interval_sec: 900,
    cached_count: 2626, push_kind: null, freshness: fresh("ok"),
    credentialId: "cred-1", counts: {}, ...over,
  };
}

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/sources/c1"]}>
        <Routes>
          <Route path="/sources/:connectionId" element={<ConnectionDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  h.detail = null;
  h.all = [];
  h.banks = [];
  h.creds = {};
  h.resolved = true;
});

describe("ConnectionDetail", () => {
  it("a shared Apple credential names its full blast radius (#74)", () => {
    h.detail = detail({ connectionId: "c1", provider: "apple", sector: "mail", credentialId: "cred-apple" });
    h.all = [
      { ...detail({ connectionId: "c1", sector: "mail" }) } as ConnectorStatus,
      { ...detail({ connectionId: "c2", sector: "calendar" }) } as ConnectorStatus,
      { ...detail({ connectionId: "c3", sector: "contacts" }) } as ConnectorStatus,
    ];
    // All three connections resolve to the SAME credential — the genuine shared case.
    h.creds = { c1: "cred-apple", c2: "cred-apple", c3: "cred-apple" };
    renderDetail();
    // the shared-credential callout enumerates the siblings
    expect(screen.getByText(/also feeds Calendar and Contacts/)).toBeTruthy();
    // the revoke lifecycle row names all three and offers "Revoke all 3"
    expect(screen.getByText(/Disconnects Mail, Calendar and Contacts/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke all 3" })).toBeTruthy();
  });

  it("titles an Apple connection iCloud in the masthead, the breadcrumb and the shared-credential note", () => {
    // The `apple` credential was called "iCloud" where you create it and "Apple" where you manage
    // it, while "Apple" already named a different provider (Apple Health) on the same list — so a
    // user could not tell which row their new credential had become (§18.4.1). The provider KEY is
    // untouched; this is display vocabulary only, and it must be the same word on all three slots.
    h.detail = detail({ connectionId: "c1", provider: "apple", sector: "mail", credentialId: "cred-apple" });
    h.all = [
      { ...detail({ connectionId: "c1", sector: "mail" }) } as ConnectorStatus,
      { ...detail({ connectionId: "c2", sector: "calendar" }) } as ConnectorStatus,
    ];
    h.creds = { c1: "cred-apple", c2: "cred-apple" };
    renderDetail();
    expect(screen.getByText("iCloud · Mail")).toBeTruthy();
    // the breadcrumb's middle crumb
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toContain("iCloud");
    expect(crumbs.textContent).not.toContain("Apple");
    // the shared-credential note and the revoke row's title
    expect(screen.getByText(/This iCloud credential also feeds Calendar/)).toBeTruthy();
    expect(screen.getByText("Revoke the iCloud credential")).toBeTruthy();
    // the mark is shared with Apple Health per the plate, but its accessible NAME is the service
    expect(screen.getAllByRole("img", { name: "iCloud" }).length).toBeGreaterThan(0);
  });

  it("a second Plaid Item is NOT a sibling — each Item is its own credential (BLOCK 1 / §12.1)", () => {
    // Two Plaid banks, SAME provider "plaid", DIFFERENT credentials. The old provider-equality
    // sibling test treated them as one shared credential → a false "Shared credential" callout and a
    // "Revoke all 2" whose scope revokeCredential(credentialId) never had. Matching on credentialId
    // (not provider) makes them strangers, as the backend model demands (#42).
    h.detail = detail({
      connectionId: "plaid-chase", provider: "plaid", sector: "finance",
      credentialId: "cred-chase", freshness: fresh("ok"),
    });
    h.all = [
      { ...detail({ connectionId: "plaid-chase", provider: "plaid", sector: "finance" }) } as ConnectorStatus,
      { ...detail({ connectionId: "plaid-amex", provider: "plaid", sector: "finance" }) } as ConnectorStatus,
    ];
    h.creds = { "plaid-chase": "cred-chase", "plaid-amex": "cred-amex" };
    h.banks = [
      {
        institution: "Chase", mask: "8830", bankKey: "kc", dedupGroupId: null,
        providers: [{ provider: "plaid", connectionId: "plaid-chase", itemStatus: "ok", lastSyncedAt: null }],
        accountCount: 1, health: "ok", unmergedDuplicate: false, classConflict: false,
      },
    ];
    renderDetail();
    // no fictional shared credential, and no over-stated "Revoke all N" row
    expect(screen.queryByText(/Shared credential/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Revoke all/ })).toBeNull();
  });

  it("Apple Health shows the ingest path (not the loopback console) and has NO Sync now (#27, §1.1)", () => {
    h.detail = detail({
      connectionId: "ah1", provider: "apple_health", sector: "health",
      policy_mode: "push", push_kind: "webhook", webhook_secret_set_at: "2026-07-01T00:00:00Z",
      cached_count: 9943,
    });
    h.all = [{ ...h.detail } as ConnectorStatus];
    renderDetail();
    expect(screen.getAllByText(/\/api\/ingest\/ah1/).length).toBeGreaterThan(0);
    // The reachable-host note. #106 rewrote it — it used to cite an ADR and TWO of the operator's own
    // port numbers (":8443 (ADR 0024) — not this loopback console on :8787"), which are this box's
    // ports and nobody else's. What must survive is the fact that Postern cannot supply the host, and
    // a worked example in the plate's placeholder family.
    const hostNote = screen.getByText(/Postern isn.t told it/);
    expect(hostNote.textContent).toMatch(/your-mac\.tailnet\.ts\.net:8443\/api\/ingest\/ah1/);
    expect(hostNote.textContent).not.toMatch(/ADR|loopback|8787/);
    // Postern cannot pull a device push — there is no Sync now
    expect(screen.queryByRole("button", { name: /Sync now/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Pause receiving/ })).toBeTruthy();
  });

  it("a lapsed Plaid consent raises the attention banner that owns the Reconnect (§1.5)", () => {
    h.detail = detail({
      connectionId: "plaid-chase", provider: "plaid", sector: "finance",
      status: "error", freshness: fresh("error", { error: { message: "consent expired", since: "2026-07-14T00:00:00Z" } }),
    });
    h.all = [{ ...h.detail } as ConnectorStatus];
    h.banks = [
      {
        institution: "Chase", mask: "8830", bankKey: "kc", dedupGroupId: null,
        providers: [{ provider: "plaid", connectionId: "plaid-chase", itemStatus: "action_required", lastSyncedAt: null }],
        accountCount: 2, health: "action_required", unmergedDuplicate: false, classConflict: false,
      },
    ];
    renderDetail();
    expect(screen.getByText("This bank needs re-approving.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect at Plaid" })).toBeTruthy();
  });

  it("a live stream's Reconnect is drawn but disabled, with a reason in the reader's words (#73/#89/#106)", () => {
    h.detail = detail({
      connectionId: "ha1", provider: HOME_ASSISTANT_PROVIDER, sector: "home",
      policy_mode: "push", push_kind: "stream", freshness: fresh("ok", { stream_state: "connected" }),
      cached_count: 1847,
    });
    h.all = [{ ...h.detail } as ConnectorStatus];
    renderDetail();
    const reconnect = screen.getByRole("button", { name: "Reconnect" });
    expect((reconnect as HTMLButtonElement).disabled).toBe(true);
    // It carries its reason inline, not in a tooltip — and the reason is about the SOURCE, not about
    // which of our routes serves what. The notice may not disappear (a bare dim is the defect this
    // guards) and may not name our wire.
    const reason = screen.getByText(/can.t tell which sign-in this source used/);
    expect(reason.textContent).toMatch(/Re-add it from Add a source/);
    expect(reason.textContent).not.toMatch(/served|Console|route|mirror/i);
  });

  // The wire value is `home_assistant`; three Console sites (this page's four branches, the
  // Gatehouse PROVIDER_MARK, the lens SourcesBand) keyed on `homeassistant`, which never matches —
  // so an HA connection rendered no provider mark and, worse, its ONLY credential-removal
  // affordance was hidden. The fixtures spelled it the same wrong way, which is why the suite was
  // green while the real box was broken.
  it("a Home Assistant connection renders its provider mark and reaches its revoke row", () => {
    h.detail = detail({
      connectionId: "ha1", provider: HOME_ASSISTANT_PROVIDER, sector: "home",
      policy_mode: "push", push_kind: "stream", freshness: fresh("ok", { stream_state: "connected" }),
      cached_count: 1847, credentialId: "cred-ha",
    });
    h.all = [{ ...h.detail } as ConnectorStatus];
    h.creds = { ha1: "cred-ha" };
    renderDetail();
    // the mark, not a blank slot
    expect(screen.getAllByRole("img", { name: "Home Assistant" }).length).toBeGreaterThan(0);
    // the revoke row: HA's token is re-pasteable, so it is offered even though nothing is shared
    expect(screen.getByText("Remove the token")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove token" })).toBeTruthy();
    expect(
      screen.getByText("Deletes the long-lived token from the vault. Home stops immediately."),
    ).toBeTruthy();
  });

  it("pins the Home Assistant wire spelling against the connector that serves it", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../../../../src/connectors/homeassistant.ts", import.meta.url)),
      "utf8",
    );
    // A fixture cannot vouch for a wire — only the connector can.
    expect(src).toMatch(
      new RegExp(`readonly\\s+provider\\s*=\\s*["']${HOME_ASSISTANT_PROVIDER}["']`),
    );
  });

  // ADR 0023 and this file's own StatusPill rule: there is NO healthy word-badge. A connected
  // stream said so three times — the header dot, the "Last synced" caption, and "Streaming · live".
  // `Stream down` stays, because an exception earns a word.
  it("a healthy live stream carries no word-badge, but a dead one keeps its word", () => {
    h.detail = detail({
      connectionId: "ha1", provider: HOME_ASSISTANT_PROVIDER, sector: "home",
      policy_mode: "push", push_kind: "stream", freshness: fresh("ok", { stream_state: "connected" }),
    });
    h.all = [{ ...h.detail } as ConnectorStatus];
    const first = renderDetail();
    expect(screen.queryByText(/Streaming/)).toBeNull();
    expect(screen.queryByText("Stream down")).toBeNull();
    first.unmount();

    h.detail = detail({
      connectionId: "ha1", provider: HOME_ASSISTANT_PROVIDER, sector: "home",
      policy_mode: "push", push_kind: "stream",
      freshness: fresh("error", { stream_state: "down", error: { message: "socket closed", since: null } }),
    });
    h.all = [{ ...h.detail } as ConnectorStatus];
    renderDetail();
    expect(screen.getByText("Stream down")).toBeTruthy();
  });
});

// A REVOKED connection's served freshness state is `disconnected` (core/freshness.ts:121) — its
// credential is deleted from the vault. The page treated that as one more flavour of "broken", so
// the banner said "re-add it from Add a source" directly above the controls' "It resumes on its own
// once the source answers again." It will not. (#96 §6.)
describe("a REMOVED connection never promises a recovery it cannot make (#96 §6)", () => {
  /** A revoked poll connection — the state `revokeCredential` leaves behind. */
  function revoked(over: Partial<ConnectorDetail> = {}): ConnectorDetail {
    return detail({
      connectionId: "c1", provider: "gmail", sector: "mail", status: "revoked",
      credentialId: "cred-gone", freshness: fresh("disconnected"), ...over,
    });
  }

  it("a removed connection never says syncing resumes on its own", () => {
    h.detail = revoked();
    h.all = [{ ...h.detail } as ConnectorStatus];
    renderDetail();
    expect(screen.queryByText(/resumes on its own/)).toBeNull();
    expect(
      screen.getByText(
        "This connection was removed — its credential is gone from the vault. Syncing will not resume on its own; re-add the source to start a new connection.",
      ),
    ).toBeTruthy();
  });

  it("a still-broken (unreachable) connection keeps the resumes-on-its-own reason", () => {
    // The regression guard: the removal copy must NOT be over-applied to every broken state.
    h.detail = detail({
      connectionId: "c1", provider: "gmail", sector: "mail", status: "error",
      freshness: fresh("error", { error: { message: "connection refused", since: null } }),
    });
    h.all = [{ ...h.detail } as ConnectorStatus];
    renderDetail();
    expect(screen.getByText(/resumes on its own once the source answers again/)).toBeTruthy();
    expect(screen.queryByText(/gone from the vault/)).toBeNull();
  });

  it("a removed connection's banner says it was removed, not that it needs attention", () => {
    h.detail = revoked();
    h.all = [{ ...h.detail } as ConnectorStatus];
    renderDetail();
    expect(
      screen.getByText("Gmail · Mail was removed — its credential is gone from the vault."),
    ).toBeTruthy();
    expect(screen.queryByText(/needs your attention/)).toBeNull();
    expect(
      screen.getByText(
        "Nothing will sync here again. Re-add Gmail from Add a source to start a new connection.",
      ),
    ).toBeTruthy();
  });

  it("a removed Plaid bank is not offered Reconnect at Plaid", () => {
    // A removed Plaid item is REMOVED, not lapsed: the hosted update flow has no credential to
    // update, so both the banner action and its "needs re-approving" cause would be false.
    h.detail = revoked({ connectionId: "plaid-chase", provider: "plaid", sector: "finance" });
    h.all = [{ ...h.detail } as ConnectorStatus];
    h.banks = [
      {
        institution: "Chase", mask: "8830", bankKey: "kc", dedupGroupId: null,
        providers: [{ provider: "plaid", connectionId: "plaid-chase", itemStatus: "ok", lastSyncedAt: null }],
        accountCount: 2, health: "ok", unmergedDuplicate: false, classConflict: false,
      },
    ];
    renderDetail();
    expect(screen.queryByRole("button", { name: "Reconnect at Plaid" })).toBeNull();
    expect(screen.queryByText("This bank needs re-approving.")).toBeNull();
    expect(
      screen.getByText("Plaid · Finance was removed — its credential is gone from the vault."),
    ).toBeTruthy();
  });

  it("a removed connection's next-poll cell claims nothing", () => {
    h.detail = revoked();
    h.all = [{ ...h.detail } as ConnectorStatus];
    renderDetail();
    // "on hold" promises a resumption; "—" claims nothing.
    expect(screen.queryByText("on hold")).toBeNull();
    expect(screen.getByText("Next poll")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("a removed connection is not offered a revoke it cannot perform", () => {
    // Home Assistant is the case that shows it: its re-pasteable token earns the revoke row even
    // when nothing is shared — but not once the token is already gone.
    h.detail = revoked({
      connectionId: "ha1", provider: HOME_ASSISTANT_PROVIDER, sector: "home",
      policy_mode: "poll", push_kind: null,
    });
    h.all = [{ ...h.detail } as ConnectorStatus];
    h.creds = { ha1: "cred-gone" };
    renderDetail();
    expect(screen.queryByRole("button", { name: "Remove token" })).toBeNull();
    expect(screen.queryByText("Remove the token")).toBeNull();
    // Disconnect STAYS — purging the cached rows and the connector row is still a real effect.
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(
      screen.getAllByText(
        "Removes Home's cached data and this connection row. The credential is already gone.",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("pausing is disabled for a removed connection, but the control stays drawn", () => {
    h.detail = revoked();
    h.all = [{ ...h.detail } as ConnectorStatus];
    renderDetail();
    const pause = screen.getByRole("button", { name: "Pause syncing" }) as HTMLButtonElement;
    expect(pause.disabled).toBe(true);
  });

  it("a revoked sibling is not counted in the shared-credential blast radius", () => {
    // A revoked sibling would OVERSTATE what a revoke removes — a false claim on a destructive
    // confirm. Two live sectors + one revoked, all on the same credential.
    h.detail = detail({
      connectionId: "c1", provider: "apple", sector: "mail", credentialId: "cred-apple",
    });
    h.all = [
      { ...detail({ connectionId: "c1", sector: "mail" }) } as ConnectorStatus,
      { ...detail({ connectionId: "c2", sector: "calendar" }) } as ConnectorStatus,
      {
        ...detail({ connectionId: "c3", sector: "contacts", status: "revoked" }),
      } as ConnectorStatus,
    ];
    h.creds = { c1: "cred-apple", c2: "cred-apple", c3: "cred-apple" };
    renderDetail();
    expect(screen.getByText("This iCloud credential also feeds Calendar. Revoking the credential disconnects all of them; disconnecting just Mail leaves the others flowing.")).toBeTruthy();
    expect(screen.queryByText(/also feeds Calendar and Contacts/)).toBeNull();
    // …and the revoke verb counts only what it will really take down
    expect(screen.getByRole("button", { name: "Revoke all 2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke all 3" })).toBeNull();
  });
});

// ── #134: Disconnect / Revoke reveal the typed confirm IN VIEW ────────────────
//
// The confirm host is the LAST child of this page (below the lifecycle rows), so the revealed
// ConfirmBar sat below the fold — same live-caught shape as the SourcesPage Remove. The scroll is
// the kit ConfirmBar's (reveal = in view); this asserts BOTH of this page's reveal sites reach it.
describe("revealing a typed confirm brings it into view (#134)", () => {
  /** The #112 spy pattern — jsdom has no layout, so scrollIntoView is absent; the stub lets the
   *  test assert the CALL without a scroll position jsdom cannot have. */
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

  it("clicking Disconnect scrolls the revealed confirm into view", () => {
    // MUTATION: delete the mount effect in kit/ConfirmBar.tsx → zero calls, red.
    h.detail = detail({ connectionId: "c1", provider: "gmail", sector: "mail" });
    h.all = [{ ...h.detail } as ConnectorStatus];
    withScrollSpy((calls) => {
      renderDetail();
      expect(calls).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
      expect(calls).toHaveLength(1);
      expect(calls[0].textContent).toContain("Type disconnect to confirm");
    });
  });

  it("clicking the revoke row's seal scrolls that confirm into view too", () => {
    // Home Assistant earns the revoke row without siblings (re-pasteable token) — the second
    // reveal site on this page.
    h.detail = detail({
      connectionId: "ha1", provider: HOME_ASSISTANT_PROVIDER, sector: "home", credentialId: "cred-ha",
    });
    h.all = [{ ...h.detail } as ConnectorStatus];
    h.creds = { ha1: "cred-ha" };
    withScrollSpy((calls) => {
      renderDetail();
      fireEvent.click(screen.getByRole("button", { name: "Remove token" }));
      expect(calls).toHaveLength(1);
      expect(calls[0].textContent).toContain("Type Home Assistant to confirm");
    });
  });
});

// ── #111 / #107 §3: the masthead mark is keyed off the served domain ──────────
describe("the connection masthead wears the bank's own mark, from the stable identifier", () => {
  it("a Plaid bank's mark comes from orgDomain, not from how its provider spells the name", () => {
    // "Citibank" is the example that made #89's case — a display string no alias table knew. Its approved
    // treatment (C on Citi blue) is reachable ONLY from `citi.com`; the name alone gives the warm-ink
    // initial, and the initial is "C" either way — so the assertion is the HEX.
    //
    // MUTATION: drop `orgDomain={bank?.orgDomain}` where ConnectionDetail hands the card to DetailBody,
    // or drop the prop off `<InstitutionMark>` → the ground becomes the neutral ink, red.
    h.detail = detail({ connectionId: "plaid-citi", provider: "plaid", sector: "finance" });
    h.all = [{ ...h.detail } as ConnectorStatus];
    h.banks = [
      {
        institution: "Citibank", orgDomain: "https://www.citi.com/", mask: "4001", bankKey: "cm:citi|4001|USD",
        dedupGroupId: null,
        providers: [{ provider: "plaid", connectionId: "plaid-citi", itemStatus: "ok", lastSyncedAt: null }],
        accountCount: 2, health: "ok", unmergedDuplicate: false, classConflict: false,
      },
    ];
    const { container } = renderDetail();
    const tile = container.querySelector<HTMLElement>('[style*="--institution-mark-ground"]');
    expect(tile).not.toBeNull();
    expect(tile!.getAttribute("style")).toContain("#056DAE");
    expect(tile!.getAttribute("style")).not.toContain("#2A2118");
    expect(tile!.textContent).toBe("C");
  });
});

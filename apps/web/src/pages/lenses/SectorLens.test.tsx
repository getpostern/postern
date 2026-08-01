// The sector lens under the two conditions the fixtures never produced (#100 items 5 and 6):
//
//   item 5 — an EMPTY sector. `onSyncNow` returns immediately when there is nothing to sync, yet the
//            empty-sector masthead handed `LensMasthead` a fully live `onSyncNow`. It sat beside a
//            working "Connect a source" CTA, so the likeliest first click was the dead one.
//   item 6 — a FAILING sync. `await Promise.allSettled(...)` then an unconditional neutral
//            "Sync requested for X", with a `catch` that could never fire (allSettled does not
//            reject). Three failed logins reported as a success.
//
// Both are behaviour a pure-function test cannot reach: the bug was in what the PAGE passed and what
// the PAGE did with the answer, not in a derivation.

import "../../api/test-dom"; // jsdom global before React / testing-library load
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, NotServedError } from "../../api/client";
import { ToastProvider } from "../../kit";
import { SectorLens } from "./SectorLens";
import type {
  ActionCatalog,
  Agent,
  ConnectorStatus,
  Freshness,
  QueryResult,
  Sector,
  SyncNowResult,
} from "../../api/types";

const fresh = (state: Freshness["state"], over: Partial<Freshness> = {}): Freshness => ({
  state,
  last_heard_at: "2026-07-24T12:00:00Z",
  next_expected_at: null,
  stream_state: null,
  error: null,
  ...over,
});

function conn(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    connectionId: "c1",
    provider: "simplefin",
    sector: "finance",
    status: "active",
    last_synced_at: "2026-07-24T12:00:00Z",
    last_error: null,
    last_error_at: null,
    policy_mode: "poll",
    next_sync_at: null,
    scopes: [],
    credential: { status: "ok", expires_at: null },
    credentialId: "cred_fixture",
    webhook_secret_set_at: null,
    sync_window_days: null,
    sync_interval_sec: 7200,
    min_interval_sec: 7200,
    default_interval_sec: 7200,
    cached_count: 10,
    freshness: fresh("ok"),
    ...over,
  };
}

function coverageResult(): QueryResult {
  return {
    sector: "x",
    object: "x",
    aggregate: { fn: "count" },
    count: 1,
    groups: [{ group: {}, value: 42 }],
  };
}

// Dates far enough either side of any real clock that the assertion cannot depend on when it runs —
// `isKeyHolder` reads the real `Date.now()` from the page, and a fixture pinned near today is how a
// key-expiry test quietly flips meaning six months later.
const LONG_EXPIRED = "2020-01-01T00:00:00Z";
const FAR_FUTURE = "2099-01-01T00:00:00Z";

function agent(over: Partial<Agent> = {}): Agent {
  return {
    agentId: "spentclaw",
    sectors: ["finance"],
    created_at: "2026-01-01T00:00:00Z",
    revoked_at: null,
    ...over,
  };
}

function mockApi(connectors: ConnectorStatus[], agents: Agent[] = []) {
  vi.spyOn(api, "listConnectors").mockResolvedValue(connectors);
  vi.spyOn(api, "listAgents").mockResolvedValue(agents);
  vi.spyOn(api, "queryData").mockResolvedValue(coverageResult());
  vi.spyOn(api, "getFinanceBanks").mockResolvedValue([]);
  vi.spyOn(api, "getFinanceDedupCandidates").mockResolvedValue([]);
  // A gateway older than the catalog route — one of the six answers, not the only one. The blocks
  // below that care about the catalog re-stub `listActions` with a SERVED envelope.
  vi.spyOn(api, "listActions").mockRejectedValue(
    new NotServedError("no_route", "Not served — this gateway has no route for the action catalog yet."),
  );
}

function renderLens(sector: Sector = "finance") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <SectorLens sector={sector} />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const syncBtn = () => screen.getByRole("button", { name: /sync now/i }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("#100 item 5 — an empty sector's Sync now is drawn, disabled, and says why", () => {
  it("an empty sector draws Sync now DISABLED with its reason, beside a live Connect CTA", async () => {
    mockApi([]);
    renderLens();
    await screen.findByText(/No Finance source connected/i);

    expect(syncBtn().disabled).toBe(true);
    expect(screen.getByText(/no source is connected here yet/i)).toBeTruthy();

    // …and the CTA next to it is NOT disabled. Disabling both would "fix" the dead button by
    // removing the one live affordance on the page.
    const connect = screen.getByRole("button", { name: /connect a source/i }) as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
  });

  it("a sector with a connection has a live Sync now", async () => {
    // Catches applying the disabled branch unconditionally — a real regression risk, and one the
    // empty-sector test alone would never see.
    mockApi([conn()]);
    renderLens();
    await waitFor(() => expect(syncBtn().disabled).toBe(false));
    expect(screen.queryByText(/no source is connected here yet/i)).toBeNull();
  });
});

// #100 item 4 — the FOURTH `!a.revoked_at` call site. The other three live on the Gatehouse and are
// covered by GatehousePage.test.tsx; this one is `SectorLens.tsx`'s CAN-READ lane, and until this
// block existed reverting it to `!a.revoked_at` left the ENTIRE apps/web suite green. An expired key
// is denied by the auth layer, so naming it here claims a reader the gate will turn away — on the
// one surface whose whole job is "who can read this domain".
describe("#100 item 4 — an expired key is not a reader of this domain", () => {
  it("an expired grantee is neither named in the CAN-READ lane nor counted in the verdict", async () => {
    mockApi([conn()], [agent({ expires_at: LONG_EXPIRED })]);
    const { container } = renderLens();
    await waitFor(() => expect(syncBtn().disabled).toBe(false));

    // The verdict counts zero readers…
    await waitFor(() => expect(container.textContent).toContain("no agents hold keys here"));
    expect(container.textContent).not.toContain("read by 1 agent");
    // …and the lane names nobody. `queryByText` over the exact agent id: the defect was that the
    // spent key appeared in the CAN-READ list as though it still held one.
    expect(screen.queryByText("spentclaw")).toBeNull();
  });

  it("a live grantee IS named and counted — the filter denies the expired, not everyone", async () => {
    // The positive control. Without it, `() => false` at the call site would pass the test above.
    mockApi([conn()], [agent({ expires_at: FAR_FUTURE })]);
    const { container } = renderLens();
    await waitFor(() => expect(syncBtn().disabled).toBe(false));

    await waitFor(() => expect(container.textContent).toContain("read by 1 agent"));
    expect(await screen.findByText("spentclaw")).toBeTruthy();
    expect(container.textContent).not.toContain("no agents hold keys here");
  });
});

describe("#100 item 6 — a sector sync reports per-connection outcomes", () => {
  it("a failed sector sync reports the failure, never 'Sync requested'", async () => {
    mockApi([conn()]);
    const syncNow = vi.spyOn(api, "syncNow").mockResolvedValue({
      connectionId: "c1",
      provider: "simplefin",
      mode: "poll",
      ran: true,
      ok: false,
      error: "item login required",
    } as SyncNowResult);

    renderLens();
    await waitFor(() => expect(syncBtn().disabled).toBe(false));
    fireEvent.click(syncBtn());

    // The served reason reaches the operator…
    expect(await screen.findByText(/item login required/i)).toBeTruthy();
    // …and the neutral lie is gone. `allSettled` resolves for a failed sync, so the old code's
    // `catch` never ran and the toast was unconditionally cheerful.
    expect(screen.queryByText(/sync requested/i)).toBeNull();
    expect(syncNow).toHaveBeenCalledWith("c1");
  });

  it("a clean sector sync reports what landed, in the ok voice", async () => {
    mockApi([conn()]);
    vi.spyOn(api, "syncNow").mockResolvedValue({
      connectionId: "c1",
      provider: "simplefin",
      mode: "poll",
      ran: true,
      ok: true,
      upserted: 9,
    } as SyncNowResult);

    renderLens();
    await waitFor(() => expect(syncBtn().disabled).toBe(false));
    fireEvent.click(syncBtn());

    const toast = await screen.findByText(/9 updated/i);
    // The tone is the assertable fact for the voice (jsdom has no cascade): an "ok" summary painted
    // in the error tone is the same defect the other direction.
    expect(toast.closest("[data-tone]")!.getAttribute("data-tone")).toBe("ok");
  });
});

// ── #58 — the lens reads the SERVED catalog envelope ─────────────────────────────────────────────
//
// THE DEFECT. `GET /api/actions` serves `{ actions, count, truncated }`. The lens did
// `const specs = await api.listActions(sector); specs.length > 0 ? catalog : readonly`. `.length` on
// that object is `undefined`, `undefined > 0` is false, so EVERY sector lens **including Home, the one
// sector that can act** rendered "read-only, no actions" — silently, with no error anywhere.
//
// NOTHING in the suite could see it. `AgentsBand.test.tsx` tested the pure component with a hand-built
// `{kind:"catalog"}`, and this file's other blocks mock `listActions` as REJECTING. A cell asserting
// merely that the call succeeded is exactly the guard that cannot fail here — so these assert the
// action ID is ON SCREEN, and that the read-only sentence is NOT.
describe("#58 — HOME renders its actions, and never reports itself read-only", () => {
  const homeConn = () =>
    conn({ connectionId: "ha1", provider: "home_assistant", sector: "home", policy_mode: "push" });

  /** A served catalog, exactly the wire shape (`ActionCatalog`) — not a bare array. */
  const served = (over: Partial<ActionCatalog> = {}): ActionCatalog => ({
    actions: [
      { id: "home.light.turn_on", description: "dim or colour any light", params: [] },
      { id: "home.lock.lock", description: "doors & deadbolts", params: [] },
    ],
    count: 2,
    truncated: false,
    ...over,
  });

  it("home renders AT LEAST ONE action from the served envelope", async () => {
    mockApi([homeConn()]);
    vi.spyOn(api, "listActions").mockResolvedValue(served());
    const { container } = renderLens("home");

    // The action itself, on screen. This is the assertion the old code fails.
    expect(await screen.findByText("home.light.turn_on")).toBeTruthy();
    expect(screen.getByText("dim or colour any light")).toBeTruthy();
    expect(screen.getByText("2 actions")).toBeTruthy();

    // …and the sentence the defect produced is absent. Both halves: rendering the list AND still
    // printing "read-only" somewhere would be a different, equally wrong surface.
    expect(container.textContent).not.toMatch(/read-only/i);
    // Rebound to the not-served arm's own sentence (#106 §2c): the wire's "no route for the action
    // catalog" is no longer rendered by any arm, so a negative on those words could not fail.
    expect(container.textContent).not.toMatch(/build from before it could list/i);
  });

  it("the lens asks for THIS sector's catalog, not the whole gateway's", async () => {
    mockApi([homeConn()]);
    const listActions = vi.spyOn(api, "listActions").mockResolvedValue(served());
    renderLens("home");
    await screen.findByText("home.light.turn_on");
    // `sector` omitted would return every sector's catalog and render another domain's actions here.
    expect(listActions).toHaveBeenCalledWith("home", undefined);
  });

  it("a genuinely EMPTY served catalog still reads read-only — the fix did not invert", async () => {
    // The positive control for the negative above. Without it, hardcoding `{kind:"catalog"}` would
    // pass every assertion in this block while claiming finance can act.
    mockApi([conn()]);
    vi.spyOn(api, "listActions").mockResolvedValue({ actions: [], count: 0, truncated: false });
    const { container } = renderLens("finance");
    await waitFor(() => expect(container.textContent).toMatch(/Read-only/));
    // The whole served fact, in one sentence: the gate answered and its list here is empty. The
    // footnote `actions: [ ]` that used to carry the evidence is deleted (#106 §2c) — the wire's own
    // notation as a caption, saying nothing the sentence had not, in a form only we can read.
    expect(container.textContent).toMatch(/No actions are exposed/);
    expect(container.textContent).not.toMatch(/actions: ?\[/);
  });
});

// `truncated` means the cap cut an ID-SORTED list, so what came back is a prefix and a whole trailing
// domain can be missing. Showing it as complete is the silent-truncation defect already removed once
// from the MCP surface. The answer is a NARROWER FILTER — which the client accepts — so the lens must
// both say the list is partial and let a person act on it.
describe("#58 — a trimmed catalog is surfaced, and the narrowing reaches the wire", () => {
  const homeConn = () =>
    conn({ connectionId: "ha1", provider: "home_assistant", sector: "home", policy_mode: "push" });

  it("a trimmed catalog says so instead of quoting its count as a total", async () => {
    mockApi([homeConn()]);
    vi.spyOn(api, "listActions").mockResolvedValue({
      actions: [{ id: "home.light.turn_on", description: "dim any light", params: [] }],
      count: 1,
      truncated: true,
    });
    const { container } = renderLens("home");
    await screen.findByText("home.light.turn_on");
    expect(screen.getByText(/whole groups after the last one above may be missing/i)).toBeTruthy();
    // "1 action" would be a claim about the catalog; the response only supports "showing 1".
    expect(container.textContent).not.toMatch(/\b1 action\b/);
    expect(screen.getByText("showing 1")).toBeTruthy();
  });

  it("narrowing re-asks the gateway with the domain filter — the control is not decorative", async () => {
    mockApi([homeConn()]);
    const listActions = vi.spyOn(api, "listActions").mockResolvedValue({
      actions: [{ id: "home.light.turn_on", description: "dim any light", params: [] }],
      count: 1,
      truncated: true,
    });
    renderLens("home");
    await screen.findByText("home.light.turn_on");

    fireEvent.change(screen.getByRole("textbox", { name: /show one group in full/i }), {
      target: { value: "switch" },
    });

    // The wire call, with the filter — `entityId`/`area`/`domain` are the served narrowing keys, and
    // a control that changed only local state would leave this assertion unsatisfied forever.
    await waitFor(() => expect(listActions).toHaveBeenCalledWith("home", { domain: "switch" }));
  });
});

// A read that FAILED and a route that does not EXIST are different facts, and neither may wear the
// other's sentence (`api/notserved.test.ts`). The lens's fallback used to be the not-served string
// unconditionally, which was honest while the route did not exist and is a lie now.
describe("#58 — an outage in the catalog read is not an absent capability", () => {
  it("a 500 from the catalog reads as unreadable, never as read-only or not-served", async () => {
    mockApi([conn()]);
    vi.spyOn(api, "listActions").mockRejectedValue(new Error("gateway unreachable"));
    const { container } = renderLens("finance");

    await waitFor(() => expect(container.textContent).toMatch(/could not be read/i));
    expect(screen.getByText("gateway unreachable")).toBeTruthy();
    expect(container.textContent).not.toMatch(/read-only/i);
    expect(container.textContent).not.toMatch(/build from before it could list/i);
  });

  it("a gateway with no catalog route still says exactly that — in the reader's words", async () => {
    // The other side of the same fork: folding not-served into the outage sentence would be the
    // mirror-image mistake, and this repo has made both.
    //
    // #106 §2c — and the sentence is the READER'S. The lens resolves `NotServedError` into the
    // `not-served` arm and drops its message: the client still throws "Not served — this gateway has
    // no route for the action catalog yet" (pinned in `api/notserved.test.ts`, untouched), and no
    // person ever reads it. MUTATION: pass `err.message` through and print it → RED on the negative.
    mockApi([conn()]);
    const { container } = renderLens("finance");
    await waitFor(() => expect(container.textContent).toMatch(/build from before it could list/i));
    expect(container.textContent).toMatch(/update the gate/i);
    expect(container.textContent).not.toMatch(/no route|not served/i);
    expect(container.textContent).not.toMatch(/could not be read/i);
  });
});

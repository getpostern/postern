// Behaviour tests a static render can't show (jsdom + @testing-library/react): the reveal-once
// secret never reaches the URL, default-deny, the three passage answers (served instant · nothing
// recorded · not recorded by this gateway) told apart, destructive confirm goes through <ConfirmBar>
// (never window.confirm), the #80 in-place expiry control as a LIVE tri-state edit that cannot
// resurrect a dead key, #53's :443 caveat, and — since `/api/exposure` landed — the bridge status
// READ from the gateway plus the expiry default that follows whether the gate is published.

import "../../api/test-dom"; // installs a jsdom global BEFORE React/testing-library load

import React from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AuditRow, ExposureStatus } from "../../api/types";

// ── mocks ──────────────────────────────────────────────────────────────────
// `exposure` starts UNDEFINED = the query is still pending. Every page under test must render
// through that frame without throwing and without inventing an address; the cells below then set it.
//
// `exposureFailed` is the THIRD state, and it is a separate flag rather than "data is undefined"
// because that is exactly the collapse §Decision 7 forbids: `useQuery` reports `data: undefined`
// while pending AND on error, and a component that reads only `data` therefore renders "the
// gateway answered: nothing" for a request that never arrived.
const H = vi.hoisted(() => ({
  agents: [] as Agent[],
  audit: [] as AuditRow[],
  exposure: undefined as ExposureStatus | undefined,
  exposureFailed: false,
}));
vi.mock("../../api/hooks", () => ({
  useAgents: () => ({ data: H.agents, isLoading: false, isError: false, error: null, refetch: () => {} }),
  useAudit: () => ({ data: H.audit, isLoading: false }),
  useInvalidateAgents: () => () => {},
  useExposure: () => ({
    data: H.exposureFailed ? undefined : H.exposure,
    isPending: !H.exposureFailed && H.exposure === undefined,
    isLoading: !H.exposureFailed && H.exposure === undefined,
    isError: H.exposureFailed,
    error: H.exposureFailed ? new Error("Failed to fetch") : null,
  }),
}));

const SERVED_ENDPOINT = "http://localhost:9191/mcp";
const PUBLIC_URL = "https://gate.example.ts.net/mcp";

function exposure(over: Partial<ExposureStatus> = {}): ExposureStatus {
  return {
    configured: null,
    serving: null,
    restartRequired: false,
    localEndpoint: SERVED_ENDPOINT,
    publishedRoutes: [],
    problem: null,
    ...over,
  };
}

const M = vi.hoisted(() => ({
  createAgent: vi.fn(),
  revokeAgent: vi.fn(),
  deleteAgent: vi.fn(),
  patchAgent: vi.fn(),
  listActions: vi.fn(),
}));
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...actual.api, ...M } };
});

import { NotServedError } from "../../api/client";
import { EXPOSURE_UNANSWERED } from "../../api/exposure";
import { PASSAGE_LOWER_BOUND_NOTE, PASSAGE_NOT_REPORTED } from "./helpers";
import { ToastProvider } from "../../kit";
import { AgentsPage } from "./AgentsPage";
import { MintKeyPage } from "./MintKeyPage";
import { AgentDetailPage } from "./AgentDetailPage";
import { ConnectHostedPage } from "./ConnectHostedPage";
import { ConnectRecipes } from "./ConnectRecipes";

function agent(over: Partial<Agent> = {}): Agent {
  return {
    agentId: "myclaw",
    sectors: ["finance"],
    created_at: "2026-01-01T00:00:00.000Z",
    revoked_at: null,
    expires_at: null,
    ...over,
  };
}

/** Surfaces the router URL so a test can assert a secret never lands in it. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search + loc.hash}</div>;
}

function ui(children: React.ReactNode, initialEntries: string[] = ["/"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  H.agents = [];
  H.audit = [];
  H.exposure = exposure();
  H.exposureFailed = false;
  M.createAgent.mockReset();
  M.revokeAgent.mockReset();
  M.patchAgent.mockReset();
  M.listActions.mockReset();
  // ReadActNote calls listActions("home"); today it is NOT served. Simulate that so the note shows
  // its degraded "action count not served yet" branch, never a fabricated number.
  M.listActions.mockRejectedValue(new NotServedError("no_route", "not served"));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MintKeyPage — reveal-once + default-deny", () => {
  it("starts default-DENY: no sector is granted until picked", () => {
    ui(<Routes><Route path="/agents/new" element={<MintKeyPage />} /></Routes>, ["/agents/new"]);
    for (const name of ["Finance", "Mail", "Calendar", "Contacts", "Health", "Home"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("shows the minted key ONCE and it never reaches the URL (a secret must not hit history)", async () => {
    M.createAgent.mockResolvedValue({
      agentId: "bot",
      sectors: ["home"],
      key: "key_SECRET_abc123",
      expires_at: null,
    });
    ui(
      <Routes>
        <Route path="/agents/new" element={<><MintKeyPage /><LocationProbe /></>} />
      </Routes>,
      ["/agents/new"],
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bot" } });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Mint the key" }));

    // The plaintext key is shown in the reveal state…
    await screen.findByText("key_SECRET_abc123");
    expect(M.createAgent).toHaveBeenCalledWith({ agentId: "bot", sectors: ["home"], expiresInDays: undefined });
    // …and the URL never carries it (reveal-once is a page STATE, not a route).
    expect(screen.getByTestId("loc").textContent).toBe("/agents/new");
    expect(screen.getByTestId("loc").textContent).not.toContain("SECRET");
  });
});

describe("AgentsPage register", () => {
  it("renders a gateway that does not report passage as a fact about the GATEWAY (#89)", () => {
    H.agents = [agent({ agentId: "myclaw", sectors: ["finance", "mail", "calendar", "contacts", "health", "home"] })];
    ui(<AgentsPage />);
    // #106: the register said "not recorded by this gateway" and the detail page said "this gateway
    // doesn't record passage per key" — two sentences for one fact, and BOTH claimed more than the
    // evidence. All the Console knows is that the field was absent from the answer; whether the gateway
    // records passage is not visible from here. One shared constant now, and it says "not reported".
    expect(screen.getByText(PASSAGE_NOT_REPORTED)).toBeTruthy();
    expect(PASSAGE_NOT_REPORTED).toBe("not reported by this gateway");
    // all six granted → the "every sector" italic line, not six chips
    expect(screen.getByText("every sector")).toBeTruthy();
  });

  /**
   * The served passage, and the two absences kept apart (#58/#89).
   *
   * `null` is the gateway saying "I have nothing recorded for this key"; `undefined` is the gateway not
   * answering the question. Collapsing either into "never used" is the trap #80 names — audit is
   * fire-and-forget and droppable, so a missing line is not proof a call never happened.
   *
   * MUTATION: render the cell as `ago(agent.last_seen_at ?? null)` (the tempting one-liner) → RED: the
   * unreported key renders "never", asserting the key has never come through on the strength of a
   * field the gateway never sent.
   */
  it("tells a served instant, nothing-recorded, and not-reported apart", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    H.agents = [
      agent({ agentId: "busy", last_seen_at: twoHoursAgo, last_read_at: { finance: twoHoursAgo } }),
      agent({ agentId: "quiet", last_seen_at: null, last_read_at: {} }),
      agent({ agentId: "legacy" }), // no last_seen_at key at all
    ];
    ui(<AgentsPage />);

    expect(screen.getByText("2h ago")).toBeTruthy();
    expect(screen.getByText("nothing recorded")).toBeTruthy();
    expect(screen.getByText(PASSAGE_NOT_REPORTED)).toBeTruthy();
    // The words that would be lies: "never" for a droppable trail, and one absence wearing the other's
    // sentence.
    expect(screen.queryByText("never used")).toBeNull();
    expect(screen.queryByText("never")).toBeNull();
  });

  /** The times are a LOWER BOUND, and the column says which way it can be wrong. Without this the
   *  Console shows a revoke-grade number and implies certainty the invariant denies it.
   *  MUTATION: delete the footnote → RED. */
  it("prints the lower-bound caveat once under the column, not in every cell", () => {
    H.agents = [agent({ agentId: "busy", last_seen_at: new Date().toISOString() })];
    ui(<AgentsPage />);
    const note = screen.getByText(/Passage is what the ledger wrote down/);
    expect(note.textContent).toMatch(/quieter here than it really was, never busier/);
  });

  it("does not qualify a column that isn't there — no caveat on the empty register", () => {
    H.agents = [];
    ui(<AgentsPage />);
    expect(screen.queryByText(/Passage is what the ledger wrote down/)).toBeNull();
    expect(screen.getByText("No keys issued yet")).toBeTruthy();
  });

  it("Revoke goes through the in-app ConfirmBar, never window.confirm (#70)", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    H.agents = [agent({ agentId: "myclaw" })];
    ui(<AgentsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    // A modal dialog with the typed ConfirmBar appears; window.confirm was never touched.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Revoke the key" })).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe("AgentDetailPage", () => {
  /** Helper: render the detail page for one agent id. */
  function detail(agentId: string) {
    return ui(
      <Routes><Route path="/agents/:agentId" element={<AgentDetailPage />} /></Routes>,
      [`/agents/${agentId}`],
    );
  }
  const chip = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

  it("the passage readout says what the ledger recorded, and stays a fact about the gateway when absent", () => {
    H.agents = [agent({ agentId: "myclaw", sectors: ["home"] })];
    detail("myclaw");
    // The SAME sentence the register prints for the same absence (#106) — the two pages held two
    // different phrasings of it, and neither was as weak as the truth.
    expect(screen.getByText(PASSAGE_NOT_REPORTED)).toBeTruthy();
    // Never the words that would claim the key has been idle, nor a claim about what the gateway does.
    expect(screen.queryByText(/never used/)).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/doesn.t record passage/);
  });

  it("a served instant reads 'last seen', and a served null reads 'no passage recorded'", () => {
    H.agents = [
      agent({ agentId: "seen", last_seen_at: new Date(Date.now() - 3_600_000).toISOString() }),
      agent({ agentId: "quiet", last_seen_at: null }),
    ];
    detail("seen");
    expect(screen.getByText("last seen 1h ago")).toBeTruthy();
    cleanup();
    detail("quiet");
    expect(screen.getByText("no passage recorded")).toBeTruthy();
  });

  /**
   * The per-sector half of passage (`last_read_at`): which grants this key has actually reached. A
   * granted sector missing from the map is a grant with nothing recorded — real and useful, and not
   * the same as the grant not existing.
   *
   * MUTATION: render `sectorReads` as an empty list when the field is absent (drop the `null` branch)
   * → RED on the last assertion: a gateway that said nothing would be quoted as "no read recorded yet
   * in Finance, Home".
   */
  it("names the grants this key has reached, and the ones with nothing recorded", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    H.agents = [
      agent({ agentId: "mixed", sectors: ["finance", "home"], last_read_at: { finance: threeDaysAgo } }),
      agent({ agentId: "legacy", sectors: ["finance", "home"] }),
    ];
    detail("mixed");
    const line = screen.getByText(/Last read — Finance/);
    expect(line.textContent).toMatch(/Last read — Finance 3d ago\./);
    expect(line.textContent).toMatch(/Nothing recorded yet in Home\./);
    cleanup();

    detail("legacy");
    expect(screen.queryByText(/Nothing recorded yet in/)).toBeNull();
    expect(screen.queryByText(/Last read/)).toBeNull();
  });

  /**
   * #80 — the in-place expiry edit is LIVE, and the tri-state reaches the wire intact.
   *
   * `expiresInDays: null` is the ONLY way to say "never expires", and ABSENT is the only way to say
   * "leave the deadline alone". A patch that carried both fields on an expiry click would overwrite the
   * grant set with whatever this render happened to hold.
   *
   * MUTATION: send `{ sectors, expiresInDays: opt.days }` → RED on the `Object.keys` assertions.
   */
  it("an expiry click patches ONLY the expiry — and Never sends explicit null", async () => {
    H.agents = [agent({ agentId: "myclaw", sectors: ["home"], expires_at: null })];
    M.patchAgent.mockResolvedValue({ ...agent({ agentId: "myclaw" }), expires_at: null });
    detail("myclaw");

    const sixty = chip("60 days");
    expect(sixty.disabled).toBe(false);
    fireEvent.click(sixty);
    await screen.findByText(/expires in 60 days/);
    expect(M.patchAgent).toHaveBeenCalledWith("myclaw", { expiresInDays: 60 });
    expect(Object.keys(M.patchAgent.mock.calls[0][1] as object)).toEqual(["expiresInDays"]);

    fireEvent.click(chip("Never"));
    await screen.findByText(/never expires now/);
    const second = M.patchAgent.mock.calls[1][1] as { expiresInDays: number | null };
    expect(second.expiresInDays).toBe(null);
    expect(Object.keys(second)).toEqual(["expiresInDays"]);
  });

  /**
   * The other half of the tri-state, and the one that fails SILENTLY: to this route `null` means
   * "never expires", so a sectors edit that sent an expiry key would clear the key's deadline, answer
   * 200, and look right.
   *
   * MUTATION: change the sectors call to `api.patchAgent(agentId, { sectors: next, expiresInDays: null })`
   * → RED (the argument is no longer the bare array, and it carries an expiry key).
   */
  it("a GRANT toggle sends no expiry key at all — absent is the only 'leave it alone'", async () => {
    H.agents = [agent({ agentId: "myclaw", sectors: ["home"], expires_at: new Date(Date.now() + 60 * 86_400_000).toISOString() })];
    M.patchAgent.mockResolvedValue(agent({ agentId: "myclaw" }));
    detail("myclaw");

    fireEvent.click(screen.getByRole("button", { name: "Finance" }));
    await screen.findByText(/Grants updated/);
    const [, arg] = M.patchAgent.mock.calls[0] as [string, unknown];
    expect(Array.isArray(arg)).toBe(true);
    expect(arg).toEqual(["finance", "home"]);
    expect(JSON.stringify(arg)).not.toContain("expiresInDays");
  });

  /**
   * AN EXPIRY EDIT MUST NEVER RESURRECT A DEAD KEY. The gateway refuses it outright (verified in
   * `src/rest/admin.ts` `patchAgent` — the liveness clause is inside the UPDATE's own WHERE, for both
   * revoked and past-deadline), because moving the deadline would hand the ORIGINAL secret its access
   * back. So the Console must not draw a control that looks like it would work.
   *
   * MUTATION: gate on `revoked` instead of `status === "active"` → RED on the expired cell (a lapsed
   * key offers four live chips whose every click the gateway answers 400).
   */
  it("refuses to look clickable on a key revoke or expiry already killed", () => {
    H.agents = [
      agent({ agentId: "gone", revoked_at: "2026-05-01T00:00:00Z" }),
      agent({ agentId: "lapsed", expires_at: new Date(Date.now() - 86_400_000).toISOString() }),
    ];
    detail("gone");
    expect(chip("Never").disabled).toBe(true);
    expect(chip("90 days").disabled).toBe(true);
    const reason = screen.getByText(/revoked, so its deadline is fixed where it stopped/);
    expect(reason.textContent).toMatch(/Rotate to mint a fresh key with a new deadline/);
    // The reason travels WITH the control: a disabled button cannot take focus, so an AT user who
    // never lands on a chip has to hear it from the group's description instead.
    // MUTATION: drop `aria-describedby` from the group → RED.
    const group = screen.getByRole("group", { name: "Expiry" });
    expect(group.getAttribute("aria-describedby")).toBe(reason.id);
    expect(reason.id).toBeTruthy();
    cleanup();

    detail("lapsed");
    expect(chip("Never").disabled).toBe(true);
    expect(chip("30 days").disabled).toBe(true);
    expect(screen.getByText(/already lapsed/)).toBeTruthy();
    // And the grants hint does not promise a session a lapsed key cannot open. Its sectors CAN still be
    // patched (the gateway allows that on a dead grant), so the affordance stays — only the promise goes.
    // MUTATION: collapse the hint back to `revoked ? … : "applies at the agent's next session"` → RED.
    expect(screen.getByText(/this key has lapsed, so nothing reaches your gate/)).toBeTruthy();
    expect(screen.queryByText(/applies at the agent's next session/)).toBeNull();
    expect((screen.getByRole("button", { name: "Finance" }) as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * A refused edit surfaces the GATEWAY's own sentence rather than a Console paraphrase, and — because
   * the control is deliberately not optimistic — leaves the true deadline on screen.
   */
  it("a refused expiry edit reports the gateway's reason and changes nothing on screen", async () => {
    H.agents = [agent({ agentId: "myclaw", expires_at: null })];
    M.patchAgent.mockRejectedValue(
      new Error("a revoked key's expiry cannot be changed — rotate to mint a fresh key with a new deadline"),
    );
    detail("myclaw");

    fireEvent.click(chip("30 days"));
    await screen.findByText(/Deadline unchanged — a revoked key's expiry cannot be changed/);
    // Still on Never: the readout follows the SERVED deadline, never the click.
    expect(chip("Never").getAttribute("aria-pressed")).toBe("true");
    expect(chip("30 days").getAttribute("aria-pressed")).toBe("false");
  });

  /**
   * A deadline that matches no preset must light NOTHING — above all not Never, which would have the
   * Console denying a deadline its own sub-line is printing.
   *
   * MUTATION: select with `expiryPresetFor(agent.expires_at) === opt.days` → RED (Never lights up on a
   * 200-day key).
   */
  it("a custom deadline lights no chip, and says so instead of pretending", () => {
    H.agents = [
      agent({ agentId: "custom", expires_at: new Date(Date.now() + 200 * 86_400_000).toISOString() }),
    ];
    detail("custom");
    for (const name of ["Never", "30 days", "60 days", "90 days"]) {
      expect(chip(name).getAttribute("aria-pressed")).toBe("false");
    }
    expect(screen.getByText(/lapses in 200 days, which isn’t one of the presets/)).toBeTruthy();
    // And the page never says the opposite of its own sub-line.
    expect(screen.queryByText(/never expires/)).toBeNull();
  });

  /**
   * While the edit is in flight the row is inactive — one deadline move per click, and the dim on
   * screen is a disabled CONTROL rather than a dimmed value.
   *
   * MUTATION: drop `|| expiryMut.isPending` from `disabled` → RED, and a double-click sends two patches
   * whose order decides the deadline.
   */
  it("goes inactive while the deadline is moving, and says what it is doing", async () => {
    H.agents = [agent({ agentId: "myclaw", expires_at: null })];
    let release: (v: unknown) => void = () => undefined;
    M.patchAgent.mockReturnValue(new Promise((res) => { release = res; }));
    detail("myclaw");

    fireEvent.click(chip("30 days"));
    await screen.findByText("Moving the deadline…");
    expect(chip("30 days").disabled).toBe(true);
    expect(chip("Never").disabled).toBe(true);
    fireEvent.click(chip("60 days"));
    expect(M.patchAgent).toHaveBeenCalledTimes(1);

    release(agent({ agentId: "myclaw" }));
    await screen.findByText(/expires in 30 days/);
  });

  /** The lower-bound caveat is ONE sentence shared with the register — two surfaces qualifying the same
   *  value must not drift into two different promises about it. */
  it("qualifies the detail readout in the same words as the register", () => {
    H.agents = [agent({ agentId: "myclaw", last_seen_at: new Date().toISOString() })];
    detail("myclaw");
    expect(screen.getByText(PASSAGE_LOWER_BOUND_NOTE)).toBeTruthy();
    cleanup();
    ui(<AgentsPage />);
    expect(screen.getByText(PASSAGE_LOWER_BOUND_NOTE)).toBeTruthy();
  });

  /** The chips are a single-select CONTROL now, so the state they carry is `aria-pressed` — the same
   *  markup as the Mint form's expiry row, not the `aria-current` read-out they were while disabled. */
  it("announces the served deadline as a pressed toggle, matching the Mint control", () => {
    H.agents = [agent({ agentId: "myclaw", expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString() })];
    detail("myclaw");
    expect(chip("90 days").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Never").getAttribute("aria-pressed")).toBe("false");
    expect(chip("90 days").getAttribute("aria-current")).toBe(null);
  });

  it("distinguishes read-vs-act (#79) GRANT-ACCURATELY: names only granted sectors, not all five", () => {
    // A mixed grant: home (can act) + finance (read-only). mail is NOT granted and must not appear.
    H.agents = [agent({ agentId: "myclaw", sectors: ["home", "finance"] })];
    ui(
      <Routes><Route path="/agents/:agentId" element={<AgentDetailPage />} /></Routes>,
      ["/agents/myclaw"],
    );
    const note = screen.getByText(
      (_, el) => el?.tagName === "P" && /this grant/i.test(el.textContent ?? ""),
    );
    expect(note.textContent).toMatch(/act.*Home/i); // home's act half surfaced
    expect(note.textContent).toMatch(/Finance/); // the granted read-only sector named
    expect(note.textContent).not.toMatch(/Mail|Calendar|Contacts|Health/); // ungranted sectors absent
  });

  it("does NOT claim Home's act half for an agent not granted Home (#79)", () => {
    H.agents = [agent({ agentId: "reader", sectors: ["finance", "mail"] })];
    ui(
      <Routes><Route path="/agents/:agentId" element={<AgentDetailPage />} /></Routes>,
      ["/agents/reader"],
    );
    const note = screen.getByText(
      (_, el) => el?.tagName === "P" && /read-only today/.test(el.textContent ?? ""),
    );
    expect(note.textContent).toMatch(/isn.t granted here/i);
    expect(note.textContent).not.toMatch(/can act on Home/i);
  });

  it("a revoked agent offers Remove (revoked-only), not Revoke", () => {
    H.agents = [agent({ agentId: "gone", revoked_at: "2026-05-01T00:00:00Z" })];
    ui(
      <Routes><Route path="/agents/:agentId" element={<AgentDetailPage />} /></Routes>,
      ["/agents/gone"],
    );
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });
});

/**
 * The action catalog behind the read-vs-act note is served now, and it arrives as
 * `{ actions, count, truncated }` rather than a bare array.
 *
 * `count` is what THIS response carried, never a total — so a trimmed catalog must not be quoted as the
 * whole one. The shape exists because the previous bare-array declaration made `.length` `undefined`
 * the day the route landed, and every surface silently reported "read-only, no actions".
 */
describe("ReadActNote — the action count, and what truncation does to it", () => {
  const detailFor = (agentId: string) =>
    ui(
      <Routes><Route path="/agents/:agentId" element={<AgentDetailPage />} /></Routes>,
      [`/agents/${agentId}`],
    );

  it("reads the count off the catalog object, not off an array's length", async () => {
    H.agents = [agent({ agentId: "myclaw", sectors: ["home"] })];
    M.listActions.mockResolvedValue({ actions: [], count: 12, truncated: false });
    detailFor("myclaw");
    const note = await screen.findByText((_, el) => el?.tagName === "P" && /12 actions/.test(el.textContent ?? ""));
    expect(note.textContent).toMatch(/can act on Home \(12 actions\)/);
  });

  /**
   * #106 — when there is no count, the sentence carries NO parenthetical, and still states the act half.
   *
   * The degraded branch used to read "action count not served yet", so a person granting Home saw
   * "This grant can act on Home (action count not served yet)" — a note about our wire wedged inside
   * the one sentence that tells them what their agent may do. Absence claims strictly LESS: the grant
   * confers act on Home whatever the catalogue says, and the count was never the claim.
   *
   * This is the DEFAULT mock for the whole file (`listActions` rejects with `NotServedError`), which is
   * exactly the state a gateway older than the route is in.
   *
   * MUTATION: restore any degraded phrase — `actPhrase = "action count not served yet"`, or the old
   * pending `"read + act"` — → RED on the "no parenthesis" assertion. Note what must NOT happen and is
   * asserted too: suppressing the act half entirely would let the note read "read-only today" for a key
   * that can switch the lights off, which is #79's whole defect and an UNDERSTATED blast radius.
   */
  it("omits the count when the gateway serves none — and still says the grant can act", async () => {
    H.agents = [agent({ agentId: "myclaw", sectors: ["home", "finance"] })];
    detailFor("myclaw");
    const note = await screen.findByText(
      (_, el) => el?.tagName === "P" && /can act on Home/.test(el.textContent ?? ""),
    );
    expect(note.textContent).toMatch(/This grant can act on Home and read Finance \(read-only today\)\./);
    // No parenthetical after "Home", and no vocabulary from our wire anywhere in the sentence.
    expect(note.textContent).not.toMatch(/can act on Home \(/);
    expect(note.textContent).not.toMatch(/not served|read \+ act|catalog mirror|route/i);
    // The act half is still stated — the understated-blast-radius failure this note exists to prevent.
    expect(note.textContent).not.toMatch(/read-only today —/);
  });

  /** MUTATION: drop the `truncated` branch → RED. The Console would state a trimmed prefix as the
   *  complete catalog, which is the silent-truncation defect this shape was introduced to prevent. */
  it("says 'at least' when the server's cap trimmed the catalog", async () => {
    H.agents = [agent({ agentId: "myclaw", sectors: ["home"] })];
    M.listActions.mockResolvedValue({ actions: [], count: 200, truncated: true });
    detailFor("myclaw");
    const note = await screen.findByText((_, el) => el?.tagName === "P" && /200 actions/.test(el.textContent ?? ""));
    expect(note.textContent).toMatch(/at least 200 actions/);
  });
});

describe("ConnectRecipes — one endpoint, any harness (#71)", () => {
  it("the remote recipe is DECOUPLED from any secret (a placeholder key) and copy is marked keyless", () => {
    ui(<ConnectRecipes />);
    // A real streamable-http config a reader can copy WITHOUT minting — the bearer is a placeholder.
    expect(screen.getByText(/Bearer <your-agent-key>/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /keyless/i })).toBeTruthy();
    // The hosted target hands off to the bridge walkthrough.
    expect(screen.getByRole("link", { name: /Set up the bridge/ })).toBeTruthy();
  });
});

describe("ConnectHostedPage — the bridge walkthrough (#53)", () => {
  it("ships the load-bearing :443 caveat and reads the bridge status instead of guessing it", () => {
    ui(<ConnectHostedPage />);
    // #47: the port-443 caveat is load-bearing — say it or users hit a silent TCP reset.
    expect(screen.getByText(/publicly served \(port 443\)/)).toBeTruthy();
    // The state is SERVED now, so the page states the fact. The old condition-shaped line and its
    // "the Console can't read that flag" admission are gone, and must not come back.
    // #106: "this edge is bearer-only" was two of ours in five words. Same state, same specificity —
    // what a person can still do (paste a key) rather than what the edge is.
    expect(
      screen.getByText("Bridge is off — agents can only reach this gate with a pasted key"),
    ).toBeTruthy();
    expect(screen.queryByText(/can't read that flag/)).toBeNull();
    expect(screen.queryByText("Bridge is on when MCP_PUBLIC_URL is set")).toBeNull();
  });
});

describe("the expiry default follows whether this gate is published (ADR 0035 §D3 item 6)", () => {
  function mintForm() {
    return ui(
      <Routes><Route path="/agents/new" element={<MintKeyPage />} /></Routes>,
      ["/agents/new"],
    );
  }
  const pressed = (name: string) =>
    screen.getByRole("button", { name }).getAttribute("aria-pressed");

  // MUTATION: hardcode the default to null → the published cell RED. Hardcode it to 90 → the
  // unpublished cell RED. Either alone would pass a one-fixture test, which is why both are here.
  it("minting a key for a published gate proposes an expiry instead of Never", () => {
    H.exposure = exposure({
      configured: { publicUrl: PUBLIC_URL, source: "db", consentedAt: null },
      serving: { publicUrl: PUBLIC_URL },
    });
    mintForm();
    expect(pressed("90 days")).toBe("true");
    expect(pressed("Never")).toBe("false");
    expect(screen.getByText(/This gate is published\. A key you paste into a hosted client should expire\./)).toBeTruthy();
    cleanup();

    // Exposure off: today's default, unchanged, and no reason line claiming a gate is published.
    H.exposure = exposure();
    mintForm();
    expect(pressed("Never")).toBe("true");
    expect(pressed("90 days")).toBe("false");
    expect(screen.queryByText(/This gate is published/)).toBeNull();
  });

  // The Console never BLOCKS a never-expiring key — the gateway's own rule at the bridge is the one
  // gate, and a second, divergent rule here is how two tables start disagreeing.
  // MUTATION: disable the Never chip when the gate is published → RED.
  it("still lets you mint a never-expiring key on a published gate", () => {
    H.exposure = exposure({
      configured: { publicUrl: PUBLIC_URL, source: "db", consentedAt: null },
      serving: { publicUrl: PUBLIC_URL },
    });
    mintForm();
    const never = screen.getByRole("button", { name: "Never" }) as HTMLButtonElement;
    expect(never.disabled).toBe(false);
    fireEvent.click(never);
    expect(never.getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Mint the key" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // MUTATION: re-introduce a module constant for the reveal-state endpoint → RED (:9191 is served,
  // and a build-time guess cannot know it).
  it("the reveal state hands over the address the gateway serves", async () => {
    M.createAgent.mockResolvedValue({ agentId: "bot", sectors: [], key: "key_x", expires_at: null });
    mintForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bot" } });
    fireEvent.click(screen.getByRole("button", { name: "Mint the key" }));
    await screen.findByText("key_x");
    expect(screen.getByText(SERVED_ENDPOINT)).toBeTruthy();
  });

  // ── §Decision 7: a failed read is never a fact about the box ──────────────────────────────────
  //
  // MUTATION: drop `exposureFailed` from MintKeyPage (revert to `exposure.data?.localEndpoint ??
  // null`) → RED. The key has just been shown ONCE and cannot be shown again; telling its holder
  // "this gateway isn't running an MCP edge" when the Console simply failed to ask is the worst
  // moment in the app to make a claim about the box.
  it("a gateway that did not answer is not reported as a gateway with no MCP edge", async () => {
    H.exposureFailed = true;
    M.createAgent.mockResolvedValue({ agentId: "bot", sectors: [], key: "key_x", expires_at: null });
    mintForm();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "bot" } });
    fireEvent.click(screen.getByRole("button", { name: "Mint the key" }));
    await screen.findByText("key_x");

    expect(screen.getByText(EXPOSURE_UNANSWERED)).toBeTruthy();
    const body = document.body.textContent ?? "";
    // Retargeted with the copy (#106: "isn't running an MCP edge" → "isn't serving MCP"). A negative
    // assertion against a string that no longer exists anywhere would pass forever and guard nothing —
    // and what this guards is the worst claim in the app to get wrong.
    expect(body).not.toMatch(/isn’t serving MCP/);
    expect(body).not.toMatch(/localhost/);
    // No endpoint Copy button either — there is no address to hand over.
    expect(screen.queryByText(SERVED_ENDPOINT)).toBeNull();
  });
});

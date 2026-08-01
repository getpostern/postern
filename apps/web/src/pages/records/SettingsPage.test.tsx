// Settings, rendered. Proves the served half is real (provider-app status, the gate's own address,
// Export, Clear-via-ConfirmBar), the still-degraded half is HONEST (a "not served" reason beside a
// drawn control, never a fabricated "On"/"2 days ago"), and — the part this file exists for now —
// that **Remote access tells the truth about what the internet can reach.**
//
// The exposure cells are the highest-stakes assertions in the Console: this panel publishes a
// gateway to the public internet. Three of them are written specifically against the shapes that
// would otherwise pass while broken, and each names the mutation that must turn it RED:
//
//   · the disclosure fixture serves NINE routes, not the real eight — a hardcoded list of eight
//     passes a test that asserts eight, which is the repo's signature defect in one line;
//   · `cleared_still_live` is asserted on its own, because a page that hides the address the moment
//     `configured` goes null tells a user they are private while a stranger is still answered;
//   · `saved_not_live` asserts the ABSENCE of a live word, because rendering `configured` as the
//     live address passes every "an address appears" assertion.

import "../../api/test-dom";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, RestError } from "../../api/client";
import { EXPOSURE_UNANSWERED } from "../../api/exposure";
import { ToastProvider } from "../../kit";
import type { BridgeRouteDescriptor, ExposureStatus } from "../../api/types";
import { SettingsPage } from "./SettingsPage";
import {
  NOT_SERVED,
  NO_MCP_ENDPOINT,
  EXPOSURE_ENV_SOURCED,
  EXPOSURE_PROBLEM,
  EXPOSURE_PROBLEM_NOT_SERVING,
  EXPOSURE_PROBLEM_WHILE_SERVING,
  EXPOSURE_SERVING_HERE,
  PUBLIC_ADDRESS_ROW_TITLE,
  PUBLIC_URL_SHAPE_NOTE,
  REACH_NOTE,
  SETUP_COMMAND_LABEL,
  SETUP_HEADING,
  SETUP_HOSTNAME,
  SETUP_HOSTNAME_CODE,
  SETUP_HOSTNAME_LABEL,
  SETUP_SILENT_PAIR,
  SETUP_WHY_443,
  SET_ADDRESS_ACTION,
  TAILSCALE_CONSOLE_MARK,
  funnelCommand,
} from "./settings";

// #118 renamed the public row's primary control ("Enable…" promised a state change its own success
// toast took back). Four cells below LOCATE that control; they now locate it by the shipped
// constant instead of a literal. Only the locators moved — every assertion in those cells is the
// U4 assertion, byte for byte. The env-sourced cell is why this is a constant and not a second
// literal: it asserts the control is ABSENT, and a literal there would have gone on passing against
// a button that no longer exists under that name. Its anti-vacuity partner is
// "the public row does not claim to control Tailscale Funnel", which asserts the SAME constant
// present in the off state — so a rename cannot leave one green without turning the other red.

const LOCAL = "http://localhost:9191/mcp"; // deliberately NOT the old baked-in :8788 constant
const LIVE_URL = "https://live.example.ts.net";
const SAVED_URL = "https://saved.example.ts.net";

/** The eight routes the real edge publishes — shape only; the counts are asserted from the fixture. */
const REAL_ROUTES: BridgeRouteDescriptor[] = [
  { path: "/.well-known/oauth-protected-resource", methods: ["GET"], auth: "open_no_user_data" },
  { path: "/.well-known/oauth-protected-resource/mcp", methods: ["GET"], auth: "open_no_user_data" },
  { path: "/.well-known/oauth-authorization-server", methods: ["GET"], auth: "open_no_user_data" },
  { path: "/authorize", methods: ["GET"], auth: "open_no_user_data" },
  { path: "/authorize", methods: ["POST"], auth: "key_login" },
  { path: "/token", methods: ["POST"], auth: "code_gated" },
  { path: "/register", methods: ["POST"], auth: "open_write" },
  { path: "/mcp", methods: ["POST", "GET", "DELETE"], auth: "bearer_gated" },
];

/**
 * `observedAtConfiguredAddress` is deliberately ABSENT from this factory (#119).
 *
 * Absent is a real wire state — a gateway older than #119 does not send the field — and it is the
 * one that must stay silent: "not served" is a fact about the wire, "nothing yet" is an answer, and
 * the whole of `api/notserved.test.ts` exists because collapsing those two is how a Console starts
 * inventing. Defaulting it to `null` here would also have flipped every published fixture into the
 * diagnosis state, drawing a second `role="list"` into two U4 cells that resolve exactly one.
 * The cells below that care about it set it explicitly, in all three of its values.
 */
function exposure(over: Partial<ExposureStatus> = {}): ExposureStatus {
  return {
    configured: null,
    serving: null,
    restartRequired: false,
    localEndpoint: LOCAL,
    publishedRoutes: REAL_ROUTES,
    problem: null,
    ...over,
  };
}

const OFF = exposure();
const LIVE = exposure({
  configured: { publicUrl: LIVE_URL, source: "db", consentedAt: "2026-07-26T00:00:00.000Z" },
  serving: { publicUrl: LIVE_URL },
});
const SAVED_NOT_LIVE = exposure({
  configured: { publicUrl: SAVED_URL, source: "db", consentedAt: "2026-07-26T00:00:00.000Z" },
  serving: null,
  restartRequired: true,
});
const CLEARED_STILL_LIVE = exposure({
  configured: null,
  serving: { publicUrl: LIVE_URL },
  restartRequired: true,
});
/** THE FIXTURE THE ORIGINAL SUITE LACKED. `problem` is a REQUEST-TIME fact about the store;
 *  `serving` is a BOOT-TIME fact about the edge. A Postgres restart under a gateway that mounted a
 *  DB-sourced bridge gives both at once — a live public edge whose setting cannot be read. All four
 *  fixtures above set `problem: null`, which is exactly why the `problem`-first ordering shipped. */
const UNREADABLE_STILL_LIVE = exposure({
  configured: null,
  serving: { publicUrl: LIVE_URL },
  restartRequired: true,
  problem: "db_unreadable",
});
/** #126's older-build case: a row this build cannot use, so the bridge never mounted. `serving` is
 *  null BECAUSE the address was refused at resolution — the two facts arrive together here, unlike
 *  the fixture above where a live edge outlives a broken store. */
const STORED_UNUSABLE = exposure({
  configured: null,
  serving: null,
  problem: "db_invalid",
});
/** What PRODUCTION runs: `MCP_PUBLIC_URL` set on the box, no DB row. This setting cannot change it. */
const ENV_PUBLISHED = exposure({
  configured: { publicUrl: LIVE_URL, source: "env", consentedAt: null },
  serving: { publicUrl: LIVE_URL },
});

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Wait for the page's slowest served row, so nothing below asserts against a loading frame. */
async function settled() {
  await screen.findAllByText("configured");
}

beforeEach(() => {
  vi.spyOn(api, "oauthAppStatus").mockResolvedValue({ configured: true, clientId: "cid", confidential: true });
  vi.spyOn(api, "plaidAppStatus").mockResolvedValue({ configured: true, clientId: "cid", env: "production" });
  vi.spyOn(api, "getExposure").mockResolvedValue(OFF);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the served half", () => {
  it("renders the four provider apps with their served status", async () => {
    renderSettings();
    expect(await screen.findByText("Microsoft")).toBeTruthy();
    for (const name of ["Google", "Whoop", "Plaid"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(await screen.findAllByText("configured")).toHaveLength(4);
  });

  // MUTATION: re-introduce a module constant for the endpoint (`const ENDPOINT = "http://localhost:8788/mcp"`)
  // and render it → RED, because the mock serves :9191 and no build-time guess can know that.
  it("the gate's address on screen came from the gateway, not from the build", async () => {
    renderSettings();
    await settled();
    expect(screen.getByText(LOCAL)).toBeTruthy();
  });

  // MUTATION: fall back to `http://localhost:8788/mcp` when `localEndpoint` is null → RED.
  // This is the state the old constant was a flat lie in: no MCP edge, and it still showed an address.
  it("a gateway with no MCP edge does not advertise an MCP address", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(exposure({ localEndpoint: null }));
    renderSettings();
    await settled();
    expect(screen.getByText(NO_MCP_ENDPOINT)).toBeTruthy();
    // Nothing anywhere on the page ends in /mcp — not a fallback, not a leaked route descriptor.
    expect(document.body.textContent ?? "").not.toMatch(/\/mcp\b/);
  });

  it("Export calls the export route", async () => {
    const exp = vi.spyOn(api, "exportBundle").mockResolvedValue({ ok: true });
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Export" }));
    await waitFor(() => expect(exp).toHaveBeenCalled());
  });

  it("Clear a provider app goes through ConfirmBar (never a browser dialog) and hits the delete route", async () => {
    const del = vi.spyOn(api, "deleteOauthApp").mockResolvedValue();
    renderSettings();
    await settled();
    const clears = screen.getAllByRole("button", { name: "Clear" });
    fireEvent.click(clears[0]);
    const confirmBtn = await screen.findByRole("button", { name: "Clear Microsoft" });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(del).toHaveBeenCalledWith("microsoft"));
  });
});

describe("Remote access — publishing this gate to the internet", () => {
  /** Open the enable flow and type an address into it. */
  async function beginPublish(url = LIVE_URL) {
    renderSettings();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: SET_ADDRESS_ACTION }));
    fireEvent.change(await screen.findByPlaceholderText("https://your-mac.tailnet.ts.net"), {
      target: { value: url },
    });
  }

  // MUTATION: call `api.setExposure` from the `Enable…` click handler → RED on the "not called"
  // assertion. Consent that is recorded AFTER the fact is not consent.
  it("publishing the gate states the three consequences before it happens", async () => {
    const set = vi.spyOn(api, "setExposure").mockResolvedValue(SAVED_NOT_LIVE);
    await beginPublish();

    expect(screen.getByText("Publish this gate to the public internet?")).toBeTruthy();
    expect(screen.getByText(/Anyone on the internet will be able to reach this address/)).toBeTruthy();
    expect(screen.getByText(/public certificate ledger/)).toBeTruthy();
    expect(screen.getByText(/only thing between a stranger and your data/)).toBeTruthy();

    // Nothing has been published yet — the bar is a gate, not a receipt.
    expect(set).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Publish this gate" }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith({ publicUrl: LIVE_URL, acknowledged: true }),
    );
  });

  // MUTATION: delete the §D9 paragraph → RED. Postern runs no `tailscale` command and holds no
  // tailnet identity; a flow that implies otherwise leaves the user stuck with a saved address and
  // no Funnel, wondering why nothing answers.
  it("Postern does not claim to do the Tailscale steps for you", async () => {
    await beginPublish();
    const note = screen.getByText(/Postern cannot do these for you/);
    expect(note.textContent).toMatch(/Tailscale account/);
    expect(note.textContent).toMatch(/MagicDNS/);
    expect(note.textContent).toMatch(/admin console/);
    expect(note.textContent).toMatch(/Funnel on 443/);
    expect(note.textContent).toMatch(/no tailnet identity of its own/);
  });

  it("the gateway's own refusal is shown verbatim, not paraphrased", async () => {
    vi.spyOn(api, "setExposure").mockRejectedValue(
      new Error("MCP_PUBLIC_URL must be https (or http on localhost)"),
    );
    await beginPublish("http://evil.example");
    fireEvent.click(screen.getByRole("button", { name: "Publish this gate" }));
    expect(
      await screen.findByText("MCP_PUBLIC_URL must be https (or http on localhost)"),
    ).toBeTruthy();
  });

  // MUTATION: delete the shape note from the panel → RED. #126: the most natural paste into this
  // field is the `/mcp` URL — the one the Gatehouse card displays — and the gateway refuses it. A
  // field that only says what it wants inside the refusal makes the user find that out by failing.
  it("the address field says what it wants before anything is pasted", async () => {
    renderSettings();
    await settled();
    // Not on the page until the field is: this is a field's instruction, not a standing warning.
    expect(screen.queryByText(PUBLIC_URL_SHAPE_NOTE)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: SET_ADDRESS_ACTION }));
    const note = await screen.findByText(PUBLIC_URL_SHAPE_NOTE);
    // It names the trap, not only the rule — "a bare origin" is not a phrase a first-time reader
    // matches against the URL in their clipboard.
    expect(note.textContent).toMatch(/\/mcp/);
  });

  // MUTATION: give `publishState`'s problem-and-not-serving branch a live word and tone
  // (`word: "published", tone: "ok"`) → RED. #126's older-build case: builds before the path rule
  // stored `https://host/mcp`, this build cannot use it, and every indicator on this page stayed
  // green through the original defect — which is the entire reason it went unnoticed in production.
  //
  // NOT "render the bridge row from `configured` instead of `serving`": both are null in this state,
  // so that swap leaves the row reading Off and this cell green. An adversarial reviewer caught that
  // claim on the first version of this comment. The mutation that reddens a cell is the only thing
  // worth writing down, and getting it wrong is how a guard comes to look stronger than it is.
  it("an address an older build stored with a path degrades this row instead of showing it green", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(STORED_UNUSABLE);
    renderSettings();
    await settled();

    // The problem is NAMED, and it carries the way out (Stop publishing clears the stored row).
    // Asserted through the shipped constants, so the wording can move without this going deaf.
    expect(
      screen.getByText(`${EXPOSURE_PROBLEM_NOT_SERVING} ${EXPOSURE_PROBLEM.db_invalid}`),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop publishing…" })).toBeTruthy();

    // And nothing on the page claims this gate is up: no live word, and the bridge row is Off.
    expect(screen.queryByText("published")).toBeNull();
    expect(screen.getByText("unavailable")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/On — published at/);

    // ANTI-VACUITY: the identical page, served a usable address, DOES show both live words. Without
    // it, a Settings page that rendered nothing at all would pass every assertion above.
    cleanup();
    vi.mocked(api.getExposure).mockResolvedValue(LIVE);
    renderSettings();
    await settled();
    expect(screen.getByText("published")).toBeTruthy();
    expect(document.body.textContent ?? "").toMatch(/On — published at/);
  });

  // MUTATION: render a hardcoded list of the eight real routes → RED, because this fixture serves
  // NINE. That is the whole point: a test that asserts "eight rows" passes against a hardcoded
  // eight, and a future bridge route would then reach the internet without ever being disclosed.
  it("a published gate lists every door a stranger can knock on", async () => {
    const ninth: BridgeRouteDescriptor = {
      path: "/introspect",
      methods: ["POST"],
      auth: "open_write",
    };
    vi.mocked(api.getExposure).mockResolvedValue(
      exposure({
        ...LIVE,
        publishedRoutes: [...REAL_ROUTES, ninth],
      }),
    );
    renderSettings();
    await settled();

    expect(screen.getByText("What a stranger can reach")).toBeTruthy();
    const list = screen.getByRole("list");
    const doors = within(list).getAllByRole("listitem");
    expect(doors).toHaveLength(9);
    // Every door carries the path it publishes AND a sentence about who can open it.
    for (const door of doors) {
      expect((door.textContent ?? "").length).toBeGreaterThan(30);
    }
    expect(within(list).getByText(/POST \/introspect/)).toBeTruthy();
    expect(
      screen.getByText(
        "Your Console, your connections and your keys are on a different port and are never published.",
      ),
    ).toBeTruthy();
  });

  // MUTATION: render `configured` as the live address (drop the saved/serving distinction) → RED,
  // because the row would then read "Published at" for an address nothing is answering.
  it("a saved address that isn't live yet says so instead of looking done", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(SAVED_NOT_LIVE);
    renderSettings();
    await settled();

    expect(screen.getByText(SAVED_URL)).toBeTruthy();
    expect(screen.getByText("Saved address")).toBeTruthy();
    expect(screen.getByText(/not published yet/)).toBeTruthy();
    expect(screen.getByText(/next time it restarts/)).toBeTruthy();

    // No live word anywhere: not the row's label, not the bridge row's.
    expect(screen.queryByText("Published at")).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/\bOn — published at\b/);
    expect(screen.getByText("Off — this edge is bearer-only.")).toBeTruthy();
  });

  // THE SAFETY-CRITICAL CELL.
  // MUTATION: hide the address as soon as `configured` is null (`state.address = configured`) → RED.
  // A user who clicked Stop publishing must never read this page as "you are private now" while the
  // process is still answering strangers.
  it("a gate you just unpublished still says it is reachable until the gateway restarts", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(CLEARED_STILL_LIVE);
    renderSettings();
    await settled();

    expect(screen.getByText(LIVE_URL)).toBeTruthy();
    expect(screen.getByText("Still serving")).toBeTruthy();
    expect(screen.getByText(/still serving this address to the internet/)).toBeTruthy();
    expect(screen.getByText(/until you restart it/)).toBeTruthy();
    // …and the bridge row agrees that it is ON, because it is.
    expect(screen.getByText(`On — published at ${LIVE_URL}`)).toBeTruthy();
  });

  // MUTATION: map `problem` onto the plain off-state (drop the branch) → RED: the reason disappears
  // and `Enable…` becomes clickable, which would write a row the gateway just failed to read.
  it("a gateway that cannot read its own setting says so rather than showing Off", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(exposure({ problem: "db_unreadable" }));
    renderSettings();
    await settled();

    const body = document.body.textContent ?? "";
    expect(body).toContain(EXPOSURE_PROBLEM.db_unreadable);
    // Nothing is mounted here, so "nothing of yours is on the internet" is a TRUE statement — and
    // this is the only shape in which it may be made.
    expect(body).toContain(EXPOSURE_PROBLEM_NOT_SERVING);
    const enable = screen.getByRole("button", { name: SET_ADDRESS_ACTION }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    expect(screen.queryByText("off")).toBeNull();
  });

  // ── THE SECOND SAFETY-CRITICAL CELL (spec §Decision 6) ────────────────────────────────────────
  //
  // MUTATION: restore the shipped ordering — move the `if (s.problem != null)` block back above the
  // `serving` test in `publishState`, i.e. one problem branch returning `address: null,
  // showDisclosure: false` → RED on every assertion below. That ordering rendered "so it is
  // publishing nothing. Nothing of yours is on the internet" two lines above the bridge row's
  // "On — published at …", with the disclosure SUPPRESSED exactly when it was true.
  it("a gateway that cannot read its setting while it is still serving says it is still reachable", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(UNREADABLE_STILL_LIVE);
    renderSettings();
    await settled();

    const body = document.body.textContent ?? "";

    // 1. The address a stranger can reach is ON SCREEN, and labelled as still being served.
    expect(screen.getByText(LIVE_URL)).toBeTruthy();
    expect(screen.getByText("Still serving")).toBeTruthy();
    expect(screen.getByText("still reachable")).toBeTruthy();

    // 2. The row states the gateway IS answering the internet…
    expect(body).toContain(EXPOSURE_PROBLEM_WHILE_SERVING);
    // …and the problem is reported as *the setting is stuck*, NEVER as "nothing is published".
    expect(body).toContain(EXPOSURE_PROBLEM.db_unreadable);
    expect(body).not.toContain(EXPOSURE_PROBLEM_NOT_SERVING);
    expect(body).not.toMatch(/publishing nothing|Nothing of yours is on the internet/);
    expect(body).not.toMatch(/Nothing is published/);

    // 3. "What a stranger can reach" is SHOWN — suppressing it here is suppressing it in the one
    //    state where it is true.
    expect(screen.getByText("What a stranger can reach")).toBeTruthy();
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(8);

    // 4. …and the bridge row, from the same object, agrees.
    expect(screen.getByText(`On — published at ${LIVE_URL}`)).toBeTruthy();
  });

  // MUTATION: give the bridge row its own state — read `configured` instead of `serving` → RED on
  // the cleared-still-live cell, where it would report Off while the edge answers the internet.
  // MUTATION (§Decision 6): restore the `problem`-first ordering in `publishState` → RED on the
  // FIFTH fixture, whose whole reason for existing is that the other four set `problem: null`.
  it("the bridge row and the publish row can never disagree", async () => {
    for (const [fixture, bridgeWord, funnelWord] of [
      [OFF, "Off — this edge is bearer-only.", "off"],
      [LIVE, `On — published at ${LIVE_URL}`, "published"],
      [SAVED_NOT_LIVE, "Off — this edge is bearer-only.", "restart to apply"],
      [CLEARED_STILL_LIVE, `On — published at ${LIVE_URL}`, "still reachable"],
      // The independent-facts fixture: the bridge row says ON, so the publish row may not say the
      // gate is unpublished. A `problem`-first `publishState` answers "unavailable" here.
      [UNREADABLE_STILL_LIVE, `On — published at ${LIVE_URL}`, "still reachable"],
    ] as const) {
      vi.mocked(api.getExposure).mockResolvedValue(fixture);
      renderSettings();
      await settled();
      expect(screen.getByText(bridgeWord), bridgeWord).toBeTruthy();
      expect(screen.getByText(funnelWord), funnelWord).toBeTruthy();
      cleanup();
    }
  });

  // ── §Decision 5: the gate published by the BOX ────────────────────────────────────────────────
  //
  // MUTATION: drop the `s.configured?.source !== "env"` overlay in `publishState` → RED. Without
  // it this exact fixture — which is what production runs — draws Stop ENABLED, the DELETE removes
  // a row that does not exist, env still wins, and the Console reports "Stopped". Nothing stopped.
  it("a gate published by the box draws Stop disabled and names the variable", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(ENV_PUBLISHED);
    renderSettings();
    await settled();

    // The control is DRAWN, in its shape, and disabled — never absent, never enabled-then-failing.
    const stop = screen.getByRole("button", { name: "Stop publishing…" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: SET_ADDRESS_ACTION })).toBeNull();

    // …and the reason names the mechanism, so the user can see WHY it is unavailable.
    const body = document.body.textContent ?? "";
    expect(body).toContain(EXPOSURE_ENV_SOURCED);
    expect(body).toMatch(/MCP_PUBLIC_URL/);
    // The row still states the truth about reachability — env-sourced is not a reason to go quiet.
    expect(screen.getByText("published")).toBeTruthy();
    expect(screen.getByText(LIVE_URL)).toBeTruthy();
  });

  // MUTATION: fire the `ok` toast outside the try (or before the `await`) → RED. A refusal reported
  // as a success is the whole of the §Decision 5 finding; the gateway now answers this DELETE with
  // a named 409 and the Console must render that refusal, not paraphrase it into "Stopped".
  it("a Stop the gateway refuses is never reported as success", async () => {
    const refusal =
      "MCP_PUBLIC_URL is set on this box, so it publishes this gateway; clearing the stored address would change nothing.";
    vi.spyOn(api, "clearExposure").mockRejectedValue(new RestError(409, refusal, { error: refusal }));
    vi.mocked(api.getExposure).mockResolvedValue(LIVE);
    renderSettings();
    await settled();

    fireEvent.click(screen.getByRole("button", { name: "Stop publishing…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop publishing" }));

    // The gateway's own words, verbatim — they name the variable and the box.
    expect(await screen.findByText(refusal)).toBeTruthy();
    // …and NOT the success sentence, in any form.
    expect(document.body.textContent ?? "").not.toMatch(/^.*Stopped — it stays reachable/);
    expect(screen.queryByText(/Stopped — it stays reachable until the gateway restarts\./)).toBeNull();
  });

  // MUTATION: revert `LocalEndpointCard` / the two Remote-access rows to `exposure.data?.x ?? null`
  // (drop `isError`) → RED: the page instructs the operator to set MCP_HTTP_PORT on a box it never
  // reached. "The gateway did not answer" and "the gateway answered: nothing" are different facts.
  it("a gateway that did not answer is never rendered as a gateway with nothing configured", async () => {
    vi.mocked(api.getExposure).mockRejectedValue(new Error("Failed to fetch"));
    renderSettings();
    await settled();
    await screen.findAllByText(EXPOSURE_UNANSWERED);

    const body = document.body.textContent ?? "";
    // Not one word about the box: no env var to set, no restart to perform, no "off".
    expect(body).not.toContain(NO_MCP_ENDPOINT);
    expect(body).not.toMatch(/MCP_HTTP_PORT/);
    expect(body).not.toMatch(/Off — this edge is bearer-only\./);
    expect(screen.queryByText("off")).toBeNull();
    // The controls are drawn and inert — nothing to publish or stop when nothing is known.
    const enable = screen.getByRole("button", { name: SET_ADDRESS_ACTION }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
  });

  it("stopping goes through a ConfirmBar that admits it is not instant", async () => {
    const clear = vi.spyOn(api, "clearExposure").mockResolvedValue(CLEARED_STILL_LIVE);
    vi.mocked(api.getExposure).mockResolvedValue(LIVE);
    renderSettings();
    await settled();

    fireEvent.click(screen.getByRole("button", { name: "Stop publishing…" }));
    expect(await screen.findByText("Stop publishing this gate?")).toBeTruthy();
    expect(screen.getByText(/stays reachable on the internet until you restart the gateway/)).toBeTruthy();
    expect(clear).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop publishing" }));
    await waitFor(() => expect(clear).toHaveBeenCalled());
  });
});

// ── #118 · the row's SUBJECT ────────────────────────────────────────────────────────────────────
//
// The operator's first question reading a freshly deployed gateway was *"what does the enable
// button do on Public: Tailscale Funnel?"* — and the honest answer is that it does nothing to
// Tailscale. It validates a URL, records consent, writes a row and asks for a restart. Postern
// issues no `tailscale` command anywhere in `src/` and holds no tailnet identity (ADR 0035 §D9), so
// a row titled after the mechanism was promising something this process cannot perform, and a
// button labelled "Enable…" was retracted by its own success toast one interaction later.
//
// These four cells hold the row to what it actually is: the address this gateway answers on, with
// Funnel named where the user acts on it and where they would otherwise assume it.
describe("Remote access — the row's subject is the address, not the mechanism (#118)", () => {
  /** Open the address flow. Separate from the block above's `beginPublish` on purpose: these cells
   *  must keep working if that helper is rewritten. */
  async function openAddressFlow(url = LIVE_URL) {
    renderSettings();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: SET_ADDRESS_ACTION }));
    fireEvent.change(await screen.findByPlaceholderText("https://your-mac.tailnet.ts.net"), {
      target: { value: url },
    });
  }

  // MUTATION: restore the shipped title `Public · Tailscale Funnel` and the bare label `Enable…`
  // → RED on all four assertions. The two negative assertions below are anti-regression and would
  // pass vacuously alone; their partners are the positive `getByText`/`getByRole` in the same cell,
  // which fail loudly if the row is retitled to anything else.
  it("the public row does not claim to control Tailscale Funnel", async () => {
    renderSettings();
    await settled();

    // What shipped, gone: a row named after a mechanism this process cannot touch, and a button
    // promising a state change it does not perform.
    expect(screen.queryByText("Public · Tailscale Funnel")).toBeNull();
    expect(screen.queryByRole("button", { name: "Enable…" })).toBeNull();

    // What replaced it: the title and the primary control both name the ADDRESS — the only part of
    // remote access Postern owns — and neither names Tailscale, which is not Postern's to run.
    const title = screen.getByText(PUBLIC_ADDRESS_ROW_TITLE);
    const control = screen.getByRole("button", { name: SET_ADDRESS_ACTION });
    for (const el of [title, control]) {
      expect(el.textContent ?? "").toMatch(/address/i);
      expect(el.textContent ?? "").not.toMatch(/tailscale|funnel/i);
    }
  });

  /**
   * The row's sub-line answers "who is this for", and it named ONE hosted client while ChatGPT was
   * already being served over this same address (witnessed 2026-08-01). Publishing to the internet
   * is the highest-stakes control in the Console; a reader deciding whether to turn it on must not
   * be told the one client they use is not among the reasons.
   *
   * MUTATION: revert the sub-line to "Where hosted clients (claude.ai) reach this gate" → RED.
   */
  it("the public row names BOTH hosted clients as who reaches this gate", async () => {
    renderSettings();
    await settled();

    const sub = screen.getByText(/Where hosted clients/);
    expect(sub.textContent).toContain("claude.ai");
    expect(sub.textContent).toContain("ChatGPT");
    // The rest of the sentence is settled copy and stays: the 443 fact and the tailnet boundary.
    expect(sub.textContent).toMatch(/port 443/);
    expect(sub.textContent).toMatch(/leaves your tailnet/);
  });

  // MUTATION: restore `Enable…` as the label → RED. The label and the message it produces are read
  // in ONE cell so that a future edit to either which re-opens the contradiction fails here, rather
  // than each staying individually defensible.
  it("the control's label is not retracted by its own success message", async () => {
    vi.spyOn(api, "setExposure").mockResolvedValue(SAVED_NOT_LIVE);
    renderSettings();
    await settled();

    const control = screen.getByRole("button", { name: SET_ADDRESS_ACTION });
    const label = control.textContent ?? "";

    fireEvent.click(control);
    fireEvent.change(await screen.findByPlaceholderText("https://your-mac.tailnet.ts.net"), {
      target: { value: LIVE_URL },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish this gate" }));
    const success = (await screen.findByText(/^Saved/)).textContent ?? "";

    // The message that lands on success still asks for a restart — so publishing has NOT happened…
    expect(success).toMatch(/restart/i);
    // …and therefore the label that led here may not have claimed that it had.
    expect(label).not.toMatch(/\benabl\w*\b|\bpublish\w*\b|\bturn on\b|\bgo live\b|\bstart\w*\b/i);
    // What the click does achieve is what both of them say: an address is recorded, and saved.
    expect(label).toMatch(/\bset\b|\bsave\b|\brecord\b/i);
    expect(success).toMatch(/^Saved\b/);
  });

  // MUTATION: move Funnel back out of the enumeration into its own trailing sentence ("…only you
  // can change. Then publish the port with Tailscale Funnel on 443.") → RED, because a full stop
  // then separates it from the prerequisites it belongs with. That shape reads as a step this flow
  // performs once the others are done, which is the misreading the whole unit exists to end.
  it("Tailscale Funnel is named as a prerequisite, beside MagicDNS and certificates", async () => {
    await openAddressFlow();
    const text = screen.getByText(/Postern cannot do these for you/).textContent ?? "";

    const head = text.indexOf("cannot do these for you");
    const funnel = text.indexOf("Funnel on 443");
    expect(head).toBeGreaterThanOrEqual(0);
    expect(funnel).toBeGreaterThan(head);

    // One sentence, four things the user does in Tailscale's console — Funnel among them, not after.
    const enumeration = text.slice(head, funnel);
    expect(enumeration).toMatch(/Tailscale account/);
    expect(enumeration).toMatch(/MagicDNS and HTTPS certificates/);
    expect(enumeration).not.toMatch(/\./);
  });

  // MUTATION 1: delete the caption from the row → RED (the first `getByText` throws).
  // MUTATION 2: render it only while the gate is off (e.g. `state?.word === "off" && …`) → RED on
  // the published fixtures. Serving an address says nothing about whether Funnel carries the
  // internet to it, so the unknowable is unchanged by this gateway's own state.
  // MUTATION 3 (found by the #118 review, and it went GREEN before this fix): move the caption onto
  // the *Tailnet · Tailscale serve* row. A page-scoped `getByText` cannot tell the two rows apart, so
  // the cell passed while asserting the opposite of its own name. Scoped to the public row now.
  it("the row states that Postern cannot tell whether Funnel is armed", async () => {
    renderSettings();
    await settled();

    const publicRow = screen.getByText(PUBLIC_ADDRESS_ROW_TITLE).closest("div")?.parentElement;
    expect(publicRow).toBeTruthy();
    const caption = within(publicRow as HTMLElement).getByText(NOT_SERVED.funnelReach);
    expect(caption.textContent ?? "").toMatch(/Funnel/);
    expect(caption.textContent ?? "").toMatch(/runs no Tailscale command/);

    // Drawn in the SAME register as the tailnet row directly above, which is degraded for exactly
    // the same reason. Inventing a second treatment for one unknowable is how a surface starts
    // teaching that some unknowns are more knowable than others.
    const tailnet = screen.getByText(NOT_SERVED.remoteAccess);
    expect(caption.className.split(" ")).toContain(tailnet.className);

    // …and it is never traded for a status word. Every exposure state keeps it, including the ones
    // where this gateway IS serving: that is a fact about this process, not about the way in.
    for (const fixture of [OFF, LIVE, SAVED_NOT_LIVE, CLEARED_STILL_LIVE] as const) {
      cleanup();
      vi.mocked(api.getExposure).mockResolvedValue(fixture);
      renderSettings();
      await settled();
      expect(screen.getByText(NOT_SERVED.funnelReach)).toBeTruthy();
    }
  });
});

// ── #119 · the instructions, and #120 · the contradiction ───────────────────────────────────────
//
// Two defects that meet on one row.
//
// #120: the row disclaimed knowing whether Funnel is open, and then — about thirty words later —
// asserted *"Reachable from the public internet at this address right now."* The second is exactly
// the claim the first disclaims, and it was the confident one. Postern holds three claims of three
// different standings and may never trade one for another: **fact** (this process is answering on
// this address — `mountedBridgeConfig()`), **evidence** (something has reached us here — the
// `Host` of requests the public edge served, dated by the process), and **unknowable** (the
// internet can get to this address — Funnel's business, ADR 0035 §D9). The third is now asserted
// nowhere.
//
// #119: a first-time user met a text field with no path to filling it. The address they must type
// does not exist until five things are true in Tailscale, and two of those fail SILENTLY — which is
// why exactly two carry a mark, and why marking all five would destroy the distinction.
//
// The negative is designed as the valuable case (spec §Decision 4): *nothing has reached this
// address* is the only place in this product a user learns that their Funnel is not carrying
// anything, and #47 is the debugging session that cost.
describe("Remote access — what is known, what is evidenced, and what is not claimed (#119, #120)", () => {
  /**
   * The routing claim, in **both** shapes this panel has worn — the published row's *"Reachable
   * from the public internet at this address right now"* and the problem row's *"answering the
   * internet at this address"*. Written as one pattern because it is one law: no sentence here may
   * say a stranger can get to this gate. Postern cannot know that, and both shapes were sitting
   * within a screen of the row's own admission that it cannot.
   */
  const CLAIMS_ROUTING = /reachable from the public internet|answering the internet/i;

  /** The three values of the served field, on an otherwise ordinary published gate. */
  const LIVE_REACHED = exposure({ ...LIVE, observedAtConfiguredAddress: true });
  const LIVE_ELSEWHERE = exposure({ ...LIVE, observedAtConfiguredAddress: false });
  const LIVE_UNREACHED = exposure({ ...LIVE, observedAtConfiguredAddress: null });

  async function openAddressFlow(fixture: ExposureStatus = OFF) {
    vi.mocked(api.getExposure).mockResolvedValue(fixture);
    renderSettings();
    await settled();
    fireEvent.click(screen.getByRole("button", { name: SET_ADDRESS_ACTION }));
    await screen.findByPlaceholderText("https://your-mac.tailnet.ts.net");
  }

  // MUTATION: restore the shipped sentence — `sentence: "Reachable from the public internet at this
  // address right now."` in `publishState`'s published branch → RED three times over (the negative
  // scan, the property assertion on the rendered sentence, and the loop). The two positive
  // assertions are the anti-vacuity partners: a `publishState` that returned no sentence at all,
  // which would pass every `not.toMatch` here, fails them.
  it("a published gate says it is answering, and does not claim the internet can reach it", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(LIVE);
    renderSettings();
    await settled();

    // What it DOES say: a fact about this process, sourced from what it mounted at boot.
    const sentence = screen.getByText(EXPOSURE_SERVING_HERE);
    expect(sentence.textContent ?? "").toMatch(/answering/i);
    // …and what it may not: the routing claim, in either of the two forms this row has worn.
    expect(sentence.textContent ?? "").not.toMatch(/\breachable\b|\bthe internet\b/i);

    // The disclaimer it used to contradict is still on the row, thirty words away and now agreeing.
    expect(screen.getByText(NOT_SERVED.funnelReach)).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(CLAIMS_ROUTING);
  });

  // The same law across every state in which this gateway is actually serving — including the two
  // U4 fixtures whose sentences must stay ALARMING. Dropping the routing claim may not quiet them.
  it("no state that is serving promises a stranger can get here", async () => {
    for (const fixture of [
      LIVE,
      LIVE_REACHED,
      LIVE_UNREACHED,
      ENV_PUBLISHED,
      CLEARED_STILL_LIVE,
      UNREADABLE_STILL_LIVE,
    ] as const) {
      vi.mocked(api.getExposure).mockResolvedValue(fixture);
      renderSettings();
      await settled();
      const body = document.body.textContent ?? "";
      expect(body).not.toMatch(CLAIMS_ROUTING);
      // …and every one of them still shows the address a stranger would use, and says the gate is
      // answering. Going quiet is not a way to pass this test.
      expect(screen.getByText(LIVE_URL)).toBeTruthy();
      expect(body).toMatch(/answering/i);
      cleanup();
    }
  });

  // MUTATION 1: collapse `null` into `unknown` in `reachEvidence` (render nothing when nothing has
  // arrived) → RED on the first assertion. That is the state the whole feature exists for.
  // MUTATION 2: drop `showSetup`'s `nothing_yet` arm → RED on the remedy assertion: the diagnosis
  // would then name three suspects and offer no way to check any of them.
  it("nothing-has-reached-this-address reads as a diagnosis, not a failure", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(LIVE_UNREACHED);
    renderSettings();
    await settled();

    const note = screen.getByText(REACH_NOTE.nothing_yet!);
    // It points UPSTREAM of Postern and names what to look at — the thing a user staring at
    // claude.ai's "couldn't reach" cannot learn from us any other way.
    expect(note.textContent ?? "").toMatch(/upstream/i);
    expect(note.textContent ?? "").toMatch(/Funnel/);
    // …it admits its own blind spot rather than crying wolf at a gateway that just restarted…
    expect(note.textContent ?? "").toMatch(/just restarted/i);
    // …it is not dressed as a failure of the gate…
    expect(note.textContent ?? "").not.toMatch(/\berror\b|\bfailed\b|\bbroken\b/i);
    // …the gate itself is still reported as working, because it is…
    expect(screen.getByText("published")).toBeTruthy();
    expect(screen.getByText(LIVE_URL)).toBeTruthy();
    // …and the remedy travels with the diagnosis.
    expect(screen.getByText(SETUP_HEADING)).toBeTruthy();
  });

  // THE ANTI-VACUITY PARTNER for the cell above: a Console that rendered the negative note
  // unconditionally — the cheapest way to pass "nothing has reached this address" — fails here.
  // MUTATION: render `REACH_NOTE.nothing_yet` regardless of the served value → RED.
  it("evidence that traffic IS arriving is stated as evidence, and stops the instructions", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(LIVE_REACHED);
    renderSettings();
    await settled();

    const note = screen.getByText(REACH_NOTE.reached_here!);
    // Evidence, and dated by the process — an in-memory record that empties at every restart, said
    // out loud so nobody reads it as a standing guarantee.
    expect(note.textContent ?? "").toMatch(/since it started/i);
    expect(note.textContent ?? "").toMatch(/starts empty again after a restart/i);
    // It does not graduate into the unknowable claim just because something arrived once.
    expect(note.textContent ?? "").not.toMatch(/\breachable\b|\bcan reach\b/i);

    expect(screen.queryByText(REACH_NOTE.nothing_yet!)).toBeNull();
    // A working gate does not carry a permanent wall of setup on its row (ADR 0035 §D2).
    expect(screen.queryByText(SETUP_HEADING)).toBeNull();
  });

  // MUTATION: fold `false` into `nothing_yet` → RED. "Something is arriving under a different name"
  // and "nothing is arriving at all" have different remedies, and the first one is the one a
  // mistyped hostname produces.
  it("traffic arriving under a different name is its own diagnosis", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(LIVE_ELSEWHERE);
    renderSettings();
    await settled();

    const note = screen.getByText(REACH_NOTE.reached_elsewhere!);
    expect(note.textContent ?? "").toMatch(/different name/i);
    expect(screen.queryByText(REACH_NOTE.nothing_yet!)).toBeNull();
    expect(screen.queryByText(REACH_NOTE.reached_here!)).toBeNull();
    // It is a hostname mismatch, so the instructions — which say where the hostname comes from —
    // come with it.
    expect(screen.getByText(SETUP_HEADING)).toBeTruthy();
  });

  // MUTATION: treat a missing field as `null` (`s.observedAtConfiguredAddress ?? null`) → RED. A
  // gateway that does not report this must never be rendered as one reporting "nothing arrived":
  // "not served" is a fact about the wire, "nothing yet" is an answer (`api/notserved.test.ts`),
  // and this row's negative is loud enough that inventing it would send a user to fix a Funnel
  // that is fine.
  it("a gateway that does not report what reached it says nothing, not 'nothing arrived'", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(LIVE); // the field is absent from this fixture
    renderSettings();
    await settled();

    for (const note of [REACH_NOTE.nothing_yet!, REACH_NOTE.reached_here!, REACH_NOTE.reached_elsewhere!]) {
      expect(screen.queryByText(note)).toBeNull();
    }
    expect(screen.queryByText(SETUP_HEADING)).toBeNull();
    // …and the rest of the row is unaffected, so silence here is silence about ONE fact.
    expect(screen.getByText("published")).toBeTruthy();
    expect(screen.getByText(EXPOSURE_SERVING_HERE)).toBeTruthy();
  });

  // MUTATION 1: mark all five steps (`inTailscaleConsole: true` throughout) → RED on the count. The
  // mark means "nothing will tell you if this is wrong", not "Tailscale owns it" — MagicDNS and the
  // certificates fail SILENTLY, while `tailscale funnel` refuses out loud and hands you the link.
  // Flattening that is deleting the only thing the mark is carrying.
  // MUTATION 2: drop any one step from `TAILSCALE_SETUP_STEPS` → RED on the length and on that
  // step's own assertion; the five are asserted by content, in order, not against the source list.
  it("the five prerequisites are named, and the two that live in Tailscale's console are marked as such", async () => {
    await openAddressFlow();

    const list = screen.getByRole("list", { name: SETUP_HEADING });
    const steps = within(list).getAllByRole("listitem");
    expect(steps).toHaveLength(5);

    const text = steps.map((s) => s.textContent ?? "");
    expect(text[0]).toMatch(/Tailscale account/);
    expect(text[1]).toMatch(/tailscale up/);
    expect(text[2]).toMatch(/MagicDNS/);
    expect(text[3]).toMatch(/HTTPS certificates/);
    expect(text[4]).toMatch(/funnel node attribute/);

    // Exactly two carry the mark, and they are the two tailnet-wide switches.
    const marked = steps.filter((s) => within(s).queryByText(TAILSCALE_CONSOLE_MARK) != null);
    expect(marked).toHaveLength(2);
    expect(marked[0].textContent ?? "").toMatch(/MagicDNS/);
    expect(marked[1].textContent ?? "").toMatch(/HTTPS certificates/);

    // …and the mark is EARNED on the page, not just drawn: the reason those two and not all five.
    const why = screen.getByText(SETUP_SILENT_PAIR).textContent ?? "";
    expect(why).toMatch(/never answers/i);
    expect(why).toMatch(/refuses out loud/i);
  });

  // MUTATION: hardcode a port in `funnelCommand` (say `:8788`, the historical one) → RED, because
  // this fixture's gateway reports `:9191`. Pointing Funnel at the wrong port is not a typo; it is
  // publishing a different server to the internet.
  it("the address field is no longer a dead end: the hostname, the command, and why 443", async () => {
    await openAddressFlow();

    // Where the hostname comes from — a command and a shape, never anyone's real machine.
    expect(screen.getByText(SETUP_HOSTNAME_LABEL)).toBeTruthy();
    expect(screen.getByText(SETUP_HOSTNAME_CODE)).toBeTruthy();
    expect(screen.getByText(SETUP_HOSTNAME).textContent ?? "").toMatch(/your-mac\.tailnet\.ts\.net/);

    // The one command, aimed at the port this gateway actually reported.
    expect(screen.getByText(SETUP_COMMAND_LABEL)).toBeTruthy();
    const command = screen.getByText(funnelCommand("9191")).textContent ?? "";
    expect(command).toMatch(/--https=443/);
    expect(command).toMatch(/127\.0\.0\.1:9191/);
    expect(command).toMatch(/--bg/);

    // Why 443 — BOTH halves, because either alone leaves two plausible ports on the table.
    const why = screen.getByText(SETUP_WHY_443).textContent ?? "";
    expect(why).toMatch(/8443/);
    expect(why).toMatch(/10000/);
    expect(why).toMatch(/443 only/);
  });

  // MUTATION: fall back to a literal port when `localEndpoint` is null → RED. A command a user
  // pastes must be right or visibly incomplete, never confidently approximate.
  it("a gateway that reports no MCP endpoint prints a placeholder, not a plausible port", async () => {
    await openAddressFlow(exposure({ localEndpoint: null }));
    const command = screen.getByText(funnelCommand(null)).textContent ?? "";
    expect(command).not.toMatch(/127\.0\.0\.1:\d/);
    expect(command).toMatch(/MCP edge/);
  });
});

describe("the degraded half is honest (drawn shape + a reason, never fabricated status) — and what is not drawn at all", () => {
  it("Apple Health ingest and backup still say why they aren't served, and tailnet-serve still does", async () => {
    renderSettings();
    await settled();
    expect(screen.getByText(new RegExp(NOT_SERVED.appleHealthIngest.slice(0, 20)))).toBeTruthy();
    // Exactly ONE row keeps this caption now: tailnet serve. The Funnel and bridge rows are served.
    expect(screen.getAllByText(NOT_SERVED.remoteAccess)).toHaveLength(1);
  });

  it("with exposure off, nothing on the page claims a public address", async () => {
    renderSettings();
    await settled();
    // The Funnel row reads plainly "off", the bridge row "Off — …", and no https address exists.
    expect(screen.getByText("off")).toBeTruthy();
    expect(screen.getByText("Off — this edge is bearer-only.")).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/https:\/\//);
    expect(screen.queryByText("What a stranger can reach")).toBeNull();
    // Back up is still genuinely unserved and still disabled.
    const backup = screen.getByRole("button", { name: "Back up" }) as HTMLButtonElement;
    expect(backup.disabled).toBe(true);
  });

  it("offers no appearance control", async () => {
    // Not a degraded row — a deleted one (§17.0). No night variant has ever been designed (all 47
    // artboards are light), so this was never an unserved VALUE the way backup age is; it was a
    // control for a mode that does not exist. Live, it invites an implementer to invent night by
    // inversion, which soul.md forbids. Disabled, it advertises the mode to the user and leaves an
    // `aria-pressed` toggle a screen reader announces as pressable when nothing can press it.
    renderSettings();
    await settled();
    expect(screen.queryByText("Appearance")).toBeNull();
    for (const name of ["Light", "Night", "System"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("Erase routes to the separate confirm page (not an inline destructive action)", async () => {
    renderSettings();
    const erase = (await screen.findByRole("link", { name: "Erase…" })) as HTMLAnchorElement;
    expect(erase.getAttribute("href")).toBe("/settings/erase");
    const edits = screen.getAllByRole("link", { name: "Edit" });
    expect((edits[0] as HTMLAnchorElement).getAttribute("href")).toBe("/connect/microsoft");
  });
});

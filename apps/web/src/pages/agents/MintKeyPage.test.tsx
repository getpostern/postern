// MintKeyPage — the reveal-once screen hands over the COMPLETE connect config (#139).
//
// What these cells are for: the mint-success screen used to render the key, the sectors and the
// endpoint as three separate copyables and then point away — "Connect an agent, on the register,
// has the config to paste" — at a recipe that is keyless BY DESIGN. So the person holding a
// shown-once secret had to stash it, navigate elsewhere, copy a block with a `<your-agent-key>`
// placeholder in it, and splice the key in by hand, at the moment of highest intent.
//
// Every assertion below is against a key and an address that are only knowable at RUNTIME:
//
//   · `MINTED_KEY` comes back from the mocked mint call, so a block built with any literal bearer —
//     the placeholder included — fails the deep-equal.
//   · `SERVED_ENDPOINT` is on a deliberately non-default port, so no build-time constant can
//     accidentally agree with it. This is the same guard `ConnectRecipes.test.tsx` uses, for the
//     same reason: the MCP edge is a separate server with no fixed offset from the REST origin.
//
// Mutation-verified against the real component (transcript in the unit's merge report): swapping the
// key for a literal → RED on the bearer; swapping the endpoint for a hardcoded URL → RED on the url.

import "../../api/test-dom"; // installs a jsdom global BEFORE React/testing-library load

import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExposureStatus } from "../../api/types";

// `exposure` undefined = the query is still pending; `exposureFailed` is the THIRD state and is a
// separate flag rather than "data is undefined", because that collapse is exactly what §Decision 7
// forbids: `useQuery` reports `data: undefined` while pending AND on error.
const H = vi.hoisted(() => ({
  exposure: undefined as ExposureStatus | undefined,
  exposureFailed: false,
}));
vi.mock("../../api/hooks", () => ({
  useInvalidateAgents: () => () => {},
  useExposure: () => ({
    data: H.exposureFailed ? undefined : H.exposure,
    isPending: !H.exposureFailed && H.exposure === undefined,
    isLoading: !H.exposureFailed && H.exposure === undefined,
    isError: H.exposureFailed,
    error: H.exposureFailed ? new Error("Failed to fetch") : null,
  }),
}));

const M = vi.hoisted(() => ({ createAgent: vi.fn(), listActions: vi.fn() }));
vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, api: { ...actual.api, ...M } };
});

import { NotServedError } from "../../api/client";
import { EXPOSURE_UNANSWERED } from "../../api/exposure";
import { ToastProvider } from "../../kit";
import { MintKeyPage } from "./MintKeyPage";
import { AGENT_KEY_PLACEHOLDER, remoteConfigJson } from "./ConnectRecipes";

/** What the GATEWAY reports as its own MCP address — a non-default port on purpose. */
const SERVED_ENDPOINT = "http://localhost:9191/mcp";
/** What the mint call hands back. Only the running component can know it. */
const MINTED_KEY = "key_live_7Qx2f9Zr";

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

const writeText = vi.fn((_text: string) => Promise.resolve());

function ui(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/agents/new"]}>
          <Routes>
            <Route path="/agents/new" element={node} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

/** Mint a key and land on the reveal-once state. */
async function mintAndReveal() {
  ui(<MintKeyPage />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "postern-qm" } });
  fireEvent.click(screen.getByRole("button", { name: "Mint the key" }));
  await screen.findByText(MINTED_KEY);
}

/** Click a Copy button and let the clipboard promise's toast settle — otherwise React logs an
 *  un-acted state update from a microtask that lands after the test body has finished. */
async function clickCopy(btn: HTMLElement) {
  await act(async () => {
    fireEvent.click(btn);
  });
}

/** The block as it appears on screen — the `<pre><code>` inside the endpoint card. */
function renderedConfig(): string | null {
  const block = document.querySelector("pre code");
  return block ? (block.textContent ?? "") : null;
}

beforeEach(() => {
  H.exposure = exposure();
  H.exposureFailed = false;
  writeText.mockClear();
  M.createAgent.mockReset();
  M.createAgent.mockResolvedValue({
    agentId: "postern-qm",
    sectors: ["finance"],
    key: MINTED_KEY,
    expires_at: null,
  });
  M.listActions.mockReset();
  // ReadActNote calls listActions("home") from the mint FORM; not served here, and irrelevant to
  // the reveal state — but an unmocked rejection would noise the run.
  M.listActions.mockRejectedValue(new NotServedError("no_route", "not served"));
  // jsdom ships no clipboard; the component's optional chain would otherwise no-op silently and
  // every "what did Copy write" assertion below would be vacuous.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MintKeyPage reveal-once — the complete connect config (#139)", () => {
  /**
   * THE WITNESS. Deep-equal against a config assembled from the two runtime values, so it fails on
   * either substitution independently:
   *
   *   MUTATION A — `remoteConfigJson(localEndpoint, minted.key)` → a literal bearer (the
   *   `<your-agent-key>` placeholder, or any string): RED on `headers.Authorization`.
   *   MUTATION B — the endpoint argument → a hardcoded URL: RED on `url`.
   *
   * A `toContain` here would be a test that cannot fail — an extra key, a resurrected
   * `transport: "streamable-http"`, or a dropped `headers` would all sail through it.
   */
  it("the copied block is the complete mcpServers object, carrying THIS key and the SERVED address", async () => {
    await mintAndReveal();

    await clickCopy(screen.getByRole("button", { name: /Copy config/i }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0];
    const cfg = JSON.parse(copied);

    expect(Object.keys(cfg)).toEqual(["mcpServers"]);
    expect(Object.keys(cfg.mcpServers)).toEqual(["postern"]);
    expect(cfg.mcpServers.postern).toEqual({
      type: "http",
      url: SERVED_ENDPOINT,
      headers: { Authorization: `Bearer ${MINTED_KEY}` },
    });
    // Nothing left to splice in: the placeholder must be nowhere on this screen.
    expect(copied).not.toContain(AGENT_KEY_PLACEHOLDER);
    expect(document.body.textContent ?? "").not.toContain(AGENT_KEY_PLACEHOLDER);
  });

  /** The classic split — the tested value is not the rendered one, so the Copy button lies.
   *  MUTATION: stringify a second time for the clipboard → RED. */
  it("what the screen shows is exactly what Copy writes", async () => {
    await mintAndReveal();

    const shown = renderedConfig();
    expect(shown).toBe(remoteConfigJson(SERVED_ENDPOINT, MINTED_KEY));

    await clickCopy(screen.getByRole("button", { name: /Copy config/i }));
    expect(writeText).toHaveBeenCalledWith(shown);
  });

  /** One derivation, two surfaces: this block IS the register's block with the bearer filled in.
   *  MUTATION: hand-roll a second JSON shape in MintKeyPage (the #111 defect) → RED the moment the
   *  two shapes differ by so much as a key order or an indent. */
  it("is the register's block with the key filled in — not a second, drifting shape", async () => {
    await mintAndReveal();

    const keyless = remoteConfigJson(SERVED_ENDPOINT);
    const mine = renderedConfig() ?? "";
    expect(mine).toBe(keyless.replace(AGENT_KEY_PLACEHOLDER, MINTED_KEY));
    // …and the register's own output is untouched by the parameterization.
    expect(keyless).toContain(`Bearer ${AGENT_KEY_PLACEHOLDER}`);
  });

  /** The endpoint on screen is the gateway's, and the address is still separately copyable — the
   *  hosted-client path pastes a bare URL, not a config file.
   *  MUTATION: re-introduce a module constant for the endpoint → RED (:9191 is served, and no
   *  build-time guess can know it). */
  it("still hands over the served address on its own, for the paths that take a URL", async () => {
    await mintAndReveal();

    expect(screen.getByText(SERVED_ENDPOINT)).toBeTruthy();
    // Two bare "Copy" buttons in DOM order: the key card's, then the endpoint's. The length
    // assertion is the point — it fails loudly if a third appears rather than silently clicking the
    // wrong one, which is how an index-addressed test starts asserting nothing.
    const copies = screen.getAllByRole("button", { name: "Copy" });
    expect(copies).toHaveLength(2);
    await clickCopy(copies[1]);
    expect(writeText).toHaveBeenCalledWith(SERVED_ENDPOINT);
  });

  /** The pointing-away caption is gone, and nothing replaced it with another errand.
   *  MUTATION: restore the caption → RED. */
  it("does not send the holder of a shown-once key somewhere else for the config", async () => {
    await mintAndReveal();
    const body = document.body.textContent ?? "";

    expect(body).not.toMatch(/Connect an agent, on the register, has the config to paste/);
    expect(body).not.toMatch(/Add this URL and this key to your agent/);
    // What it says instead is where to put the block, not where to go find one.
    expect(body).toMatch(/Paste the whole object into your agent's MCP config/);
  });

  /** A gateway with no MCP edge offers no block rather than a guessed one: a pasteable config with
   *  an invented URL in it is worse than none, because it looks right and silently does not work.
   *  MUTATION: fall back to a literal address when `localEndpoint` is null → RED. */
  it("a gateway serving no MCP edge offers no config at all", async () => {
    H.exposure = exposure({ localEndpoint: null });
    await mintAndReveal();

    expect(screen.getByText(/isn’t serving MCP yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy config/i })).toBeNull();
    expect(renderedConfig()).toBeNull();
    // The key is still shown — the mint succeeded; only the address is missing.
    expect(screen.getByText(MINTED_KEY)).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/localhost/);
  });

  /**
   * §Decision 7, on the screen where it matters most: the key has just been shown ONCE and cannot be
   * shown again, so telling its holder "this gateway isn't serving MCP" — an instruction to go change
   * a box — when the Console merely failed to ask is the worst claim in the app to get wrong.
   * MUTATION: collapse the two absences (`exposure.data?.localEndpoint ?? null`) → RED.
   */
  it("a gateway that did not answer is not reported as a gateway with no MCP edge", async () => {
    H.exposureFailed = true;
    await mintAndReveal();

    expect(screen.getByText(EXPOSURE_UNANSWERED)).toBeTruthy();
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/isn’t serving MCP/);
    expect(body).not.toMatch(/MCP_HTTP_PORT/);
    expect(screen.queryByRole("button", { name: /Copy config/i })).toBeNull();
    expect(renderedConfig()).toBeNull();
  });

  /** Pending is neither absence: a <Skeleton>, never a fallback address and never a block built on
   *  one. MUTATION: treat pending as "no endpoint" → RED on the sentence appearing while loading. */
  it("says nothing about the gate while the exposure read is still in flight", async () => {
    H.exposure = undefined;
    await mintAndReveal();

    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/isn’t serving MCP/);
    expect(body).not.toMatch(EXPOSURE_UNANSWERED);
    expect(renderedConfig()).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy config/i })).toBeNull();
  });
});

describe("the shown-once key has to survive the trip to a hosted client", () => {
  /**
   * THE KEEP-THE-KEY WITNESS, on the screen where the key exists.
   *
   * "Copy the key now" was never enough. The hosted sign-in asks for this key at a LATER step, in
   * another app, after the connect page's own Copy button has replaced it on the clipboard — the
   * operator hit exactly that on 2026-08-01, pasted the URL into the key box, and was told "That
   * agent key was not accepted". The key cannot be re-shown, so the fix is a sentence, here.
   *
   * MUTATION: revert the sub to "Copy the key now — it is shown once. Postern keeps only a hash of
   * it; …" → RED on all three assertions below.
   */
  it("says to KEEP the key, not just to copy it, and says who will ask for it", async () => {
    await mintAndReveal();
    const body = document.body.textContent ?? "";

    // Somewhere to put it, not just an action to take…
    expect(body).toMatch(/keep it somewhere safe/);
    // …the reason, so it is followable rather than superstition…
    expect(body).toMatch(/will ask for it later/);
    // …and the screen's existing shown-once register is intact, not replaced.
    expect(body).toMatch(/it is shown once/);
  });

  /**
   * The pointer off this screen is the OTHER claude.ai-only site the spec names: a ChatGPT user
   * holding a fresh key was told the hosted path belonged to someone else.
   *
   * MUTATION: revert the link to "Connect a hosted client (claude.ai) →" → RED.
   */
  it("points at the hosted walkthrough for BOTH clients", async () => {
    await mintAndReveal();
    const link = screen.getByRole("link", { name: /Connect a hosted client/ });

    expect(link.getAttribute("href")).toBe("/agents/connect/hosted");
    expect(link.textContent).toContain("claude.ai");
    expect(link.textContent).toContain("ChatGPT");
  });
});

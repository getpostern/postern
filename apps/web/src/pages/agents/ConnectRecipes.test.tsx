// ConnectRecipes — #101 item 1 and item 2: the remote block must be a COMPLETE, pasteable
// `mcpServers` config object, and the stdio column must state its unavailability instead of showing
// a dead `transport: stdio` tag.
//
// Two of these are mutation-proven by hand (see docs/specs/notes/connect-an-agent.md): EX-R2 goes
// red on the pre-#101 shape, EX-R3 goes red the moment the rendered text and the copied text stop
// being the same call.

import "../../api/test-dom"; // installs a jsdom global BEFORE React/testing-library load

import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../api/client";
import { EXPOSURE_UNANSWERED } from "../../api/exposure";
import type { ExposureStatus } from "../../api/types";
import { ToastProvider } from "../../kit";
import { ConnectRecipes, remoteConfigJson } from "./ConnectRecipes";

/** An endpoint that is NOT the shipped loopback default — so a hardcoded default fails. */
const U = "https://gate.example.ts.net/mcp";
/** What the GATEWAY reports as its own MCP address. Deliberately a non-default port, so a
 *  re-introduced build-time constant cannot accidentally agree with it. */
const SERVED = "http://localhost:9191/mcp";
/** The hosted column's label AND its accessible name — one literal, because they are the same string
 *  in the component and drifting them apart is the defect. A literal, not an import: importing it
 *  would make every cell below agree with whatever the component happens to say. */
const HOSTED_COLUMN = "Hosted · claude.ai, ChatGPT";

function exposure(over: Partial<ExposureStatus> = {}): ExposureStatus {
  return {
    configured: null,
    serving: null,
    restartRequired: false,
    localEndpoint: SERVED,
    publishedRoutes: [],
    problem: null,
    ...over,
  };
}

const writeText = vi.fn(() => Promise.resolve());

function ui(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  writeText.mockClear();
  vi.spyOn(api, "getExposure").mockResolvedValue(exposure());
  // jsdom ships no clipboard; the component's optional chain would otherwise no-op silently.
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConnectRecipes — the pasteable remote recipe (#101)", () => {
  // EX-R1 — catches a component that ignores its input, and a default that stopped reading the
  // gateway. MUTATION: revert the default to a module constant → the second half goes RED, because
  // the served address is :9191 and no build-time guess can know that.
  it("renders the endpoint it was given, not a hardcoded localhost", async () => {
    const { unmount } = ui(<ConnectRecipes endpoint={U} />);

    expect(screen.getByText("MCP endpoint")).toBeTruthy();
    expect(screen.getByText(U)).toBeTruthy(); // the endpoint card carries exactly the given URL
    const remote = screen.getByRole("region", { name: "Remote · bearer" });
    expect(remote.querySelector("pre code")?.textContent).toContain(U);
    expect(screen.queryByText("http://localhost:8788/mcp")).toBeNull();

    unmount();

    // …and with no prop the address is the one the GATEWAY reports — in the card AND in the recipe.
    ui(<ConnectRecipes />);
    expect(await screen.findByText(SERVED)).toBeTruthy();
    const served = screen.getByRole("region", { name: "Remote · bearer" });
    expect(served.querySelector("pre code")?.textContent).toContain(SERVED);
  });

  // MUTATION: copy a different string than the one rendered (or revert the default to a constant)
  // → RED. What is handed over must be what the gateway serves, byte for byte.
  it("the recipe hands over the address this gateway serves", async () => {
    ui(<ConnectRecipes />);
    await screen.findByText(SERVED);

    const expected = remoteConfigJson(SERVED);
    const remote = screen.getByRole("region", { name: "Remote · bearer" });
    expect(remote.querySelector("pre code")?.textContent).toBe(expected);

    fireEvent.click(screen.getByRole("button", { name: /keyless/i }));
    expect(writeText).toHaveBeenCalledWith(expected);
  });

  // MUTATION: fall back to a literal address when `localEndpoint` is null → RED. A pasteable config
  // carrying a guessed URL is worse than none: it looks right and silently does not work.
  it("a gateway with no MCP edge offers no recipe rather than a guessed one", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(exposure({ localEndpoint: null }));
    ui(<ConnectRecipes />);

    expect(await screen.findAllByText(/isn’t serving MCP/)).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.queryByRole("button", { name: /keyless/i })).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/localhost/);
  });

  // ── §Decision 7: a failed read is never a fact about the box ──────────────────────────────────
  //
  // MUTATION: drop the `failed` branch (revert to `exposure.data?.localEndpoint ?? null`) → RED.
  // On an error `data` is undefined, so this component printed "Set MCP_HTTP_PORT on the box and
  // restart it" — TWICE, once per column — in response to a request that never reached the box.
  it("a gateway that did not answer is not reported as a gateway with no MCP edge", async () => {
    vi.mocked(api.getExposure).mockRejectedValue(new Error("Failed to fetch"));
    ui(<ConnectRecipes />);

    expect(await screen.findAllByText(EXPOSURE_UNANSWERED)).not.toHaveLength(0);
    const body = document.body.textContent ?? "";
    // Retargeted with the copy (#106: "isn't running an MCP edge" → "isn't serving MCP"). A negative
    // assertion against a phrase no longer in the app passes forever and guards nothing.
    expect(body).not.toMatch(/isn’t serving MCP/);
    expect(body).not.toMatch(/MCP_HTTP_PORT/);
    // No recipe either — a pasteable config with no URL in it is not a recipe.
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(screen.queryByRole("button", { name: /keyless/i })).toBeNull();
  });

  // EX-R2 — the reported defect verbatim (no wrapper, no server name), a resurrected
  // `transport: "streamable-http"`, a dropped `headers`, or an extra stray key. Deep-equal, never a
  // `toContain`: a non-emptiness assertion here would be a test that cannot fail.
  it("the remote recipe is a complete mcpServers config object — wrapper, server name, http type, url, bearer header", () => {
    const cfg = JSON.parse(remoteConfigJson(U));

    expect(Object.keys(cfg)).toEqual(["mcpServers"]);
    expect(Object.keys(cfg.mcpServers)).toEqual(["postern"]);
    expect(cfg.mcpServers.postern).toEqual({
      type: "http",
      url: U,
      headers: { Authorization: "Bearer <your-agent-key>" },
    });
  });

  // EX-R3 — the classic split where the tested pure function is not the rendered/copied text.
  it("what the page shows is exactly what the Copy button writes", () => {
    ui(<ConnectRecipes endpoint={U} />);
    const expected = remoteConfigJson(U);

    const remote = screen.getByRole("region", { name: "Remote · bearer" });
    expect(remote.querySelector("pre code")?.textContent).toBe(expected);

    fireEvent.click(screen.getByRole("button", { name: /keyless/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(expected);
  });

  // EX-R4 — catches any future "helpfully" injecting a minted key into the recipe.
  it("the recipe carries a placeholder key and never a real one", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    ui(<ConnectRecipes endpoint={U} />);

    const json = remoteConfigJson(U);
    expect(json).toContain("Bearer <your-agent-key>");
    expect(json.match(/Bearer /g)).toHaveLength(1);
    // Viewing "how to connect" must never require minting — so it must never call the gateway.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // EX-R5 — catches a fabricated `docker compose exec …` recipe, or the dead tag coming back.
  it("the stdio column offers no command and routes to the remote recipe", () => {
    ui(<ConnectRecipes endpoint={U} />);
    const local = screen.getByRole("region", { name: "Local · stdio" });

    expect(within(local).queryByRole("button")).toBeNull();
    expect(local.textContent).toMatch(/Remote · bearer/);
    expect(local.textContent).not.toMatch(/docker|npx|npm |command|transport: stdio/);
  });

  // EX-R6 — catches deleting the constraint from the choice point, leaving it only on the next page.
  it("names the 443 constraint in the hosted column, where the target is chosen", () => {
    ui(<ConnectRecipes endpoint={U} />);
    const hosted = screen.getByRole("region", { name: HOSTED_COLUMN });

    expect(hosted.textContent).toMatch(/port 443/);
    expect(within(hosted).getByRole("link", { name: /Set up the bridge/ })).toBeTruthy();
  });

  /**
   * EX-R8 — the register is where a reader CHOOSES a target, and a column labelled with one vendor
   * tells a ChatGPT user that none of the three is theirs. ChatGPT was witnessed on this same bridge
   * 2026-08-01.
   *
   * MUTATION: revert the label to "Hosted · claude.ai" → RED twice — `getByRole` cannot find the
   * region by its accessible name, and the visible label no longer names both. The label and the
   * aria-label are asserted together on purpose: they are two strings that must not drift apart.
   */
  it("the hosted column names BOTH hosted clients — it is where the target is chosen", () => {
    ui(<ConnectRecipes endpoint={U} />);
    const hosted = screen.getByRole("region", { name: HOSTED_COLUMN });

    expect(within(hosted).getByText(HOSTED_COLUMN)).toBeTruthy();
    expect(hosted.textContent).toContain("ChatGPT");
    expect(hosted.textContent).toContain("claude.ai");
  });

  // EX-R7 — a second harness tab would break agents.render.test.tsx:205-206, a file this unit may
  // not edit. Pin the single-occurrence anchors here so the break is caught in the owned file.
  it("keeps the single-occurrence anchors agents.render.test.tsx depends on", () => {
    ui(<ConnectRecipes endpoint={U} />);

    expect(screen.getAllByText(/Bearer <your-agent-key>/)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /keyless/i })).toHaveLength(1);
  });
});

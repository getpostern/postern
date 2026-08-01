import "../../api/test-dom";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotServedError, RestError, api } from "../../api/client";
import { ConnectProvider } from "./ConnectProvider";
import { HEALTH_PUSH_TEMPLATE } from "./ingestPayload";
import { conn, renderAt } from "./testutil";

const routes = [
  { pattern: "/connect/:provider", element: <ConnectProvider /> },
  { pattern: "/connect", element: <div>Add a source page</div> },
  { pattern: "/sources", element: <div>Sources page</div> },
];

beforeEach(() => {
  vi.spyOn(api, "healthz").mockResolvedValue({ ok: true });
  vi.spyOn(api, "listConnectors").mockResolvedValue([]);
  // The gateway is asked what redirect_uri it will send (ADR 0035 §D4). Standing in for a gateway
  // running on its own default; the cases below that care override this with their own answer.
  vi.spyOn(api, "oauthRedirectUri").mockImplementation(
    async (provider: string) => `http://localhost:8787/api/oauth/${provider}/callback`,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConnectProvider — the shared template", () => {
  it("renders the masthead, steps and creates footer for a paste screen", () => {
    renderAt("/connect/simplefin", routes);
    expect(screen.getByText("SimpleFIN")).toBeTruthy();
    expect(screen.getByText("Get your access URL")).toBeTruthy();
    // The creates footer names the sector the credential fans out to.
    expect(screen.getByText(/read-only\. Your banks are linked at SimpleFIN Bridge/)).toBeTruthy();
  });

  it("splices the OAuth redirect URI into step 2 (not a mock literal)", async () => {
    renderAt("/connect/microsoft", routes);
    // The value now ARRIVES from the gateway, so it is asserted asynchronously.
    expect(await screen.findByText(/\/api\/oauth\/microsoft\/callback$/)).toBeTruthy();
    // Microsoft is public — the secret field is disabled with its reason as the ghost text.
    const secret = screen.getByLabelText("Client secret") as HTMLInputElement;
    expect(secret.disabled).toBe(true);
    expect(secret.placeholder).toMatch(/not required/i);
  });

  it("an unknown slug degrades to a zero-state, never a blank screen", () => {
    renderAt("/connect/nonsense", routes);
    expect(screen.getByText("No such source")).toBeTruthy();
  });
});

// The registration steps used to render a redirect URI the CONSOLE composed from its own origin —
// a second source for a string only the gateway knows, silently disagreeing with the one actually
// sent to the provider. The gateway now reports it and this screen renders that, verbatim.
// (ADR 0035 §D4.)
describe("the redirect URI in the registration steps has ONE source: the gateway", () => {
  it("the redirect URI in the registration steps is the one the gateway reports, not one the Console derived", async () => {
    // A host the Console could never derive from its own origin, so a re-grown local derivation
    // cannot produce it.
    vi.spyOn(api, "oauthRedirectUri").mockResolvedValue(
      "https://gw.example.com/api/oauth/google/callback",
    );
    renderAt("/connect/google", routes);
    expect(await screen.findByText("https://gw.example.com/api/oauth/google/callback")).toBeTruthy();
  });

  it("the displayed redirect URI moves when the gateway's own setting moves", async () => {
    // The end-to-end proof of the single source: two gateways, two answers, two displays. A cached
    // or hardcoded value cannot satisfy both.
    const a = "https://a.example/api/oauth/google/callback";
    const b = "https://b.example/api/oauth/google/callback";
    expect(a).not.toBe(b);

    const spy = vi.spyOn(api, "oauthRedirectUri").mockResolvedValue(a);
    renderAt("/connect/google", routes);
    expect(await screen.findByText(a)).toBeTruthy();
    cleanup();

    spy.mockResolvedValue(b);
    renderAt("/connect/google", routes);
    expect(await screen.findByText(b)).toBeTruthy();
    expect(screen.queryByText(a)).toBeNull();
  });

  it("a gateway that cannot report its redirect URI says so instead of showing a guess", async () => {
    const sentence = "Not served — this gateway did not answer with the redirect URI it uses.";
    vi.spyOn(api, "oauthRedirectUri").mockRejectedValue(new NotServedError("no_route", sentence));
    renderAt("/connect/whoop", routes);

    expect(await screen.findByText(/did not answer with the redirect URI it uses/)).toBeTruthy();
    // Nothing anywhere on screen looks like a callback URL — a stated absence, never an invented one.
    expect(document.body.textContent).not.toMatch(/\/api\/oauth\/\w+\/callback/);
  });

  it("a non-OAuth connect screen asks the gateway for no redirect URI at all", async () => {
    const spy = vi.spyOn(api, "oauthRedirectUri");
    renderAt("/connect/simplefin", routes);
    expect(await screen.findByText("Get your access URL")).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/\/api\/oauth\//);
  });

  it("the redirect URI is COPYABLE via the kit primitive — pasted, never hand-typed (#121)", async () => {
    // The providers exact-match this string, and one mistyped character is a dead consent that
    // Google reports only as redirect_uri_mismatch. The kit Copyable is the affordance; the value
    // is still the one gateway-served source asserted above.
    //
    // MUTATION: revert parts.tsx to the plain inline <code> run → no Copy button, red.
    renderAt("/connect/microsoft", routes);
    expect(await screen.findByText(/\/api\/oauth\/microsoft\/callback$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });
});

describe("the three connect-failure kinds (§14.1d)", () => {
  it("OURS — a mis-shaped input seals the field BEFORE any round-trip", async () => {
    const add = vi.spyOn(api, "addCredential");
    renderAt("/connect/simplefin", routes);

    fireEvent.change(screen.getByLabelText("Access URL"), {
      target: { value: "https://bridge.simplefin.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect SimpleFIN" }));

    expect(await screen.findByText(/bridge address/i)).toBeTruthy();
    expect(add).not.toHaveBeenCalled(); // never spent a round-trip
  });

  it("THEIRS — a provider refusal renders the provider's string VERBATIM in mono", async () => {
    vi.spyOn(api, "addCredential").mockRejectedValue(
      new RestError(401, "AUTHENTICATIONFAILED · invalid credentials", { error: "AUTHENTICATIONFAILED · invalid credentials" }),
    );
    renderAt("/connect/gmail", routes);

    fireEvent.change(screen.getByLabelText("Gmail address"), { target: { value: "me@gmail.com" } });
    fireEvent.change(screen.getByLabelText("App password"), { target: { value: "abcd efgh ijkl mnop" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Gmail" }));

    // Our plain sentence, and their literal string untouched (never paraphrased).
    expect(await screen.findByText("Gmail refused it.")).toBeTruthy();
    const verbatim = await screen.findByText("AUTHENTICATIONFAILED · invalid credentials");
    expect(verbatim.tagName.toLowerCase()).toBe("code");
  });

  it("NOBODY'S — an already-connected source warns and REQUIRES intent (#55), never a silent re-run", async () => {
    vi.spyOn(api, "listConnectors").mockResolvedValue([
      conn({ provider: "apple", status: "active", connectionId: "apple_1" }),
    ]);
    const onboard = vi.spyOn(api, "appleOnboard");
    renderAt("/connect/icloud", routes);

    // The nobody's-failure notice appears once the connectors query resolves.
    expect(await screen.findByText(/already connected/i)).toBeTruthy();

    const submit = (await screen.findByRole("button", { name: "Reconnect iCloud" })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // gated on explicit intent
    fireEvent.click(submit);
    expect(onboard).not.toHaveBeenCalled(); // no silent Apple fan-out of three

    // Ticking the acknowledgement enables the reconnect.
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(submit.disabled).toBe(false));
  });
});

// A FAILED consent used to 302 onto a deleted `/connections` route — the Console's `*` "— not
// found" placeholder — with the provider's own code in the query string and nothing reading it. It
// now lands on the provider's OWN connect screen: the registration steps and the client-id/secret
// form ARE the repair for access_denied / invalid_client / redirect_uri_mismatch. (#96 §1.6.)
describe("returning from a refused OAuth consent", () => {
  it("returning from a refused consent shows the provider's own code, verbatim", async () => {
    renderAt("/connect/google?oauth_error=access_denied&provider=google", routes);
    expect(await screen.findByText("Google did not complete the sign-in.")).toBeTruthy();
    const verbatim = screen.getByText("access_denied");
    // rendered in <code>, untouched — never paraphrased into our own voice (§14.1d, law 10)
    expect(verbatim.tagName.toLowerCase()).toBe("code");
  });

  it("returning from a refused consent leaves the configure form usable", async () => {
    // The screen is the REPAIR, not a report of the break: the form must still be there and enabled.
    renderAt("/connect/whoop?oauth_error=invalid_client&provider=whoop", routes);
    // `def.name` — the connect catalog's own word for the provider ("Whoop"), which is what every
    // other sentence on this screen already uses.
    expect(await screen.findByText("Whoop did not complete the sign-in.")).toBeTruthy();
    const clientId = screen.getByLabelText("Client ID") as HTMLInputElement;
    expect(clientId.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Save & sign in with Whoop" })).toBeTruthy();
    expect(screen.getByText("Register your app")).toBeTruthy();
  });

  it("a clean arrival at a connect screen shows no failure at all", () => {
    renderAt("/connect/google", routes);
    expect(screen.queryByText(/did not complete the sign-in/)).toBeNull();
  });
});

// `connectApi` wrapped the first sync in a bare `try {} catch {}`, so this screen toasted success
// and navigated away over a source that never answered (#96 §4).
describe("a connect whose first sync fails (#96 §4)", () => {
  function mockCreate() {
    vi.spyOn(api, "addCredential").mockResolvedValue({
      credentialId: "cred1",
      provider: "home_assistant",
      status: "active",
    });
    vi.spyOn(api, "createConnector").mockResolvedValue({
      connectionId: "ha-conn-1",
      sector: "home",
      provider: "home_assistant",
      status: "active",
    });
  }

  function fillHomeAssistant() {
    fireEvent.change(screen.getByLabelText("Instance URL"), {
      target: { value: "http://192.168.1.50:8123" },
    });
    fireEvent.change(screen.getByLabelText("Long-lived token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Home Assistant" }));
  }

  it("does not toast success and does not navigate away", async () => {
    mockCreate();
    vi.spyOn(api, "syncNow").mockResolvedValue({
      connectionId: "ha-conn-1",
      provider: "home_assistant",
      mode: "poll",
      ran: true,
      ok: false,
      error: "401 unauthorized from Home Assistant",
    });
    renderAt("/connect/home-assistant", routes);
    fillHomeAssistant();

    expect(
      await screen.findByText("Home Assistant is connected, but its first sync failed."),
    ).toBeTruthy();
    // the provider's own string, verbatim
    expect(screen.getByText("401 unauthorized from Home Assistant")).toBeTruthy();
    // stayed put, and never claimed success
    expect(screen.queryByText("Sources page")).toBeNull();
    expect(screen.queryByText("Home Assistant connected.")).toBeNull();
  });

  it("offers the connection it did create", async () => {
    mockCreate();
    vi.spyOn(api, "syncNow").mockRejectedValue(new Error("connect ECONNREFUSED"));
    renderAt("/connect/home-assistant", routes);
    fillHomeAssistant();

    const manage = await screen.findByRole("link", { name: /Manage this connection/ });
    expect(manage.getAttribute("href")).toBe("/sources/ha-conn-1");
  });

  it("a clean connect still toasts and lands on Sources", async () => {
    // The regression guard for the fix: the failure branch must not be over-applied.
    mockCreate();
    vi.spyOn(api, "syncNow").mockResolvedValue({
      connectionId: "ha-conn-1",
      provider: "home_assistant",
      mode: "poll",
      ran: true,
      ok: true,
      upserted: 1847,
    });
    renderAt("/connect/home-assistant", routes);
    fillHomeAssistant();

    expect(await screen.findByText("Sources page")).toBeTruthy();
    expect(screen.getByText("Home Assistant connected.")).toBeTruthy();
    expect(screen.queryByText(/its first sync failed/)).toBeNull();
  });
});

describe("Apple Health device walkthrough (#27)", () => {
  it("shows the SERVED relative ingest path honestly and never dresses loopback as the reachable endpoint", async () => {
    vi.spyOn(api, "addCredential").mockResolvedValue({ credentialId: "cred1", provider: "apple_health", status: "active" });
    vi.spyOn(api, "createConnector").mockResolvedValue({
      connectionId: "hc1",
      sector: "health",
      provider: "apple_health",
      status: "active",
    });
    vi.spyOn(api, "mintIngestSecret").mockResolvedValue({
      // What the backend ACTUALLY returns: a RELATIVE path (admin.ts; asserted relative in
      // ingest.db.test.ts) — never an absolute reachable URL. The reachable host is the operator's
      // remote-access address, which the Console cannot derive and must not synthesize (#27).
      ingestUrl: "/api/ingest/abc123",
      secret: "whsec_test_0001",
    });
    renderAt("/connect/apple-health", routes);

    fireEvent.click(screen.getByRole("button", { name: "Create your ingest endpoint" }));

    // The served relative path is shown verbatim (as the copyable value), not absolutised.
    expect(await screen.findByText("/api/ingest/abc123")).toBeTruthy();
    expect(screen.getByText("whsec_test_0001")).toBeTruthy();
    // #106: the COPYABLE's label names the value being copied ("Device secret"), not the HTTP header
    // it goes in. The header is a wire literal the person has to type, so it survives — in the
    // sentence that tells them where to put it, which is the assertion below.
    expect(screen.getByText("Device secret — shown once")).toBeTruthy();
    expect(screen.getByText(/Send it on every push as the/).textContent).toMatch(
      /X-PCI-Webhook-Secret/,
    );
    expect(screen.getByText(/waiting for the first push/i)).toBeTruthy();
    // #27: no origin is dressed up as the reachable endpoint. What PINS that is the exact-text
    // assertion above — the copyable value is the served `/api/ingest/abc123` and nothing else.
    //
    // The two checks below are a HISTORICAL-LITERAL guard, and their reach shrank in this unit.
    // They were written when GATEWAY_URL was the baked `http://localhost:8787` and the bug was
    // absolutising the served path against it; **this unit moved that default to `""`**
    // (same-origin, ADR 0035 §D4), so the same mistake made today would yield the relative path
    // again and these two could not see it. They still catch a hardcoded loopback literal, which is
    // the other way this regresses — so they stay, correctly described.
    //
    // A whole-body scan for `scheme://…/api/ingest` is NOT the guard to add: the prose deliberately
    // shows `https://your-mac.tailnet.ts.net:8443/api/ingest/abc123` as the worked example of the
    // host the operator must supply, and that sentence is the honesty this cell is protecting.
    expect(screen.queryByText(/localhost:8787\/api\/ingest/)).toBeNull();
    expect(screen.queryByText("http://localhost:8787/api/ingest/abc123")).toBeNull();
    // The operator is told the reachable host is their configured remote-access address, not the Console.
    expect(screen.getByText(/remote-access host/i)).toBeTruthy();
  });
});

// #27's LAST named acceptance item, and the reason the issue could not be closed: *"show the exact
// JSON body the connector expects"*, acceptance *"no source-diving for the payload"*. Four of the five
// walkthrough steps already shipped; the screen said only that the Shortcut should post "your Health
// export", so the shape had to be read out of `src/connectors/apple-health.ts`.
//
// What the template CONTAINS is pinned by `ingestPayload.test.ts`, which runs the real connector over
// it. This block pins that it is on the screen, in both states, without the two things the issue
// forbids: a reachable host it cannot know, and a second airing of the one-time secret.
describe("the Apple Health payload template (#27, step 4)", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    writeText.mockClear();
    // jsdom ships no clipboard; the component's optional chain would otherwise no-op silently and the
    // copy assertion below would pass against a button that does nothing.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  });

  /** The rendered block, read as one exact string — testing-library's text matcher normalises
   *  whitespace, which would silently accept a reflowed or truncated template. */
  function renderedTemplate(container: HTMLElement): string {
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    return pre!.textContent ?? "";
  }

  /** Stub the three calls "Create your ingest endpoint" makes, so the minted branch can be reached. */
  function stubMint(): void {
    vi.spyOn(api, "addCredential").mockResolvedValue({ credentialId: "cred1", provider: "apple_health", status: "active" });
    vi.spyOn(api, "createConnector").mockResolvedValue({
      connectionId: "hc1",
      sector: "health",
      provider: "apple_health",
      status: "active",
    });
    vi.spyOn(api, "mintIngestSecret").mockResolvedValue({
      ingestUrl: "/api/ingest/abc123",
      secret: "whsec_test_0001",
    });
  }

  it("names Health Auto Export — the app the issue names — and keeps the Shortcuts route beside it", async () => {
    stubMint();
    renderAt("/connect/apple-health", routes);
    expect(screen.getByText("Health Auto Export")).toBeTruthy();

    // NOT a replacement: #27 asks for the app OR a Shortcuts automation, and the hand-built route may
    // not be removed to make room for this one. It lives in the minted branch, so reach that branch
    // rather than assert it into existence.
    //
    // #106 §2b removed the AFFORDANCE and kept the ROUTE: there is no Postern-published shortcut and
    // no endpoint that serves one, so a disabled "Add the Postern Health shortcut" button beside a
    // fake QR captioned "not served" was a dead control plus a build-status label. The instruction it
    // was sitting on top of is now the instruction. Both halves are asserted, because deleting the
    // button without keeping the instruction would be removing a capability.
    fireEvent.click(screen.getByRole("button", { name: "Create your ingest endpoint" }));
    expect(await screen.findByText("/api/ingest/abc123")).toBeTruthy();
    expect(screen.getByText(/Get Contents of\s+URL/)).toBeTruthy();
    expect(screen.getByText("Health Auto Export")).toBeTruthy();
    // No dead control, and no caption narrating what we have not built.
    expect(screen.queryByRole("button", { name: /Add the Postern Health shortcut/ })).toBeNull();
    expect(screen.queryByText("not served")).toBeNull();
  });

  it("renders the template verbatim, character for character", () => {
    const { container } = renderAt("/connect/apple-health", routes);
    expect(renderedTemplate(container)).toBe(HEALTH_PUSH_TEMPLATE);
    // The three keys a reader is here for, so a template gutted to `{}` cannot pass on identity alone.
    for (const key of ["metrics", "sleep_analysis", "workouts"]) {
      expect(renderedTemplate(container)).toContain(key);
    }
  });

  it("no longer tells the reader to post an unspecified “Health export”", async () => {
    // The exact copy that made source-diving necessary. Rendering the template while ALSO still
    // saying "your Health export" would leave the vague instruction as the thing a user follows.
    //
    // The sentence lives in the MINTED branch, so this must mint before it can see anything. Written
    // without the mint first, it was vacuous — mutation-verified: restoring the old wording left it
    // green, because the element it looks for had never rendered.
    stubMint();
    renderAt("/connect/apple-health", routes);
    fireEvent.click(screen.getByRole("button", { name: "Create your ingest endpoint" }));
    // The positive half proves the sentence is on screen at all, so the negative half is a claim about
    // its WORDING rather than about its absence.
    expect(await screen.findByText(/POSTs the body below/)).toBeTruthy();
    expect(screen.queryByText(/POSTs your Health export/)).toBeNull();
  });

  it("is reachable BEFORE a mint and AFTER one — a returning operator never lands on the mint branch", async () => {
    stubMint();
    const { container } = renderAt("/connect/apple-health", routes);

    // Pre-mint: the payload is a static fact about our ingest contract, not a property of an endpoint.
    expect(renderedTemplate(container)).toBe(HEALTH_PUSH_TEMPLATE);

    fireEvent.click(screen.getByRole("button", { name: "Create your ingest endpoint" }));
    expect(await screen.findByText("/api/ingest/abc123")).toBeTruthy();

    // Post-mint: exactly one block, not a second copy stamped out by the minted branch.
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(renderedTemplate(container)).toBe(HEALTH_PUSH_TEMPLATE);
  });

  it("copies the same string it displays", () => {
    // One stringify, rendered and copied. Two would drift, and the one a user pastes is the one they
    // never proofread.
    const { container } = renderAt("/connect/apple-health", routes);
    fireEvent.click(screen.getByRole("button", { name: "Copy the template" }));
    expect(writeText).toHaveBeenCalledWith(renderedTemplate(container));
    expect(writeText).toHaveBeenCalledWith(HEALTH_PUSH_TEMPLATE);
  });

  it("puts no reachable host and no secret inside the block", async () => {
    // The two traps #27 and coverage.md both record. (a) The ingest HOST cannot be derived from this
    // origin and the MCP public URL is a DIFFERENT edge with no fixed offset — filling it in would be
    // inventing a value. (b) The one-time secret is already handled above; the template must not air
    // it a second time. Scoped to the <pre>, because the prose around it legitimately shows a
    // placeholder host and legitimately names the header.
    stubMint();
    const { container } = renderAt("/connect/apple-health", routes);
    fireEvent.click(screen.getByRole("button", { name: "Create your ingest endpoint" }));
    expect(await screen.findByText("whsec_test_0001")).toBeTruthy();

    const block = renderedTemplate(container);
    expect(block).not.toMatch(/https?:\/\//);
    expect(block).not.toContain("localhost");
    expect(block).not.toContain("tailnet");
    expect(block).not.toContain("/api/ingest");
    expect(block).not.toContain("whsec_test_0001");
    // And the secret is still shown exactly once, in its own Copyable — not twice.
    expect(screen.getAllByText("whsec_test_0001")).toHaveLength(1);
  });
});

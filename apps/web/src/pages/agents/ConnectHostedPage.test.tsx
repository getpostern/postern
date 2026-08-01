// ConnectHostedPage — #101 item 3: the cloud walkthrough must never hand out a Copy button for an
// address a hosted client cannot reach. Under the shipped quickstart the gateway's own endpoint is
// `http://localhost:8788/mcp`; copying that into claude.ai is the reported defect.
//
// EX-H2 is #47 as one assertion: an https endpoint on a non-443 port is unreachable, and the failure
// mode is a SILENT TCP reset — the user sees nothing at all, so the Console has to say it.
//
// What changed with `/api/exposure`: the endpoint and the bridge status are now READ from the
// gateway instead of baked in at build time or stated as a condition the Console could not check.
// #101's `classifyCloudTarget` / `reasonFor` logic is untouched — only the SOURCE of the string it
// judges moved — so every EX-H cell below still holds and must stay green.

import "../../api/test-dom"; // installs a jsdom global BEFORE React/testing-library load

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../api/client";
import { EXPOSURE_UNANSWERED } from "../../api/exposure";
import type { ExposureStatus } from "../../api/types";
import { ToastProvider } from "../../kit";
import { ConnectHostedPage, classifyCloudTarget } from "./ConnectHostedPage";
import { PUBLIC_ADDRESS_ROW_TITLE } from "../records/settings";

/** What the gateway really serves in `serving`/`configured`: a bare origin (#126). The exposure
 *  fixtures below MUST use this shape — the pre-#131 fixtures put the `/mcp` URL into
 *  `serving.publicUrl`, which is how the page shipped handing out an origin that 404s under a test
 *  that could not go red. */
const ORIGIN = "https://gate.example.ts.net";
const USABLE = "https://gate.example.ts.net/mcp";
const PATTERN = "https://your-mac.tailnet.ts.net/mcp";
const LOOPBACK = "http://localhost:8788/mcp";

/** The paste label, in one place because four cells locate the reachable branch by it. It is a
 *  LITERAL here on purpose — importing it from the component would make every cell below agree with
 *  whatever the component says, which is the "test that cannot fail" shape. */
const PASTE_LABEL = "Paste this into claude.ai or ChatGPT";

/** One endpoint per unreachable kind — the shapes an operator actually lands on. */
const UNREACHABLE: Record<string, string> = {
  loopback: LOOPBACK,
  insecure: "http://gate.example.ts.net/mcp",
  "wrong-port": "https://gate.example.ts.net:10000/mcp",
  unreadable: "not a url",
};

function exposure(over: Partial<ExposureStatus> = {}): ExposureStatus {
  return {
    configured: null,
    serving: null,
    restartRequired: false,
    localEndpoint: LOOPBACK,
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

describe("classifyCloudTarget — a fact about the string, not a claim about the world", () => {
  // EX-H1 — the exact defect: treating the gateway's own loopback address as the cloud endpoint.
  it("calls the shipped loopback endpoint unreachable from a hosted client", () => {
    expect(classifyCloudTarget("http://localhost:8788/mcp").kind).toBe("loopback");
    expect(classifyCloudTarget("http://127.0.0.1:8788/mcp").kind).toBe("loopback");
    expect(classifyCloudTarget("http://[::1]:8788/mcp").kind).toBe("loopback");
  });

  // EX-H2 — catches a classifier that only checks the scheme. This one assertion IS #47.
  it("calls an https endpoint on a non-443 port unreachable — the silent-reset case", () => {
    expect(classifyCloudTarget("https://your-mac.tailnet.ts.net:10000/mcp")).toEqual({
      kind: "wrong-port",
      url: "https://your-mac.tailnet.ts.net:10000/mcp",
      port: "10000",
    });
  });

  // EX-H3 — catches an over-strict rule that rejects the one shape that works (implicit 443).
  it("accepts https on 443, explicit or implied, as the only pasteable shape", () => {
    expect(classifyCloudTarget("https://x.ts.net/mcp").kind).toBe("usable");
    expect(classifyCloudTarget("https://x.ts.net:443/mcp").kind).toBe("usable");
    expect(classifyCloudTarget("http://x.ts.net/mcp").kind).toBe("insecure");
  });

  // EX-H4 — catches an unguarded `new URL()` white-screening a page with no ErrorBoundary above it.
  it("degrades a malformed endpoint instead of throwing — the Console has no ErrorBoundary", () => {
    expect(classifyCloudTarget("not a url").kind).toBe("unreadable");
    expect(() => ui(<ConnectHostedPage endpoint="not a url" />)).not.toThrow();
    expect(screen.getByText(/isn't an address it can read/)).toBeTruthy();
  });
});

describe("ConnectHostedPage — Copy only for an address the cloud can reach (#101)", () => {
  // EX-H5 — catches re-adding an unconditional Copy button, the reported defect.
  it("offers no Copy button and no paste label when the endpoint cannot be reached from the cloud", () => {
    for (const [kind, endpoint] of Object.entries(UNREACHABLE)) {
      ui(<ConnectHostedPage endpoint={endpoint} />);

      expect(screen.queryByRole("button", { name: /copy/i }), kind).toBeNull();
      expect(screen.queryByText(PASTE_LABEL), kind).toBeNull();
      expect(screen.getByText(PATTERN), kind).toBeTruthy();

      cleanup();
    }
  });

  // EX-H6 — catches a Copy button that copies a stale/derived value, and a branch that never renders.
  it("offers Copy only for an https 443 endpoint, and copies that exact URL", () => {
    ui(<ConnectHostedPage endpoint={USABLE} />);

    expect(screen.getByText(PASTE_LABEL)).toBeTruthy();
    expect(screen.queryByText(PATTERN)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(USABLE);
  });

  // EX-H7 — a branch that drops the load-bearing 443 caveat, which is also a direct break of
  // agents.render.test.tsx (a file this unit also owns, but which must keep its own anchor).
  it("keeps the 443 caveat in every branch", () => {
    for (const endpoint of [...Object.values(UNREACHABLE), USABLE]) {
      ui(<ConnectHostedPage endpoint={endpoint} />);
      expect(screen.getAllByText(/publicly served \(port 443\)/), endpoint).toHaveLength(1);
      cleanup();
    }
  });
});

describe("the address and the bridge state come from the gateway (ADR 0035 §D1)", () => {
  // MUTATION: default the endpoint to a constant (`endpoint ?? "http://localhost:8788/mcp"`) → RED:
  // the page would degrade to the loopback refusal while the gate is genuinely published.
  //
  // MUTATION (#131 — the shipped defect): hand out `serving.publicUrl` as-is → RED on both the
  // displayed value and the copied one. The gateway serves a bare ORIGIN; the value a user pastes
  // into claude.ai is that origin plus `/mcp`, and showing the origin sent every hosted connect to
  // a root that 404s while the OAuth grant landed in the ledger looking healthy.
  it("the address offered to claude.ai is the served origin PLUS /mcp — never the bare origin", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(
      exposure({
        configured: { publicUrl: ORIGIN, source: "db", consentedAt: null },
        serving: { publicUrl: ORIGIN },
      }),
    );
    ui(<ConnectHostedPage />);

    expect(await screen.findByText(PASTE_LABEL)).toBeTruthy();
    expect(screen.getByText(USABLE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(USABLE);
  });

  // MUTATION: treat `localEndpoint` as usable (skip `classifyCloudTarget`) → RED. This is #101's
  // defect re-created through the new source of the string.
  it("a gateway that has published nothing still refuses to hand out a loopback address", async () => {
    ui(<ConnectHostedPage />);
    // #106 dropped the word "loopback" — it was glossed by its own next four words. The REFUSAL is
    // what this pins, so it is pinned on the gloss and on the two facts around it, not on the noun.
    const refusal = await screen.findByText(/an address only this machine can use/);
    // The refusal names the CLASS, not one vendor: ChatGPT connects from OpenAI's cloud, not
    // Anthropic's, and the pre-2026-08-01 sentence was false for half the clients it refused.
    expect(refusal.textContent).toMatch(/A hosted client connects from its own cloud and can never reach it/);
    expect(refusal.textContent).toMatch(/can't fill it in for you/);
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    expect(screen.getByText(PATTERN)).toBeTruthy();
  });

  // MUTATION: restore the old step 1 ("set MCP_PUBLIC_URL and expose the gateway…") → RED. Needing
  // a file edit on the box is the product gap this unit closes; the walkthrough must not re-open it.
  it("the walkthrough sends you to the setting, not to a file on the box", async () => {
    ui(<ConnectHostedPage endpoint={USABLE} />);
    // Assert the ROW TITLE, not just the path prefix: `/Settings → Remote access/` kept passing
    // while the row it points at was renamed out from under it. MUTATION: retype the old
    // "Public · Tailscale Funnel" literal into STEPS[0] → RED.
    expect(screen.getByText(new RegExp(`Settings → Remote access → ${PUBLIC_ADDRESS_ROW_TITLE}`))).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/MCP_PUBLIC_URL/);
  });

  // MUTATION: restore the degraded hint ("The Console can't read that flag from here…") and the
  // condition-shaped status line → RED. The flag IS served now; stating a condition instead of the
  // fact is a claim the page no longer has any excuse for.
  it("the bridge status is read, not guessed", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(
      exposure({
        configured: { publicUrl: ORIGIN, source: "db", consentedAt: null },
        serving: { publicUrl: ORIGIN },
      }),
    );
    ui(<ConnectHostedPage />);
    // "Published at" states the gate's ADDRESS — the origin — while the paste block hands out the
    // endpoint. Two different facts, and #131 was the page blurring them in the wrong direction.
    expect(await screen.findByText(`Bridge is on — published at ${ORIGIN}`)).toBeTruthy();
    expect(screen.queryByText(/can't read that flag/)).toBeNull();
    expect(screen.queryByText("Bridge is on when MCP_PUBLIC_URL is set")).toBeNull();
  });

  // The two restart states, each stated rather than collapsed into on/off. The cleared-still-live
  // one is the safety direction: the bridge IS on, and saying "off" would be the dangerous lie.
  // MUTATION: derive the bridge state from `configured` instead of `serving` → RED on both cells.
  it("distinguishes saved-not-yet-live from stopped-but-still-serving", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(
      exposure({ configured: { publicUrl: ORIGIN, source: "db", consentedAt: null }, serving: null }),
    );
    ui(<ConnectHostedPage />);
    expect(
      await screen.findByText("Bridge is off — an address is saved but not published yet"),
    ).toBeTruthy();
    cleanup();

    vi.mocked(api.getExposure).mockResolvedValue(
      exposure({ configured: null, serving: { publicUrl: ORIGIN } }),
    );
    ui(<ConnectHostedPage />);
    expect(await screen.findByText(`Bridge is on — published at ${ORIGIN}`)).toBeTruthy();
    expect(screen.getByText(/keeps serving that address until it restarts/)).toBeTruthy();
  });

  // MUTATION: route this state through `classifyCloudTarget("")` instead (delete the `noAddress`
  // branch) → RED: the page would say "Postern is configured with , which isn't an address it can
  // read", which describes a parse failure rather than the truth — there is no address to parse.
  it("a gateway with no address at all says so, instead of blaming a malformed one", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(exposure({ localEndpoint: null }));
    ui(<ConnectHostedPage />);
    expect(await screen.findByText(/has published nothing, so it has no address at all yet/)).toBeTruthy();
    expect(screen.queryByText(/isn't an address it can read/)).toBeNull();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    // The operator-supplied pattern still shows — a shape to fill in, never a value we invented.
    expect(screen.getByText(PATTERN)).toBeTruthy();
  });

  // ── §Decision 6: `serving` is answered BEFORE `problem` ───────────────────────────────────────
  //
  // MUTATION: restore the shipped ordering — move the `if (s.problem != null)` block in
  // `bridgeStatus` back above the `s.serving != null` test → RED. That ordering printed "Bridge is
  // off … Nothing is published" directly above a live Copy button for the address claude.ai was
  // being answered on. `problem` is request-time and about the store; `serving` is boot-time and
  // about the edge, and neither speaks for the other.
  it("a bridge that is still serving says so even when the gateway can't read its own setting", async () => {
    vi.mocked(api.getExposure).mockResolvedValue(
      exposure({ configured: null, serving: { publicUrl: ORIGIN }, problem: "db_unreadable" }),
    );
    ui(<ConnectHostedPage />);

    expect(await screen.findByText(`Bridge is on — published at ${ORIGIN}`)).toBeTruthy();
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/Bridge is off/);
    expect(body).not.toMatch(/Nothing is published/);
    // The problem is reported as *the setting is stuck*, and the served address is still handed over.
    expect(screen.getByText(/can't be changed right now/)).toBeTruthy();
    expect(screen.getByText(PASTE_LABEL)).toBeTruthy();
    expect(screen.getByText(USABLE)).toBeTruthy();
  });

  // ── §Decision 7: a failed read is never a fact about the box ──────────────────────────────────
  //
  // MUTATION: delete the `failed` branch (revert to `pending = exposure.isPending` and
  // `bridgeStatus(pending ? undefined : exposure.data)`) → RED. `exposure.data` is undefined on an
  // error too, so the card sat on "Reading this gate's bridge status…" forever while the address
  // block asserted the box runs no MCP edge and has published nothing.
  it("a gateway that did not answer is not reported as a gateway with nothing published", async () => {
    vi.mocked(api.getExposure).mockRejectedValue(new Error("Failed to fetch"));
    ui(<ConnectHostedPage />);

    // Twice: the bridge-status hint and the address block. Both are the SAME sentence, on purpose.
    expect(await screen.findAllByText(EXPOSURE_UNANSWERED)).toHaveLength(2);
    const body = document.body.textContent ?? "";
    // Not stuck on the pending sentence…
    expect(body).not.toMatch(/Reading this gate's bridge status/);
    // …and no claim about the box: nothing about an MCP edge, nothing about what is published.
    expect(body).not.toMatch(/has published nothing/);
    // Retargeted with the copy (#106: "isn't running an MCP edge" → "isn't serving MCP"). A negative
    // assertion against a phrase no longer in the app passes forever and guards nothing.
    expect(body).not.toMatch(/isn’t serving MCP/);
    expect(body).not.toMatch(/Bridge is off/);
    // No address of any kind, and not even the pattern — showing a shape to fill in implies the box
    // needs changing, and nothing about the box is known here.
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    expect(screen.queryByText(PATTERN)).toBeNull();
    expect(body).not.toMatch(/https?:\/\//);
  });

  // MUTATION: drop the pending branch and let `new URL(displayEndpoint(undefined)!)` run unguarded
  // → RED (a throw, and there is no ErrorBoundary to catch it).
  it("nothing white-screens when the gateway has not answered yet", () => {
    vi.mocked(api.getExposure).mockReturnValue(new Promise<ExposureStatus>(() => {}));
    expect(() => ui(<ConnectHostedPage />)).not.toThrow();
    // Renders, and offers no address of any kind while it waits.
    expect(screen.getByText("Connect claude.ai or ChatGPT")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    expect(screen.queryByText(PATTERN)).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/https?:\/\//);
  });
});

describe("this page is for BOTH hosted clients, not just claude.ai", () => {
  /**
   * ChatGPT connects through this same bridge and was witnessed doing it 2026-08-01. Before that the
   * whole page — verdict, steps, paste label, refusals — spoke as though claude.ai were the only
   * hosted client, which tells a ChatGPT user the path is not for them.
   *
   * MUTATION (the one the spec names): delete "ChatGPT" from the verdict, the steps and the paste
   * label → RED here, three times over. Asserted on the RENDERED page rather than on the STEPS
   * constant, so moving the word into a comment does not satisfy it.
   */
  it("names ChatGPT on the verdict, in the steps, and on the label you paste under", () => {
    ui(<ConnectHostedPage endpoint={USABLE} />);

    expect(screen.getByText("Connect claude.ai or ChatGPT")).toBeTruthy();
    expect(screen.getByText(PASTE_LABEL)).toBeTruthy();
    // Anti-vacuity: the two above could both be satisfied while the STEPS — the part a person
    // actually follows — still knew only one client.
    const steps = document.querySelector("ol")?.textContent ?? "";
    expect(steps).toContain("ChatGPT");
    expect(steps).toContain("claude.ai");
  });

  /**
   * The entry paths, from the operator's witnessed run — not invented, and not one client's path
   * reused for the other. ChatGPT's rail item is **Plugins**, custom servers need **Developer mode**
   * on, and the connector is created with **“+”** on the Plugins page.
   *
   * MUTATION: replace ChatGPT's path with claude.ai's ("Settings → Connectors → Add custom
   * connector") → RED on all three, because none of those three words appears in it.
   */
  it("carries ChatGPT's real entry path — Plugins, Developer mode, the “+” button", () => {
    ui(<ConnectHostedPage endpoint={USABLE} />);
    const steps = document.querySelector("ol")?.textContent ?? "";

    expect(steps).toMatch(/Settings → Plugins → Developer mode/);
    expect(steps).toMatch(/“\+” on the Plugins page/);
    // The naming drift is admitted rather than resolved: ChatGPT calls one page three things.
    expect(steps).toMatch(/also calls these Apps/);
  });

  /** claude.ai's step is settled copy. MUTATION: rewrite it into a shared "add a custom server"
   *  sentence → RED. Extending the page to a second client may not cost the first its exact path. */
  it("leaves claude.ai's settled path exactly as it was", () => {
    ui(<ConnectHostedPage endpoint={USABLE} />);
    const steps = document.querySelector("ol")?.textContent ?? "";
    expect(steps).toContain("In claude.ai, open Settings → Connectors → Add custom connector.");
  });

  /**
   * THE KEEP-THE-KEY WITNESS.
   *
   * The trap it exists for, witnessed in the same run: the reveal screen's Copy puts the agent KEY on
   * the clipboard, this page's Copy then replaces it with the URL, and the sign-in asks for the key
   * later — in another app, after the key has been shown for the only time. The operator pasted the
   * URL into the key box and got "That agent key was not accepted".
   *
   * MUTATION: delete the sentence from STEPS[2] → RED on all three assertions.
   */
  it("tells you to keep the key BEFORE the endpoint's Copy overwrites it", () => {
    ui(<ConnectHostedPage endpoint={USABLE} />);
    const steps = document.querySelector("ol")?.textContent ?? "";

    // It says to save the key…
    expect(steps).toMatch(/Save that key somewhere safe before you copy the endpoint/);
    // …names the mechanism, so the instruction is followable rather than superstition…
    expect(steps).toMatch(/replaces it on your clipboard/);
    // …and stays in the screen's existing shown-once register.
    expect(steps).toMatch(/shown only once/);
  });

  /** The five-minute failure cache stays, and its subject generalised with the page.
   *  MUTATION: drop the sentence → RED. A user who fixes the address and retries immediately gets
   *  the cached failure and concludes the fix did not work. */
  it("keeps the five-minute failure-cache warning, for either client", () => {
    ui(<ConnectHostedPage endpoint={USABLE} />);
    const note = screen.getByText(/remembers a failed check for a few minutes/);
    expect(note.textContent).toMatch(/wait five minutes/);
    expect(note.textContent).toMatch(/claude\.ai or ChatGPT/);
  });
});

describe("step 1 POINTS at remote access — the switch and the guide", () => {
  /** Every anchor on the page, split by where it goes: in-app navigation is a <Link> and emits a
   *  root-relative href; anything with a scheme is leaving the Console. Same split guideLink.test.tsx
   *  uses on the connect screens, for the same reason. */
  function anchors(): { external: HTMLAnchorElement[]; internal: HTMLAnchorElement[] } {
    const all = [...document.querySelectorAll("a")] as HTMLAnchorElement[];
    const external = all.filter((a) => /^[a-z][a-z0-9+.-]*:/i.test(a.getAttribute("href") ?? ""));
    return { external, internal: all.filter((a) => !external.includes(a)) };
  }

  /** Spelled out, never via `guideUrlForSlug` — a derivation that broke could otherwise satisfy this
   *  file by agreeing with itself, which is the defect class this repo is named for. */
  const REMOTE_ACCESS_GUIDE = "https://getpostern.com/guides/remote-access";

  /** MUTATION: drop the <Link> and leave step 1 naming the path in prose → RED. Naming a screen is
   *  not pointing at it; a person mid-connect had to go hunt for the switch. */
  it("links the Console's own Remote access screen, as in-app navigation", () => {
    ui(<ConnectHostedPage endpoint={USABLE} />);
    const settings = anchors().internal.filter((a) => a.getAttribute("href") === "/settings");
    expect(settings).toHaveLength(1);
    expect(settings[0].textContent).toMatch(/Remote access/);
  });

  /** MUTATION: drop the guide anchor → RED. MUTATION: render it as text → RED (it is an anchor
   *  count). The Tailscale + Funnel half is the part Postern does not own and cannot walk you
   *  through in a step. */
  it("links the remote-access field guide, and it is the ONLY external anchor here", () => {
    ui(<ConnectHostedPage endpoint={USABLE} />);
    const { external } = anchors();
    expect(external.map((a) => a.getAttribute("href"))).toEqual([REMOTE_ACCESS_GUIDE]);
    expect(external[0].textContent).toMatch(/full/i);
    expect(external[0].textContent).toMatch(/guide/i);
    expect(external[0].textContent).toContain("getpostern.com");
  });

  /** MUTATION: drop `rel` (or either half of it) → RED. A `_blank` tab is handed `window.opener` and
   *  a Referer otherwise — and this page is reached with a live agent key in play. */
  it("opens away from the walkthrough with the rel guard intact, and carries nothing about this gate", () => {
    ui(<ConnectHostedPage endpoint={USABLE} />);
    const link = anchors().external[0];

    expect(link.getAttribute("target")).toBe("_blank");
    const rel = (link.getAttribute("rel") ?? "").split(/\s+/);
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");

    const url = new URL(link.href);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("getpostern.com");
    expect(url.pathname).toBe("/guides/remote-access");
    // Nothing about this gate travels to the public site — not its address, not which step failed.
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  /**
   * The static half, and the reason this link goes through `guideUrlForSlug` instead of being typed:
   * `guideLink.test.tsx`'s source scan (#136 M5) only reads `pages/connect`, so a hand-typed origin
   * in `pages/agents` would be exactly as invisible on a site rename as the nine that scan exists to
   * prevent. This is that scan, for this group.
   *
   * MUTATION: inline `"https://getpostern.com/guides/remote-access"` in ConnectHostedPage.tsx → RED.
   */
  it("no shipped file in the agents group writes a guide URL — it is derived", () => {
    const shipped = groupSource();
    // Vacuity guard: a glob that matched nothing would make the loop below trivially true.
    expect(Object.keys(shipped)).toContain("ConnectHostedPage.tsx");
    expect(Object.keys(shipped).length).toBeGreaterThan(5);

    // The URL prefix, not the bare host: "at getpostern.com →" is the link's own TEXT (the #136
    // convention — a link says out loud that it leaves), and banning the host would ban that too.
    for (const [name, text] of Object.entries(shipped)) {
      expect(text, `${name} writes its own guide URL`).not.toContain("getpostern.com/guides");
    }
  });
});

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/web/src/pages/agents

/** Every SHIPPED source file of the agents group, by basename. Tests are excluded — this file
 *  legitimately writes the URL out, and asserting on itself is circular. */
function groupSource(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(HERE)) {
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out[name] = readFileSync(join(HERE, name), "utf8");
  }
  return out;
}

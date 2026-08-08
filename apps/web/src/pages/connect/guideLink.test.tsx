// The field-guide link on every connect screen (#136).
//
// The problem it guards: each provider's card states the short path, but the full walkthrough — every
// console screen, the traps, the debugging paths — lives in that provider's field guide on
// getpostern.com, and until this unit nothing in the Console pointed there. Someone stuck mid-connect
// had no route from the screen they are stuck on to the page that unsticks them.
//
// What can go wrong, and is what each block below falsifies:
//   1. a screen ships with no link at all (the tenth provider, added later, is the likely one);
//   2. a link points at the WRONG guide — a 404 the Console cannot see, because nothing in this repo
//      knows the site's routes;
//   3. the derivation is replaced by a hardcoded lookalike — nine hand-typed URLs that are right the
//      day they are typed and wrong the day a page is renamed;
//   4. the `rel` guard is dropped, handing a `_blank` tab `window.opener` and a Referer;
//   5. something about this gate is appended to the URL as a parameter;
//   6. the convention leaks — some other address in the step copy becomes an anchor too.
//
// These are the FIRST live external anchors in the connect flow. Before this unit every URL on these
// screens rendered as text, which is why (6) is a real risk and gets its own cell.

import "../../api/test-dom";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { ConnectProvider } from "./ConnectProvider";
import { PROVIDERS, type ProviderDef } from "./catalog";
import { renderAt } from "./testutil";

const routes = [
  { pattern: "/connect/:provider", element: <ConnectProvider /> },
  { pattern: "/connect", element: <div>Add a source page</div> },
  { pattern: "/sources", element: <div>Sources page</div> },
];

/**
 * The guide slugs the DOCS site (docs.getpostern.com) publishes for connectable sources under
 * `/connect/` — fixed by the docs site's sitemap, 2026-08-08 (#149; the guides moved off the
 * landing site). `gmail` is a docs-side redirect to the google guide, mirroring the landing
 * site's alias. `remote-access` is a guide but not a connectable source; it is published under
 * `/start/`, not `/connect/` (see REMOTE_ACCESS_GUIDE_URL). The docs also publish
 * `/connect/chatgpt`, which no catalog entry links — outside this contract.
 *
 * Written out by hand on purpose: importing the catalog's own slugs to build the expectation would
 * make a renamed slug agree with itself and prove nothing.
 */
const PUBLISHED_GUIDE_SLUGS = [
  "google",
  "gmail",
  "microsoft",
  "icloud",
  "plaid",
  "simplefin",
  "whoop",
  "home-assistant",
  "apple-health",
  "remote-access",
];

/** The URL each connect screen must carry — spelled out here, never via `guideUrl`, so a broken
 *  derivation cannot satisfy this file by agreeing with itself. */
function expectedGuideUrl(slug: string): string {
  return `https://docs.getpostern.com/connect/${slug}`;
}

/** Every anchor on the rendered screen, split by where it goes. In-app navigation is `<Link>` and
 *  emits a root-relative href; anything with a scheme is leaving the Console. */
function anchors(container: HTMLElement): { external: HTMLAnchorElement[]; internal: HTMLAnchorElement[] } {
  const all = [...container.querySelectorAll("a")] as HTMLAnchorElement[];
  const external = all.filter((a) => /^[a-z][a-z0-9+.-]*:/i.test(a.getAttribute("href") ?? ""));
  return { external, internal: all.filter((a) => !external.includes(a)) };
}

/** The one external anchor on a connect screen, asserted to be exactly one before it is returned. */
function guideAnchor(container: HTMLElement, slug: string): HTMLAnchorElement {
  const { external } = anchors(container);
  expect(external.map((a) => a.getAttribute("href")), `/connect/${slug}`).toHaveLength(1);
  return external[0];
}

beforeEach(() => {
  vi.spyOn(api, "healthz").mockResolvedValue({ ok: true });
  vi.spyOn(api, "listConnectors").mockResolvedValue([]);
  vi.spyOn(api, "oauthRedirectUri").mockImplementation(
    async (provider: string) => `http://localhost:8787/api/oauth/${provider}/callback`,
  );
  // The Plaid screen asks on mount; unmocked it would reach for a real gateway. Its answer is
  // irrelevant here — the guide link is in the steps column, which never sees it.
  vi.spyOn(api, "plaidAppStatus").mockResolvedValue({
    configured: false,
    clientId: null,
    env: "production",
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the catalog slug IS the guide slug (#136 — the whole mapping)", () => {
  it("every connectable source's slug is one the site publishes a guide for", () => {
    // Vacuity guard: an emptied catalog would make the loop below trivially true.
    expect(PROVIDERS).toHaveLength(9);
    for (const p of PROVIDERS) {
      expect(PUBLISHED_GUIDE_SLUGS, `no published guide for slug "${p.slug}"`).toContain(p.slug);
    }
  });

  it("covers every published guide except remote-access, which is not a connectable source", () => {
    const covered = PROVIDERS.map((p) => p.slug).sort();
    expect(covered).toEqual(PUBLISHED_GUIDE_SLUGS.filter((s) => s !== "remote-access").sort());
  });

  it("no slug can carry a character that would change the URL's shape", () => {
    // The reason `guideUrl` encodes: a slug with a `/`, `?` or `#` in it would silently become a
    // different path, a query string, or a fragment on a live external URL.
    for (const p of PROVIDERS) expect(p.slug).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("every connect screen links its own field guide", () => {
  // The walk. Nine screens, four custody shapes, one assertion set — so a shape that renders its own
  // right card (Apple Health's ingest flow) cannot quietly be the one without a link.
  it("all nine carry exactly one external link, and it is that provider's guide", () => {
    expect(PROVIDERS).toHaveLength(9);
    for (const p of PROVIDERS) {
      const { container } = renderAt(`/connect/${p.slug}`, routes);
      const link = guideAnchor(container, p.slug);
      expect(link.getAttribute("href"), `/connect/${p.slug}`).toBe(expectedGuideUrl(p.slug));
      cleanup();
    }
  });

  it("all nine open away from the half-filled form, with the rel guard intact", () => {
    for (const p of PROVIDERS) {
      const { container } = renderAt(`/connect/${p.slug}`, routes);
      const link = guideAnchor(container, p.slug);
      // `_blank` is the product call: the reader is mid-connect, and following the guide in place
      // discards a half-filled form — on a paste screen, a token they cannot get back.
      expect(link.getAttribute("target"), `/connect/${p.slug}`).toBe("_blank");
      // …which is exactly what makes the rel guard load-bearing: a `_blank` tab is handed
      // `window.opener` and a Referer without it.
      const rel = (link.getAttribute("rel") ?? "").split(/\s+/);
      expect(rel, `/connect/${p.slug}`).toContain("noopener");
      expect(rel, `/connect/${p.slug}`).toContain("noreferrer");
      cleanup();
    }
  });

  it("all nine reach the guide over https, with no parameter and no fragment", () => {
    for (const p of PROVIDERS) {
      const { container } = renderAt(`/connect/${p.slug}`, routes);
      const url = new URL(guideAnchor(container, p.slug).href);
      expect(url.protocol, `/connect/${p.slug}`).toBe("https:");
      expect(url.host, `/connect/${p.slug}`).toBe("docs.getpostern.com");
      expect(url.pathname, `/connect/${p.slug}`).toBe(`/connect/${p.slug}`);
      // Nothing about this gate travels to the public site — not the host, not a connection id, not
      // which step failed.
      expect(url.search, `/connect/${p.slug}`).toBe("");
      expect(url.hash, `/connect/${p.slug}`).toBe("");
      cleanup();
    }
  });

  it("reads as what it is: a fuller walkthrough, elsewhere", () => {
    const { container } = renderAt("/connect/whoop", routes);
    const link = guideAnchor(container, "whoop");
    // Named for the provider it belongs to (nine screens, nine different destinations), described as
    // the FULL guide (the steps above are the short path), and it says out loud that it leaves.
    expect(link.textContent).toMatch(/full/i);
    expect(link.textContent).toContain("Whoop");
    expect(link.textContent).toMatch(/guide/i);
    expect(link.textContent).toContain("docs.getpostern.com");
  });
});

describe("the URL is DERIVED from the slug, in one place", () => {
  /**
   * The mutation this cell exists for: replace `guideUrl` with a hand-written nine-entry lookup — or
   * with nine literals on the defs — and every assertion above still passes, because all nine are
   * right the day they are typed. What no hardcoded table can do is answer for a source it has never
   * seen.
   *
   * So: put a source in the catalog that no author could have typed a URL for, and ask the screen.
   */
  it("a source the catalog has never seen still gets the right guide link", () => {
    const synthetic: ProviderDef = {
      slug: "a-source-no-one-hardcoded",
      providerKey: "gmail", // any registered key; nothing here talks to a backend
      tile: "gmail",
      name: "Test Source",
      custody: "paste",
      sectors: ["mail"],
      connectSector: "mail",
      cardSub: "—",
      cardSectorRun: "Mail",
      mastheadSub: "—",
      stepsHeader: "Do the thing",
      steps: [{ before: "Do the thing at the source." }],
      footnote: "—",
      formHeader: "Paste it here",
      fields: [{ label: "Token", placeholder: "paste it", wire: "secret" }],
      cta: "Connect Test Source",
      createsLine: "— from this one credential.",
    };

    PROVIDERS.push(synthetic);
    try {
      const { container } = renderAt(`/connect/${synthetic.slug}`, routes);
      // The screen really rendered (not the "No such source" zero-state), so the absence of a link
      // below would be an absence, not a miss.
      expect(screen.getByText("Do the thing")).toBeTruthy();
      const link = guideAnchor(container, synthetic.slug);
      expect(link.getAttribute("href")).toBe(
        "https://docs.getpostern.com/connect/a-source-no-one-hardcoded",
      );
    } finally {
      PROVIDERS.splice(PROVIDERS.indexOf(synthetic), 1);
    }
    expect(PROVIDERS).toHaveLength(9);
  });

  /**
   * And the static half: a guide URL written out anywhere but the one derivation file. The
   * behavioural cell above catches a lookup table; this one catches the shape that would pass it —
   * a correct derivation PLUS a stray literal beside it, which is how a second source of truth
   * starts.
   */
  it("no shipped file in the group writes a guide URL except the one that derives it", () => {
    const shipped = groupSource();
    // Vacuity guard: a glob that matched nothing, or an excluded catalog.ts, would make both
    // assertions below trivially true.
    expect(Object.keys(shipped).sort()).toEqual(
      ["AddASource.tsx", "ConnectProvider.tsx", "catalog.ts", "connectApi.ts", "index.ts", "ingestPayload.ts", "parts.tsx"].sort(),
    );
    // The URL prefix, not the bare host: "at docs.getpostern.com →" is a link's own TEXT; only a
    // written-out URL literal is a second source of truth.
    expect(shipped["catalog.ts"]).toContain("https://docs.getpostern.com");

    for (const [name, text] of Object.entries(shipped)) {
      if (name === "catalog.ts") continue;
      expect(text, `${name} writes its own guide URL`).not.toContain("https://docs.getpostern.com");
    }
  });

  it("no guide URL anywhere in the group carries a parameter or a fragment", () => {
    // The static twin of the runtime check: `?from=…`, `#step-2`, or anything else appended to a
    // guide URL in source. Nothing about a person's gate belongs on the public site.
    for (const [name, text] of Object.entries(groupSource())) {
      expect(text, `${name} appends something to a guide URL`).not.toMatch(
        /docs\.getpostern\.com[^\s"'`]*[?#]/,
      );
    }
  });
});

describe("the anchor convention does not leak", () => {
  /**
   * Every other address on these screens is a PROVIDER's console — appleid.apple.com,
   * entra.microsoft.com, myaccount.google.com/apppasswords, dashboard.plaid.com — and each stays
   * text. A link is a promise about where it goes, and those are pages we neither own nor can keep
   * in step; the guide is the one target we publish ourselves.
   *
   * MUTATION: turn any of these into an <a> → red, on the count in `guideAnchor`.
   */
  it.each([
    ["gmail", "myaccount.google.com/apppasswords"],
    ["google", "console.cloud.google.com"],
    ["microsoft", "entra.microsoft.com"],
    ["icloud", "appleid.apple.com"],
    ["simplefin", "bridge.simplefin.org"],
    ["plaid", "dashboard.plaid.com"],
    ["whoop", "developer.whoop.com"],
  ])("%s: the provider's own console is still text, never an anchor", (slug, address) => {
    const { container } = renderAt(`/connect/${slug}`, routes);
    // The address is genuinely on the screen — otherwise the negative below would be about nothing.
    expect(container.textContent).toContain(address);
    const link = guideAnchor(container, slug);
    expect(link.getAttribute("href")).toBe(expectedGuideUrl(slug));
    for (const a of anchors(container).external) {
      expect(a.getAttribute("href"), `${address} became an anchor`).not.toContain(address);
    }
  });

  it("in-app navigation is untouched — the back link is still a route, not a URL", () => {
    const { container } = renderAt("/connect/gmail", routes);
    const back = anchors(container).internal.find((a) => a.textContent?.includes("Add a source"));
    expect(back?.getAttribute("href")).toBe("/connect");
  });
});

describe("Apple Health — the screen whose right card is not a form", () => {
  /**
   * The one screen the shared template could plausibly have missed: its custody is `device`, its
   * right card mints an ingest endpoint rather than collecting a credential, and it has TWO states.
   * The guide link lives in the shared steps column, so it must survive the mint — asserted rather
   * than assumed.
   */
  it("carries the guide before the endpoint is minted and after", async () => {
    vi.spyOn(api, "addCredential").mockResolvedValue({
      credentialId: "cred1",
      provider: "apple_health",
      status: "active",
    });
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

    const { container } = renderAt("/connect/apple-health", routes);
    expect(guideAnchor(container, "apple-health").getAttribute("href")).toBe(
      expectedGuideUrl("apple-health"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Create your ingest endpoint" }));
    expect(await screen.findByText("/api/ingest/abc123")).toBeTruthy();

    // Still exactly one external anchor — the minted branch neither dropped it nor added a second.
    expect(guideAnchor(container, "apple-health").getAttribute("href")).toBe(
      expectedGuideUrl("apple-health"),
    );
    // And the minted values stayed off the public URL.
    expect(guideAnchor(container, "apple-health").href).not.toContain("abc123");
    expect(guideAnchor(container, "apple-health").href).not.toContain("whsec");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url)); // apps/web/src/pages/connect

/** Every SHIPPED source file of the connect group, by basename. Tests and the test-only helper are
 *  excluded — they legitimately write the URL out, and asserting on themselves is circular. */
function groupSource(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(HERE)) {
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name) || name === "testutil.tsx") continue;
    out[name] = readFileSync(join(HERE, name), "utf8");
  }
  return out;
}

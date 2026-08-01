// The exposure derivations — the four questions every surface asks about the gate's address.
//
// Each cell below names the mutation that must turn it RED (run, observed, reverted; the table is in
// `docs/specs/notes/console-exposure-surface-console.md`). The repo's signature defect is a guard
// that agrees with the code instead of constraining it, and two of these are exactly the shape that
// invites it: a `displayEndpoint` test whose fixtures never disagree passes against ANY precedence
// order, and a `restartCell` test with only the on/off fixtures passes against a two-state boolean.
// So the fixtures deliberately DISAGREE — `changed_not_live` has a different address in `configured`
// and in `serving`, and `cleared_still_live` exists at all.

import { describe, expect, it } from "vitest";
import {
  EXPOSURE_UNANSWERED,
  defaultExpiryDays,
  displayEndpoint,
  restartCell,
  routeSentence,
} from "./exposure";
import type { BridgeRouteAuth, ExposureStatus } from "./types";

/** Two DIFFERENT public addresses — the whole point of the changed-not-live fixture. */
const LIVE_URL = "https://live.example.ts.net";
const SAVED_URL = "https://saved.example.ts.net";
/** A local MCP endpoint that is not either of them, so a fallback can never masquerade as a hit. */
const LOCAL = "http://localhost:9191/mcp";

function status(over: Partial<ExposureStatus> = {}): ExposureStatus {
  return {
    configured: null,
    serving: null,
    restartRequired: false,
    localEndpoint: LOCAL,
    publishedRoutes: [],
    problem: null,
    ...over,
  };
}

const OFF = status();
const NOTHING_AT_ALL = status({ localEndpoint: null });
const LIVE = status({
  configured: { publicUrl: LIVE_URL, source: "db", consentedAt: "2026-07-26T00:00:00.000Z" },
  serving: { publicUrl: LIVE_URL },
});
const SAVED_NOT_LIVE = status({
  configured: { publicUrl: SAVED_URL, source: "db", consentedAt: "2026-07-26T00:00:00.000Z" },
  serving: null,
  restartRequired: true,
});
const CLEARED_STILL_LIVE = status({
  configured: null,
  serving: { publicUrl: LIVE_URL },
  restartRequired: true,
});
const CHANGED_NOT_LIVE = status({
  configured: { publicUrl: SAVED_URL, source: "db", consentedAt: "2026-07-26T00:00:00.000Z" },
  serving: { publicUrl: LIVE_URL },
  restartRequired: true,
});

describe("displayEndpoint", () => {
  // MUTATION: prefer `configured` over `serving` → RED on the changed-not-live cell (SAVED_URL
  // instead of LIVE_URL). Every other fixture agrees with itself, which is exactly why that one
  // fixture has to exist — without it this test passes against either precedence order.
  //
  // MUTATION (#131 — the shipped defect): return the bare `publicUrl`, dropping the `/mcp` append,
  // → RED on every published cell. The gate's saved address is an origin (#126) and the MCP edge
  // answers only at `/mcp` on it, so handing out the origin sent every claude.ai connect to a root
  // that 404s. The fixtures here are bare origins BECAUSE that is the shape the gateway really
  // serves — the original page test put `/mcp` into `serving.publicUrl` itself, and a fixture that
  // arrives pre-fixed is exactly how this defect shipped under green.
  it("hands out the MCP endpoint of what is actually reachable — never the bare origin, never what was merely typed in", () => {
    expect(displayEndpoint(CHANGED_NOT_LIVE)).toBe(`${LIVE_URL}/mcp`); // serving beats configured
    expect(displayEndpoint(LIVE)).toBe(`${LIVE_URL}/mcp`);
    expect(displayEndpoint(CLEARED_STILL_LIVE)).toBe(`${LIVE_URL}/mcp`); // still reachable, so still shown
    expect(displayEndpoint(SAVED_NOT_LIVE)).toBe(`${SAVED_URL}/mcp`); // configured beats the local fallback
    expect(displayEndpoint(OFF)).toBe(LOCAL); // the local fallback is served WITH its path — never doubled
    // Nothing served and nothing local: an ABSENCE, never a placeholder address.
    expect(displayEndpoint(NOTHING_AT_ALL)).toBeNull();
    expect(displayEndpoint(undefined)).toBeNull();
  });

  // MUTATION: append blindly (`publicUrl + "/mcp"`) → RED on the slash cell (`//mcp`). And a shape
  // the gateway should never serve but a page must survive: an unreadable value is handed through
  // UNCHANGED for the caller's classifier to name — never "corrected" into a plausible address,
  // never thrown on (there is no ErrorBoundary above any exposure surface).
  it("normalizes what it can read and refuses to invent an address from what it can't", () => {
    expect(displayEndpoint(status({ serving: { publicUrl: `${LIVE_URL}/` } }))).toBe(`${LIVE_URL}/mcp`);
    expect(displayEndpoint(status({ serving: { publicUrl: "not a url" } }))).toBe("not a url");
  });
});

describe("restartCell", () => {
  // MUTATION: collapse `cleared_still_live` into `none` (`if (configured === null) return "none"`)
  // → RED. That is the safety-critical direction: it is the cell that stops a user who clicked
  // *Stop publishing* from believing they are private while the edge is still serving.
  it("each of the four restart situations gets its own answer", () => {
    expect(restartCell(OFF)).toBe("none");
    expect(restartCell(LIVE)).toBe("none");
    expect(restartCell(SAVED_NOT_LIVE)).toBe("saved_not_live");
    expect(restartCell(CLEARED_STILL_LIVE)).toBe("cleared_still_live");
    expect(restartCell(CHANGED_NOT_LIVE)).toBe("changed_not_live");
    expect(restartCell(undefined)).toBe("none");

    // All four values are actually reachable — a mapping that can only ever answer two of them is
    // not four sentences, and `toBe` on each fixture alone would not notice.
    const seen = new Set(
      [OFF, LIVE, SAVED_NOT_LIVE, CLEARED_STILL_LIVE, CHANGED_NOT_LIVE].map(restartCell),
    );
    expect(seen).toEqual(new Set(["none", "saved_not_live", "cleared_still_live", "changed_not_live"]));
  });
});

describe("defaultExpiryDays", () => {
  // MUTATION: always return null → the first cell RED. Always return 90 → the second RED.
  it("a key minted for a published gate defaults to expiring", () => {
    expect(defaultExpiryDays(LIVE)).toBe(90);
    expect(defaultExpiryDays(SAVED_NOT_LIVE)).toBe(90);
    expect(defaultExpiryDays(OFF)).toBeNull();
    expect(defaultExpiryDays(undefined)).toBeNull();
  });
});

describe("the sentence for a read that FAILED (spec §Decision 7)", () => {
  // The defect this constant exists to end: five of the six exposure surfaces rendered
  // `exposure.data?.x ?? null` on error and printed a fact about the BOX — "This gateway isn't
  // running an MCP edge… Set MCP_HTTP_PORT on the box and restart it" — in response to an
  // ECONNREFUSED. This asserts the shape of the sentence, not just that one exists.
  //
  // MUTATION: point EXPOSURE_UNANSWERED at the `NO_MCP_ENDPOINT` copy (or append "Set
  // MCP_HTTP_PORT on the box and restart it." to it) → RED on the instruction assertions.
  it("a failed read never instructs the user to go change their box", () => {
    expect(EXPOSURE_UNANSWERED.length).toBeGreaterThan(40);
    // It says the REQUEST failed…
    expect(EXPOSURE_UNANSWERED).toMatch(/request failed/i);
    // …and it names no environment variable, asks for no restart of the gateway, and makes no
    // claim about how the gate is configured — a dropped request carries none of that.
    expect(EXPOSURE_UNANSWERED).not.toMatch(/MCP_HTTP_PORT|MCP_PUBLIC_URL/);
    expect(EXPOSURE_UNANSWERED).not.toMatch(/on the box/i);
    expect(EXPOSURE_UNANSWERED).not.toMatch(/isn.t running|isn.t serving|has published nothing/i);
  });
});

describe("routeSentence", () => {
  /**
   * Every member of the union, as a Record so the COMPILER enforces exhaustiveness: adding a sixth
   * `BridgeRouteAuth` fails to typecheck here AND in `routeSentence`'s switch. That compile error is
   * the guard — a runtime "unknown class" branch would white-screen Settings (no ErrorBoundary).
   */
  const AUTH_CLASSES: Record<BridgeRouteAuth, true> = {
    open_no_user_data: true,
    open_write: true,
    code_gated: true,
    key_login: true,
    bearer_gated: true,
  };
  const ALL = Object.keys(AUTH_CLASSES) as BridgeRouteAuth[];

  // MUTATION: add a sixth member to `BridgeRouteAuth` → compile error in both places (verified).
  // Second mutation: return the same string for two classes → the distinctness assertion RED.
  it("every way a route can be guarded has a sentence a non-expert can act on", () => {
    expect(ALL).toHaveLength(5);
    const sentences = ALL.map(routeSentence);
    for (const s of sentences) {
      expect(s.length).toBeGreaterThan(20);
      // Plain language, not the wire vocabulary: this paragraph is read by someone deciding whether
      // to open their gate to the internet, not by whoever wrote the route table.
      expect(s).not.toMatch(/PKCE|DCR|bearer_gated|oauth/i);
    }
    expect(new Set(sentences).size).toBe(ALL.length);

    // The one that matters most says what is behind it, in the reader's words.
    expect(routeSentence("bearer_gated")).toMatch(/Your data/);
    // …and the unauthenticated write admits it writes.
    expect(routeSentence("open_write")).toMatch(/writes a row/);
  });
});

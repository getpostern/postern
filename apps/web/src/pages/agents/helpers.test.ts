// Pure helper tests — the derivations three agent pages agree on, with the degradation branches the
// group exists to get right (#80/#89).

import { describe, it, expect } from "vitest";
import type { Agent } from "../../api/types";
import {
  PASSAGE_LOWER_BOUND_NOTE,
  PASSAGE_NOT_REPORTED,
  REMOVE_BLAST_RADIUS,
  REVOKE_BLAST_RADIUS,
  agentStatusOf,
  expiryPhrase,
  expiryPresetFor,
  expirySelection,
  grantSummary,
  isExpiryChipOn,
  passageDisplay,
  sectorReads,
} from "./helpers";

const DAY = 86_400_000;
const NOW = Date.parse("2026-07-23T12:00:00.000Z");

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

describe("passageDisplay — the three passage answers (#80/#89)", () => {
  it("undefined last_seen_at → NOT SERVED, never 'never'", () => {
    // A gateway older than the field omits it entirely. Still reachable, still a different fact.
    const a = agent();
    expect("last_seen_at" in a).toBe(false);
    expect(passageDisplay(a)).toEqual({ kind: "not_served" });
  });

  it("null last_seen_at → served-but-never (a genuinely quiet key)", () => {
    expect(passageDisplay(agent({ last_seen_at: null }))).toEqual({ kind: "never" });
  });

  it("a served timestamp → the instant, for rendering with ago()", () => {
    expect(passageDisplay(agent({ last_seen_at: "2026-07-23T11:00:00.000Z" }))).toEqual({
      kind: "at",
      iso: "2026-07-23T11:00:00.000Z",
    });
  });

  it("distinguishes not-served from never (the whole of #58)", () => {
    // These two must never collapse to the same rendering: one is a fact about the wire, the other
    // a fact about the key.
    expect(passageDisplay(agent()).kind).not.toBe(passageDisplay(agent({ last_seen_at: null })).kind);
  });
});

describe("agentStatusOf", () => {
  it("revoked wins over everything", () => {
    expect(agentStatusOf(agent({ revoked_at: "2026-05-01T00:00:00Z", expires_at: "2020-01-01T00:00:00Z" }), NOW)).toBe(
      "revoked",
    );
  });
  it("expired is computed from served expires_at vs now", () => {
    expect(agentStatusOf(agent({ expires_at: new Date(NOW - DAY).toISOString() }), NOW)).toBe("expired");
    expect(agentStatusOf(agent({ expires_at: new Date(NOW + DAY).toISOString() }), NOW)).toBe("active");
  });
  it("never-expiring is active", () => {
    expect(agentStatusOf(agent({ expires_at: null }), NOW)).toBe("active");
  });
});

describe("expiryPhrase", () => {
  it("null/undefined → never expires", () => {
    expect(expiryPhrase(null, NOW)).toBe("never expires");
    expect(expiryPhrase(undefined, NOW)).toBe("never expires");
  });
  it("future → expires in Nd", () => {
    expect(expiryPhrase(new Date(NOW + 60 * DAY).toISOString(), NOW)).toBe("expires in 60d");
  });
  it("past → expired", () => {
    expect(expiryPhrase(new Date(NOW - DAY).toISOString(), NOW)).toBe("expired");
  });
});

describe("expiryPresetFor — rotate preload rounds to a preset, never invents a number", () => {
  it("null when never-expiring", () => {
    expect(expiryPresetFor(null, NOW)).toBe(null);
  });
  it("rounds a ~60-day key back to 60", () => {
    expect(expiryPresetFor(new Date(NOW + 60 * DAY + 1000).toISOString(), NOW)).toBe(60);
  });
  it("null (re-pick) when far from any preset", () => {
    expect(expiryPresetFor(new Date(NOW + 200 * DAY).toISOString(), NOW)).toBe(null);
  });
});

describe("expirySelection — which chip the SERVED deadline sits on", () => {
  it("null/undefined → never (the chip that clears a deadline)", () => {
    expect(expirySelection(null, NOW)).toEqual({ kind: "never" });
    expect(expirySelection(undefined, NOW)).toEqual({ kind: "never" });
    expect(isExpiryChipOn(expirySelection(null, NOW), null)).toBe(true);
    expect(isExpiryChipOn(expirySelection(null, NOW), 30)).toBe(false);
  });

  it("a deadline near a preset → that preset", () => {
    expect(expirySelection(new Date(NOW + 60 * DAY + 1000).toISOString(), NOW)).toEqual({
      kind: "preset",
      days: 60,
    });
    expect(isExpiryChipOn(expirySelection(new Date(NOW + 60 * DAY).toISOString(), NOW), 60)).toBe(true);
  });

  /**
   * THE DEFECT this function exists to prevent. `expiryPresetFor` folds "never expires" and "no preset
   * is close" into the same `null` — right for preloading the Rotate form, a false claim on a live
   * control: the Never chip would light up for a key whose own sub-line reads "expires in 200d". Any
   * deadline not within a day of 30/60/90 hits it, and `createAgent` takes 1..3650.
   *
   * MUTATION: select with `expiryPresetFor(...) === opt.days` instead → this test goes RED on the last
   * two assertions (Never claims a 200-day key).
   */
  it("a CUSTOM deadline lights NOTHING — it must never fall through to Never", () => {
    const custom = new Date(NOW + 200 * DAY).toISOString();
    expect(expirySelection(custom, NOW)).toEqual({ kind: "custom", days: 200 });
    for (const days of [null, 30, 60, 90]) {
      expect(isExpiryChipOn(expirySelection(custom, NOW), days)).toBe(false);
    }
    // The fold that would have made this wrong, kept visible: both answer null.
    expect(expiryPresetFor(custom, NOW)).toBe(null);
    expect(expiryPresetFor(null, NOW)).toBe(null);
    expect(expirySelection(custom, NOW)).not.toEqual(expirySelection(null, NOW));
  });

  it("a lapsed deadline is its own case, and lights nothing either", () => {
    const past = new Date(NOW - DAY).toISOString();
    expect(expirySelection(past, NOW)).toEqual({ kind: "expired" });
    for (const days of [null, 30, 60, 90]) {
      expect(isExpiryChipOn(expirySelection(past, NOW), days)).toBe(false);
    }
  });

  it("agrees with expiryPhrase on the same key — two renderings of one fact", () => {
    // An unusable timestamp reads as "never expires" in the sub-line; the chip row must not disagree.
    expect(expiryPhrase("not-a-date", NOW)).toBe("never expires");
    expect(expirySelection("not-a-date", NOW)).toEqual({ kind: "never" });
  });
});

describe("sectorReads — which grants this key has actually reached", () => {
  it("undefined last_read_at → null, so no line is drawn at all", () => {
    // An empty list would render as "it has used none of its grants" — a claim, from a gateway that
    // said nothing.
    expect(sectorReads(agent({ sectors: ["mail"] }))).toBe(null);
  });

  it("served {} → every granted sector is 'nothing recorded', none invented", () => {
    expect(sectorReads(agent({ sectors: ["finance", "mail"], last_read_at: {} }))).toEqual({
      read: [],
      unread: ["finance", "mail"],
    });
  });

  it("a missing sector KEY is no recorded read THERE — not the grant being absent", () => {
    const a = agent({ sectors: ["finance", "mail"], last_read_at: { mail: "2026-07-23T11:00:00.000Z" } });
    expect(sectorReads(a)).toEqual({
      read: [{ sector: "mail", iso: "2026-07-23T11:00:00.000Z" }],
      unread: ["finance"],
    });
  });

  it("a read in a sector this key no longer holds is not listed under its current grants", () => {
    // The grant came off since; the ledger still has the call. This line's subject is the grant set.
    const a = agent({ sectors: ["finance"], last_read_at: { mail: "2026-07-23T11:00:00.000Z" } });
    expect(sectorReads(a)).toEqual({ read: [], unread: ["finance"] });
  });

  it("lists in canonical SECTORS order, ignoring unknown tokens on the grant", () => {
    const a = agent({ sectors: ["home", "bogus", "finance"], last_read_at: {} });
    expect(sectorReads(a)?.unread).toEqual(["finance", "home"]);
  });
});

describe("grantSummary — register cell / reveal recap", () => {
  it("all six → every", () => {
    expect(grantSummary(["finance", "mail", "calendar", "contacts", "health", "home"])).toEqual({ kind: "all" });
  });
  it("none → none (a default-deny key)", () => {
    expect(grantSummary([])).toEqual({ kind: "none" });
  });
  it("some → canonical-order chips, ignoring unknown tokens", () => {
    expect(grantSummary(["home", "finance", "bogus"])).toEqual({ kind: "some", sectors: ["finance", "home"] });
  });
});

/**
 * The copy this page group SHARES, and what each shared sentence is not allowed to say (#106).
 *
 * Every string here was duplicated across two or three of the four agent screens before this sweep —
 * two blast radii verbatim in `AgentsPage` and `AgentDetailPage`, two different phrasings of one
 * passage absence. This page group has already been bitten by duplicate vocabulary twice (two provider
 * display tables, two sector-label tables), and a blast-radius sentence is the worst possible place for
 * two copies to disagree: it is the last thing a person reads before revoking a key.
 *
 * These are asserted as SENTENCES, not as non-emptiness — a copy test that only checks a string is
 * present passes with the jargon back in.
 */
describe("the shared agent copy (#106)", () => {
  it("the passage absence is a fact about the ANSWER, never a claim about the gateway's behaviour", () => {
    // "not recorded by this gateway" / "this gateway doesn't record passage per key" both asserted what
    // the gateway DOES. All the Console saw was a missing field.
    // MUTATION: revert either page to its own phrasing → RED (both pages assert this constant).
    expect(PASSAGE_NOT_REPORTED).toBe("not reported by this gateway");
    expect(PASSAGE_NOT_REPORTED).not.toMatch(/record|serve|wire|field/i);
  });

  it("the revoke blast radius keeps every fact, and drops every noun that is ours", () => {
    // The four facts, each load-bearing. Naming the hosted client is the one that must not weaken:
    // UNDERSTATING what dies with the key is the dangerous direction on this screen.
    expect(REVOKE_BLAST_RADIUS).toMatch(/stops working immediately/);
    expect(REVOKE_BLAST_RADIUS).toMatch(/claude\.ai/); // which tokens die with it, by name
    expect(REVOKE_BLAST_RADIUS).toMatch(/ChatGPT/); // BOTH hosted clients, since the 2026-08-01 witness (#141)
    expect(REVOKE_BLAST_RADIUS).toMatch(/ledger are kept/); // the trail survives
    // The honest limit on how instant a revoke is — grants resolve once per session. Softening this to
    // "takes effect immediately" is the overclaim the sentence exists to refuse.
    expect(REVOKE_BLAST_RADIUS).toMatch(/already under way/);
    expect(REVOKE_BLAST_RADIUS).toMatch(/the next one is denied/);
    // …and none of the vocabulary #106 bans from a person-facing string.
    expect(REVOKE_BLAST_RADIUS).not.toMatch(/bridge|bearer|audit|in-flight|rotating/i);
  });

  it("the remove blast radius still says the thing that makes it safe — nothing changes", () => {
    expect(REMOVE_BLAST_RADIUS).toMatch(/already revoked, so no access changes/);
    expect(REMOVE_BLAST_RADIUS).toMatch(/ledger survive the delete/);
    expect(REMOVE_BLAST_RADIUS).not.toMatch(/audit/i);
  });

  it("the lower-bound note says WHICH WAY the number can be wrong, in nobody's jargon", () => {
    // Without the direction the figure is unsafe to revoke on; with it, a quiet reading is never an
    // overstatement. Already #106-clean before this sweep — pinned so it stays that way.
    expect(PASSAGE_LOWER_BOUND_NOTE).toMatch(/quieter here than it really was, never busier/);
    expect(PASSAGE_LOWER_BOUND_NOTE).not.toMatch(/audit_log|served|invariant|fire-and-forget/i);
  });
});

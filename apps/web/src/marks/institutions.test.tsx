// The institution two-tier resolver, AGAINST THE PLATE — every plate label takes its plate treatment,
// and all 41 are accounted for.
//
// ⚠️ THIS FILE IS THE PLATE'S SIDE OF THE CONTRACT, NOT A COVERAGE CLAIM. It was fully green while
// most of a real gateway's institutions wore the neutral tile, because a test written in the plate's
// vocabulary cannot see a string the plate never uses. The other two directions live elsewhere:
// `institutions.domain.test.tsx` (the DOMAIN path — the general fix, and the primary key now that
// `orgDomain` IS served) and `institutions.served.test.tsx` (the census of QUALIFIED display-string
// shapes, and the alias table's own laws).
//
// Two rules are enforced HERE, in code, because review has already failed to catch both:
//   1. the ~32px wordmark rule (build-notes §13.2 — Amex read as a blue smudge at 22px on five
//      artboards before anyone noticed), and
//   2. EXACT matching on the display-name FALLBACK path — a substring match would let "First National
//      Bank of Discovery" wear the Discover mark. (Note for anyone reading an old comment: `orgDomain`
//      is no longer unserved. #89 item 3 landed, exactness is no longer the *whole* safety property,
//      and it is still non-negotiable on both paths.)

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  resolveInstitutionMark,
  normaliseInstitutionName,
  CRAFTED_INSTITUTION_KEYS,
  WORDMARK_MIN_SIZE,
  NEUTRAL_MONOGRAM_HEX,
} from "./institutions";
import { InstitutionMark } from "./InstitutionMark";

describe("normaliseInstitutionName", () => {
  it("case-folds, strips punctuation and collapses whitespace", () => {
    expect(normaliseInstitutionName("  Capital   One  ")).toBe("capital one");
    expect(normaliseInstitutionName("U.S. Bank")).toBe("us bank");
    expect(normaliseInstitutionName("E*TRADE")).toBe("etrade");
    expect(normaliseInstitutionName("CHASE")).toBe("chase");
  });

  it("drops a leading 'the' and trailing legal suffixes only", () => {
    expect(normaliseInstitutionName("The Chase")).toBe("chase");
    expect(normaliseInstitutionName("TD Bank, N.A.")).toBe("td bank");
    expect(normaliseInstitutionName("Discover Inc.")).toBe("discover");
    // Never from the middle — that is how one institution turns into another.
    expect(normaliseInstitutionName("NA Trust Company of Boston")).toBe("na trust company of boston");
  });

  it("never collapses two different institutions onto one key", () => {
    expect(normaliseInstitutionName("Discover")).not.toBe(
      normaliseInstitutionName("First National Bank of Discovery"),
    );
  });
});

/**
 * The plate's tier-1 marks that are PORTED, as an independent transcription of `sec-institutions`
 * H1L-0: the label the plate prints, the id, the brand hex and the plate's own tilt. `InstitutionMark`
 * carries the same four facts; if the two lists disagree, one of them mis-read the plate and the run
 * goes red instead of a wrong-coloured mark reaching a surface.
 */
const PORTED: Array<{ label: string; id: string; hex: string; tilt: number }> = [
  { label: "Chase", id: "chase", hex: "#117ACA", tilt: -1.5 },
  { label: "Bank of America", id: "boa", hex: "#012169", tilt: 1.2 },
  { label: "HSBC", id: "hsbc", hex: "#DB0011", tilt: -0.8 },
  { label: "Barclays", id: "barclays", hex: "#00AEEF", tilt: 1.1 },
  { label: "Deutsche Bank", id: "deutschebank", hex: "#0018A8", tilt: -1.3 },
  { label: "Revolut", id: "revolut", hex: "#191C1F", tilt: 0.9 },
  { label: "Monzo", id: "monzo", hex: "#14233C", tilt: -1.1 },
  { label: "Starling Bank", id: "starling", hex: "#6935D3", tilt: 1.5 },
  { label: "N26", id: "n26", hex: "#48AC98", tilt: -1.2 },
  { label: "Wise", id: "wise", hex: "#163300", tilt: -0.9 },
  { label: "PayPal", id: "paypal", hex: "#002991", tilt: 1.1 },
  { label: "Cash App", id: "cashapp", hex: "#00C244", tilt: -1.4 },
  { label: "Zelle", id: "zelle", hex: "#6D1ED4", tilt: 0.8 },
  { label: "Mastercard", id: "mastercard", hex: "#EB001B", tilt: -1 },
  { label: "Robinhood", id: "robinhood", hex: "#00C805", tilt: 0.9 },
  { label: "Binance", id: "binance", hex: "#F0B90B", tilt: -1.1 },
];

describe("resolveInstitutionMark — the crafted tier", () => {
  it("resolves an exact crafted name to its crafted mark", () => {
    expect(resolveInstitutionMark("Chase", 22)).toEqual({ kind: "crafted", id: "chase" });
  });

  // The pin #107 §3 asked for: WHICH id each name resolves to, not merely that something renders. A
  // test that only asserted `kind === "crafted"` would pass with every name pointing at Chase's
  // octagon — sixteen banks wearing one bank's mark is a worse defect than sixteen neutral tiles.
  it.each(PORTED)("$label resolves to the $id vector, in $hex, at the plate's tilt", (mark) => {
    expect(resolveInstitutionMark(mark.label, 22)).toEqual({ kind: "crafted", id: mark.id });
    const markup = renderToStaticMarkup(<InstitutionMark institution={mark.label} />);
    expect(markup).toContain(`fill="${mark.hex}"`);
    expect(markup).toContain(`transform="rotate(${mark.tilt} 12 12)"`);
  });

  it("the transcription above is COMPLETE — no crafted name is missing from it", () => {
    // Closes the loop. `PORTED` is a second, independent read of the plate; `CRAFTED_INSTITUTION_KEYS`
    // is what the resolver actually stores. Without this, a mark could be ported into the resolver and
    // never checked here — which is how the hex and tilt of a new mark would go unasserted.
    expect([...CRAFTED_INSTITUTION_KEYS].sort()).toEqual(
      PORTED.map((m) => normaliseInstitutionName(m.label)).sort(),
    );
  });

  it("gives every ported mark a DISTINCT vector — no two names share a drawing", () => {
    // The failure this catches is a copy-paste port: a new entry added with the previous entry's `d`
    // still resolves to its own id and still carries its own hex, so every other assertion here
    // passes while two institutions wear the same shape.
    const geometry = PORTED.map(
      (m) => /\sd="([^"]+)"/.exec(renderToStaticMarkup(<InstitutionMark institution={m.label} />))![1],
    );
    expect(new Set(geometry).size).toBe(PORTED.length);
    const hexes = PORTED.map((m) => m.hex);
    expect(new Set(hexes).size).toBe(PORTED.length);
  });

  it("Bank of America is no longer a neutral 'B' — the defect #107 §3 reported", () => {
    // #107 §3: BofA missed CRAFTED, had no MONOGRAM row, and landed on the same warm-black tile an
    // unknown credit union gets. It is a tier-1 non-wordmark mark on the plate, so it takes its own
    // vector at every Console size, and it must never resolve to the neutral ground again.
    for (const size of [22, 24, 31, 32, 40]) {
      expect(resolveInstitutionMark("Bank of America", size)).toEqual({ kind: "crafted", id: "boa" });
    }
    const markup = renderToStaticMarkup(<InstitutionMark institution="Bank of America" size={22} />);
    expect(markup).toContain("<svg");
    expect(markup).toContain("#012169");
    expect(markup).not.toContain(NEUTRAL_MONOGRAM_HEX);
    expect(markup).not.toContain(">B<");
  });

  it("is case- and punctuation-insensitive but still exact", () => {
    expect(resolveInstitutionMark("  chase  ", 22)).toEqual({ kind: "crafted", id: "chase" });
    // ⚠️ THIS LINE USED TO READ `expect(resolveInstitutionMark("Chase Bank", 22).kind).toBe("monogram")`
    // and it was DELETED on 2026-07-26 because it PINNED THE DEFECT. "Chase Bank" is the exact string
    // Plaid serves for a Chase Item — `GET /api/finance/banks` puts it on the wire — so this
    // assertion required that the one bank the plate has had a vector for since the beginning must NOT
    // wear it. A test can be green and wrong, and this was the shape: an exactness canary written on a
    // string a provider actually sends. "Chase Bank" now reaches the chase vector
    // through the explicit `SERVED_NAME_ALIASES` table (`institutions.served.test.tsx` is the guard).
    //
    // The property it was reaching for — a longer string that merely CONTAINS a known name is not that
    // institution — is unchanged and now asserted on a string that names a different bank entirely.
    expect(resolveInstitutionMark("Chase Bank of the Ozarks", 22).kind).toBe("monogram");
    expect(resolveInstitutionMark("Chase Bank of the Ozarks", 22)).toEqual({
      kind: "monogram",
      initials: "C",
      hex: NEUTRAL_MONOGRAM_HEX,
    });
  });

  it("never sends a non-wordmark crafted mark to a monogram, at any size", () => {
    for (const size of [11, 15, 22, 31, 32, 40, 64]) {
      expect(resolveInstitutionMark("Chase", size)).toEqual({ kind: "crafted", id: "chase" });
    }
  });
});

describe("resolveInstitutionMark — the ~32px wordmark rule, KEPT ARMED with nothing left to arm it against", () => {
  // The crafted Amex and Discover logotypes were deleted 2026-07-25: no Console surface places a
  // mark at 32px or more (SourcesPage, SourcesBand and ConnectionDetail are all below it), so the
  // vectors were unreachable path data implying a coverage the app does not have. With them gone,
  // the 31→monogram / 32→crafted boundary can no longer be asserted with a real institution — so
  // the assertion moves to what still has teeth: the POLICY, which is what a future port must clear.
  it("keeps the rule armed for all five tier-1 wordmarks — none resolves to a vector at any size", () => {
    for (const name of ["Wells Fargo", "Goldman Sachs", "Visa", "American Express", "Discover"]) {
      expect(resolveInstitutionMark(name, 22).kind).toBe("monogram");
      expect(resolveInstitutionMark(name, WORDMARK_MIN_SIZE).kind).toBe("monogram");
      expect(resolveInstitutionMark(name, 64).kind).toBe("monogram");
    }
    // The threshold itself is the law's number and stays exactly 32 — the constant is the seam a
    // future crafted wordmark is gated on, so a drift here is a silent licence to re-ship a smudge.
    expect(WORDMARK_MIN_SIZE).toBe(32);
  });

  it("keeps Amex and Discover in their OWN brand colours — a tile is not a downgrade to neutral", () => {
    // The initials and hexes are brand facts recorded by the law, not vectors. Deleting a logotype
    // must not quietly turn an Amex row into a generic ink tile.
    expect(resolveInstitutionMark("American Express", 22)).toEqual({
      kind: "monogram",
      initials: "AX",
      hex: "#2E77BC",
    });
    expect(resolveInstitutionMark("Discover", 40)).toEqual({
      kind: "monogram",
      initials: "D",
      hex: "#FF6000",
    });
  });

  it("still routes a NON-wordmark crafted mark through the size branch untouched", () => {
    // Chase is a mark, not a logotype, so the rule must not catch it — the branch has to stay a
    // wordmark test rather than degenerating into "everything is a monogram now".
    expect(resolveInstitutionMark("Chase", WORDMARK_MIN_SIZE - 1)).toEqual({
      kind: "crafted",
      id: "chase",
    });
  });
});

describe("resolveInstitutionMark — the monogram is the DEFAULT branch, not an error path", () => {
  it("gives every tier-2 institution its plate initials and its official brand hex", () => {
    const expected: Array<[string, string, string]> = [
      ["Citi", "C", "#056DAE"],
      ["Capital One", "C1", "#CC2427"],
      ["U.S. Bank", "US", "#001E79"],
      ["PNC", "P", "#F58025"],
      ["Truist", "T", "#2D1A47"],
      ["TD Bank", "TD", "#003F2D"],
      ["Charles Schwab", "S", "#00A0DF"],
      ["Fidelity", "F", "#368727"],
      ["Vanguard", "V", "#96151D"],
      ["Ally", "A", "#481149"],
      ["Navy Federal", "NF", "#003767"],
      ["Interactive Brokers", "IB", "#D81222"],
      ["USAA", "U", "#002855"],
      ["SoFi", "So", "#00A9E0"],
      ["Chime", "Ch", "#1EC677"],
      ["E*TRADE", "E", "#6C3F98"],
      ["Morgan Stanley", "MS", "#002B5C"],
    ];
    for (const [name, initials, hex] of expected) {
      expect(resolveInstitutionMark(name, 22)).toEqual({ kind: "monogram", initials, hex });
    }
  });

  it("gives an unknown institution its initial on the neutral ink ground — never a blank, never a throw", () => {
    const resolved = resolveInstitutionMark("Kōbe Shinkin Bank", 22);
    expect(resolved).toEqual({ kind: "monogram", initials: "K", hex: NEUTRAL_MONOGRAM_HEX });
  });

  it("never invents a brand colour for an institution the law does not colour", () => {
    for (const name of ["Wells Fargo", "Goldman Sachs", "Visa", "Some Credit Union"]) {
      const resolved = resolveInstitutionMark(name, 22);
      expect(resolved.kind).toBe("monogram");
      if (resolved.kind === "monogram") expect(resolved.hex).toBe(NEUTRAL_MONOGRAM_HEX);
    }
  });

  it("still returns a mark for an empty or punctuation-only name", () => {
    expect(resolveInstitutionMark("", 22)).toEqual({
      kind: "monogram",
      initials: "?",
      hex: NEUTRAL_MONOGRAM_HEX,
    });
    expect(resolveInstitutionMark("—", 22).kind).toBe("monogram");
  });
});

describe("resolveInstitutionMark — no substring or fuzzy matching, ever", () => {
  it("does not let 'First National Bank of Discovery' pick up the Discover mark", () => {
    const resolved = resolveInstitutionMark("First National Bank of Discovery", 22);
    expect(resolved).toEqual({ kind: "monogram", initials: "F", hex: NEUTRAL_MONOGRAM_HEX });
    // The specific failure this guards: Discover's orange must not appear.
    if (resolved.kind === "monogram") expect(resolved.hex).not.toBe("#FF6000");
    expect(renderToStaticMarkup(<InstitutionMark institution="First National Bank of Discovery" />)).not.toContain(
      "FF6000",
    );
  });

  it("rejects every near-miss of a crafted name", () => {
    for (const name of [
      "Chase Sapphire",
      "JPMorgan Chase",
      "Discovery",
      "American Express Travel",
      "Express",
    ]) {
      expect(resolveInstitutionMark(name, 40).kind).toBe("monogram");
    }
  });
});

// ── the plate's 41, all accounted for ────────────────────────────────────────
//
// The plate approves 24 tier-1 brand marks + 17 tier-2 monogram tiles. This block is the arithmetic:
// every one of the 41 is either a ported vector, a brand-coloured tile, or on a NAMED list of the ones
// that deliberately still fall to the neutral ground — and the three lists have to add up to 41. That
// is what stops "we ported some marks" from being the end of the story: a plate label that is on none
// of the three lists fails, and the neutral list can only shrink on purpose.
//
// It also encodes the reason each neutral one is neutral, because they are NOT the same reason.

/** Plate labels that still resolve to the warm-ink initial, and why. */
const STILL_NEUTRAL: Array<{ label: string; because: string }> = [
  { label: "Wells Fargo", because: "tier-1 wordmark, no vector ported and no tier-2 tile on the plate" },
  { label: "Goldman Sachs", because: "tier-1 wordmark, no vector ported and no tier-2 tile on the plate" },
  { label: "Visa", because: "tier-1 wordmark, no vector ported and no tier-2 tile on the plate" },
  { label: "Venmo", because: "plate vector is a 5.3:1 logotype — a smudge at 22px (#107 §3)" },
  { label: "Coinbase", because: "plate vector is a 5.6:1 logotype — a smudge at 22px (#107 §3)" },
  { label: "Nubank", because: "plate node serves invalid path data — parked rather than approximated" },
];

/** The tier-2 tiles, plus the two tier-1 wordmarks the ~32px rule sends to a tile. */
const BRAND_TILES = [
  "Citi",
  "Capital One",
  "U.S. Bank",
  "PNC",
  "Truist",
  "TD Bank",
  "Charles Schwab",
  "Fidelity",
  "Vanguard",
  "Ally",
  "Navy Federal",
  "Interactive Brokers",
  "USAA",
  "SoFi",
  "Chime",
  "E*TRADE",
  "Morgan Stanley",
  "American Express",
  "Discover",
];

describe("every institution on the plate is accounted for", () => {
  it("the three lists add up to the plate's 41 — 24 tier-1 + 17 tier-2", () => {
    // Ported vectors + brand tiles + named-neutral = 41, with the two tier-1 wordmarks that hold a
    // tier-2 tile (Amex, Discover) counted once, in BRAND_TILES.
    expect(PORTED.length + BRAND_TILES.length + STILL_NEUTRAL.length).toBe(41);
    // and the tier split is still the law's: 16 ported + 3 wordmark-no-tile + 2 logotype + 1 parked
    // = 22 of the 24 tier-1, with Amex and Discover living in BRAND_TILES.
    expect(PORTED.length + STILL_NEUTRAL.length + 2).toBe(24);
    expect(BRAND_TILES.length - 2).toBe(17);
  });

  it("no plate label appears on two lists", () => {
    const all = [...PORTED.map((m) => m.label), ...BRAND_TILES, ...STILL_NEUTRAL.map((n) => n.label)];
    expect(new Set(all).size).toBe(all.length);
  });

  it("every brand-tile institution gets a colour that is NOT the neutral ground", () => {
    for (const label of BRAND_TILES) {
      const resolved = resolveInstitutionMark(label, 22);
      expect(resolved.kind, `${label} should take a tile`).toBe("monogram");
      if (resolved.kind === "monogram") {
        expect(resolved.hex, `${label} fell through to neutral`).not.toBe(NEUTRAL_MONOGRAM_HEX);
      }
    }
  });

  it.each(STILL_NEUTRAL)("$label is still neutral — $because", ({ label }) => {
    // These are the honest gaps. Each is neutral for a reason recorded above and in the source; the
    // assertion exists so that porting one is a deliberate act that has to update this list.
    const resolved = resolveInstitutionMark(label, 22);
    expect(resolved.kind).toBe("monogram");
    if (resolved.kind === "monogram") expect(resolved.hex).toBe(NEUTRAL_MONOGRAM_HEX);
  });

  it("Venmo and Coinbase stay UNPORTED until the ~32px rule is armed for them", () => {
    // Not a style preference: both plate vectors spell the brand out horizontally (5.3:1 and 5.6:1),
    // inside the band the plate itself calls unreadable at icon size, and every Console placement is
    // 22–24px. Porting one without adding it to WORDMARK_INSTITUTIONS re-ships the exact defect that
    // got the Amex and Discover logotypes deleted on 2026-07-25. If you are here because this test is
    // red: arm the rule first, and give the brand a tile, then come back.
    for (const label of ["Venmo", "Coinbase"]) {
      expect(resolveInstitutionMark(label, 22).kind).toBe("monogram");
      expect(renderToStaticMarkup(<InstitutionMark institution={label} size={22} />)).not.toContain("<svg");
    }
  });
});

describe("<InstitutionMark>", () => {
  it("renders a crafted vector as an svg, and every wordmark as a tile at every size", () => {
    const crafted = renderToStaticMarkup(<InstitutionMark institution="Chase" size={40} />);
    expect(crafted).toContain("<svg");
    expect(crafted).toContain("#117ACA");

    for (const size of [22, 40]) {
      const tile = renderToStaticMarkup(<InstitutionMark institution="American Express" size={size} />);
      expect(tile).not.toContain("<svg");
      expect(tile).toContain("AX");
      expect(tile).toContain("--institution-mark-ground:#2E77BC");
    }
  });

  it("hands the brand ground to CSS as a custom property and scales the tile from 22", () => {
    const markup = renderToStaticMarkup(<InstitutionMark institution="Citi" size={44} />);
    expect(markup).toContain("--institution-mark-ground:#056DAE");
    expect(markup).toContain("--institution-mark-size:44px");
    expect(markup).toContain("--institution-mark-scale:2");
  });

  it("is aria-hidden — it always sits beside its institution's name", () => {
    expect(renderToStaticMarkup(<InstitutionMark institution="Chase" />)).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<InstitutionMark institution="Fidelity" />)).toContain('aria-hidden="true"');
  });
});

// A CENSUS of the string SHAPES a finance provider puts on the wire, each with the exact treatment it
// must resolve to. NOT a coverage claim, and not an inventory of what Postern supports.
//
// ⚠️ READ THIS BEFORE READING A NUMBER OUT OF THIS FILE. "Two of these eleven are neutral" is a
// statement about eleven chosen strings and says NOTHING about any real gateway's mix. It is not
// "institutions are covered", it is not a percentage, and it must never be quoted as either.
//
// WHY IT IS SEPARATE FROM `institutions.test.tsx`. That file proves the resolver is faithful to the
// plate: every plate label takes its plate treatment, and all 41 are accounted for. It was fully green
// on 2026-07-26 while most institutions on a real gateway wore the neutral tile, because a test
// written from the plate's own vocabulary cannot see a string the plate never uses. "Chase Bank" is
// not "Chase". This file starts from the other end — the QUALIFIED display string a provider actually
// emits — and ends at the pixel.
//
// IT IS ALSO A MONUMENT TO A FIX THAT WAS THE WRONG SHAPE. The first remedy for that gap was four
// aliases, one per string that one box happened to expose, and the correction was immediate: a fix
// whose size equals the number of instances one live box revealed is scoped to that box, and a user
// with "Citibank" or "PNC Bank" hits the identical bug and gets nothing. The general fix is
// `institutions.domain.test.tsx`: key on `orgDomain`, the stable identifier.
//
// THE CENSUS NAMES NO REAL GATEWAY'S ACCOUNTS, deliberately. An earlier version of this file listed
// strings read off one gateway on one day under a "REAL DATA" banner — which made a test fixture into
// a published statement about where one person banks. The strings below are chosen
// to exercise the resolver's paths (legal-suffix stripping, punctuation folding, an exact plate hit,
// a wordmark with no tile, a brand the plate has never heard of); the connection to what providers
// really send is carried by `SERVED_NAME_ALIASES` itself, which the alias laws below walk entry by
// entry. That is the stronger form anyway: it covers the NEXT alias, which no fixture can.
//
// WHAT IT DOES NOT COVER, AND CANNOT. The domain path — these are display strings, and the census
// exercises the name FALLBACK only. Eleven strings against the ~12,000 institutions Plaid and
// SimpleFIN reach (build-notes §13.3).
//
// THE TEST THAT WOULD NOT HAVE BITTEN. "the alias table has four entries", or "aliasing 'chase bank'
// yields the chase vector". Both pass with the app still shipping the defect for every other string,
// and neither notices when a fifth spelling turns up in the wild. So the assertions run over the whole
// census and over the whole alias table, with each string's exact expected treatment — move one and
// several cells go red.
//
// MUTATION-VERIFIED 2026-07-28 — twelve mutations, every one red on the law it targets, each
// reverted. The repo's signature defect is the test that cannot fail (memory: tests-that-cannot-fail),
// so this list is the receipt, not a claim, and the counts below were read off the run:
//   the census ·
//     delete the `citi` monogram tile           -> "Citi N.A." falls to neutral C. RED (×3 cells)
//     delete the `barclays` crafted vector      -> "Barclays PLC" falls to neutral B. RED (×3)
//     drop the legal-suffix strip from normalise-> four qualified strings fall to neutral. RED (×6)
//   the alias laws ·
//     drop the alias lookup from the resolver   -> every entry stops reaching its label. RED (×4)
//     delete one alias entry                    -> RED (×1), and only on the four-entry FLOOR. ⚠️ THE
//       WEAKEST CELL IN THIS FILE, and it is weak by construction: every other alias law is written
//       `it.each(entries)`, so a deleted entry takes its own assertions with it. A delete-and-replace
//       therefore keeps the count and passes. It is left this way deliberately — the alternative is a
//       second copy of the table's keys here, and the table is the FALLBACK path now (rule 1: the
//       domain is the key), so a regression on it is caught where it matters by the domain laws.
//     add "wealthfront" -> "wells fargo"        -> target has no plate treatment. RED (×1)
//     add "Chase Bank" -> "chase" (unnormalised)-> key unreachable after normalisation. RED (×1)
//     add "chase" -> "citi"                     -> alias shadows a direct plate hit. RED (×4)
//     add "bofa chase bank" -> "chase bank"     -> chained alias. RED (×2)
//     hasApprovedTreatment => true              -> RED (×5)   } the helper is vacuous in
//     hasApprovedTreatment => false             -> RED (×4)   } neither direction
//   the exactness ·
//     substring-match in `craftedFor` — replace its table lookup with
//     `Object.keys(CRAFTED).find((k) => normalised.includes(k))`
//                                               -> RED (×2) here, ×2 in institutions.test.tsx's
//                                                  canary and ×2 in institutions.domain.test.tsx.
//                                                  A DIFFERENT substring mutation moves a different
//                                                  number of cells, which is why the shape is named.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  resolveInstitutionMark,
  normaliseInstitutionName,
  hasApprovedTreatment,
  SERVED_NAME_ALIASES,
  NEUTRAL_MONOGRAM_HEX,
  type InstitutionMarkResolution,
} from "./institutions";
import { InstitutionMark } from "./InstitutionMark";

/**
 * Eleven QUALIFIED display strings of the kind `org.name` carries on the wire — a legal suffix, a
 * punctuated abbreviation, a bare plate label, a brand nobody has drawn.
 *
 * INVENTED, and invented on purpose. Every name-shaped literal in this repo's design work is mock
 * data (CLAUDE.md: the plates are a design reference drawn on invented data), and a fixture that
 * transcribed one person's accounts would make this file a statement about them rather than about the
 * resolver. What is load-bearing is the SHAPE of each string, not whose card it is.
 *
 * If a real served string ever surprises the resolver, the honest move is to ADD its shape here and
 * an entry to `SERVED_NAME_ALIASES` if it needs one — never to rewrite a row to make a test pass.
 */
const QUALIFIED_SERVED_STRINGS = [
  "Barclays PLC",
  "Citi N.A.",
  "Deutsche Bank AG",
  "E*TRADE",
  "HSBC",
  "Navy Federal",
  "Revolut Ltd",
  "Starling Bank",
  "U.S. Bank",
  "Vireo Mutual Bank",
  "Visa",
] as const;

/** Every size any Console surface places an institution mark at: SourcesPage 22, SourcesBand 22,
 *  ConnectionDetail 24. All below `WORDMARK_MIN_SIZE`, which is why the wordmark brands take tiles. */
const CONSOLE_SIZES = [22, 24] as const;

/**
 * What each string resolves to, and WHY that is the right answer for it. Eleven measurements — not an
 * inventory of what Postern supports, and not a denominator.
 *
 * The `why` is load-bearing for the two neutrals. They are not "not done yet" — neither has an
 * approved treatment on the locked-assets plate, and the plate is law (CLAUDE.md). Inventing a hex, a
 * monogram or a borrowed logo for either is the one move this file exists to make unattractive.
 */
const CENSUS: Array<{ served: string; expected: InstitutionMarkResolution; why: string }> = [
  {
    served: "Barclays PLC",
    expected: { kind: "crafted", id: "barclays" },
    why: "tier-1 non-wordmark vector i-barclays; the trailing legal suffix is stripped before the lookup",
  },
  {
    served: "Citi N.A.",
    expected: { kind: "monogram", initials: "C", hex: "#056DAE" },
    why: "tier-2 tile m-citi — punctuation folds away and 'na' is a legal suffix, so 'Citi N.A.' IS 'citi'",
  },
  {
    served: "Deutsche Bank AG",
    expected: { kind: "crafted", id: "deutschebank" },
    why: "tier-1 vector i-deutschebank — a MULTI-word label survives the suffix strip intact",
  },
  {
    served: "E*TRADE",
    expected: { kind: "monogram", initials: "E", hex: "#6C3F98" },
    why: "tier-2 tile m-etrade — the brand's own asterisk is punctuation, not a word boundary",
  },
  {
    served: "HSBC",
    expected: { kind: "crafted", id: "hsbc" },
    why: "tier-1 vector i-hsbc; the served string already equals the plate label",
  },
  {
    served: "Navy Federal",
    expected: { kind: "monogram", initials: "NF", hex: "#003767" },
    why: "tier-2 tile m-navyfederal, NF on #003767",
  },
  {
    served: "Revolut Ltd",
    expected: { kind: "crafted", id: "revolut" },
    why: "tier-1 vector i-revolut behind a legal suffix",
  },
  {
    served: "Starling Bank",
    expected: { kind: "crafted", id: "starling" },
    why: "tier-1 vector i-starling — 'bank' is part of the plate label, NOT a suffix to strip",
  },
  {
    served: "U.S. Bank",
    expected: { kind: "monogram", initials: "US", hex: "#001E79" },
    why: "tier-2 tile m-usbank — the dots fold away and 'u s bank' collapses to the plate's 'us bank'",
  },
  {
    served: "Vireo Mutual Bank",
    expected: { kind: "monogram", initials: "V", hex: NEUTRAL_MONOGRAM_HEX },
    why: "NOT ON THE PLATE at all — neither tier. A tile for it would be an invented brand colour",
  },
  {
    served: "Visa",
    expected: { kind: "monogram", initials: "V", hex: NEUTRAL_MONOGRAM_HEX },
    why: "tier-1 WORDMARK (i-visa) with NO tier-2 tile drawn on the plate — no alias can help; the fix is a plate correction, recorded in institutions.test.tsx STILL_NEUTRAL",
  },
];

/** The strings that legitimately keep the neutral tile. Pinned as a set, not just a count, so that
 *  losing one and gaining another cannot cancel out. */
const EXPECTED_NEUTRAL = ["Vireo Mutual Bank", "Visa"];

describe("the qualified-string census — eleven shapes a provider can put on the wire", () => {
  it("the fixture is the eleven strings the census measures, with no duplicates and nothing added", () => {
    // Guards the fixture itself. A census whose input list drifted would still be green while covering
    // fewer strings than it claims.
    expect(QUALIFIED_SERVED_STRINGS).toHaveLength(11);
    expect(new Set(QUALIFIED_SERVED_STRINGS).size).toBe(11);
    expect(CENSUS.map((c) => c.served)).toEqual([...QUALIFIED_SERVED_STRINGS]);
  });

  it.each(CENSUS)("$served -> $why", ({ served, expected }) => {
    // The whole treatment, not just the branch: a `kind: "monogram"` assertion alone passes with every
    // brand tile collapsed to warm black, which IS the defect.
    for (const size of CONSOLE_SIZES) {
      expect(resolveInstitutionMark(served, size)).toEqual(expected);
    }
  });

  it("two of THESE ELEVEN wear the neutral tile — a fact about eleven chosen strings, not a coverage figure", () => {
    // ⚠️ NOT A STATISTIC. Its job is to be a TRIPWIRE: any regression that drops a brand back to the
    // neutral ground moves this list and this cell plus the next one go red. The SET is pinned as well
    // as the count, so losing one and gaining another cannot cancel out.
    const neutral = QUALIFIED_SERVED_STRINGS.filter((served) => {
      const resolved = resolveInstitutionMark(served, 22);
      return resolved.kind === "monogram" && resolved.hex === NEUTRAL_MONOGRAM_HEX;
    });
    expect(neutral).toEqual(EXPECTED_NEUTRAL);
    expect(neutral).toHaveLength(2);
  });

  it("every neutral one is neutral because the PLATE has no treatment for it, not because we missed it", () => {
    // The only honest reason for a neutral tile. If a served string is neutral while its normalised
    // label DOES have an approved mark, that is the #107 defect back again — and the alias that would
    // have connected them is missing.
    for (const served of EXPECTED_NEUTRAL) {
      const key = SERVED_NAME_ALIASES[normaliseInstitutionName(served)] ?? normaliseInstitutionName(served);
      expect(hasApprovedTreatment(key), `${served} has an approved mark and should not be neutral`).toBe(
        false,
      );
    }
  });

  it("renders every served string as its own drawing or its own ground — nine of eleven branded", () => {
    // Resolution is not pixels. This closes the gap between "the resolver returns the right object" and
    // "the row on the page stops looking like an unknown credit union".
    for (const { served, expected } of CENSUS) {
      const markup = renderToStaticMarkup(<InstitutionMark institution={served} size={22} />);
      if (expected.kind === "crafted") {
        expect(markup, served).toContain("<svg");
        expect(markup, served).not.toContain(NEUTRAL_MONOGRAM_HEX);
        continue;
      }
      expect(markup, served).toContain(`--institution-mark-ground:${expected.hex}`);
      if (expected.hex !== NEUTRAL_MONOGRAM_HEX) {
        expect(markup, served).not.toContain(NEUTRAL_MONOGRAM_HEX);
      }
    }
  });

  it("gives the eleven ten DISTINCT treatments — no served string wears another bank's mark", () => {
    // The failure mode of any name->brand mapping, and the reason fuzzy matching was rejected: two
    // institutions resolving to one drawing is worse than either being neutral. Ten, not eleven,
    // because the two plate-less brands share the one neutral ground by design — the treatment they
    // share is precisely "we are not claiming to know this brand".
    const treatments = QUALIFIED_SERVED_STRINGS.map((served) => {
      const r = resolveInstitutionMark(served, 22);
      return r.kind === "crafted" ? `crafted:${r.id}` : `tile:${r.initials}:${r.hex}`;
    });
    expect(new Set(treatments).size).toBe(10);
    expect(treatments.filter((t) => t === `tile:V:${NEUTRAL_MONOGRAM_HEX}`)).toHaveLength(2);
  });

  it("never places a wordmark logotype at a Console size", () => {
    // A tier-1 WORDMARK is path data that spells the brand out, and the plate calls it unreadable
    // below ~32px. All five labels are pinned in `institutions.test.tsx`; these two are the ones with
    // no tier-2 tile behind them, so they must land on the honest neutral initial rather than on a
    // 5:1 smudge. If someone later ports one of the logotypes to "finish the job", this goes red —
    // as does the alias law below, which is the OTHER route a served string can take to a wordmark.
    for (const served of ["Visa", "Goldman Sachs"]) {
      for (const size of CONSOLE_SIZES) {
        expect(resolveInstitutionMark(served, size).kind, `${served} @${size}`).toBe("monogram");
      }
      expect(renderToStaticMarkup(<InstitutionMark institution={served} size={22} />)).not.toContain(
        "<svg",
      );
    }
  });
});

describe("the alias is a table, not a matcher", () => {
  const entries = Object.entries(SERVED_NAME_ALIASES);

  it("has at least the four entries the served-string gap demanded", () => {
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });

  // Every law below runs over ALL entries rather than a hand-listed few, so the NEXT alias somebody
  // adds — the one nobody writes a test for — is covered the moment it is written. This is also where
  // the file's connection to REAL wire strings lives: the table's keys are the strings providers were
  // observed to send, so walking the table exercises them without a fixture transcribing anybody's
  // accounts.

  it.each(entries)("'%s' reaches the treatment its plate label '%s' already has", (key, target) => {
    // TWO halves, and the second is the one a census used to cover by naming four real strings.
    //
    // An alias may never CONJURE a mark. Pointing at an unapproved label is a silent no-op that reads
    // like coverage in a diff: the row still shows the neutral tile and the table looks longer.
    expect(hasApprovedTreatment(target), `${target} has no crafted vector and no plate tile`).toBe(true);
    // And it must actually CONNECT. Deleting the entry, or dropping the lookup from the resolver,
    // leaves the served string on its own neutral initial while the plate label keeps its mark — so
    // comparing the two resolutions is what makes this cell fail when the alias stops working. Both
    // Console sizes, because the ~32px wordmark rule must apply identically however the string
    // arrived: an alias must never be the route by which a logotype reaches a 22px box.
    for (const size of CONSOLE_SIZES) {
      expect(resolveInstitutionMark(key, size), `${key} @${size}`).toEqual(
        resolveInstitutionMark(target, size),
      );
    }
  });

  it.each(entries)("'%s' is already in normalised form, so the lookup can reach it", (key) => {
    // The lookup happens AFTER `normaliseInstitutionName`. An entry keyed "Chase Bank" or "chase  bank"
    // is dead code that no served string can ever hit — the defect wearing the costume of the fix.
    expect(normaliseInstitutionName(key)).toBe(key);
  });

  it.each(entries)("'%s' does not shadow a direct plate hit, and does not alias itself", (key, target) => {
    // An alias keyed on an approved label would override the plate's own answer for that label — the
    // one way this table could make a currently-correct mark wrong.
    expect(hasApprovedTreatment(key), `${key} is itself an approved label`).toBe(false);
    expect(key).not.toBe(target);
  });

  it("never chains — one hop, always", () => {
    // Chains make the table unreadable line by line and make cycles possible; the resolver does exactly
    // one lookup, so a chain would silently half-apply.
    const keys = new Set(entries.map(([key]) => key));
    for (const [, target] of entries) {
      expect(keys.has(target), `${target} is both an alias target and an alias key`).toBe(false);
    }
  });

  it("resolves the plate label itself unchanged — an alias adds a spelling, it never replaces one", () => {
    // "Chase" and "Chase Bank" must both land on the chase vector. A refactor that moved the plate
    // label into the alias table instead of alongside it would pass every census assertion above.
    expect(resolveInstitutionMark("Chase", 22)).toEqual({ kind: "crafted", id: "chase" });
    expect(resolveInstitutionMark("Charles Schwab", 22)).toEqual({
      kind: "monogram",
      initials: "S",
      hex: "#00A0DF",
    });
    expect(resolveInstitutionMark("Fidelity", 22)).toEqual({
      kind: "monogram",
      initials: "F",
      hex: "#368727",
    });
    expect(resolveInstitutionMark("Discover", 22)).toEqual({
      kind: "monogram",
      initials: "D",
      hex: "#FF6000",
    });
  });

  it("does NOT spread to a near-miss of an alias key — the exactness survives the table", () => {
    // The whole reason the remedy is a table: "Chase Bank" being known must not make anything that
    // merely contains it known. If any of these ever goes non-neutral, a matcher has been introduced.
    for (const name of [
      "Chase Banking",
      "Chase Bank of the Ozarks",
      "Discover Credit Cards",
      "Discovery Credit Card",
      "Charles Schwab USA",
      "Fidelity Investments Group of Idaho",
      "Not Chase Bank",
    ]) {
      const resolved = resolveInstitutionMark(name, 22);
      expect(resolved.kind, name).toBe("monogram");
      if (resolved.kind === "monogram") expect(resolved.hex, name).toBe(NEUTRAL_MONOGRAM_HEX);
    }
  });
});

// The DOMAIN path — resolution keyed on the stable identifier, which is what makes the fix general.
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT `institutions.served.test.tsx`. That file starts from a
// census of QUALIFIED display-string shapes and from the alias table's own laws. This one starts from
// the property: a bank nobody has ever seen served, whose provider sends a qualified display string,
// must still get its approved mark — because it was identified by its DOMAIN and not by how its
// provider chose to spell it. "Citibank" and "PNC Bank" are the examples that made the case — the bug
// a four-entry name-alias table could not reach — and they are the first two rows below.
//
// WHERE THE DOMAIN LITERALS COME FROM, stated plainly because provenance is the whole discipline here:
// they are the institutions' own public registrable web domains, written from general knowledge. They
// are FACTS ABOUT THE WORLD, not design values and not values read off any gateway — with two
// exceptions that are both: `www.bankofamerica.com` and `americanexpress.com` are also recorded as
// wire-observed in `src/rest/finance-routes.db.test.ts`. Nothing here was taken off a Paper plate, and nothing
// here is a plate value (the plate carries marks, hexes and initials; it carries no domains).
//
// A WRONG DOMAIN KEY IS INERT, WHICH IS WHY THIS IS SAFE TO WRITE FROM KNOWLEDGE. A domain no gateway
// sends can never render. The only way a key could assert a false fact is if two brands shared one
// registrable label, and the fold is exact — no substrings, no scoring — so the failure mode fuzzy
// matching has (this bank's mark on that bank's row) is unreachable by construction.
//
// MUTATION-VERIFIED (each red on the law it targets, each reverted) — see the run log in the unit's
// report:
//   drop the domain branch from `resolveInstitutionMark`  -> the world table + the "does the work" cell
//   make the name path win over the domain                -> the precedence cell
//   stop stripping the scheme / `www.` in the host fold   -> the fold cell + the live-observed rows
//   take the registrable label from labels[0]             -> the sub-domain and multi-label cells
//   substring-match the fold against the label index      -> the no-fuzzy cell
//   add `cash` to DOMAIN_HOST_EXCEPTIONS                  -> the deliberately-unkeyed cell
//   point an exception at a label with no treatment       -> the exception-table laws
//   inline a crafted lookup into the domain branch        -> the wordmark STRUCTURAL cell
//
// ONE MUTATION CAME BACK GREEN AND IS RECORDED AS SUCH: disabling `wordmarkTooSmall` changes nothing
// any fixture can see, because no tier-1 wordmark has a crafted vector to demote. That is pre-existing
// and already documented in `institutions.test.tsx`; the wordmark block below says so out loud and
// asserts the structure instead of pretending to test the rule.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  APPROVED_LABELS,
  DOMAIN_HOST_EXCEPTIONS,
  HOST_FOLDS_LEFT_UNKEYED,
  NEUTRAL_MONOGRAM_HEX,
  canonicalHostLabel,
  hasApprovedTreatment,
  plateLabelForDomain,
  resolveInstitutionMark,
  type InstitutionMarkResolution,
} from "./institutions";
import { InstitutionMark } from "./InstitutionMark";

/** Every size a Console surface places an institution mark at: SourcesPage 22, SourcesBand 22,
 *  ConnectionDetail 24. */
const CONSOLE_SIZES = [22, 24] as const;

/** The despaced form of a normalised plate label — the derived host key. */
function despace(label: string): string {
  return label.replace(/[^a-z0-9]/g, "");
}

describe("canonicalHostLabel — the dedup engine's own fold, copied verbatim", () => {
  it("lowercases, strips scheme, www, path and port, and takes the registrable label", () => {
    expect(canonicalHostLabel("chase.com")).toBe("chase");
    expect(canonicalHostLabel("https://www.Chase.com/")).toBe("chase");
    expect(canonicalHostLabel("HTTP://SCHWAB.COM:8443/accounts/summary")).toBe("schwab");
    expect(canonicalHostLabel("  api.sub.schwab.com  ")).toBe("schwab");
    // The stored values a real gateway was observed to serve (finance-routes.db.test.ts).
    expect(canonicalHostLabel("www.bankofamerica.com")).toBe("bankofamerica");
    expect(canonicalHostLabel("americanexpress.com")).toBe("americanexpress");
    // Non-alphanumerics inside the label go, which is how a hyphenated domain reaches its plate label.
    expect(canonicalHostLabel("deutsche-bank.de")).toBe("deutschebank");
  });

  it("answers null for every shape that is not a host — never a guess, never a throw", () => {
    for (const value of [null, undefined, "", "   ", "...", "://", "/"]) {
      expect(canonicalHostLabel(value), String(value)).toBeNull();
    }
  });

  it("a single-label host is its own fold", () => {
    // `labels.length >= 2 ? labels[length-2] : labels[0]` — the engine's branch, kept.
    expect(canonicalHostLabel("localhost")).toBe("localhost");
  });

  it("⚠️ IS AN SLD RULE, NOT A PUBLIC-SUFFIX RULE — barclays.co.uk folds to 'co'", () => {
    // The inherited limitation, pinned rather than hidden. This is the ENTIRE reason the display-name
    // path still runs when a domain is present but unrecognised: a UK Barclays card renders the
    // Barclays vector today off its NAME, and restricting the fallback to `orgDomain == null` would
    // have deleted that. Removing coverage is not a fix.
    expect(canonicalHostLabel("barclays.co.uk")).toBe("co");
    expect(plateLabelForDomain("barclays.co.uk")).toBeNull();
    expect(resolveInstitutionMark("Barclays", 22, "https://www.barclays.co.uk/")).toEqual({
      kind: "crafted",
      id: "barclays",
    });
  });
});

/**
 * THE POINT OF THE UNIT: an institution identified by its own domain, wearing a display string its
 * provider chose. `nameAlone` is not a hand-check — the cell below computes it — but it is written out
 * so a reader can see how many of these the display-name path could never have reached.
 */
const WORLD: Array<{ served: string; domain: string; expected: InstitutionMarkResolution }> = [
  // The operator's two named examples — the strings a four-entry alias table could not have known.
  { served: "Citibank", domain: "citi.com", expected: { kind: "monogram", initials: "C", hex: "#056DAE" } },
  { served: "PNC Bank", domain: "pnc.com", expected: { kind: "monogram", initials: "P", hex: "#F58025" } },
  // …then a wide spread of plausible provider spellings across both tiers.
  { served: "Chase Bank", domain: "chase.com", expected: { kind: "crafted", id: "chase" } },
  { served: "BANK OF AMERICA, N.A.", domain: "www.bankofamerica.com", expected: { kind: "crafted", id: "boa" } },
  { served: "Charles Schwab US", domain: "schwab.com", expected: { kind: "monogram", initials: "S", hex: "#00A0DF" } },
  { served: "Fidelity Investments", domain: "fidelity.com", expected: { kind: "monogram", initials: "F", hex: "#368727" } },
  { served: "Discover Credit Card", domain: "discover.com", expected: { kind: "monogram", initials: "D", hex: "#FF6000" } },
  { served: "AMEX", domain: "americanexpress.com", expected: { kind: "monogram", initials: "AX", hex: "#2E77BC" } },
  { served: "Capital One Bank (USA), National Association", domain: "capitalone.com", expected: { kind: "monogram", initials: "C1", hex: "#CC2427" } },
  { served: "U.S. Bank National Association", domain: "usbank.com", expected: { kind: "monogram", initials: "US", hex: "#001E79" } },
  { served: "TD Bank, N.A.", domain: "tdbank.com", expected: { kind: "monogram", initials: "TD", hex: "#003F2D" } },
  { served: "TD", domain: "td.com", expected: { kind: "monogram", initials: "TD", hex: "#003F2D" } },
  { served: "Interactive Brokers LLC", domain: "ibkr.com", expected: { kind: "monogram", initials: "IB", hex: "#D81222" } },
  { served: "E*TRADE Securities", domain: "us.etrade.com", expected: { kind: "monogram", initials: "E", hex: "#6C3F98" } },
  { served: "Navy Federal Credit Union", domain: "navyfederal.org", expected: { kind: "monogram", initials: "NF", hex: "#003767" } },
  { served: "Morgan Stanley Private Bank", domain: "morganstanley.com", expected: { kind: "monogram", initials: "MS", hex: "#002B5C" } },
  { served: "The Vanguard Group, Inc.", domain: "investor.vanguard.com", expected: { kind: "monogram", initials: "V", hex: "#96151D" } },
  { served: "Truist Bank", domain: "truist.com", expected: { kind: "monogram", initials: "T", hex: "#2D1A47" } },
  { served: "Ally Bank", domain: "ally.com", expected: { kind: "monogram", initials: "A", hex: "#481149" } },
  { served: "USAA Federal Savings Bank", domain: "usaa.com", expected: { kind: "monogram", initials: "U", hex: "#002855" } },
  { served: "SoFi Bank", domain: "sofi.com", expected: { kind: "monogram", initials: "So", hex: "#00A9E0" } },
  { served: "Chime", domain: "chime.com", expected: { kind: "monogram", initials: "Ch", hex: "#1EC677" } },
  { served: "Starling", domain: "starlingbank.com", expected: { kind: "crafted", id: "starling" } },
  { served: "Monzo Bank Ltd", domain: "monzo.com", expected: { kind: "crafted", id: "monzo" } },
  { served: "Revolut Ltd", domain: "revolut.com", expected: { kind: "crafted", id: "revolut" } },
  { served: "N26 Bank", domain: "n26.com", expected: { kind: "crafted", id: "n26" } },
  { served: "Wise Payments", domain: "wise.com", expected: { kind: "crafted", id: "wise" } },
  { served: "HSBC Bank USA", domain: "hsbc.com", expected: { kind: "crafted", id: "hsbc" } },
  { served: "Barclays Bank Delaware", domain: "barclays.com", expected: { kind: "crafted", id: "barclays" } },
  { served: "Deutsche Bank AG", domain: "db.com", expected: { kind: "crafted", id: "deutschebank" } },
  { served: "Robinhood Securities", domain: "robinhood.com", expected: { kind: "crafted", id: "robinhood" } },
  { served: "PayPal Holdings", domain: "paypal.com", expected: { kind: "crafted", id: "paypal" } },
  { served: "Cash App", domain: "cashapp.com", expected: { kind: "crafted", id: "cashapp" } },
  { served: "Zelle", domain: "zellepay.com", expected: { kind: "crafted", id: "zelle" } },
  { served: "Mastercard", domain: "mastercard.com", expected: { kind: "crafted", id: "mastercard" } },
  { served: "Binance", domain: "binance.com", expected: { kind: "crafted", id: "binance" } },
];

describe("a bank is identified by its DOMAIN, whatever its provider calls it", () => {
  it.each(WORLD)("$served @ $domain -> its approved treatment", ({ served, domain, expected }) => {
    // The whole treatment, at every Console size. A `kind` assertion alone passes with every tile
    // collapsed to warm black, which IS the defect this unit is about.
    for (const size of CONSOLE_SIZES) {
      expect(resolveInstitutionMark(served, size, domain)).toEqual(expected);
    }
  });

  it("the DOMAIN is what does the work — most of these are neutral on the display name alone", () => {
    // The cell with teeth. Every row above where the display string would have produced the warm-ink
    // initial is a row the previous design could not have fixed without somebody first observing that
    // exact string on a running gateway. Deleting the domain branch turns this whole set red at once.
    const rescued = WORLD.filter(({ served }) => {
      const byName = resolveInstitutionMark(served, 22);
      return byName.kind === "monogram" && byName.hex === NEUTRAL_MONOGRAM_HEX;
    });
    // A FLOOR, not a census: the exact number is an artifact of which plausible spellings are written
    // above, and pinning it would make adding a row a test edit. What must not happen is the domain
    // path ceasing to carry the majority of them.
    expect(rescued.length).toBeGreaterThanOrEqual(20);
    for (const { served, domain, expected } of rescued) {
      expect(resolveInstitutionMark(served, 22, domain), served).toEqual(expected);
    }
  });

  it("the domain BEATS the display name when the two disagree", () => {
    // Precedence, asserted rather than implied. The domain is the stable identifier; a display name is
    // whatever the provider formatted. If a name could overrule a domain, a card whose domain says one
    // brand could end up wearing another's mark — the exact false fact this file exists to prevent.
    expect(resolveInstitutionMark("Some Random Credit Union", 22, "chase.com")).toEqual({
      kind: "crafted",
      id: "chase",
    });
    expect(resolveInstitutionMark("Chase", 22, "pnc.com")).toEqual({
      kind: "monogram",
      initials: "P",
      hex: "#F58025",
    });
  });

  it("renders through the component, not only through the resolver", () => {
    // Resolution is not pixels. `<InstitutionMark>` has to thread `orgDomain` through, and a call site
    // that forgets the prop silently demotes its row to the weaker path.
    const withDomain = renderToStaticMarkup(
      <InstitutionMark institution="Citibank" orgDomain="citi.com" size={22} />,
    );
    expect(withDomain).toContain("--institution-mark-ground:#056DAE");
    expect(withDomain).not.toContain(NEUTRAL_MONOGRAM_HEX);

    // …and the same row WITHOUT the prop is the bug, which is what makes the prop load-bearing.
    const withoutDomain = renderToStaticMarkup(<InstitutionMark institution="Citibank" size={22} />);
    expect(withoutDomain).toContain(`--institution-mark-ground:${NEUTRAL_MONOGRAM_HEX}`);
  });
});

describe("the derivation, not a table — porting a tile gains its domain key", () => {
  it("every approved plate label is reachable from its own name as a host fold", () => {
    // This is the property that makes the fix general instead of census-sized: for the great majority
    // of institutions the registrable label already IS the plate label with the spaces removed, so no
    // entry has to be written and no live read has to happen first. A tile ported off the plate
    // tomorrow answers to its own domain in the same commit.
    for (const label of APPROVED_LABELS) {
      expect(plateLabelForDomain(`${despace(label)}.com`), label).toBe(label);
      expect(plateLabelForDomain(`https://www.${despace(label)}.com/`), label).toBe(label);
    }
  });

  it("no two approved labels despace onto one host key", () => {
    // A collision would silently hand one brand's domain to another's mark — the one way a DERIVED
    // index could assert a false fact.
    const folds = APPROVED_LABELS.map(despace);
    expect(new Set(folds).size).toBe(folds.length);
  });

  it("every approved label has a renderable treatment at every Console size", () => {
    // The guard behind the `??` arm in `resolveInstitutionMark`'s domain branch. While this holds, a
    // domain that names an approved label ALWAYS yields a mark and the fallthrough is unreachable. It
    // stops holding the day a tier-1 WORDMARK is given a crafted vector with no tier-2 tile beside it
    // (Visa is the live candidate) — and then the fallthrough matters, so read it before "fixing" this.
    for (const label of APPROVED_LABELS) {
      for (const size of CONSOLE_SIZES) {
        const resolved = resolveInstitutionMark("Zzz Unknown Bank", size, `${despace(label)}.com`);
        expect(resolved, `${label} @${size}`).not.toEqual({
          kind: "monogram",
          initials: "Z",
          hex: NEUTRAL_MONOGRAM_HEX,
        });
      }
    }
  });
});

describe("the host-exception table is a table, not a matcher", () => {
  const entries = Object.entries(DOMAIN_HOST_EXCEPTIONS);

  it("has the entries the derivation cannot reach", () => {
    expect(entries.length).toBeGreaterThanOrEqual(6);
  });

  // Every law runs over ALL entries, so the NEXT exception somebody adds — the one nobody writes a
  // test for — is covered the moment it is written.

  it.each(entries)("'%s' -> '%s' points at a label that ALREADY has an approved treatment", (_key, target) => {
    // An exception may never conjure a mark. Pointing at an unapproved label is a silent no-op that
    // reads like coverage in a diff.
    expect(hasApprovedTreatment(target), `${target} has no crafted vector and no plate tile`).toBe(true);
  });

  it.each(entries)("'%s' is already in host-fold form, so the lookup can reach it", (key) => {
    // The lookup happens AFTER `canonicalHostLabel`. An entry keyed "Schwab.com" is dead code no served
    // domain can ever hit — the defect wearing the costume of the fix.
    expect(canonicalHostLabel(key)).toBe(key);
  });

  it.each(entries)("'%s' is purely ADDITIVE — it does not override a derived key", (key) => {
    // If a key were also the despaced form of an approved label, this table would quietly overrule the
    // plate's own answer for that label. Widening coverage is the only thing it may do.
    expect(APPROVED_LABELS.map(despace), key).not.toContain(key);
    expect(hasApprovedTreatment(key), `${key} is itself an approved label`).toBe(false);
  });

  it("never chains — one hop, always", () => {
    const keys = new Set(entries.map(([key]) => key));
    for (const [, target] of entries) {
      expect(keys.has(despace(target)), `${target} is both a target and a key`).toBe(false);
    }
  });

  it.each(Object.entries(HOST_FOLDS_LEFT_UNKEYED))(
    "'%s' names a plate brand and is deliberately NOT keyed — %s",
    (fold) => {
      // The honest gap on this path: a fold that is a generic English word cannot be claimed for one
      // brand, because the fold is not a public-suffix rule and ANY host at `<word>.<tld>` produces it.
      for (const tld of ["com", "app", "org"]) {
        expect(plateLabelForDomain(`${fold}.${tld}`), `${fold}.${tld}`).toBeNull();
      }
    },
  );
});

describe("no substring or fuzzy matching on the domain path either", () => {
  it("a host that merely CONTAINS a known label is not that institution", () => {
    for (const host of [
      "discoverybank.com",
      "chasebanking.com",
      "notchase.com",
      "mychase.com",
      "firstnationalbankofdiscovery.com",
      "allyson.com",
      "wisdom.com",
    ]) {
      expect(plateLabelForDomain(host), host).toBeNull();
    }
  });

  it("a look-alike host cannot borrow a brand's mark through the display name either", () => {
    const resolved = resolveInstitutionMark("First National Bank of Discovery", 22, "discoverybank.com");
    expect(resolved).toEqual({ kind: "monogram", initials: "F", hex: NEUTRAL_MONOGRAM_HEX });
    expect(
      renderToStaticMarkup(
        <InstitutionMark institution="First National Bank of Discovery" orgDomain="discoverybank.com" />,
      ),
    ).not.toContain("FF6000");
  });

  it("a real sub-domain still resolves, and a suffixed impostor does not", () => {
    expect(plateLabelForDomain("secure.online.chase.com")).toBe("chase");
    // The registrable-label rule is doing real work here: the brand appears in the host, and the
    // answer is still nothing, because the label that OWNS the host is not the brand's.
    expect(plateLabelForDomain("chase.com.phish.example")).toBeNull();
  });
});

describe("the ~32px wordmark rule is ONE gate, on both paths", () => {
  // ⚠️ IT CANNOT BE EXERCISED BY DATA, AND THAT IS PRE-EXISTING. The rule only bites when a tier-1
  // WORDMARK has a crafted vector, and none does — the Amex and Discover logotypes were deleted
  // 2026-07-25 as unreachable, and `institutions.test.tsx` already describes the rule as "KEPT ARMED
  // with nothing left to arm it against". Disabling `wordmarkTooSmall` today changes NOTHING that any
  // fixture can see: MUTATION-VERIFIED, and it came back green across all three mark suites.
  //
  // So the honest assertion is STRUCTURAL, in the style of `api/one-clock.test.ts`: the rule is
  // consulted in exactly ONE place, and `resolveInstitutionMark` reaches a vector only through it. That
  // is what a future port of a wordmark vector depends on — if the domain branch grows its own crafted
  // lookup, the smudge comes back on cards identified by domain and on nothing else, which is the
  // hardest possible version of this bug to see.

  const SOURCE = readFileSync(new URL("./institutions.ts", import.meta.url), "utf8");
  /** Comments stripped: prose ABOUT the rule is not the rule. */
  const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("`WORDMARK_INSTITUTIONS` is consulted exactly once — one gate, not one per path", () => {
    expect(code.match(/WORDMARK_INSTITUTIONS\.has\(/g) ?? []).toHaveLength(1);
    expect(code.match(/WORDMARK_MIN_SIZE/g) ?? []).toHaveLength(2); // the declaration + the one check
  });

  it("the resolver reaches a crafted vector only through `treatmentFor`", () => {
    // `craftedFor` is the vector lookup. It may appear in `treatmentFor` (the gate) and in
    // `hasApprovedTreatment` (a boolean, no size involved) — never inside `resolveInstitutionMark`.
    const resolver = /export function resolveInstitutionMark\([\s\S]*?\n}/.exec(code);
    expect(resolver, "resolveInstitutionMark not found — this guard has gone blind").not.toBeNull();
    expect(resolver![0]).not.toContain("craftedFor(");
    expect(resolver![0]).not.toContain("MONOGRAM[");
    // …and it does route both of its branches through the gate.
    expect(resolver![0].match(/treatmentFor\(/g) ?? []).toHaveLength(2);
  });

  it("a wordmark reached by DOMAIN renders its brand tile, not a logotype and not neutral", () => {
    // Not the rule — the OUTCOME. This is what a reader of a Sources row actually sees, and it does bite
    // (MUTATION: skip the tile lookup on the domain branch → red). Amex wearing AX on Amex blue is the
    // plate's own prescribed remedy, not a defect.
    for (const [served, domain, initials, hex] of [
      ["AMEX", "americanexpress.com", "AX", "#2E77BC"],
      ["Discover Credit Card", "discover.com", "D", "#FF6000"],
    ] as const) {
      for (const size of CONSOLE_SIZES) {
        expect(resolveInstitutionMark(served, size, domain)).toEqual({
          kind: "monogram",
          initials,
          hex,
        });
      }
      const markup = renderToStaticMarkup(
        <InstitutionMark institution={served} orgDomain={domain} size={22} />,
      );
      expect(markup, served).not.toContain("<svg");
      expect(markup, served).toContain(`--institution-mark-ground:${hex}`);
    }
  });
});

describe("the honest gaps survive the new path", () => {
  /** Brands the PLATE has no approved treatment for. Their own domain cannot help them, and inventing a
   *  hex or borrowing a logo for one is the move this whole file exists to make unattractive. The three
   *  reasons are recorded in `institutions.test.tsx`'s STILL_NEUTRAL. */
  const NO_APPROVED_TREATMENT: Array<{ served: string; domain: string; initial: string }> = [
    { served: "Wells Fargo", domain: "wellsfargo.com", initial: "W" },
    { served: "Goldman Sachs", domain: "goldmansachs.com", initial: "G" },
    { served: "Visa", domain: "visa.com", initial: "V" },
    { served: "Venmo", domain: "venmo.com", initial: "V" },
    { served: "Coinbase", domain: "coinbase.com", initial: "C" },
    { served: "Nubank", domain: "nubank.com.br", initial: "N" },
    // Not on the plate in either tier — a tile for one of these would be an invented brand colour.
    { served: "Wealthfront", domain: "wealthfront.com", initial: "W" },
    { served: "Apple Card (Updated Monthly)", domain: "goldmansachs.com", initial: "A" },
  ];

  it.each(NO_APPROVED_TREATMENT)(
    "$served keeps the neutral tile even when its own domain is served",
    ({ served, domain, initial }) => {
      expect(resolveInstitutionMark(served, 22, domain)).toEqual({
        kind: "monogram",
        initials: initial,
        hex: NEUTRAL_MONOGRAM_HEX,
      });
    },
  );

  it("a card with NO domain still runs the full display-name path, alias table included", () => {
    // `null` (this gateway has no domain for the card) and `undefined` (a gateway predating the field)
    // are different FACTS and the same visual answer — and neither may be rendered as a domain.
    for (const absent of [null, undefined] as const) {
      expect(resolveInstitutionMark("Chase", 22, absent)).toEqual({ kind: "crafted", id: "chase" });
      expect(resolveInstitutionMark("Chase Bank", 22, absent)).toEqual({ kind: "crafted", id: "chase" });
      expect(resolveInstitutionMark("Charles Schwab US", 22, absent)).toEqual({
        kind: "monogram",
        initials: "S",
        hex: "#00A0DF",
      });
      expect(resolveInstitutionMark("Kōbe Shinkin Bank", 22, absent)).toEqual({
        kind: "monogram",
        initials: "K",
        hex: NEUTRAL_MONOGRAM_HEX,
      });
    }
  });

  it("an unrecognised domain falls through to the name rather than blanking the row", () => {
    // The Barclays `.co.uk` case generalised: a domain the index does not know says NOTHING, so it must
    // not silence a name that does say something. This is not the domain being overruled — an unknown
    // fold is not a disagreement.
    expect(resolveInstitutionMark("Chase", 22, "some-aggregator.example")).toEqual({
      kind: "crafted",
      id: "chase",
    });
    expect(resolveInstitutionMark("Nowhere Savings", 22, "some-aggregator.example")).toEqual({
      kind: "monogram",
      initials: "N",
      hex: NEUTRAL_MONOGRAM_HEX,
    });
  });
});

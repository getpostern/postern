// The institution -> mark lookup, the brand hexes, and the two-tier resolver.
//
// The law is §VII of the locked-assets plate (landing file 01KXV3PJEGEJW84ERA8Z46GVS8 node F69-0 ->
// `sec-institutions` H1L-0): 41 marks in two tiers — 24 official brand marks + 17 brand-coloured
// monogram tiles. Every hex and every set of initials below was read off that plate via the Paper MCP
// (`get_jsx`); none was sampled from an image and none was invented.
//
// FIVE RULES THIS FILE EXISTS TO ENFORCE
//
// 1. RESOLUTION IS KEYED ON THE DOMAIN, NOT ON THE DISPLAY NAME — because a domain is a stable
//    identifier and a display name is provider-formatted and unbounded. `orgDomain` IS served on every
//    finance bank card now (`src/rest/finance-routes.ts`; `api/types.ts` records the three facts it
//    carries), the stored string verbatim.
//
//    THIS IS A CORRECTION, AND THE REASON MATTERS MORE THAN THE CHANGE. A read against a real
//    gateway found most of its institutions wearing the neutral tile, because the resolver matched an
//    EXACT normalised name while providers send QUALIFIED display strings ("Chase Bank" is not
//    "chase"). That was first fixed with four aliases — one per string that one box happened to
//    expose. A fix whose size equals the number of instances one live box revealed is scoped to that
//    box: a user whose gateway says "Citibank" or "PNC Bank" hits the identical bug and gets nothing.
//    Postern is built for the world; the live box VERIFIES a design, it never decides one (CLAUDE.md).
//    So the name path is now the FALLBACK and the domain is the key.
//
// 2. EVERY MATCH IS EXACT, ON BOTH PATHS. No substring matching, no token overlap, no edit distance.
//    A matcher that maps a string to the WRONG bank asserts a false fact about where a person's money
//    is — strictly worse than admitting we do not know. "First National Bank of Discovery" must not
//    pick up the Discover mark, and neither must `discoverybank.example`.
//
// 3. The monogram tile is the DEFAULT BRANCH, not an error path (build-notes §13). An institution
//    outside the crafted set still gets a correct treatment. Coverage is a matter of porting more
//    tiles, never of rendering a blank and never of inventing a mark. An institution with no approved
//    treatment on the plate KEEPS the neutral tile — `institutions.test.tsx` names each one and why.
//
// 4. The ~32px wordmark rule is enforced HERE, in code, not in review (build-notes §13.2). Five
//    tier-1 marks are logotypes that spell the brand out in path data and the law says they are
//    unreadable below ~32px: "render them larger, or fall back to a monogram tile." So below 32 they
//    resolve to their monogram, and no caller can place a blue smudge by accident.
//
//    The rule is KEPT ARMED even though no wordmark vector is ported (the crafted Amex and Discover
//    logotypes were deleted 2026-07-25 as unreachable — every Console call site is below 32px). It is
//    the gate a FUTURE port has to clear: `WORDMARK_INSTITUTIONS` already lists all five, so
//    re-porting one cannot silently reintroduce the smudge the rule exists to prevent. It gates the
//    DOMAIN path too: how a card was identified must never change how large a mark may be drawn.
//
// 5. THE SERVED NAME IS NOT THE PLATE LABEL, and on the fallback path the bridge between them is an
//    explicit table, never a matcher. `SERVED_NAME_ALIASES` is one hand-written entry per real-world
//    string, pointing at a plate label that already has an approved mark. It is deliberately NOT
//    prefix/token/distance matching (#89 records the rule as "exact-name+monogram, NOT fuzzy"). The
//    table is no longer the remedy for the class of bug that produced it — rule 1 is — but it is still
//    the remedy for a card that carries NO domain, which the wire says happens.

/**
 * Tier 1 — the crafted brand vectors, keyed by NORMALISED plate label -> the id of the vector.
 *
 * **16 of the plate's 24 tier-1 marks, ported verbatim from `sec-institutions` H1L-0 (#107 §3).** The
 * eight that are absent are absent for three stated reasons, and none of them is "not drawn yet":
 *
 *  - FIVE are the WORDMARK logotypes the law names (Wells Fargo, Discover, American Express, Goldman
 *    Sachs, Visa). The ~32px rule below sends them to a monogram tile at every size the Console uses,
 *    so a vector would be unreachable path data implying coverage the app does not have — two of them
 *    were ported once and deleted again on 2026-07-25 for exactly that reason. Amex wearing `AX` on
 *    Amex blue is the plate's own prescribed remedy, not a defect: do not "fix" it.
 *  - TWO are Venmo and Coinbase, wordmark logotypes the law's five-name list misses. Measured off the
 *    plate's own path data they are 5.3:1 and 5.6:1 — inside the band the plate itself calls
 *    unreadable at icon size. Same reason, same outcome; see `InstitutionMark.tsx`.
 *  - ONE is Nubank, whose plate node serves path data that is not valid SVG. Also in
 *    `InstitutionMark.tsx`; it is parked, not skipped.
 *
 * Adding a row here is a PORT, never a drawing, and it cannot be a half-port: `CraftedInstitutionId`
 * is derived from these values and `CRAFTED_PATH` in `InstitutionMark.tsx` is a `Record` over that
 * union, so a name added here does not compile until its vector is added there.
 */
const CRAFTED = {
  // US banks & cards
  chase: "chase",
  "bank of america": "boa",
  // International banks
  hsbc: "hsbc",
  barclays: "barclays",
  "deutsche bank": "deutschebank",
  // Neobanks
  revolut: "revolut",
  monzo: "monzo",
  "starling bank": "starling",
  n26: "n26",
  // Payments & transfer
  wise: "wise",
  paypal: "paypal",
  "cash app": "cashapp",
  zelle: "zelle",
  // Card networks
  mastercard: "mastercard",
  // Brokerage & crypto
  robinhood: "robinhood",
  binance: "binance",
} as const;

/** The crafted marks this vault carries — DERIVED from `CRAFTED`, so the id list and the name list
 *  can never drift apart. */
export type CraftedInstitutionId = (typeof CRAFTED)[keyof typeof CRAFTED];

/**
 * Every normalised name that resolves to a crafted vector, for the tests that must hold over ALL of
 * them — the path-grammar and no-wordmark-geometry laws in `institution-vectors.test.tsx`.
 *
 * Exported rather than hand-listed there on purpose: a hand-listed set means the geometry laws only
 * cover the marks somebody remembered to add to the list, so the very next port — the one most likely
 * to be a smudge or a truncated path — is the one that escapes them. Feeding the laws from here makes
 * the coverage automatic.
 */
export const CRAFTED_INSTITUTION_KEYS: readonly string[] = Object.freeze(Object.keys(CRAFTED));

/** The one cast in this file. `CRAFTED` is `as const` so its id union can be derived from it, which
 *  makes its key type a closed union too — but the lookup key is a normalised name from the wire, so
 *  the honest read of it is "a string that may or may not be present". */
function craftedFor(normalised: string): CraftedInstitutionId | undefined {
  return (CRAFTED as Readonly<Record<string, CraftedInstitutionId | undefined>>)[normalised];
}

export type InstitutionMarkResolution =
  | { kind: "crafted"; id: CraftedInstitutionId }
  | { kind: "monogram"; initials: string; hex: string };

/**
 * The size below which a tier-1 WORDMARK logotype renders as its monogram tile instead.
 * The law's words: "Wordmark logos ... are inherently unreadable below ~32px — that's their logo,
 * not our drawing."
 */
export const WORDMARK_MIN_SIZE = 32;

/**
 * The neutral ground for an institution the law does not colour. Warm ink, never black, never an
 * invented brand colour — "never a blank, never an invented brand colour."
 */
export const NEUTRAL_MONOGRAM_HEX = "#2A2118";

/**
 * Legal-entity noise that a provider's `org.name` carries and a brand's plate label does not.
 * Stripped from the END of a name only, repeatedly — never from the middle, where it could turn one
 * institution into another.
 */
const LEGAL_SUFFIXES = new Set([
  "na",
  "nassociation",
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "plc",
  "corp",
  "corporation",
  "company",
  "sa",
  "ag",
  "nv",
  "bv",
]);

/**
 * Case-fold, drop punctuation, collapse whitespace, drop a leading "the", then drop trailing legal
 * suffixes. Deterministic and dumb on purpose — the whole point is that two different institutions
 * can never normalise onto the same key by accident.
 */
export function normaliseInstitutionName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);

  if (words[0] === "the") words.shift();
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) words.pop();

  return words.join(" ");
}

/**
 * The five tier-1 logotypes the law names as unreadable below ~32px. Kept COMPLETE and kept ARMED,
 * even though none of the five has a crafted vector in this vault today — this set is the policy,
 * not an index of what is ported, and it is what a future port has to get past.
 *
 * ⚠️ THE LAW'S LIST OF FIVE IS INCOMPLETE, and this set deliberately still matches it. Measured off
 * the plate's own path data, `i-venmo` H41-0 is a 5.3:1 horizontal logotype and `i-coinbase` H45-0 is
 * 5.6:1 — the same shape as the five, and inside the very band the plate's tier-2 note calls unreadable
 * at icon size ("US Bank 5:1, Truist 4:1, IBKR 7:1"). Neither is ported, so adding them here could not
 * change what renders, and #107's acceptance says this set stays untouched. The durable fix is a PLATE
 * correction (add both to §VII's wordmark note, and give each a tier-2 tile in its own hex) — a design
 * decision, not a code one. Until then `institution-vectors.test.tsx` refuses any ported vector wider
 * than 3:1, which is the same protection arrived at from the geometry instead of from a list.
 */
const WORDMARK_INSTITUTIONS = new Set([
  "wells fargo",
  "discover",
  "american express",
  "goldman sachs",
  "visa",
]);

/**
 * Tier 2 — the wordmark-only institutions, each a brand-coloured monogram tile.
 *
 * Initials come from the law's plate (`m-*` tiles); hexes are the brands' own official colours as
 * recorded by the law. `american express` and `discover` also appear here: they are tier-1 marks the
 * ~32px rule sends to a tile at Console scale, which is the law's own prescribed remedy. `AX` on
 * #2E77BC and `D` on #FF6000 are BRAND FACTS, not vectors — deleting the two logotypes does not
 * touch them, and an Amex row keeps wearing Amex blue.
 *
 * Bank of America is deliberately NOT here. It was the institution reported as a neutral "B"
 * (#107 §3), and the cheap remedy on the table was a tier-2 tile for it — but BofA is a tier-1
 * non-wordmark mark on the plate, so its real vector is ported into `CRAFTED` above and always wins.
 * A tile row for it would be unreachable.
 */
const MONOGRAM: Record<string, { initials: string; hex: string }> = {
  citi: { initials: "C", hex: "#056DAE" },
  "capital one": { initials: "C1", hex: "#CC2427" },
  "us bank": { initials: "US", hex: "#001E79" },
  pnc: { initials: "P", hex: "#F58025" },
  truist: { initials: "T", hex: "#2D1A47" },
  "td bank": { initials: "TD", hex: "#003F2D" },
  "charles schwab": { initials: "S", hex: "#00A0DF" },
  fidelity: { initials: "F", hex: "#368727" },
  vanguard: { initials: "V", hex: "#96151D" },
  ally: { initials: "A", hex: "#481149" },
  "navy federal": { initials: "NF", hex: "#003767" },
  "interactive brokers": { initials: "IB", hex: "#D81222" },
  usaa: { initials: "U", hex: "#002855" },
  sofi: { initials: "So", hex: "#00A9E0" },
  chime: { initials: "Ch", hex: "#1EC677" },
  etrade: { initials: "E", hex: "#6C3F98" },
  "morgan stanley": { initials: "MS", hex: "#002B5C" },
  "american express": { initials: "AX", hex: "#2E77BC" },
  discover: { initials: "D", hex: "#FF6000" },
};

/**
 * The SERVED-NAME ALIAS — normalised string a provider actually sends -> normalised plate label whose
 * approved treatment it takes. Rule 5 in the header is the why; this is the table.
 *
 * ⚠️ THIS IS THE FALLBACK PATH NOW, not the answer. It is reached only for a card the gateway has no
 * `orgDomain` for, and it is deliberately NOT grown one live string at a time any more — that is what
 * rule 1 replaced. Every entry below stays because the string it names is real and some gateway still
 * serves that card without a domain; nothing here is a template for adding a fifth.
 *
 * WHAT AN ENTRY IS. A statement that one exact real-world string names one brand on the plate. Nothing
 * more: no scoring, no partial credit, no ordering. Adding an entry is adding a line somebody can read
 * and disagree with by eye, which is the point — the alternative on the table was a fuzzy matcher, and
 * a fuzzy matcher is a machine for putting Wells Fargo's mark on a credit union.
 *
 * WHAT AN ENTRY MAY POINT AT. Only a label that is ALREADY APPROVED — a `CRAFTED` vector or a
 * `MONOGRAM` tile. An alias may not conjure a treatment: pointing at a label with no mark is a no-op
 * that reads like coverage, and `institutions.served.test.tsx` fails the build for it. Three further
 * shapes it fails, all of them silent otherwise: a key that is not already in normalised form (dead
 * code — the lookup happens AFTER `normaliseInstitutionName`), a key that is itself an approved label
 * (an alias must never shadow a direct hit), and a target that is itself a key (no chains — one hop,
 * always, so the table can be read a line at a time).
 *
 * WHAT IS NOT HERE, AND WHY NOT. Only strings a real gateway has been OBSERVED to serve get an entry.
 * "JPMorgan Chase" is the same bank as "Chase Bank" and is deliberately absent: nothing has been seen
 * to send it, and `institutions.test.tsx` pins it neutral as a canary for the fuzzy matching this file
 * refuses. Speculating entries is how the table stops being evidence and starts being a guess.
 */
export const SERVED_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // Plaid's Chase Item serves "Chase Bank"; the plate label is "Chase" (tier-1 vector `i-chase`).
  // This is the one that stings: the chase vector predates every other mark in this file and had
  // never once matched a string a provider actually sends.
  "chase bank": "chase",
  // "Charles Schwab US" — the plate label is "Charles Schwab" (tier-2 tile `m-schwab`, S on #00A0DF).
  "charles schwab us": "charles schwab",
  // "Discover Credit Card" — the plate label is "Discover". Its plate mark is a horizontal LOGOTYPE
  // (`i-discover` H26-0, #FF6000), so the ~32px rule sends it to its tile at every Console size. The
  // fix is the tile, in Discover's own orange; porting the logotype would re-ship the smudge.
  "discover credit card": "discover",
  // "Fidelity Investments" — the plate label is "Fidelity" (tier-2 tile `m-fidelity`, F on #368727).
  "fidelity investments": "fidelity",
});

/** The first character of an unknown institution's name, on the neutral ink ground. */
function fallbackMonogram(normalised: string, original: string): InstitutionMarkResolution {
  const source = normalised || original;
  const initial = source.trim().charAt(0).toUpperCase();
  return {
    kind: "monogram",
    // An empty name still gets a mark rather than a blank; "?" is the honest stand-in for "the
    // gateway did not serve a name", not a guess at which institution this is.
    initials: initial || "?",
    hex: NEUTRAL_MONOGRAM_HEX,
  };
}

/**
 * Whether a normalised plate label carries an approved treatment at all — a crafted vector or a
 * brand-coloured tile. The alias laws are written against this rather than against the two private
 * tables, so a future tier gets covered without anybody remembering to widen the test.
 */
export function hasApprovedTreatment(normalisedLabel: string): boolean {
  return craftedFor(normalisedLabel) !== undefined || normalisedLabel in MONOGRAM;
}

/** Every normalised plate label that carries an approved treatment, DERIVED from the two tables so the
 *  list can never fall behind them. The domain index below is built over exactly these. */
export const APPROVED_LABELS: readonly string[] = Object.freeze([
  ...Object.keys(CRAFTED),
  ...Object.keys(MONOGRAM),
]);

// ── the DOMAIN path (rule 1) ────────────────────────────────────────────────

/**
 * The dedup ENGINE'S OWN host fold, character for character.
 *
 * COPIED, NOT DESIGNED: `canonFromDomain` in `src/core/finance-dedup.ts` — lowercase, trim, strip
 * `http(s)://`, strip from the first `/`, strip a `:port`, take the registrable second-level label,
 * drop non-alphanumerics. The Console cannot import backend code, so the rule is duplicated; it is
 * duplicated VERBATIM and this comment is the receipt. A fold that disagreed with the engine's would
 * put one institution's mark on a card the engine had merged under another.
 *
 * Deterministic and dumb, exactly like `normaliseInstitutionName` and for the same reason: two
 * different institutions must never be able to fold onto one key by accident.
 *
 * ⚠️ IT IS AN SLD RULE, NOT A PUBLIC-SUFFIX RULE, and that limitation is inherited on purpose (fixing
 * it here would fork the fold). `barclays.co.uk` folds to `"co"`, not `"barclays"` — as does every host
 * under a two-label public suffix. That is precisely why the display-name path still runs when a domain
 * is PRESENT but unrecognised: restricting the fallback to `orgDomain == null` would have taken the
 * Barclays mark off a UK Barclays card that renders it correctly today. Removing coverage is not a fix.
 */
export function canonicalHostLabel(orgDomain: string | null | undefined): string | null {
  if (typeof orgDomain !== "string" || orgDomain === "") return null;
  let host = orgDomain.toLowerCase().trim();
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length === 0) return null;
  const sld = labels.length >= 2 ? labels[labels.length - 2]! : labels[0]!;
  const folded = sld.replace(/[^a-z0-9]/g, "");
  return folded || null;
}

/**
 * host fold -> the plate label it names, DERIVED from the approved labels by removing their spaces.
 *
 * This is the part that makes the fix general rather than census-sized. For most institutions the
 * registrable label already IS the plate label with the spaces taken out — `chase.com`, `pnc.com`,
 * `citi.com`, `bankofamerica.com`, `capitalone.com`, `usbank.com`, `navyfederal.org`,
 * `morganstanley.com`, `americanexpress.com`, `starlingbank.com`, `cashapp.com` — so a bank nobody
 * has ever seen served gets its approved mark with no table entry and no live read. Porting a new
 * tile off the plate gains its domain key in the same commit, automatically.
 *
 * It is still EXACT equality on a deterministic fold: one label in, one label out, no scoring.
 */
const LABEL_BY_HOST_FOLD: ReadonlyMap<string, string> = new Map(
  APPROVED_LABELS.map((label) => [label.replace(/[^a-z0-9]/g, ""), label] as const),
);

/**
 * The host folds the derivation above cannot reach: an institution whose registrable domain is not its
 * own name. Every entry is one statement — "this registrable label is that brand" — readable and
 * disagreeable by eye, and every target is a label that ALREADY carries an approved treatment
 * (`institutions.domain.test.tsx` fails the build otherwise, so an entry can never conjure a mark).
 *
 * PURELY ADDITIVE: no key here is also a derived key, so the table can only widen coverage, never
 * silently overrule the plate's own answer for a label. That is asserted, not assumed.
 */
export const DOMAIN_HOST_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  // schwab.com — the plate label is "Charles Schwab" (tier-2 tile `m-schwab`).
  schwab: "charles schwab",
  // citibank.com, beside the derived citi.com.
  citibank: "citi",
  // ibkr.com — the plate label is "Interactive Brokers" (tier-2 tile `m-ibkr`), and
  // interactivebrokers.com is already covered by the derivation.
  ibkr: "interactive brokers",
  // td.com — TD's own registrable label. tdbank.com is covered by the derivation.
  td: "td bank",
  // zellepay.com — Zelle's operating domain; zelle.com is covered by the derivation.
  zellepay: "zelle",
  // db.com — Deutsche Bank's registrable label. `deutsche-bank.de` folds to "deutschebank" and is
  // covered by the derivation (the fold strips the hyphen).
  db: "deutsche bank",
});

/**
 * Host folds that name a brand on the plate and are DELIBERATELY NOT KEYED, with the reason.
 *
 * The honest gap on this path: a fold that is a generic English word cannot be claimed for one brand,
 * because the fold is not a public-suffix rule and any host at `<word>.<tld>` produces it. Listing
 * them here rather than leaving them absent is what stops the next reader "finishing the job".
 */
export const HOST_FOLDS_LEFT_UNKEYED: Readonly<Record<string, string>> = Object.freeze({
  cash:
    "Cash App's own cash.app folds to the generic word \"cash\"; keying it would hand Cash App's " +
    "mark to any institution at cash.<tld>. cashapp.com is covered by the derivation.",
});

/**
 * The plate label a served `orgDomain` names, or null when this gateway's domain names nothing we have
 * an approved treatment for. Takes the value AS SERVED — verbatim, scheme and `www.` included, exactly
 * as `api/types.ts` promises — and folds it here, at the point of use, owning that choice.
 */
export function plateLabelForDomain(orgDomain: string | null | undefined): string | null {
  const fold = canonicalHostLabel(orgDomain);
  if (fold === null) return null;
  const exception = DOMAIN_HOST_EXCEPTIONS[fold];
  if (exception !== undefined) return exception;
  return LABEL_BY_HOST_FOLD.get(fold) ?? null;
}

/**
 * The treatment a plate label earns at a given size, or null when the plate has none for it.
 *
 * One function so the ~32px wordmark rule (rule 4) cannot apply on one path and not the other: how a
 * card was IDENTIFIED must never change how large its mark may be drawn.
 */
function treatmentFor(label: string, size: number): InstitutionMarkResolution | null {
  const crafted = craftedFor(label);
  const wordmarkTooSmall = WORDMARK_INSTITUTIONS.has(label) && size < WORDMARK_MIN_SIZE;

  if (crafted && !wordmarkTooSmall) return { kind: "crafted", id: crafted };

  const tile = MONOGRAM[label];
  if (tile) return { kind: "monogram", initials: tile.initials, hex: tile.hex };

  return null;
}

/**
 * Which branch will render, for a given card at a given size.
 *
 * Exported for tests and for surfaces that must know the answer before they lay out (a monogram tile
 * and a crafted vector occupy the same 22px box, but only one of them is a `<div>`).
 *
 * ORDER: the stable identifier, then the display name, then the honest initial.
 */
export function resolveInstitutionMark(
  name: string,
  size: number,
  orgDomain?: string | null,
): InstitutionMarkResolution {
  const normalised = normaliseInstitutionName(name);

  const fromDomain = plateLabelForDomain(orgDomain);
  if (fromDomain !== null) {
    // The DOMAIN decided which institution this card belongs to, so the display name may not overrule
    // it — falling through to the name here is how a card whose domain says one brand could end up
    // wearing another's mark. Only the TREATMENT can be missing, and the honest answer to a missing
    // treatment is the neutral initial of the name as served.
    //
    // The `??` arm is unreachable with today's tables (every approved label has a treatment at every
    // Console size — `institutions.domain.test.tsx` asserts exactly that, so this stops being a claim
    // and starts being a fact). It becomes live the day a tier-1 WORDMARK gets a crafted vector with
    // no tier-2 tile beside it: Visa's domain would then name Visa, and Visa at 22px has no drawing.
    return treatmentFor(fromDomain, size) ?? fallbackMonogram(normalised, name);
  }

  // One hop, exact, after normalisation. An unaliased name is its own key, so this line can only ever
  // move a string that is written out in `SERVED_NAME_ALIASES` above.
  const key = SERVED_NAME_ALIASES[normalised] ?? normalised;

  // The fallback reads the name AS SERVED, never the alias target: if an alias ever pointed at a label
  // with no mark, an "Apple Card" row must still show "A" and not the initial of some other brand.
  return treatmentFor(key, size) ?? fallbackMonogram(normalised, name);
}

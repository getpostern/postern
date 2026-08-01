// THE grains the Console counts in — and the ONE tally over each.
//
// Two of them are about connections (`sources` ‖ `connections`, #65/#91). The third is about banks
// (`institutionRun`, #111) and was added later; its own block sits further down. They are one file
// because they are one mistake: a surface printing a count under a noun of a different grain.
//
// Audit finding #65 named it and #91 is its rerun: "sources" and "connections" are TWO different
// numbers. A credential fans out to N sector connectors, and each Plaid Item is its OWN credential
// (CLAUDE.md: one bank = one connection, and there is no single "Plaid connector") — so on a real
// gate the two numbers differ, and printing one under the other's noun makes a revoke's blast radius
// invisible. Pulling one iCloud credential darkens three connections; a verdict that spells the
// CONNECTION count under the word "sources" says nothing about that — and the Gatehouse did exactly
// that while the Sources page one click away printed both grains correctly.
//
// The design settles both the rule and the sentence. Gatehouse verdict sub-line (`9KQ-0`, `F7Y-0`,
// `F85-0`): "Seven sources · twenty-four connections · …". Sources masthead (`1KX-0`): "Twenty-four
// connections behind seven providers, across six sectors". Finance lens (`IZ-0`): "Fifteen
// connections behind two providers". Where the two grains diverge the design names BOTH; where they
// agree it names one. **"Source" ≡ provider, always.** (Every figure in a plate is an invented
// placeholder — build-notes §0. The SHAPE is the spec; the digits are not.)
//
// ONE number, two nouns: the Sources masthead prints "providers", the Gatehouse prints "sources",
// and they are the same tally. It is named once here (`sources`) so no surface has to decide, and
// both read it instead of re-deriving it — three derivations is what produced #65, and then #91.
//
// The tally takes the CONNECTOR ROWS, never the /sources page's groups: the Gatehouse never groups,
// so a group-shaped input would have forced it to build a grouping it does not render — a second
// implementation wearing a shared name. `grain.parity.test.ts` pins that grouping is lossless, so
// the group-derived number and this one cannot drift.
//
// WHERE THIS BELONGS: `src/api/`, beside `freshness.ts` (the one state derivation) and `format.ts`
// (the one clock) — as #91 says in as many words. It is here because the unit that closed #91 owned
// `pages/` and `shell/` only, and `api/` was concurrently another unit's file set. Moving it is a
// file move plus imports; nothing about the derivation changes.

// The INSTITUTION grain is the third one, added for #111 — same family, one table over. Its fold is
// documented at `institutionIdentity` below.

// Direct module import, NOT the `../../marks` barrel: the barrel pulls the components and their CSS
// modules, and a counting module must stay renderable-free. The fold's real home is `api/`, beside
// `freshness.ts` — the same note this module's own header makes about itself.
import { canonicalHostLabel } from "../../marks/institutions";
import type { ConnectorStatus, FinanceBankSummary } from "../../api/types";

/**
 * The connections a surface speaks for: everything the gate is currently holding.
 *
 * A revoked connector is GONE, not unhealthy — `revokeCredential` deliberately KEEPS the rows and
 * the list serves them, so without this filter a removed connection paints a green dot and a cadence
 * it is not on (disconnected → tone `idle` → `isUnhealthy` false → groupHealth "ok"; #96 §5).
 *
 * ONE filter, because the two surfaces must count the same rows: the Gatehouse and Sources each held
 * a private copy of this predicate, and #91's trap #2 is exactly that sharing a tally is worthless
 * while the inputs are chosen independently.
 *
 * Applied at the CALL SITES, never inside `groupConnectors` — a hidden filter inside a grouping
 * function is a trap for the next reader.
 */
export function liveConnectors(cs: ConnectorStatus[]): ConnectorStatus[] {
  return cs.filter((c) => c.status !== "revoked");
}

export interface GrainCounts {
  /**
   * The SOURCE grain — distinct providers the user named. Plaid's N Items are one Plaid; two
   * Microsoft consents are still one Microsoft. Never the group count, never the credential count.
   */
  sources: number;
  /** The CONNECTION grain — one per connector row (`connectors.id` IS the connection_id). */
  connections: number;
}

/** THE tally over the two grains. Every surface that names either number reads it from here. */
export function sourceCounts(connectors: ConnectorStatus[]): GrainCounts {
  return {
    sources: new Set(connectors.map((c) => c.provider)).size,
    connections: connectors.length,
  };
}

// ── the INSTITUTION grain (#111) ────────────────────────────────────────────
//
// #111 is #65/#91's family one table over. `GET /api/finance/banks` serves ONE ROW PER ACCOUNT
// IDENTITY — canonical institution × last-4 mask × currency — under a field named `institution`, and
// the Console read the array's LENGTH as an institution count. The finance surfaces printed an
// ACCOUNT count under the word "institutions", over far fewer banks, and repeated the same
// institution once per card. The wire's own type comment admitted the grain; the field name won.
//
// THE FOLD, NOT THE STRING. Counting distinct display strings is right on one box and wrong for anyone
// whose provider spells one bank two ways — the same trap as keying a mark on a name. So identity comes
// from `orgDomain`, the stable identifier, folded exactly the way the dedup ENGINE folds it, with the
// engine's own NAME fold behind it for a card that carries no domain. Using the engine's fold is what
// makes it impossible for the Console's grouping and the engine's merges to disagree.
//
// `institutionKey` IS NOT SERVED. #111 asked the backend for both `institutionKey` and `orgDomain`;
// only `orgDomain` landed. So the fold is client-side, and `institutionIdentity` is the ONE place it
// happens — the one thing to delete here the day the key arrives.

/** The engine's `INSTITUTION_ALIAS`, copied verbatim from `src/core/finance-dedup.ts`. */
const INSTITUTION_ALIAS: Record<string, string> = {
  amex: "americanexpress",
  americanexpressco: "americanexpress",
};

/**
 * The engine's `canonFromName`, copied verbatim from `src/core/finance-dedup.ts` — lowercase, drop
 * "(updated monthly)", drop a trailing `(dddd)` mask, strip non-alphanumerics, then the alias map.
 *
 * DELIBERATELY NOT `normaliseInstitutionName` (marks/institutions.ts), which is a different fold for a
 * different job: that one keys into the plate's label vocabulary and keeps word boundaries; this one
 * has to agree with the server about which cards are one bank. Two folds, two purposes, both exact.
 */
function canonicalNameFold(name: string | null | undefined): string | null {
  if (typeof name !== "string" || name === "") return null;
  let s = name.toLowerCase();
  s = s.replace(/\(updated monthly\)/g, " ");
  s = s.replace(/\(\s*\d{4}\s*\)/g, " ");
  s = s.replace(/[^a-z0-9]+/g, "");
  s = INSTITUTION_ALIAS[s] ?? s;
  return s || null;
}

/**
 * A card that is a CONNECTOR, not an institution.
 *
 * `summarizeBanks` appends one card per finance connector that has cached no accounts, so a
 * mid-onboarding link is still visible and manageable. Its `institution` is a connector label
 * ("Plaid (connecting…)"), it carries no domain, and counting it as a bank is one of the three things
 * #111 asks for.
 *
 * `accountCount === 0` is the served signature: every other card is grouped FROM live account rows, so
 * it has at least one. (The direct signal would be a served flag — or the `institutionKey: null` #111
 * asked for and did not get. Reading the `conn:` prefix off `bankKey` was the alternative and is worse:
 * the wire calls that key opaque and the Console joins by equality, never by parsing it.)
 */
function isConnectorPlaceholder(bank: FinanceBankSummary): boolean {
  return bank.accountCount === 0;
}

/**
 * WHICH INSTITUTION a bank card belongs to. Domain first, the engine's name fold second, the card's own
 * key last.
 *
 * The last arm is fail-open and deliberate: a card with neither a domain nor a usable name is its OWN
 * institution rather than being merged with every other nameless card — the same choice the engine
 * makes with `__unkeyed__:${r.id}`. Overcounting by one is honest; merging two banks the gateway cannot
 * identify would assert a fact about somebody's money that nothing supports.
 *
 * The two folds share one namespace, exactly as `canonicalInstitution` does server-side, so a card
 * that has a domain and a card that only has the name still land on one institution when they agree.
 */
export function institutionIdentity(bank: FinanceBankSummary): string {
  return (
    canonicalHostLabel(bank.orgDomain) ??
    canonicalNameFold(bank.institution) ??
    `card:${bank.bankKey}`
  );
}

/** One institution: the fold that identifies it (a React key that cannot repeat) and the first display
 *  name the gateway served for it. */
export interface Institution {
  id: string;
  name: string;
}

/**
 * THE institution tally — the distinct institutions a set of bank cards names, in served order,
 * placeholders excluded.
 *
 * Every surface that says "institutions", or renders one chip per bank, reads it from here. Three
 * independent copies of the source/connection tally is what produced #65 and then #91; this one starts
 * with one.
 *
 * The display name is the FIRST one served for the institution — deterministic because the route orders
 * its rows deterministically, and honest because it is a string the gateway actually sent rather than a
 * prettier one we chose between two spellings.
 */
export function institutionRun(banks: FinanceBankSummary[]): Institution[] {
  const byIdentity = new Map<string, string>();
  for (const bank of banks) {
    if (isConnectorPlaceholder(bank)) continue;
    const id = institutionIdentity(bank);
    if (!byIdentity.has(id)) byIdentity.set(id, bank.institution);
  }
  return [...byIdentity].map(([id, name]) => ({ id, name }));
}

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/**
 * THE number-word speller for the editorial sentences ("Fourteen connections"). Above 99 it falls
 * back to digits — a gate holding a hundred sources is past the point a sentence spells.
 *
 * There were TWO, and they disagreed above nine: the Gatehouse spelled to ninety-nine while the
 * Sources view-model spelled to nine and then fell back to digits, so the masthead rendered "24
 * connections behind seven providers" — digits and words in one clause, on the very page #91 holds up
 * as the surface that gets the grain right. The design spells structural counts and prints data
 * figures ("Twenty-four connections" but "8,925 records across 23 accounts"), so this is the
 * structural one; `api/format.ts`'s `count()` remains the figure one.
 */
export function numberWord(n: number): string {
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const r = n % 10;
    return r === 0 ? TENS[t] : `${TENS[t]}-${ONES[r]}`;
  }
  return String(n);
}

/** Capitalise the first letter (a spelled number opening a sentence). */
export function cap(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * THE spelled count-with-noun rule — "one connection" / "fourteen connections".
 *
 * The editorial twin of `api/format.ts`'s `plural()`, which renders the number through `count()` and
 * therefore cannot serve a spelled sentence. Same reason for existing: the guard was hand-rolled
 * (`${n === 1 ? "x" : "xs"}`) at six sites across the two grain sentences, which is how #92's "feeds
 * 1 banks" happened one file over. `many` is overridable because English is not a rule.
 */
export function spelled(n: number, one: string, many = `${one}s`): string {
  return `${numberWord(n)} ${n === 1 ? one : many}`;
}

// The ONE tally over the two grains, and the ONE speller. Pure — no DOM, no fetching.
//
// Every fixture here is deliberately LOPSIDED: the provider count, the credential count and the
// connection count are three different numbers. A fixture where they coincide cannot fail, and that
// is precisely how #65 shipped and then #91 shipped again — the Gatehouse's own fixture gave every
// connector the same `credentialId` and one provider apiece.

import { describe, expect, it } from "vitest";
import {
  cap,
  institutionIdentity,
  institutionRun,
  liveConnectors,
  numberWord,
  sourceCounts,
  spelled,
} from "./grain";
import type { ConnectorStatus, FinanceBankSummary } from "../../api/types";

function conn(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    connectionId: "c1",
    credentialId: "cred-1",
    provider: "apple",
    sector: "mail",
    status: "active",
    last_synced_at: null,
    last_error: null,
    last_error_at: null,
    policy_mode: "poll",
    next_sync_at: null,
    scopes: [],
    credential: { status: "active", expires_at: null },
    webhook_secret_set_at: null,
    sync_window_days: null,
    sync_interval_sec: null,
    min_interval_sec: null,
    default_interval_sec: null,
    cached_count: 0,
    ...over,
  };
}

/**
 * A gate shaped like a real one, if smaller: THREE providers, FIVE credentials, SEVEN connections.
 * One iCloud credential fanned across three sectors, three Plaid Items each with its own credential
 * (one bank = one connection), one WHOOP.
 */
const GATE: ConnectorStatus[] = [
  conn({ connectionId: "a-mail", provider: "apple", sector: "mail", credentialId: "apple-1" }),
  conn({ connectionId: "a-cal", provider: "apple", sector: "calendar", credentialId: "apple-1" }),
  conn({ connectionId: "a-con", provider: "apple", sector: "contacts", credentialId: "apple-1" }),
  conn({ connectionId: "p-1", provider: "plaid", sector: "finance", credentialId: "plaid-a" }),
  conn({ connectionId: "p-2", provider: "plaid", sector: "finance", credentialId: "plaid-b" }),
  conn({ connectionId: "p-3", provider: "plaid", sector: "finance", credentialId: "plaid-c" }),
  conn({ connectionId: "w-1", provider: "whoop", sector: "health", credentialId: "whoop-1" }),
];

describe("sourceCounts — two grains, three different numbers", () => {
  it("counts providers for sources and rows for connections", () => {
    // MUTATION: count credentials instead of providers → sources becomes 5, red. Count rows → 7, red.
    expect(sourceCounts(GATE)).toEqual({ sources: 3, connections: 7 });
    // …and the credential count is neither of them, which is the whole reason this is not one number.
    expect(new Set(GATE.map((c) => c.credentialId)).size).toBe(5);
  });

  it("two consents for ONE provider are still one source", () => {
    // Two independent Microsoft credentials, four connections. "Sources" is what the user NAMED, so
    // this is one Microsoft — the /sources page still draws two removable groups (that is a different
    // question, and `groupConnectors` answers it).
    const cs = [
      conn({ connectionId: "m1", provider: "microsoft", sector: "mail", credentialId: "ms-A" }),
      conn({ connectionId: "m2", provider: "microsoft", sector: "calendar", credentialId: "ms-A" }),
      conn({ connectionId: "m3", provider: "microsoft", sector: "mail", credentialId: "ms-B" }),
      conn({ connectionId: "m4", provider: "microsoft", sector: "calendar", credentialId: "ms-B" }),
    ];
    expect(sourceCounts(cs)).toEqual({ sources: 1, connections: 4 });
  });

  it("an empty gate is two zeroes, not a crash and not a one", () => {
    expect(sourceCounts([])).toEqual({ sources: 0, connections: 0 });
  });
});

describe("liveConnectors — a revoked connection is GONE, not unhealthy", () => {
  it("drops revoked rows and keeps every other status", () => {
    const cs = [
      conn({ connectionId: "gone", status: "revoked" }),
      conn({ connectionId: "live" }),
      conn({ connectionId: "paused", status: "paused" }),
      conn({ connectionId: "err", status: "error" }),
    ];
    expect(liveConnectors(cs).map((c) => c.connectionId)).toEqual(["live", "paused", "err"]);
  });

  it("is what makes the two surfaces count the same rows", () => {
    // The asymmetry #91 warns about: sharing a tally is worthless if each surface filters its own
    // input. Both call THIS function, so a revoked row can never be in one count and out of the other.
    const cs = [...GATE, conn({ connectionId: "dead", provider: "gmail", status: "revoked" })];
    expect(sourceCounts(liveConnectors(cs))).toEqual({ sources: 3, connections: 7 });
    // and the unfiltered tally really is different — otherwise this cell asserts nothing
    expect(sourceCounts(cs)).toEqual({ sources: 4, connections: 8 });
  });
});

// ── the INSTITUTION grain (#111) ────────────────────────────────────────────
//
// THE FIXTURE IS THE TEST. `GET /api/finance/banks` serves one row per institution × last-4 × currency,
// so the numbers that matter here are three DIFFERENT ones: 6 served cards, 9 accounts, 3 institutions.
// A fixture with one account per institution passes on `banks.length` and on a display-string `Set`
// alike, and that is precisely how an account count under the word "institutions" shipped.
//
// It also carries the two folds the display string cannot do:
//   · ONE institution under THREE spellings ("American Express" / "AMERICAN EXPRESS" / "Amex") — with
//     one of the three writing its domain as a full URL, so the host fold has to earn its keep.
//   · TWO domain-less cards that are one bank only after the engine's NAME fold strips
//     "(Updated Monthly)" — the exact pair #111 names as unresolvable by display string.

function bankCard(over: Partial<FinanceBankSummary> = {}): FinanceBankSummary {
  return {
    institution: "Ally",
    orgDomain: "ally.com",
    mask: "2001",
    bankKey: "cm:ally|2001|USD",
    dedupGroupId: null,
    providers: [{ provider: "simplefin", connectionId: "sfin-1", itemStatus: null, lastSyncedAt: null }],
    accountCount: 1,
    health: "ok",
    unmergedDuplicate: false,
    classConflict: false,
    ...over,
  };
}

/** Six served CARDS · nine ACCOUNTS · three INSTITUTIONS. No two of those numbers are equal. */
const CARDS: FinanceBankSummary[] = [
  bankCard({ institution: "American Express", orgDomain: "americanexpress.com", mask: "1001", bankKey: "cm:amex|1001|USD" }),
  bankCard({ institution: "AMERICAN EXPRESS", orgDomain: "https://www.americanexpress.com/", mask: "1002", bankKey: "cm:amex|1002|USD" }),
  bankCard({ institution: "Amex", orgDomain: "americanexpress.com", mask: "1003", bankKey: "cm:amex|1003|USD", accountCount: 2 }),
  bankCard({ institution: "Ally", orgDomain: "ally.com", mask: "2001", bankKey: "cm:ally|2001|USD" }),
  bankCard({ institution: "Vanguard", orgDomain: null, mask: "3001", bankKey: "cm:vanguard|3001|USD", accountCount: 3 }),
  bankCard({ institution: "Vanguard (Updated Monthly)", orgDomain: null, mask: "3002", bankKey: "cm:vanguard|3002|USD" }),
];

/** The zero-account card `summarizeBanks` appends for a finance connector that has cached nothing. Its
 *  `institution` is a CONNECTOR label, and #111 requires that it never count as a bank. */
const PLACEHOLDER = bankCard({
  institution: "SimpleFIN (connecting…)",
  orgDomain: null,
  mask: null,
  bankKey: "conn:sfin-1",
  accountCount: 0,
});

describe("institutionRun — the wire is card-grained, the sentence is institution-grained (#111)", () => {
  it("the fixture's three numbers really are three numbers", () => {
    // Without this cell every assertion below could be satisfied by the wrong grain.
    expect(CARDS).toHaveLength(6);
    expect(CARDS.reduce((n, b) => n + b.accountCount, 0)).toBe(9);
    expect(institutionRun(CARDS)).toHaveLength(3);
  });

  it("folds three spellings of one bank into one institution, keeping the FIRST served name", () => {
    // MUTATION: return `banks.map(b => b.institution)` → six entries with Amex three times, red.
    // MUTATION: fold on the display string instead of the identity → five entries, red.
    expect(institutionRun(CARDS).map((i) => i.name)).toEqual([
      "American Express",
      "Ally",
      "Vanguard",
    ]);
  });

  it("gives every institution a DISTINCT id — the duplicate React key, at its source", () => {
    // Three children keyed "American Express" was an independent symptom of the same error (#111).
    const ids = institutionRun(CARDS).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the host fold does the Amex folding, through a URL and a case change", () => {
    // The three Amex cards carry "americanexpress.com", a full "https://www.americanexpress.com/" and
    // "americanexpress.com" again. MUTATION: stop stripping the scheme/www in `canonicalHostLabel` and
    // the middle card becomes its own institution — four entries, red.
    const [a, b, c] = CARDS;
    expect(institutionIdentity(a)).toBe("americanexpress");
    expect(institutionIdentity(b)).toBe("americanexpress");
    expect(institutionIdentity(c)).toBe("americanexpress");
  });

  it("a card with NO domain falls to the ENGINE'S name fold, not to the display string", () => {
    // "Vanguard" and "Vanguard (Updated Monthly)" are ONE institution to `canonFromName` (it strips the
    // suffix) and TWO strings to any client that compares display names. Agreeing with the engine is
    // what makes the Console's grouping and the engine's merges incapable of disagreeing.
    const [, , , , v1, v2] = CARDS;
    expect(institutionIdentity(v1)).toBe("vanguard");
    expect(institutionIdentity(v2)).toBe("vanguard");
  });

  it("carries the engine's alias map, so 'Amex' alone still folds onto American Express", () => {
    // The domain-absent path has to survive the same spellings the domain path handles. `INSTITUTION_ALIAS`
    // is the engine's, copied verbatim.
    expect(institutionIdentity(bankCard({ institution: "Amex", orgDomain: null }))).toBe("americanexpress");
    expect(institutionIdentity(bankCard({ institution: "American Express", orgDomain: null }))).toBe(
      "americanexpress",
    );
  });

  it("a zero-account CONNECTOR card is not an institution", () => {
    // MUTATION: drop the placeholder guard → the run reads ["SimpleFIN (connecting…)"], red. The Console
    // would name a connector as one of the user's banks.
    expect(institutionRun([PLACEHOLDER])).toEqual([]);
    expect(institutionRun([...CARDS, PLACEHOLDER])).toHaveLength(3);
  });

  it("the DOMAIN wins over the name when the two disagree about the bank", () => {
    // Two cards whose names match and whose domains do not are two institutions. The stable identifier
    // decides; a shared display string is not evidence of a shared bank.
    const run = institutionRun([
      bankCard({ institution: "Premier Bank", orgDomain: "premier-mn.example", bankKey: "k1" }),
      bankCard({ institution: "Premier Bank", orgDomain: "premierbanktx.example", bankKey: "k2" }),
    ]);
    expect(run).toHaveLength(2);
  });

  it("a card with neither a domain nor a usable name is its OWN institution, never merged", () => {
    // Fail-open, the engine's own choice (`__unkeyed__:${r.id}`). Overcounting by one is honest;
    // merging two banks the gateway cannot identify asserts a fact about somebody's money.
    const run = institutionRun([
      bankCard({ institution: "", orgDomain: null, bankKey: "unkeyed-1" }),
      bankCard({ institution: "   ", orgDomain: null, bankKey: "unkeyed-2" }),
    ]);
    expect(run).toHaveLength(2);
    expect(new Set(run.map((i) => i.id)).size).toBe(2);
  });

  it("an absent orgDomain field (a gateway predating it) behaves as no domain, never as a domain", () => {
    // `undefined` is "NOT SERVED" and `null` is "served, and there is none" — different facts, same
    // fold, and neither may be treated as a host.
    const legacy = bankCard({ institution: "Vanguard", bankKey: "legacy" });
    delete (legacy as { orgDomain?: string | null }).orgDomain;
    expect(institutionIdentity(legacy)).toBe("vanguard");
  });

  it("an empty card list is zero institutions, not a crash and not a one", () => {
    expect(institutionRun([])).toEqual([]);
  });
});

describe("numberWord — ONE speller, to ninety-nine", () => {
  it("spells the range the design's sentences use", () => {
    expect(numberWord(0)).toBe("zero");
    expect(numberWord(1)).toBe("one");
    expect(numberWord(9)).toBe("nine");
    // The boundary the SECOND speller stopped at — it printed "10", "24", "14" as digits mid-sentence.
    expect(numberWord(10)).toBe("ten");
    expect(numberWord(11)).toBe("eleven");
    expect(numberWord(14)).toBe("fourteen");
    expect(numberWord(24)).toBe("twenty-four");
    expect(numberWord(99)).toBe("ninety-nine");
  });
  it("falls back to digits past 99", () => {
    expect(numberWord(100)).toBe("100");
  });
  it("does not crash on bad input", () => {
    expect(numberWord(-1)).toBe("-1");
    expect(numberWord(1.5)).toBe("1.5");
  });
});

describe("spelled — the count-with-noun rule for a spelled sentence", () => {
  it("agrees the noun with the number", () => {
    expect(spelled(1, "connection")).toBe("one connection");
    expect(spelled(14, "connection")).toBe("fourteen connections");
    expect(spelled(0, "connection")).toBe("zero connections");
  });
  it("takes an irregular plural, because English is not a rule", () => {
    expect(spelled(1, "Plaid bank is", "Plaid banks are")).toBe("one Plaid bank is");
    expect(spelled(2, "Plaid bank is", "Plaid banks are")).toBe("two Plaid banks are");
  });
});

describe("cap", () => {
  it("capitalises the first letter only", () => {
    expect(cap("twenty-four")).toBe("Twenty-four");
    expect(cap("")).toBe("");
  });
});

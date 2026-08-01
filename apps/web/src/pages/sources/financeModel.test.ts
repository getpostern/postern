// Finance-join tests — Plaid bank rows + SimpleFIN institution line, joined by connection id (never
// by re-deriving dedup).
//
// #111 IS PINNED BY THE FIXTURES, NOT BY A COUNT. The wire is card-grained (institution × last-4 ×
// currency) and both surfaces here render per-institution, so every fixture that matters gives a
// DIFFERENT number of cards, accounts and institutions, and puts at least one institution under two
// display strings. A fixture where those coincide passes with the bug in place — which is how an
// account count under the word "institutions", and one bank drawn once per card, shipped.

import { describe, expect, it } from "vitest";
import type { ConnectorStatus, FinanceBankSummary, Freshness, FreshnessState } from "../../api/types";
import { humanize } from "../../api/format";
import { providerDisplay } from "./model";
import { plaidBankRows, simplefinInstitutions } from "./financeModel";

function fresh(state: FreshnessState, over: Partial<Freshness> = {}): Freshness {
  return {
    state,
    last_heard_at: "2026-07-23T12:00:00.000Z",
    next_expected_at: null,
    stream_state: null,
    error: null,
    ...over,
  };
}

/** A Plaid connector on a 2h poll — the cadence every bank row inherits (§18.2). */
function plaidConn(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    connectionId: "plaid-1",
    credentialId: "cred-plaid-1",
    provider: "plaid",
    sector: "finance",
    status: "active",
    last_synced_at: "2026-07-23T12:00:00.000Z",
    last_error: null,
    last_error_at: null,
    policy_mode: "poll",
    next_sync_at: null,
    scopes: [],
    credential: { status: "active", expires_at: null },
    webhook_secret_set_at: null,
    sync_window_days: null,
    sync_interval_sec: 7200,
    min_interval_sec: 7200,
    default_interval_sec: 7200,
    cached_count: 2,
    push_kind: null,
    freshness: fresh("ok"),
    ...over,
  };
}

function bank(over: Partial<FinanceBankSummary>): FinanceBankSummary {
  return {
    institution: "Chase",
    // `null` = served, and this gateway has no domain for the card. The DEFAULT on purpose: these
    // fixtures are about the joins, so they identify by the engine's name fold and a test that cares
    // about the domain says so. (The domain path itself is `marks/institutions.domain.test.tsx`.)
    orgDomain: null,
    mask: "8830",
    bankKey: "k1",
    dedupGroupId: null,
    providers: [{ provider: "plaid", connectionId: "plaid-1", itemStatus: "ok", lastSyncedAt: "2026-07-23T12:00:00Z" }],
    accountCount: 2,
    health: "ok",
    unmergedDuplicate: false,
    classConflict: false,
    ...over,
  };
}

describe("plaidBankRows", () => {
  it("builds a row per bank routed through a Plaid connection, with coverage", () => {
    const banks = [
      bank({ institution: "Chase", accountCount: 2, health: "ok" }),
      bank({ institution: "Fidelity", bankKey: "k2", accountCount: 1, health: "ok", mask: "2207" }),
    ];
    const rows = plaidBankRows(banks, [plaidConn()]);
    expect(rows).toHaveLength(2);
    expect(rows[0].coverage).toBe("2 accounts");
    expect(rows[0].needsReconnect).toBe(false);
    expect(rows[0].connectionId).toBe("plaid-1");
  });

  it("a healthy Plaid bank row shows its inherited schedule, not a consent word", () => {
    // The CADENCE column carried `consent ok` on every healthy bank while the same 150px lane on
    // every other row in the table held a real schedule — a column heading is a promise about every
    // cell beneath it (§18.2). A healthy state earns no cell at all (§14.1a), so the row falls
    // through to the cadence its OWN connector is on. The old string must not come back.
    const [row] = plaidBankRows([bank({ health: "ok" })], [plaidConn()]);
    expect(row.cadence).toEqual({ text: "every 2h · poll", alarm: false });
    expect(row.consent).toBeNull();
    expect(JSON.stringify(row)).not.toContain("consent ok");
  });

  it("a lapsed Item reads 'consent lapsed' (seal) and asks for Reconnect (#73 broken row)", () => {
    const banks = [bank({ health: "action_required" })];
    const [row] = plaidBankRows(banks, [plaidConn()]);
    expect(row.consent).toEqual({ text: "consent lapsed", alarm: true });
    expect(row.lastHeard.alarm).toBe(true);
    expect(row.needsReconnect).toBe(true);
  });

  /**
   * #95 item 3 — the CADENCE lane, across all four served health values at once.
   *
   * `console-plate-corrections` took `consent ok` out of this column on the principle that a column
   * heading is a promise about every cell beneath it (§18.2), and the defect survived for `unknown`:
   * `consentCell` still returned `{ text: "consent unknown", alarm: false }` and
   * `cadence: consent ?? cadenceCell(connector)` put it straight back. `unknown` is what
   * `finance-routes.ts` serves for an Item whose `item_status` is null — **a freshly linked bank** —
   * or one whose connector is paused, so the ONE state every new bank passes through was the state
   * that still answered a cadence question with a consent word.
   *
   * Parametrised deliberately, over the whole `health` union rather than the one value that regressed:
   * the previous fix tested `ok` and `action_required` and both passed with `unknown` broken. Any new
   * health value the wire grows lands here as a compile error at the `expected` map, not as a silent
   * pass.
   *
   * MUTATIONS RUN, and what each one actually reddens (the fix has two independent guards, so a note
   * that claimed one mutation kills everything would be wrong):
   *   A. `consentCell` returns `{ text: "consent unknown", alarm: false }` again, lane guard kept →
   *      RED on "an as-yet-unknown consent earns NO cell at all" (the cell is back), GREEN on the
   *      cadence rows, because the lane guard holds the column clean on its own.
   *   B. `consentCell` kept lapse-only, lane reverted to `consent ?? cadenceCell(connector)` → all
   *      green, which is exactly why guard A exists: today nothing non-alarm reaches the lane.
   *   C. Both reverted — the shipped defect — → RED on three of these, including `health=unknown` and
   *      the paused row. Either guard alone stops today's bug; both are needed to stop tomorrow's.
   */
  it.each([
    ["ok", "every 2h · poll", false] as const,
    ["unknown", "every 2h · poll", false] as const,
    ["action_required", "consent lapsed", true] as const,
    ["error", "consent lapsed", true] as const,
  ])("health=%s puts %o in the cadence lane", (health, text, isAlarm) => {
    const [row] = plaidBankRows([bank({ health })], [plaidConn()]);
    expect(row.cadence).toEqual({ text, alarm: isAlarm });
    // A consent word may only ever appear in this lane when it is an alarm the row can act on.
    if (!isAlarm) expect(row.cadence.text).not.toMatch(/consent/);
    // And the reconnect affordance still hangs off exactly the lapse, not off "not ok".
    expect(row.needsReconnect).toBe(isAlarm);
  });

  it("an as-yet-unknown consent earns NO cell at all, and raises nothing", () => {
    // The state a bank sits in the moment it is linked. `unknown` is not a lapse — no alarm, no
    // Reconnect — and it is not a schedule either, so it belongs in neither: the row keeps its own
    // connector's schedule and `lastHeard` says whether anything has arrived yet.
    const [row] = plaidBankRows([bank({ health: "unknown" })], [plaidConn()]);
    expect(row.consent).toBeNull();
    expect(row.needsReconnect).toBe(false);
    expect(row.lastHeard.alarm).toBe(false);
    expect(JSON.stringify(row)).not.toContain("consent unknown");
  });

  it("a PAUSED connector's bank row says paused, which is what the reader needs, not a consent word", () => {
    // The second reachable `unknown`: `finance-routes.ts` serves it for a paused connector too. The
    // lane's own vocabulary already has a word for this and it is strictly more use.
    const paused = plaidConn({ status: "paused", freshness: fresh("paused") });
    const [row] = plaidBankRows([bank({ health: "unknown" })], [paused]);
    expect(row.cadence).toEqual({ text: "paused", alarm: false });
  });

  it("a lapsed bank still raises the reconnect action — the alarm PREDICATE outlived the word", () => {
    // `needsReconnect` and `lastHeard.alarm` are both derived from the consent alarm, and that alarm
    // is what switches the row's action from "Manage →" to "Reconnect →". Deleting the healthy
    // string without keeping the derivation would have silently disabled the one affordance that
    // clears a lapse — a cosmetic edit removing a function.
    const lapsed = plaidBankRows([bank({ health: "action_required" })], [plaidConn()])[0];
    const healthy = plaidBankRows([bank({ health: "ok" })], [plaidConn()])[0];
    expect(lapsed.needsReconnect).toBe(true);
    // and the lapse displaces the schedule in the cadence lane, which is where it is drawn
    expect(lapsed.cadence).toEqual({ text: "consent lapsed", alarm: true });
    expect(healthy.needsReconnect).toBe(false);
  });

  it("a cross-provider merge is shown ONCE under Plaid with the 'also arrives via' note (§12.3)", () => {
    const banks = [
      bank({
        institution: "American Express",
        dedupGroupId: "g1",
        providers: [
          { provider: "plaid", connectionId: "plaid-1", itemStatus: "ok", lastSyncedAt: null },
          { provider: "simplefin", connectionId: "sfin-1", itemStatus: null, lastSyncedAt: null },
        ],
      }),
    ];
    const [row] = plaidBankRows(banks, [plaidConn()]);
    expect(row.mergedNote).toBe("also arrives via SimpleFIN — served as one");
  });

  it("names the other provider through the SHARED vocabulary, never a local table (#95 item 4)", () => {
    // A local `OTHER_PROVIDER_NAME = { simplefin: "SimpleFIN", plaid: "Plaid" }` was consulted here
    // BEFORE `providerDisplay`. Both entries agreed with the shared path — and that agreement is
    // verbatim the argument that deleted model.ts's PROVIDER_DISPLAY: *the entry was never the
    // defect, the duplicate was.* Those two tables had already drifted on a second provider
    // ("Whoop" vs "WHOOP") while every surface still looked right.
    //
    // MUTATION: reintroduce a local spelling for either provider (`x.provider === "simplefin" ?
    // "Simplefin" : providerDisplay(...)`) and this cell goes red — the assertion is tied to
    // `providerDisplay`, so it cannot be satisfied by a second table that merely happens to agree.
    for (const other of ["simplefin", "plaid", "sofi_direct"]) {
      const [row] = plaidBankRows(
        [
          bank({
            institution: "American Express",
            dedupGroupId: "g1",
            providers: [
              { provider: "plaid", connectionId: "plaid-1", itemStatus: "ok", lastSyncedAt: null },
              { provider: other, connectionId: "other-1", itemStatus: null, lastSyncedAt: null },
            ],
          }),
        ],
        [plaidConn()],
      );
      expect(row.mergedNote).toBe(`also arrives via ${providerDisplay(other)} — served as one`);
      // …and the shared path is the ONE humanisation rule, so the note inherits the brand casing
      // rather than a local guess ("SimpleFIN", not "Simplefin").
      expect(row.mergedNote).toBe(`also arrives via ${humanize(other)} — served as one`);
    }
  });

  it("ignores banks that do not route through the given Plaid connections", () => {
    const banks = [bank({ providers: [{ provider: "simplefin", connectionId: "sfin-1", itemStatus: null, lastSyncedAt: null }] })];
    expect(plaidBankRows(banks, [plaidConn()])).toHaveLength(0);
  });

  it("each bank inherits ITS OWN connector's cadence, never one borrowed from a sibling", () => {
    // The wire is per-row while the design draws one rule for the group (#88 / §13.1). Reading the
    // matched connector — rather than any Plaid connector — is what keeps the cell honest when two
    // Items really are on different schedules; `plaidGroupCadence` reports that divergence above.
    const banks = [
      bank({ institution: "Chase", bankKey: "kc" }),
      bank({
        institution: "Fidelity",
        bankKey: "kf",
        providers: [{ provider: "plaid", connectionId: "plaid-2", itemStatus: "ok", lastSyncedAt: null }],
      }),
    ];
    const rows = plaidBankRows(banks, [
      plaidConn(),
      plaidConn({
        connectionId: "plaid-2",
        sync_interval_sec: 21_600,
        min_interval_sec: 7200,
        default_interval_sec: 7200,
      }),
    ]);
    expect(rows.map((r) => r.cadence.text)).toEqual(["every 2h · poll", "every 6h · poll"]);
  });
});

describe("simplefinInstitutions", () => {
  it("names every org inside the single SimpleFIN link and flags merges", () => {
    const banks = [
      bank({ institution: "Ally", accountCount: 1, providers: [{ provider: "simplefin", connectionId: "sfin-1", itemStatus: null, lastSyncedAt: null }] }),
      bank({ institution: "Vanguard", accountCount: 2, providers: [{ provider: "simplefin", connectionId: "sfin-1", itemStatus: null, lastSyncedAt: null }] }),
      bank({
        institution: "American Express",
        accountCount: 1,
        dedupGroupId: "g1",
        providers: [
          { provider: "plaid", connectionId: "plaid-1", itemStatus: "ok", lastSyncedAt: null },
          { provider: "simplefin", connectionId: "sfin-1", itemStatus: null, lastSyncedAt: null },
        ],
      }),
    ];
    const out = simplefinInstitutions(banks, "sfin-1");
    expect(out.institutions.map((i) => i.name)).toEqual(["Ally", "Vanguard", "American Express"]);
    expect(out.anyMerged).toBe(true);
    // the merged Amex account still counts toward SimpleFIN's own total (§12.3).
    expect(out.totalAccounts).toBe(4);
  });
});

// ── #111: one row per ACCOUNT was being read as one row per INSTITUTION ──────

/** A SimpleFIN card. Six of them, nine accounts, three institutions — no two of those are equal. */
function sfin(over: Partial<FinanceBankSummary>): FinanceBankSummary {
  return bank({
    providers: [{ provider: "simplefin", connectionId: "sfin-1", itemStatus: null, lastSyncedAt: null }],
    ...over,
  });
}

const SIX_CARDS_THREE_BANKS: FinanceBankSummary[] = [
  sfin({ institution: "American Express", orgDomain: "americanexpress.com", mask: "1001", bankKey: "cm:amex|1001|USD", accountCount: 1 }),
  sfin({ institution: "AMERICAN EXPRESS", orgDomain: "https://www.americanexpress.com/", mask: "1002", bankKey: "cm:amex|1002|USD", accountCount: 1 }),
  sfin({ institution: "Amex", orgDomain: "americanexpress.com", mask: "1003", bankKey: "cm:amex|1003|USD", accountCount: 2 }),
  sfin({ institution: "Ally", orgDomain: "ally.com", mask: "2001", bankKey: "cm:ally|2001|USD", accountCount: 1 }),
  sfin({ institution: "Vanguard", orgDomain: null, mask: "3001", bankKey: "cm:vg|3001|USD", accountCount: 3 }),
  sfin({ institution: "Vanguard (Updated Monthly)", orgDomain: null, mask: "3002", bankKey: "cm:vg|3002|USD", accountCount: 1 }),
];

describe("SimpleFIN's coverage line is INSTITUTION-grained (#111)", () => {
  it("names each bank once, however many cards it has and however it is spelled", () => {
    // The symptom #111 names: one bank drawn once per CARD, so a three-card issuer takes three rows.
    // The fixture reproduces it exactly — six cards over three banks, one of them spelled three ways.
    // MUTATION: push `bank.institution` per card (the shipped code) → six entries with Amex three
    // times and Vanguard twice, red.
    const out = simplefinInstitutions(SIX_CARDS_THREE_BANKS, "sfin-1");
    expect(out.institutions.map((i) => i.name)).toEqual(["American Express", "Ally", "Vanguard"]);
  });

  it("the three numbers stay three numbers — 6 cards, 9 accounts, 3 institutions", () => {
    // "One link carries all N" reads the institution count; the coverage cell reads the account count.
    // The fixture keeps them apart so neither can be silently substituted for the other.
    const out = simplefinInstitutions(SIX_CARDS_THREE_BANKS, "sfin-1");
    expect(SIX_CARDS_THREE_BANKS).toHaveLength(6);
    expect(out.totalAccounts).toBe(9);
    expect(out.institutions).toHaveLength(3);
  });

  it("a zero-account connector placeholder is never one of the banks", () => {
    // `summarizeBanks` appends a card per finance connector with no cached accounts, labelled
    // "SimpleFIN (connecting…)". MUTATION: drop the placeholder guard → the line reads that connector
    // label as an institution and says "One link carries it", red.
    const out = simplefinInstitutions(
      [sfin({ institution: "SimpleFIN (connecting…)", orgDomain: null, mask: null, bankKey: "conn:sfin-1", accountCount: 0 })],
      "sfin-1",
    );
    expect(out.institutions).toEqual([]);
    expect(out.totalAccounts).toBe(0);
  });

  it("every institution carries a distinct id — the duplicate React key at its source", () => {
    const ids = simplefinInstitutions(SIX_CARDS_THREE_BANKS, "sfin-1").institutions.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the Plaid lane is one row per (connection × institution), not per card (#111)", () => {
  /** One Plaid Item (one bank = one connection, §12.1) serving three Amex cards. */
  const AMEX_ITEM: FinanceBankSummary[] = [
    bank({ institution: "American Express", orgDomain: "americanexpress.com", mask: "1001", bankKey: "cm:amex|1001|USD", accountCount: 1 }),
    bank({ institution: "AMERICAN EXPRESS", orgDomain: "https://www.americanexpress.com/", mask: "1002", bankKey: "cm:amex|1002|USD", accountCount: 1 }),
    bank({ institution: "Amex", orgDomain: "americanexpress.com", mask: "1003", bankKey: "cm:amex|1003|USD", accountCount: 2 }),
  ];

  it("folds one Item's cards into ONE row, summing the accounts", () => {
    // Three rows all reading "American Express", each with its own "Manage →" pointing at the SAME
    // connection page, is the #111 symptom in this lane. §12.2: a row exists for every connection.
    // MUTATION: push a row per card (the shipped code) → three rows, red.
    const rows = plaidBankRows(AMEX_ITEM, [plaidConn()]);
    expect(rows).toHaveLength(1);
    expect(rows[0].institution).toBe("American Express");
    expect(rows[0].coverage).toBe("4 accounts");
    expect(rows[0].connectionId).toBe("plaid-1");
  });

  it("drops the last-4 when the row covers several cards, and keeps it when it covers one", () => {
    // A connection holding three cards has three masks; printing one of them narrows the row to an
    // account it is not. The coverage cell carries the count instead.
    expect(plaidBankRows(AMEX_ITEM, [plaidConn()])[0].mask).toBeNull();
    expect(plaidBankRows([AMEX_ITEM[0]], [plaidConn()])[0].mask).toBe("1001");
  });

  it("never folds across CONNECTIONS — two banks stay two rows", () => {
    // The fold is keyed on the connection AND the institution. Folding on the institution alone would
    // merge the same bank connected twice, which is two credentials and two things to manage.
    const rows = plaidBankRows(
      [
        bank({ institution: "American Express", orgDomain: "americanexpress.com", bankKey: "a" }),
        bank({
          institution: "American Express",
          orgDomain: "americanexpress.com",
          bankKey: "b",
          providers: [{ provider: "plaid", connectionId: "plaid-2", itemStatus: "ok", lastSyncedAt: null }],
        }),
      ],
      [plaidConn(), plaidConn({ connectionId: "plaid-2" })],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.connectionId)).toEqual(["plaid-1", "plaid-2"]);
    expect(new Set(rows.map((r) => r.rowKey)).size).toBe(2);
  });

  it("splits one connection that somehow serves two institutions, rather than hiding one", () => {
    // One Plaid Item is one bank today, and this is what keeps that from being an assumption the row
    // builder enforces: if a gateway ever serves two institutions under one Item, both are drawn.
    const rows = plaidBankRows(
      [
        bank({ institution: "Chase", orgDomain: "chase.com", bankKey: "a" }),
        bank({ institution: "Ally", orgDomain: "ally.com", bankKey: "b" }),
      ],
      [plaidConn()],
    );
    expect(rows.map((r) => r.institution)).toEqual(["Chase", "Ally"]);
  });

  it("a lapse on ANY folded card raises the whole row's consent — a healthy sibling cannot hide it", () => {
    // Health is worst-of over the fold. A card that merged with SimpleFIN carries that connector's
    // standing too, so two cards of one Item can genuinely disagree.
    // MUTATION: take the first card's health instead → consent null, needsReconnect false, red.
    const rows = plaidBankRows(
      [
        bank({ institution: "Amex", orgDomain: "americanexpress.com", bankKey: "a", health: "ok" }),
        bank({ institution: "Amex", orgDomain: "americanexpress.com", bankKey: "b", health: "action_required" }),
      ],
      [plaidConn()],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].consent).toEqual({ text: "consent lapsed", alarm: true });
    expect(rows[0].needsReconnect).toBe(true);
  });

  it("carries orgDomain through to the row, so the mark keys off the stable identifier", () => {
    // A row that dropped it would silently demote its mark to the display-name path — the bug that had
    // most of a real gateway's institutions wearing the neutral tile.
    expect(plaidBankRows(AMEX_ITEM, [plaidConn()])[0].orgDomain).toBe("americanexpress.com");
    // …verbatim when that is what the wire said, and honest about an absence.
    expect(
      plaidBankRows([bank({ orgDomain: "https://www.Chase.com/" })], [plaidConn()])[0].orgDomain,
    ).toBe("https://www.Chase.com/");
    expect(plaidBankRows([bank({ orgDomain: null })], [plaidConn()])[0].orgDomain).toBeNull();
  });

  it("names the second pipe once when a folded card merged, not once per card", () => {
    const rows = plaidBankRows(
      [
        bank({
          institution: "American Express",
          orgDomain: "americanexpress.com",
          bankKey: "a",
          dedupGroupId: "g1",
          providers: [
            { provider: "plaid", connectionId: "plaid-1", itemStatus: "ok", lastSyncedAt: null },
            { provider: "simplefin", connectionId: "sfin-1", itemStatus: null, lastSyncedAt: null },
          ],
        }),
        bank({
          institution: "Amex",
          orgDomain: "americanexpress.com",
          bankKey: "b",
          dedupGroupId: "g2",
          providers: [
            { provider: "plaid", connectionId: "plaid-1", itemStatus: "ok", lastSyncedAt: null },
            { provider: "simplefin", connectionId: "sfin-1", itemStatus: null, lastSyncedAt: null },
          ],
        }),
      ],
      [plaidConn()],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mergedNote).toBe("also arrives via SimpleFIN — served as one");
  });
});

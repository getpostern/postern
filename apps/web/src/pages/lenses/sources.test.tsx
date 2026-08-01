// THE SOURCES — the finance dedup-trust UI (build-notes §12.3, three asymmetric outcomes) and the
// confirm-a-merge join by bankKey EQUALITY (zero FE dedup logic). These are shipped, tested backend
// routes that never had a UI — so the FE join/rendering is exactly what this pins.

import "../../api/test-dom";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, it, expect, vi } from "vitest";
import type {
  ConnectorStatus,
  FinanceBankSummary,
  FinanceDedupCandidate,
} from "../../api/types";
import { SourcesBand, type TrustFlag } from "./SourcesBand";
import { sourceGroupHref } from "../sources/model";
import {
  buildFinanceSources,
  buildGenericSources,
  findMergeCandidate,
  findMergeSides,
} from "./SectorLens";

afterEach(cleanup);

function conn(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    connectionId: "c1",
    provider: "plaid",
    sector: "finance",
    status: "active",
    last_synced_at: "2026-07-23T10:00:00.000Z",
    last_error: null,
    last_error_at: null,
    policy_mode: "poll",
    next_sync_at: null,
    scopes: [],
    credential: { status: "ok", expires_at: null },
    credentialId: "cred_fixture",
    webhook_secret_set_at: null,
    sync_window_days: null,
    sync_interval_sec: 7200,
    min_interval_sec: 7200,
    default_interval_sec: 7200,
    cached_count: 5,
    ...over,
  };
}

function bank(over: Partial<FinanceBankSummary>): FinanceBankSummary {
  return {
    institution: "Chase",
    mask: "8830",
    bankKey: "k-chase",
    dedupGroupId: null,
    providers: [{ provider: "plaid", connectionId: "c1", itemStatus: null, lastSyncedAt: null }],
    accountCount: 1,
    health: "ok",
    unmergedDuplicate: false,
    classConflict: false,
    ...over,
  };
}

describe("buildFinanceSources — provider aggregation + the three dedup outcomes", () => {
  it("aggregates Plaid's per-bank connectors into one row and SimpleFIN into one link", () => {
    const cs = [
      conn({ connectionId: "p1", provider: "plaid" }),
      conn({ connectionId: "p2", provider: "plaid" }),
      conn({ connectionId: "s1", provider: "simplefin" }),
    ];
    const { rows, glossLabel } = buildFinanceSources(cs, [], { "finance.account": 23 });
    const plaid = rows.find((r) => r.provider === "plaid")!;
    const sf = rows.find((r) => r.provider === "simplefin")!;
    expect(plaid.countLabel).toBe("2 banks");
    expect(sf.countLabel).toBe("one link");
    // A provider aggregate has no single connection page, so it manages via Sources — but ON its own
    // group there, not at the top of the page (#112, rebound: the bare "/sources" this asserted was
    // the third of the three hardcoded targets). Derived through the same function /sources renders
    // its group ids from; MUTATION: hardcode "/sources" back and this goes red.
    expect(plaid.manageTo).toBe(sourceGroupHref(cs[0]));
    expect(plaid.manageTo).not.toBe("/sources");
    // …and SimpleFIN's aggregate lands on ITS group, never on Plaid's.
    expect(sf.manageTo).toBe(sourceGroupHref(cs[2]));
    expect(sf.manageTo).not.toBe(plaid.manageTo);
    expect(glossLabel).toContain("2 providers");
    expect(glossLabel).toContain("23 accounts");
  });

  it("counts INSTITUTIONS by the served identifier, not by the number of bank rows (#111)", () => {
    // A gateway printed an ACCOUNT count under the word "institutions", over far fewer banks, because
    // `banks` is ONE ROW PER ACCOUNT IDENTITY (institution × last-4 × currency) and this lens read the
    // array's LENGTH. The fold that fixes it shipped in `pages/sources/grain.ts`; this lens kept its own
    // derivation and so kept the bug — the three-places problem #91 names.
    //
    // THE FIXTURE IS THE POINT: five bank rows, three institutions, and one institution spelled TWO
    // WAYS by its provider. A fixture where rows and institutions coincide passes either way, which is
    // exactly why this shipped; and a fixture whose duplicate spellings MATCH would still pass a
    // count-distinct-strings implementation, which is the box-specific fix this replaced.
    const cs = [conn({ connectionId: "c1", provider: "plaid" })];
    const banks = [
      bank({ bankKey: "b1", institution: "Chase Bank", orgDomain: "www.chase.com", mask: "1111" }),
      bank({ bankKey: "b2", institution: "Chase", orgDomain: "chase.com", mask: "2222" }),
      bank({ bankKey: "b3", institution: "Chase Bank", orgDomain: "www.chase.com", mask: "3333" }),
      bank({ bankKey: "b4", institution: "Amex", orgDomain: "www.americanexpress.com", mask: "4444" }),
      bank({ bankKey: "b5", institution: "Wells Fargo", orgDomain: "www.wellsfargo.com", mask: "5555" }),
    ];
    const { glossLabel, finance } = buildFinanceSources(cs, banks, { "finance.account": 5 });

    // Three institutions over five rows. MUTATION: read `banks.length` again and this reads "5".
    expect(glossLabel).toContain("3 institutions");
    expect(glossLabel).not.toContain("5 institutions");
    // The account figure is a DIFFERENT grain and must not be folded with it.
    expect(glossLabel).toContain("5 accounts");
    // And the chip run stops repeating one institution once per card — the other half of #111.
    expect(finance?.institutions).toHaveLength(3);
    expect(finance?.institutions.filter((n) => /chase/i.test(n))).toHaveLength(1);
  });

  it("the institution run's 'and N more →' lands on the group of the first hidden bank THIS SECTOR serves (#112)", () => {
    // The operator clicked this link from SimpleFIN's institution list and arrived at the top of a
    // page listing everything. The run shows nine; the tenth bank is the first thing the reader could
    // not see, and it resolves to a connector in this sector, so its OWN group is where the link goes.
    //
    // The name is precise on purpose. The scan skips a hidden bank whose connection this sector does
    // not serve (next cell), and a DEDUPED bank names several providers, so a merged bank can resolve
    // through either side — the link lands on a real group holding a real hidden connection, which is
    // the property, rather than on "the first institution" specifically.
    //
    // MUTATION: hardcode `to="/sources"` back in SourcesBand (or drop `moreTo` here) → red.
    const plaidConns = Array.from({ length: 9 }, (_, i) =>
      conn({ connectionId: `p${i}`, provider: "plaid", credentialId: `cred-p${i}` }),
    );
    const sfin = conn({ connectionId: "sf1", provider: "simplefin", credentialId: "cred-sf" });
    const banks = [
      ...plaidConns.map((c, i) =>
        bank({
          institution: `Bank ${i}`,
          bankKey: `k${i}`,
          providers: [{ provider: "plaid", connectionId: c.connectionId, itemStatus: null, lastSyncedAt: null }],
        }),
      ),
      // the TENTH — hidden behind "and 1 more", and it arrives via SimpleFIN
      bank({
        institution: "Tenth Credit Union",
        bankKey: "k-tenth",
        providers: [{ provider: "simplefin", connectionId: "sf1", itemStatus: null, lastSyncedAt: null }],
      }),
    ];
    const { finance } = buildFinanceSources([...plaidConns, sfin], banks, undefined);
    expect(finance.moreCount).toBe(1);
    expect(finance.institutions).not.toContain("Tenth Credit Union");
    expect(finance.moreTo).toBe(sourceGroupHref(sfin));
    expect(finance.moreTo).not.toBe("/sources");
  });

  it("nothing hidden means no landing to invent, and an unresolvable one degrades to the page", () => {
    // The anti-vacuity partner. A `moreTo` that always pointed at the first connector would satisfy
    // the cell above; and a bank whose connection is not among this sector's connectors (an errored
    // read, a revoked row) must fall back to the bare page rather than a fragment on no element.
    const cs = [conn({ connectionId: "p1", provider: "plaid", credentialId: "cred-p1" })];
    const none = buildFinanceSources(cs, [bank({ providers: [{ provider: "plaid", connectionId: "p1", itemStatus: null, lastSyncedAt: null }] })], undefined);
    expect(none.finance.moreCount).toBe(0);
    expect(none.finance.moreTo).toBe("/sources");

    const orphaned = [
      ...Array.from({ length: 9 }, (_, i) =>
        bank({ institution: `Bank ${i}`, bankKey: `k${i}`, providers: [{ provider: "plaid", connectionId: "p1", itemStatus: null, lastSyncedAt: null }] }),
      ),
      bank({ institution: "Orphan", bankKey: "k-orphan", providers: [{ provider: "plaid", connectionId: "gone", itemStatus: null, lastSyncedAt: null }] }),
    ];
    const out = buildFinanceSources(cs, orphaned, undefined);
    expect(out.finance.moreCount).toBe(1);
    expect(out.finance.moreTo).toBe("/sources");
  });

  it("MERGED banks produce the evidence note and NO warning flag (§12.3)", () => {
    const merged = bank({
      institution: "American Express",
      dedupGroupId: "g1",
      bankKey: "k-amex",
      providers: [
        { provider: "plaid", connectionId: "c1", itemStatus: null, lastSyncedAt: null },
        { provider: "simplefin", connectionId: "c2", itemStatus: null, lastSyncedAt: null },
      ],
    });
    const { finance } = buildFinanceSources([conn()], [merged], undefined);
    expect(finance.mergedNote).toContain("American Express");
    expect(finance.mergedNote).toContain("served as one");
    // A successful merge is never a trust FLAG.
    expect(finance.trustFlags).toHaveLength(0);
  });

  it("POSSIBLY-THE-SAME is the one confirmable flag; CLASS CONFLICT is a fact with no action", () => {
    const possible = bank({
      institution: "Chase",
      bankKey: "k-chase",
      mask: null,
      possibleDuplicate: { otherBankKey: "k-chase2", confirmable: true },
    });
    const conflict = bank({ institution: "Fidelity", bankKey: "k-fid", classConflict: true });
    const { finance } = buildFinanceSources([conn()], [possible, conflict], undefined);
    const kinds = finance.trustFlags.map((f) => f.kind).sort();
    expect(kinds).toEqual(["conflict", "possible"]);
    const p = finance.trustFlags.find((f) => f.kind === "possible");
    expect(p).toMatchObject({ kind: "possible", institution: "Chase", bankKey: "k-chase" });
  });
});

describe("SourcesBand rendering — the trust flags on the surface", () => {
  it("'and N more →' renders the target it was HANDED, never a path of its own (#112)", () => {
    // MUTATION: put `to="/sources"` back in SourcesBand and this goes red. The band is pure — the
    // page derives the landing (it holds the connections; the band holds only strings) — so the one
    // thing this file can pin about the component is that it does not invent a destination.
    render(
      <MemoryRouter>
        <SourcesBand
          glossLabel="x"
          rows={[]}
          finance={{
            institutions: ["Chase", "Fidelity"],
            moreCount: 3,
            moreTo: "/sources#source-cred-sfin-1",
            mergedNote: null,
            trustFlags: [],
          }}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /and 3 more/i });
    expect(link.getAttribute("href")).toBe("/sources#source-cred-sfin-1");
  });

  it("a confirmable flag renders a marigold offer linking to confirm-a-merge by bankKey", () => {
    render(
      <MemoryRouter>
        <SourcesBand
          glossLabel="1 provider · 1 connection across 1 institution"
          rows={buildGenericSources([conn()]).rows}
          finance={{
            institutions: ["Chase"],
            moreCount: 0,
            moreTo: "/sources",
            mergedNote: null,
            trustFlags: [{ kind: "possible", institution: "Chase", bankKey: "k-chase" }],
          }}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /the same/i });
    expect(link.getAttribute("href")).toBe("/sectors/finance/merges/k-chase");
  });

  it("a class conflict states 'Kept apart' and offers NO action", () => {
    render(
      <MemoryRouter>
        <SourcesBand
          glossLabel="x"
          rows={[]}
          finance={{
            institutions: [],
            moreCount: 0,
            moreTo: "/sources",
            mergedNote: null,
            trustFlags: [{ kind: "conflict", institution: "Fidelity" }],
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Kept apart/)).not.toBeNull();
    expect(screen.queryByRole("link", { name: /same/i })).toBeNull();
  });

  it("an unknown provider renders its row without a tile and without crashing", () => {
    const rows = buildGenericSources([conn({ provider: "weirdco", sector: "mail" })]).rows;
    render(
      <MemoryRouter>
        <SourcesBand glossLabel="1 connected · Weirdco" rows={rows} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Weirdco")).not.toBeNull();
  });
});

describe("confirm-a-merge join — bankKey EQUALITY, zero FE dedup logic", () => {
  const cand: FinanceDedupCandidate = {
    institution: "Chase",
    currency: "USD",
    a: {
      connectionId: "cp",
      sourceObjectId: "sp",
      accountId: "ap",
      provider: "plaid",
      name: "Chase Sapphire Checking",
      institutionName: "Chase",
      mask: "8830",
    },
    b: {
      connectionId: "cs",
      sourceObjectId: "ss",
      accountId: "as",
      provider: "simplefin",
      name: "CHASE CHECKING",
      institutionName: "Chase",
      mask: null,
    },
    aBankKey: "k-a",
    bBankKey: "k-b",
  };

  it("finds the pair spanning a bankKey on EITHER side, and no other", () => {
    expect(findMergeCandidate([cand], "k-a")).toBe(cand);
    expect(findMergeCandidate([cand], "k-b")).toBe(cand);
    expect(findMergeCandidate([cand], "k-nope")).toBeUndefined();
  });

  it("builds both sides from SERVED fields only (mask presence, currency), never a balance", () => {
    const sides = findMergeSides([cand], "k-a")!;
    expect(sides[0]).toMatchObject({ providerLabel: "via Plaid", name: "Chase Sapphire Checking" });
    expect(sides[0].detail).toBe("USD · ••••8830");
    expect(sides[1].detail).toBe("USD · no last-4 published");
    // Balance is not on the candidate wire — it must not appear.
    expect(sides[1].detail).not.toContain("$");
  });

  it("returns null when no pair matches — the page shows 'nothing to confirm', not a guess", () => {
    expect(findMergeSides([cand], "k-nope")).toBeNull();
  });
});

// ── #100 item 7 — the `unmergedDuplicate` trust pill the port dropped ──────────
//
// The backend has always computed and served `unmergedDuplicate` on every bank
// (`src/rest/finance-routes.ts`: same mask, ≥2 DISAGREEING canonical institutions — the alias gap),
// and `api/types.ts` has always typed it. After the Console port, NO surface in apps/web read it: a
// served signal about the operator's own money, silently on the floor. This restores it; it invents
// nothing and computes nothing client-side.

describe("#100 item 7 — the served alias-gap flag reaches the surface", () => {
  function renderFlags(trustFlags: TrustFlag[]) {
    return render(
      <MemoryRouter>
        <SourcesBand
          glossLabel="x"
          rows={[]}
          finance={{ institutions: [], moreCount: 0, moreTo: "/sources", mergedNote: null, trustFlags }}
        />
      </MemoryRouter>,
    );
  }

  it("a served un-merged duplicate becomes a trust flag", () => {
    const { finance } = buildFinanceSources(
      [conn()],
      [bank({ unmergedDuplicate: true, institution: "Chase", bankKey: "k1" })],
      undefined,
    );
    expect(finance.trustFlags).toContainEqual({
      kind: "unmerged",
      institution: "Chase",
      bankKey: "k1",
    });
  });

  it("the alias-gap flag names the gap and offers no action", () => {
    renderFlags([{ kind: "unmerged", institution: "Chase", bankKey: "k1" }]);
    expect(screen.getByText(/alias gap/i)).not.toBeNull();
    // Copying the `possible` arm would inherit its confirm link — offering a merge the ENGINE has
    // already refused, because the two cards disagree on the institution.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("un-merged is not painted as the one confirmable offer", () => {
    // jsdom has no cascade, so the class name is the assertable fact (and a screenshot may never
    // source a value). Marigold is reserved for the ONE flag the operator can act on.
    const { container } = renderFlags([{ kind: "unmerged", institution: "Chase", bankKey: "k1" }]);
    const dots = [...container.querySelectorAll('[class*="trustDot"]')];
    expect(dots).toHaveLength(1);
    expect(dots[0].className).toMatch(/trustDotIdle/);
    expect(dots[0].className).not.toMatch(/trustDotAttention/);
  });

  it("a card can be both un-merged and class-conflicted and shows both facts", () => {
    // Different facts about different PAIRS — an `else if` chain that swallows one loses a real
    // signal about the operator's accounts.
    const { finance } = buildFinanceSources(
      [conn()],
      [bank({ unmergedDuplicate: true, classConflict: true, institution: "Chase", bankKey: "k1" })],
      undefined,
    );
    expect(finance.trustFlags.map((f) => f.kind).sort()).toEqual(["conflict", "unmerged"]);

    const { container } = renderFlags(finance.trustFlags);
    expect(container.querySelectorAll('[class*="trustDot"]')).toHaveLength(2);
    expect(screen.getByText(/alias gap/i)).not.toBeNull();
    expect(screen.getByText(/Kept apart/)).not.toBeNull();
  });

  it("two un-merged cards keyed on bankKey do not collide", () => {
    // Two un-merged cards ALWAYS carry different canonical institutions but may render the same
    // display NAME — so a React key built from `institution` is a duplicate key.
    //
    // Counting rendered rows is NOT enough and this is the trap worth naming: React renders both
    // children under a duplicate key and merely WARNS, so "two rows are present" passes against the
    // colliding implementation. The warning is the only observable difference, so the warning is
    // what this asserts.
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { finance } = buildFinanceSources(
        [conn()],
        [
          bank({ unmergedDuplicate: true, institution: "Chase", bankKey: "k1" }),
          bank({ unmergedDuplicate: true, institution: "Chase", bankKey: "k2" }),
        ],
        undefined,
      );
      expect(finance.trustFlags).toHaveLength(2);

      const { container } = renderFlags(finance.trustFlags);
      expect(screen.getAllByText(/alias gap/i)).toHaveLength(2);
      expect(container.querySelectorAll('[class*="trustDot"]')).toHaveLength(2);

      const messages = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(messages).not.toMatch(/same key/i);
    } finally {
      warn.mockRestore();
    }
  });
});

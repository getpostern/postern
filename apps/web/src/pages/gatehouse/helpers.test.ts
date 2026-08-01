// Pure-logic tests for the glance verdict's derivations.

import { describe, expect, it } from "vitest";
import {
  composeHeadline,
  agentsClause,
  groupSectorSources,
  needsAttention,
  bySeverity,
  providerMark,
  sectorAgentsClause,
  verdictLead,
  SECTOR_CARD_MAX_SOURCES,
} from "./helpers";
// The speller, the tally and the revoked filter moved to the ONE grain module both this page and
// Sources read (#91). Their own cells live in `pages/sources/grain.test.ts`; what is asserted HERE is
// the Gatehouse's sentences over them.
import { liveConnectors, sourceCounts } from "../sources/grain";
// `isKeyHolder` lives in `pages/agents/helpers.ts`, but its tests live HERE: `pages/agents/` is
// owned by the connect-an-agent unit this wave, and `pages/agents/helpers.test.ts` is not this
// unit's file to edit. The predicate's four CONSUMERS are all in this page group anyway.
import { isKeyHolder } from "../agents/helpers";
import { freshnessDisplay, freshnessRollup } from "../../api/freshness";
import type { Agent, ConnectorStatus, Freshness } from "../../api/types";

function conn(over: Partial<ConnectorStatus> & { freshness?: Freshness }): ConnectorStatus {
  return {
    connectionId: "c1",
    provider: "simplefin",
    sector: "finance",
    status: "active",
    last_synced_at: "2026-07-21T12:00:00Z",
    last_error: null,
    last_error_at: null,
    policy_mode: "poll",
    next_sync_at: null,
    scopes: [],
    credential: { status: "ok", expires_at: null },
    credentialId: "cred_fixture",
    webhook_secret_set_at: null,
    sync_window_days: null,
    sync_interval_sec: null,
    min_interval_sec: null,
    default_interval_sec: null,
    cached_count: 0,
    ...over,
  };
}

const fresh = (state: Freshness["state"], over: Partial<Freshness> = {}): Freshness => ({
  state,
  last_heard_at: "2026-07-21T12:00:00Z",
  next_expected_at: null,
  stream_state: null,
  error: null,
  ...over,
});

describe("verdictLead — the sub-line names BOTH grains (#91)", () => {
  // THE defect this file exists to keep out. The sub-line rendered `live.length` — a CONNECTION count
  // — as "Eleven sources connected", and the attention variant then subtracted the attention count
  // from it. The fixture below is deliberately LOPSIDED: three providers, five credentials, seven
  // connections. A fixture where the numbers coincide cannot fail.
  //
  // MUTATION: `counts.sources` → `counts.connections` in `verdictLead` and the first cell goes red
  // ("Seven sources · seven connections"); re-introduce the subtraction and the lead loses a number.
  const gate = [
    conn({ connectionId: "a-mail", provider: "apple", sector: "mail", credentialId: "apple-1" }),
    conn({ connectionId: "a-cal", provider: "apple", sector: "calendar", credentialId: "apple-1" }),
    conn({ connectionId: "a-con", provider: "apple", sector: "contacts", credentialId: "apple-1" }),
    conn({ connectionId: "p-1", provider: "plaid", sector: "finance", credentialId: "plaid-a" }),
    conn({ connectionId: "p-2", provider: "plaid", sector: "finance", credentialId: "plaid-b" }),
    conn({ connectionId: "p-3", provider: "plaid", sector: "finance", credentialId: "plaid-c" }),
    conn({ connectionId: "w-1", provider: "whoop", sector: "health", credentialId: "whoop-1" }),
  ];

  it("names the provider count first and the connection count second", () => {
    expect(verdictLead(sourceCounts(gate))).toBe("Three sources · seven connections");
  });

  it("never mixes the two grains, whichever way round the numbers fall", () => {
    // A one-credential gate has ONE of each; a spelled plural on either half would show here.
    expect(verdictLead(sourceCounts([gate[0]]))).toBe("One source · one connection");
  });

  it("spells past nine — the Sources speller stopped there and printed digits", () => {
    const many = Array.from({ length: 24 }, (_, i) =>
      conn({ connectionId: `p${i}`, provider: "plaid", sector: "finance", credentialId: `c${i}` }),
    );
    expect(verdictLead(sourceCounts(many))).toBe("One source · twenty-four connections");
  });
});

describe("composeHeadline — exceptions-first", () => {
  it("is quiet when nothing needs attention", () => {
    expect(composeHeadline(0).headlineBottom).toBe("and everything is flowing.");
  });
  // The headline carries NO grain noun (operator ruling, #91): the count is a connection count and
  // "source" is a provider, so the design's own "but three sources need you." attached the wrong noun
  // to the number the attention band prints beneath it.
  //
  // MUTATION: put "source"/"sources" back in either branch → red.
  it("changes shape for one down, with no grain noun", () => {
    expect(composeHeadline(1).headlineBottom).toBe("but one needs your attention.");
  });
  it("spells the count for many down, with no grain noun", () => {
    expect(composeHeadline(3).headlineBottom).toBe("but three need your attention.");
  });
  it("names neither grain at any count — the headline never has to pick one", () => {
    for (const n of [1, 2, 3, 11, 24]) {
      const bottom = composeHeadline(n).headlineBottom;
      expect(bottom).not.toMatch(/sources?/);
      expect(bottom).not.toMatch(/connections?/);
      expect(bottom).not.toMatch(/providers?/);
    }
  });
});

describe("agentsClause", () => {
  it("handles none, one, many", () => {
    expect(agentsClause(0)).toBe("no agents hold keys");
    expect(agentsClause(1)).toBe("one agent holds keys");
    expect(agentsClause(3)).toBe("three agents hold keys");
  });
});

describe("needsAttention — read off the SERVED renderer, never a timestamp", () => {
  it("is true for error and unreachable (tone error)", () => {
    expect(needsAttention(conn({ freshness: fresh("error", { error: { message: "x", since: null } }) }))).toBe(true);
    expect(needsAttention(conn({ freshness: fresh("unreachable") }))).toBe(true);
  });
  it("is true for a poll source the server COMPLAINS about (tone attention)", () => {
    // Rebound by #116. This cell used to pass a bare `fresh("stale")` and assert `true`, because the
    // renderer painted every non-webhook `stale` red. It now keys on the SERVED complaint, so the
    // fixture must carry one — a bare stale tuple would have left the cell asserting nothing.
    expect(
      needsAttention(
        conn({
          policy_mode: "poll",
          freshness: fresh("stale", {
            error: { message: "scheduled sync overdue by several cadences", since: null },
          }),
        }),
      ),
    ).toBe(true);
  });

  it("is FALSE for a poll source that is merely LATE — the #116 band honesty rule", () => {
    // The row shape that produced #116: Microsoft connections whose syncs had SUCCEEDED minutes
    // earlier, sitting in NEEDS ATTENTION beside genuinely broken sources. A band that reports
    // working connections teaches its reader to ignore it.
    expect(needsAttention(conn({ policy_mode: "poll", freshness: fresh("stale") }))).toBe(false);
  });
  it("is FALSE for webhook staleness (advisory / idle) — the device owes us nothing", () => {
    expect(
      needsAttention(
        conn({ policy_mode: "push", push_kind: "webhook", freshness: fresh("stale") }),
      ),
    ).toBe(false);
  });
  it("is false for ok, paused, syncing, never_synced", () => {
    expect(needsAttention(conn({ freshness: fresh("ok") }))).toBe(false);
    expect(needsAttention(conn({ freshness: fresh("paused") }))).toBe(false);
    expect(needsAttention(conn({ freshness: fresh("syncing") }))).toBe(false);
    expect(needsAttention(conn({ freshness: fresh("never_synced") }))).toBe(false);
  });
});

describe("liveConnectors", () => {
  it("drops revoked connectors", () => {
    const cs = [conn({ connectionId: "a" }), conn({ connectionId: "b", status: "revoked" })];
    expect(liveConnectors(cs).map((c) => c.connectionId)).toEqual(["a"]);
  });
});

describe("bySeverity", () => {
  it("orders worst first", () => {
    const err = conn({ connectionId: "e", freshness: fresh("error", { error: { message: "x", since: null } }) });
    const stale = conn({ connectionId: "s", freshness: fresh("stale") });
    expect([stale, err].sort(bySeverity).map((c) => c.connectionId)).toEqual(["e", "s"]);
  });
});

// ── #100 item 4 — an expired key is not a key-holder ──────────────────────────

const NOW = Date.parse("2026-07-25T12:00:00Z");

function ag(over: Partial<Agent>): Agent {
  return {
    agentId: "myclaw",
    sectors: ["finance"],
    created_at: "2026-01-01T00:00:00Z",
    revoked_at: null,
    ...over,
  };
}

describe("isKeyHolder — the gate's own answer, not `!revoked_at` (#100 item 4)", () => {
  it("an expired key is not a key-holder — the auth layer denies it and so does the count", () => {
    // Today's bug is `!a.revoked_at` alone, which answers TRUE for every one of these.
    expect(isKeyHolder(ag({ expires_at: "2026-07-01T00:00:00Z" }), NOW)).toBe(false);
    expect(isKeyHolder(ag({ expires_at: "2026-12-01T00:00:00Z" }), NOW)).toBe(true);
    expect(isKeyHolder(ag({ expires_at: null }), NOW)).toBe(true);
    expect(isKeyHolder(ag({}), NOW)).toBe(true);
    // The boundary, pinned: a key whose expiry is EXACTLY now is spent. Catches the inverted
    // comparison (`>=` vs `<=`), which no past/future pair on its own can see.
    expect(isKeyHolder(ag({ expires_at: new Date(NOW).toISOString() }), NOW)).toBe(false);
  });

  it("a revoked key is not a key-holder even when its expiry is in the future", () => {
    expect(
      isKeyHolder(ag({ revoked_at: "2026-07-02T00:00:00Z", expires_at: "2026-12-01T00:00:00Z" }), NOW),
    ).toBe(false);
  });
});

// ── #100 item 10 — two concepts, one phrase each ──────────────────────────────

describe("sectorAgentsClause — the ONE sector-scoped phrase (#100 item 10)", () => {
  it("zero agents in a sector reads the same sentence everywhere", () => {
    expect(sectorAgentsClause(0)).toBe("no agents hold keys here");
    expect(sectorAgentsClause(1)).toBe("read by 1 agent");
    expect(sectorAgentsClause(4)).toBe("read by 4 agents");
  });

  it("the global clause and the sector clause stay different sentences", () => {
    // Two genuinely different scopes: "the gate holds N keys" vs "N agents can read THIS sector".
    // Collapsing them would make one sector's silence read as the whole gate's.
    expect(agentsClause(0)).not.toBe(sectorAgentsClause(0));
    expect(sectorAgentsClause(0).endsWith("here")).toBe(true);
    expect(agentsClause(0).endsWith("here")).toBe(false);
  });
});

// ── #100 item 8 — one row per PROVIDER, capped, worst-first ────────────────────

describe("groupSectorSources — a glance card is not an unbounded list (#100 item 8)", () => {
  const at = (provider: string, i: number, state: Freshness["state"] = "ok"): ConnectorStatus =>
    conn({
      connectionId: `${provider}-${i}`,
      provider,
      freshness: fresh(state, state === "error" ? { error: { message: "x", since: null } } : {}),
    });

  it("a sector's connections are grouped one row per provider, not one per connection", () => {
    // Each Plaid Item is its OWN credential (CLAUDE.md: one bank = one connection), so fourteen
    // banks is the ordinary case — and it used to render fourteen rows all reading "Plaid".
    const cs = [
      ...Array.from({ length: 14 }, (_, i) => at("plaid", i)),
      at("simplefin", 0),
    ];
    const { groups, moreCount } = groupSectorSources(cs);
    expect(groups).toHaveLength(2);
    expect(moreCount).toBe(0);
    const byName = Object.fromEntries(groups.map((g) => [g.provider, g.connectionCount]));
    expect(byName).toEqual({ plaid: 14, simplefin: 1 });
  });

  it("the broken provider survives the cap", () => {
    // Alphabetically LAST and the only one in trouble: a slice-before-sort keeps a, b, c and drops
    // exactly the row the operator needs. A cap that can hide the broken source is worse than none.
    const cs = [at("aaa", 0), at("bbb", 0), at("ccc", 0), at("zzz", 0, "error")];
    const { groups, moreCount } = groupSectorSources(cs);
    expect(groups).toHaveLength(SECTOR_CARD_MAX_SOURCES);
    expect(groups.map((g) => g.provider)).toContain("zzz");
    expect(groups[0].provider).toBe("zzz"); // worst first
    expect(moreCount).toBe(1);
  });

  it("the cap reports how many it withheld", () => {
    const cs = ["p1", "p2", "p3", "p4", "p5"].map((p) => at(p, 0));
    const { groups, moreCount } = groupSectorSources(cs);
    expect(groups).toHaveLength(3);
    expect(moreCount).toBe(2);
  });

  it("a single-connection provider's freshness is unchanged by grouping", () => {
    // `freshnessRollup([c])` runs the same renderer over the same inputs as `freshnessDisplay(c)`.
    // Deep equality is the assertion that catches a hand-rolled rollup — the ONE derivation law.
    //
    // NOTE this test CANNOT, on its own, prove the row speaks for the whole group: with one
    // connection `freshnessRollup([c])` ≡ `freshnessDisplay(c)` BY CONSTRUCTION, so the mutation it
    // reads as guarding against (`freshnessRollup(group)` → `freshnessDisplay(group[0]!)`) passes it
    // unchanged. The two multi-connection tests below are what actually pin it.
    const c = at("simplefin", 0, "stale");
    expect(groupSectorSources([c]).groups[0].display).toEqual(freshnessDisplay(c));
  });

  it("a provider row speaks for its WORST connection, not for whichever arrived first", () => {
    // The load-bearing case, and the one a single-connection fixture can never reach: thirteen
    // healthy Plaid banks and one broken one. `freshnessDisplay(group[0])` says "ok" here — the row
    // would report the state of an arbitrary member and the broken bank would vanish into the count.
    const banks = Array.from({ length: 14 }, (_, i) => at("plaid", i, i === 8 ? "error" : "ok"));
    const { groups } = groupSectorSources(banks);
    expect(groups).toHaveLength(1);
    expect(groups[0].connectionCount).toBe(14);
    expect(groups[0].display.state).toBe("error");
    // …and it IS the served rollup over the whole group, not a re-derivation.
    expect(groups[0].display).toEqual(freshnessRollup(banks));
  });

  it("a multi-connection provider whose worst connection is broken survives the cap", () => {
    // The full shape of the defect: the errored provider is the one with MANY connections, and its
    // error is not on its first. Rank it off `group[0]` and it sorts as "ok", loses the worst-first
    // sort to three healthy providers, and is pushed clean out of the three-row cap — the exact
    // outcome "the cap must never be able to hide the provider that needs you" forbids.
    const cs = [
      ...Array.from({ length: 14 }, (_, i) => at("plaid", i, i === 8 ? "error" : "ok")),
      at("aaa", 0),
      at("bbb", 0),
      at("ccc", 0),
    ];
    const { groups, moreCount } = groupSectorSources(cs);
    expect(groups).toHaveLength(SECTOR_CARD_MAX_SOURCES);
    expect(groups[0].provider).toBe("plaid"); // worst first, ahead of aaa/bbb/ccc
    expect(groups.map((g) => `${g.provider}:${g.display.state}`)).toEqual([
      "plaid:error",
      "aaa:ok",
      "bbb:ok",
    ]);
    expect(moreCount).toBe(1);
  });

  it("no connections is no groups, not a phantom row", () => {
    // `moreFrom` joined the shape for #112 — the overflow link's target is derived from the first
    // hidden provider's connection, so nothing hidden means nothing to point at. Asserted, not
    // loosened to a partial match: a phantom rep on an empty sector would be a link to nowhere.
    expect(groupSectorSources([])).toEqual({ groups: [], moreCount: 0, moreFrom: null });
  });

  it("the overflow reports WHICH source it hid, so the link can land on it (#112)", () => {
    // "and N more →" went to the top of /sources — a page listing everything, reached from a link
    // about the sources this card could not show. The honest destination is where the first hidden
    // one lives, and only this function knows which that is. It also must be a HIDDEN one: pointing
    // at a provider the card already shows would send the reader to something they were looking at.
    const cs = [
      at("aaa", 0),
      at("bbb", 0),
      at("ccc", 0),
      at("zzz", 0),
      at("zzz", 1),
    ];
    const { groups, moreCount, moreFrom } = groupSectorSources(cs);
    expect(moreCount).toBe(1);
    expect(moreFrom).not.toBeNull();
    expect(moreFrom!.provider).toBe("zzz");
    expect(groups.map((g) => g.provider)).not.toContain(moreFrom!.provider);
    // …and it is one of that provider's REAL connections, never a synthesised stand-in.
    expect(cs).toContain(moreFrom!);
  });

  it("a card that hides nothing offers no target", () => {
    // The anti-vacuity partner: a helper that always returned the first connection would satisfy the
    // cell above and put a landing link on a card with no overflow.
    expect(groupSectorSources([at("aaa", 0), at("bbb", 0)]).moreFrom).toBeNull();
  });
});

describe("providerMark", () => {
  it("maps known providers to their brand mark", () => {
    expect(providerMark("simplefin")).toBe("simplefin");
    expect(providerMark("homeassistant")).toBe("homeassistant");
  });
  it("returns null for an unknown provider rather than guessing a mark", () => {
    expect(providerMark("notion")).toBeNull();
  });
});

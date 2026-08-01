// Pure view-model tests — the strongest regression net for the sources group. Everything here is a
// deterministic function of the SERVED wire; no DOM, no fetching.

import { describe, expect, it } from "vitest";
import { humanize } from "../../api/format";
import type { Freshness, FreshnessState, Sector } from "../../api/types";
import {
  cadenceCell,
  cadencePresets,
  connectorsOf,
  coverageNoun,
  effectiveIntervalSec,
  formatInterval,
  groupConnectors,
  groupHealth,
  lastHeardCell,
  plaidGroupCadence,
  providerDisplay,
  providerSub,
  providerTileId,
  sourceGroupAnchorId,
  sourceGroupHref,
  sourcesSummary,
  SECTOR_LABEL,
  type ConnectorWithCredential,
} from "./model";
// The tally over the two grains and the revoked filter live in the ONE grain module (#91) — the same
// one the Gatehouse reads. `grain.test.ts` owns their unit cells; the masthead's use of them is here.
import { liveConnectors, sourceCounts } from "./grain";
import { PROVIDER_MARK_KEYS, providerMarkFor } from "../../marks/providerMarks";

function fresh(state: FreshnessState, over: Partial<Freshness> = {}): Freshness {
  return {
    state,
    last_heard_at: "2026-07-23T12:00:00.000Z",
    next_expected_at: "2026-07-23T14:00:00.000Z",
    stream_state: null,
    error: null,
    ...over,
  };
}

let idn = 0;
function conn(over: Partial<ConnectorWithCredential> = {}): ConnectorWithCredential {
  idn += 1;
  return {
    connectionId: over.connectionId ?? `conn-${idn}`,
    credentialId: `cred-${idn}`,
    provider: "apple",
    sector: "mail",
    status: "active",
    last_synced_at: "2026-07-23T12:00:00.000Z",
    last_error: null,
    last_error_at: null,
    policy_mode: "poll",
    next_sync_at: "2026-07-23T14:00:00.000Z",
    scopes: [],
    credential: { status: "active", expires_at: null },
    webhook_secret_set_at: null,
    sync_window_days: null,
    sync_interval_sec: null,
    min_interval_sec: 300,
    default_interval_sec: 900,
    cached_count: 100,
    push_kind: null,
    freshness: fresh("ok"),
    ...over,
  };
}

describe("formatInterval / effectiveIntervalSec", () => {
  it("formats whole units", () => {
    expect(formatInterval(300)).toBe("5m");
    expect(formatInterval(900)).toBe("15m");
    expect(formatInterval(3600)).toBe("1h");
    expect(formatInterval(7200)).toBe("2h");
    expect(formatInterval(86_400)).toBe("1d");
    expect(formatInterval(null)).toBeNull();
    expect(formatInterval(0)).toBeNull();
  });
  it("clamps override to the floor (a user may only slow a poll down)", () => {
    // 60s override under a 300s floor clamps up to the floor.
    expect(effectiveIntervalSec({ sync_interval_sec: 60, default_interval_sec: 900, min_interval_sec: 300 })).toBe(300);
    // an override above the floor is honoured.
    expect(effectiveIntervalSec({ sync_interval_sec: 3600, default_interval_sec: 900, min_interval_sec: 300 })).toBe(3600);
    // no override → default (clamped).
    expect(effectiveIntervalSec({ sync_interval_sec: null, default_interval_sec: 900, min_interval_sec: 300 })).toBe(900);
  });
});

describe("liveConnectors — a revoked connection is GONE, not unhealthy (#96 §5)", () => {
  it("a revoked connection is not one of the connections Sources speaks for", () => {
    // `revokeCredential` deliberately KEEPS the rows and `listConnectorsEnriched` serves them. Left
    // in, a revoked connector paints healthy at every step: disconnected → tone `idle` → isUnhealthy
    // false → groupHealth "ok" → a green dot and a cadence it is not on.
    const gone = conn({ connectionId: "dead", status: "revoked" });
    const live = conn({ connectionId: "alive", status: "active" });
    expect(liveConnectors([gone, live]).map((c) => c.connectionId)).toEqual(["alive"]);
    // and it really would have painted healthy — the reason the filter exists, not just that it runs
    expect(groupHealth([gone])).toBe("ok");
  });

  it("a paused or errored connection is still spoken for", () => {
    // Over-filtering to `status === "active"` would hide exactly the rows the ledger exists to show.
    const cs = [
      conn({ connectionId: "p", status: "paused" }),
      conn({ connectionId: "e", status: "error", freshness: fresh("error") }),
      conn({ connectionId: "s", status: "syncing" }),
      conn({ connectionId: "a", status: "active" }),
    ];
    expect(liveConnectors(cs).map((c) => c.connectionId)).toEqual(["p", "e", "s", "a"]);
  });
});

describe("cadencePresets — the ladder is not truncated (#96 §8)", () => {
  it("a 5-minute-floor connection can be set to a daily poll", () => {
    // A `.slice(0, 6)` here made `1d` unreachable EVERYWHERE.
    const presets = cadencePresets({
      sync_interval_sec: null,
      default_interval_sec: 900,
      min_interval_sec: 300,
    });
    expect(presets.map((p) => p.label)).toEqual(["5m", "15m", "30m", "1h", "6h", "12h", "1d"]);
    expect(presets.map((p) => p.sec)).toEqual([300, 900, 1800, 3600, 21600, 43200, 86400]);
  });

  it("a mail connection with an off-ladder default keeps 12h and 1d on the ladder", () => {
    // The off-ladder effective value is inserted, so the truncation dropped BOTH 12h and 1d — every
    // gmail / apple / icloud-mail connection was capped at a 6h poll.
    const presets = cadencePresets({
      sync_interval_sec: null,
      default_interval_sec: 600,
      min_interval_sec: 300,
    });
    expect(presets.map((p) => p.label)).toEqual([
      "5m",
      "10m",
      "15m",
      "30m",
      "1h",
      "6h",
      "12h",
      "1d",
    ]);
  });

  it("no preset below the connector's floor is ever offered", () => {
    const presets = cadencePresets({
      sync_interval_sec: null,
      default_interval_sec: 7200,
      min_interval_sec: 7200,
    });
    expect(presets.every((p) => p.sec >= 7200)).toBe(true);
    expect(presets.map((p) => p.label)).toEqual(["2h", "6h", "12h", "1d"]);
  });

  it("always includes the current effective value, so the selected chip exists", () => {
    const presets = cadencePresets({
      sync_interval_sec: 5400, // 1.5h — off the ladder entirely
      default_interval_sec: 900,
      min_interval_sec: 300,
    });
    expect(presets.map((p) => p.sec)).toContain(5400);
  });
});

describe("SECTOR_LABEL", () => {
  it("names every sector — the `?? c.sector` fallback is a safety net, not a missing key", () => {
    const sectors: Sector[] = ["mail", "calendar", "contacts", "health", "home", "finance"];
    for (const s of sectors) expect(SECTOR_LABEL[s]).toBeTruthy();
    expect(Object.keys(SECTOR_LABEL).sort()).toEqual([...sectors].sort());
  });
});

describe("coverageNoun", () => {
  it("pluralises per sector", () => {
    expect(coverageNoun("mail", 2626)).toBe("2,626 envelopes");
    expect(coverageNoun("mail", 1)).toBe("1 envelope");
    expect(coverageNoun("home", 1847)).toBe("1,847 entities");
    expect(coverageNoun("finance", 2)).toBe("2 accounts");
  });

  it("the unknown-sector FALLBACK pluralises too — the latent half of #92", () => {
    // Same defect class as "feeds 1 banks", and the more dangerous of the two: this branch printed
    // "1 rows", and all six sectors are covered by `SECTOR_NOUN` today, so it can only ever fire on
    // the addition of a SEVENTH sector — the one change least likely to be looking for it. A sector
    // is "a new table plus a REGISTRY entry" (CLAUDE.md), so that day comes.
    //
    // MUTATION: put `return \`${count(n)} rows\`` back and the first row goes red.
    expect(coverageNoun("notes", 1)).toBe("1 row");
    expect(coverageNoun("notes", 4)).toBe("4 rows");
    expect(coverageNoun("notes", 0)).toBe("0 rows");
  });
});

describe("groupConnectors + countLabel", () => {
  it("fans out one credential's connectors, keeps singles flat, and Plaid is its own kind", () => {
    const cs = [
      // Apple's three sectors share ONE credential — a real fan-out.
      conn({ provider: "apple", sector: "mail", credentialId: "apple-1" }),
      conn({ provider: "apple", sector: "calendar", credentialId: "apple-1" }),
      conn({ provider: "apple", sector: "contacts", credentialId: "apple-1" }),
      conn({ provider: "simplefin", sector: "finance", credentialId: "sfin-1" }),
      // Two Plaid Items, each its OWN credential — still one app group (§12.1).
      conn({ provider: "plaid", sector: "finance", credentialId: "plaid-a" }),
      conn({ provider: "plaid", sector: "finance", credentialId: "plaid-b" }),
      conn({ provider: "home_assistant", sector: "home", credentialId: "ha-1" }),
    ];
    const groups = groupConnectors(cs);
    const apple = groups.find((g) => g.provider === "apple")!;
    const plaid = groups.find((g) => g.provider === "plaid")!;
    const sfin = groups.find((g) => g.provider === "simplefin")!;
    const ha = groups.find((g) => g.provider === "home_assistant")!;
    expect(apple.kind).toBe("fanout");
    expect(apple.connectors).toHaveLength(3);
    // the fan-out group names the ONE credential it would remove
    expect(apple.credentialId).toBe("apple-1");
    expect(plaid.kind).toBe("plaid");
    expect(plaid.connectors).toHaveLength(2);
    // the Plaid group spans many per-Item credentials, so it names none
    expect(plaid.credentialId).toBeUndefined();
    expect(sfin.kind).toBe("flat");
    expect(sfin.credentialId).toBe("sfin-1");
    expect(ha.kind).toBe("flat");
    // fan-out before plaid before flat
    expect(groups.map((g) => g.kind)).toEqual(["fanout", "plaid", "flat", "flat"]);
  });

  it("does NOT collapse two consents for one provider into a single fan-out (BLOCK 2 / #74)", () => {
    // Two independent Microsoft consents (two credentials), each feeding mail+calendar. The OLD
    // provider-string grouping merged all four into ONE group whose Remove revoked only credential
    // A while claiming the whole group — leaving credential B silently live and agent-readable.
    const cs = [
      conn({ provider: "microsoft", sector: "mail", credentialId: "ms-A" }),
      conn({ provider: "microsoft", sector: "calendar", credentialId: "ms-A" }),
      conn({ provider: "microsoft", sector: "mail", credentialId: "ms-B" }),
      conn({ provider: "microsoft", sector: "calendar", credentialId: "ms-B" }),
    ];
    const groups = groupConnectors(cs);
    const ms = groups.filter((g) => g.provider === "microsoft");
    // TWO groups now, one per credential — never one merged group.
    expect(ms).toHaveLength(2);
    expect(new Set(ms.map((g) => g.credentialId))).toEqual(new Set(["ms-A", "ms-B"]));
    // each group's connectors are EXACTLY its own credential's connectors — the proven blast radius.
    for (const g of ms) {
      expect(g.connectors).toHaveLength(2);
      expect(
        (g.connectors as ConnectorWithCredential[]).every((c) => c.credentialId === g.credentialId),
      ).toBe(true);
    }
    // still ONE provider the user named, though it holds two credentials — and the masthead reads
    // that number from the ONE tally, so a credential-grain count would show up here too.
    expect(sourcesSummary(groups).sources).toBe(1);
    expect(sourcesSummary(groups).connections).toBe(4);
  });

  it("keeps two same-provider connectors with DISTINCT credentials as two separate groups", () => {
    // Two independent Gmail consents (two credentials) → two separate flat groups, each carrying its
    // OWN credentialId as its removable boundary, never one fan-out claiming a shared credential.
    const cs = [
      conn({ provider: "gmail", sector: "mail", connectionId: "g1", credentialId: "gmail-A" }),
      conn({ provider: "gmail", sector: "mail", connectionId: "g2", credentialId: "gmail-B" }),
    ];
    const groups = groupConnectors(cs);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind === "flat")).toBe(true);
    expect(new Set(groups.map((g) => g.credentialId))).toEqual(new Set(["gmail-A", "gmail-B"]));
  });

  it("counts providers as apps the user named (not groups, not raw Plaid Items) and connections as rows", () => {
    const cs = [
      conn({ provider: "apple", sector: "mail", credentialId: "apple-1" }),
      conn({ provider: "apple", sector: "calendar", credentialId: "apple-1" }),
      conn({ provider: "plaid", sector: "finance", credentialId: "plaid-a" }),
      conn({ provider: "plaid", sector: "finance", credentialId: "plaid-b" }),
      conn({ provider: "plaid", sector: "finance", credentialId: "plaid-c" }),
    ];
    // 5 Plaid+Apple connections, but only 2 providers the user named.
    const groups = groupConnectors(cs);
    const s = sourcesSummary(groups);
    expect({ sources: s.sources, connections: s.connections }).toEqual({ sources: 2, connections: 5 });
    // …and the page's group-shaped path answers the same as the flat one the Gatehouse takes. Grouping
    // is a PARTITION of the served rows; the moment it is not, the two surfaces disagree again (#65).
    expect(sourceCounts(connectorsOf(groups))).toEqual(sourceCounts(cs));
  });
});

// ── #112: "and N more →" landed at the top of /sources ────────────────────────
//
// Three surfaces linked to a bare `/sources` while being about ONE provider's connections. The fix
// needed a destination first — the page's groups carried no id — so the load-bearing property is
// that the LINK's key and the PAGE's key are the same rule. These cells pin that against
// `groupConnectors` itself, over every group shape, so the two cannot drift apart in silence.
describe("sourceGroupAnchorId — one key for the link and for the group it lands on (#112)", () => {
  const mixed = (): ConnectorWithCredential[] => [
    // one credential, three sectors (a fan-out)
    conn({ provider: "apple", sector: "mail", connectionId: "a-mail", credentialId: "apple-1" }),
    conn({ provider: "apple", sector: "calendar", connectionId: "a-cal", credentialId: "apple-1" }),
    conn({ provider: "apple", sector: "contacts", connectionId: "a-con", credentialId: "apple-1" }),
    // two Plaid Items, each its own credential — ONE app group on the page (§12.1)
    conn({ provider: "plaid", sector: "finance", connectionId: "p-a", credentialId: "plaid-a" }),
    conn({ provider: "plaid", sector: "finance", connectionId: "p-b", credentialId: "plaid-b" }),
    // two independent consents for one provider — two groups, never merged (#74)
    conn({ provider: "microsoft", sector: "mail", connectionId: "ms-a1", credentialId: "ms-A" }),
    conn({ provider: "microsoft", sector: "mail", connectionId: "ms-b1", credentialId: "ms-B" }),
    // a flat single, and one whose credential the wire never resolved
    conn({ provider: "simplefin", sector: "finance", connectionId: "sf", credentialId: "sfin-1" }),
    conn({ provider: "whoop", sector: "health", connectionId: "wh", credentialId: undefined }),
    // …and the shape that BROKE the pairing: falsy but NOT nullish. The fixture only ever carried
    // `undefined`, so it could not see that grouping keyed with `??` (blank is a credential) while the
    // anchor keyed on TRUTHINESS (blank is unresolved). Two connectors, one group, two different ids
    // — a link to a fragment no element carries. Both now read the ONE `sourceGroupKey`.
    conn({ provider: "gmail", sector: "mail", connectionId: "x1", credentialId: "" }),
    conn({ provider: "gmail", sector: "mail", connectionId: "x2", credentialId: "" }),
  ];

  it("every connection in a group answers with its group's id, and no two groups collide", () => {
    // MUTATION either way. Key the anchor on the PROVIDER and the two Microsoft consents collide —
    // a link about consent B lands on consent A, which is the same wrong-boundary class as the
    // Remove that revoked one credential while claiming both (#74). Key it on the CONNECTION and a
    // fan-out group's three sectors answer three different ids, two of which are on no element.
    const groups = groupConnectors(mixed());
    const perGroup = groups.map((g) => new Set(g.connectors.map((c) => sourceGroupAnchorId(c))));
    for (const ids of perGroup) expect(ids.size).toBe(1);
    const all = perGroup.map((s) => [...s][0]);
    expect(new Set(all).size).toBe(groups.length);
  });

  it("keys on the CREDENTIAL, not the provider name — and Plaid's app group is the one exception", () => {
    // One credential fans out to N sector connectors and each Plaid Item is its own credential, so
    // "the Plaid section" is not a single thing on either axis (CLAUDE.md). The page nonetheless
    // draws ONE Plaid group — the app you would remove to kill them all — so the anchor follows the
    // page rather than the credential there, which is exactly why this rule is pinned and not
    // described.
    expect(sourceGroupAnchorId({ provider: "apple", credentialId: "apple-1", connectionId: "a-mail" })).toContain(
      "apple-1",
    );
    expect(
      sourceGroupAnchorId({ provider: "plaid", credentialId: "plaid-a", connectionId: "p-a" }),
    ).toBe(sourceGroupAnchorId({ provider: "plaid", credentialId: "plaid-b", connectionId: "p-b" }));
    // an unresolved credential falls back to its OWN connection, never to a shared boundary
    expect(sourceGroupAnchorId({ provider: "whoop", connectionId: "wh" })).toContain("wh");
  });

  it("a BLANK credentialId is unresolved in BOTH places, not a credential named empty string", () => {
    // The exact divergence a reviewer proved: page ids ["source-conn-x1"], link ids
    // ["source-conn-x1", "source-conn-x2"], "resolves on page? false". `groupConnectors` keyed with
    // `??` (so "" is a credential and the two connectors share one group) while the anchor keyed on
    // truthiness (so "" is unresolved and each answers its own connection).
    //
    // MUTATION: give `sourceGroupKey` back `c.credentialId ?? ""` semantics — i.e. treat blank as a
    // credential — and the first assertion goes red (two connectors, one group, so the group's own
    // members must agree on one id). Restore the truthiness/`??` split across the two functions and
    // the LAST assertion goes red: the group renders one id and the links ask for two.
    const blank = [
      conn({ provider: "gmail", sector: "mail", connectionId: "x1", credentialId: "" }),
      conn({ provider: "gmail", sector: "mail", connectionId: "x2", credentialId: "" }),
    ];
    const groups = groupConnectors(blank);
    // never merged into a boundary the wire can't prove — two connections, two groups
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.credentialId).toBeUndefined();
    // and each link's id IS the id its own group renders
    const pageIds = groups.map((g) => sourceGroupAnchorId(g.connectors[0]));
    const linkIds = blank.map((c) => sourceGroupAnchorId(c));
    expect(new Set(pageIds).size).toBe(2);
    for (const id of linkIds) expect(pageIds).toContain(id);
  });

  it("is INJECTIVE — two punctuation-differing ids never collapse to one id", () => {
    // `"a.b"` and `"a-b"` both became `"a-b"` under the collapse-to-"-" sanitiser, so two DIFFERENT
    // groups rendered two sibling elements with the SAME id: invalid HTML, `getElementById` silently
    // answers the first, and the arrival mark paints the wrong group.
    //
    // MUTATION: restore `key.replace(/[^A-Za-z0-9_-]/g, "-")` and the first assertion goes red.
    const a = sourceGroupAnchorId({ provider: "gmail", credentialId: "a.b", connectionId: "c1" });
    const b = sourceGroupAnchorId({ provider: "gmail", credentialId: "a-b", connectionId: "c2" });
    expect(a).not.toBe(b);
    // The class, not the example: every pair below differs somewhere, so every id must.
    //
    // The last pair is the FIXED-WIDTH trap, and it is why the escape pads to four hex digits and
    // walks code UNITS. `"."` is U+002E and `"ˠ"` is a real character; with an unpadded escape
    // both `"a.0b"` and `"aˠb"` render `a_2e0b` — a fresh collision inside the fix for a
    // collision. MUTATION: drop the `.padStart(4, "0")` and the set-size assertion goes red.
    const raw = [
      "a.b", "a-b", "a_b", "a__b", "a b", "a/b", "a%2eb", "aéb", "A.b", "a😀b",
      "a.0b", "aˠb",
    ];
    const ids = raw.map((credentialId) =>
      sourceGroupAnchorId({ provider: "gmail", credentialId, connectionId: "c" }),
    );
    expect(new Set(ids).size).toBe(raw.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    // a uuid — the shape the gateway actually serves — passes through unmangled, so the fragment in
    // the address bar stays readable
    const uuid = "a1b2c3d4-e89f-4a1b-8c2d-3e4f5a6b7c8d";
    expect(sourceGroupAnchorId({ provider: "gmail", credentialId: uuid, connectionId: "c" })).toBe(
      `source-cred-${uuid}`,
    );
  });

  it("is a usable DOM id and a usable fragment", () => {
    for (const c of mixed()) {
      const id = sourceGroupAnchorId(c);
      expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
      expect(sourceGroupHref(c)).toBe(`/sources#${id}`);
      // and it survives a hostile served id rather than emitting a broken selector
      const nasty = sourceGroupAnchorId({ provider: "x", credentialId: 'a b"#?', connectionId: "c" });
      expect(nasty).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    }
  });
});

describe("cadenceCell / lastHeardCell — read the served freshness, never a clock", () => {
  it("a healthy poll names its cadence; a held (errored) poll says 'held'", () => {
    const ok = conn({ policy_mode: "poll", sync_interval_sec: 900, freshness: fresh("ok") });
    expect(cadenceCell(ok)).toEqual({ text: "every 15m · poll", alarm: false });
    const errored = conn({
      policy_mode: "poll",
      status: "error",
      freshness: fresh("error", { error: { message: "consent withdrawn", since: null } }),
    });
    expect(cadenceCell(errored).text).toBe("held");
  });
  // #106: the cadence lane answers "how often?", so it stopped answering with two transport names —
  // "websocket" is a protocol a person managing their home has never met, and "on write" was ours for
  // the moment a device posts. MUTATION: put either old string back → RED here.
  it("a live stream reads 'streaming' in last-heard, 'push · live' in cadence — never a protocol name", () => {
    const ha = conn({
      provider: "home_assistant",
      sector: "home",
      policy_mode: "push",
      push_kind: "stream",
      freshness: fresh("ok", { stream_state: "connected" }),
    });
    expect(cadenceCell(ha).text).toBe("push · live");
    expect(cadenceCell(ha).text).not.toMatch(/websocket/i);
    expect(lastHeardCell(ha).text).toBe("streaming");
  });
  it("a device push reads 'push · when sent' — the schedule from the reader's side", () => {
    const ah = conn({ provider: "apple_health", sector: "health", policy_mode: "push", push_kind: "webhook" });
    expect(cadenceCell(ah).text).toBe("push · when sent");
    // The word the standard names outright: nobody managing their own device should read it.
    expect(cadenceCell(ah).text).not.toMatch(/webhook/i);
  });
  it("an unhealthy last-heard is coloured seal (alarm) — and a merely-late one is not", () => {
    // REBOUND AT MERGE (#116). A bare `stale` used to be red everywhere. It no longer is: staleness
    // the server complains about is actionable, staleness it does not is advisory. The fixture now
    // carries the complaint it is asserting about, and the calm counterpart is asserted beside it so
    // this cell cannot pass by colouring everything.
    const alarming = conn({
      freshness: fresh("stale", {
        error: { message: "scheduled sync overdue by several cadences", since: null },
      }),
    });
    expect(lastHeardCell(alarming).alarm).toBe(true);
    expect(lastHeardCell(conn({ freshness: fresh("stale") })).alarm).toBe(false);
  });
});

describe("groupHealth — ok / partial / down", () => {
  it("all healthy → ok", () => {
    expect(groupHealth([conn(), conn()])).toBe("ok");
  });
  it("some but not all unhealthy → partial (the marigold case)", () => {
    expect(groupHealth([conn(), conn({ freshness: fresh("error") })])).toBe("partial");
  });
  it("every connection unhealthy → down (the poppy case — Microsoft's whole credential out)", () => {
    expect(groupHealth([conn({ freshness: fresh("error") }), conn({ freshness: fresh("error") })])).toBe("down");
  });
});

describe("plaidGroupCadence (#88, read-only from per-bank values)", () => {
  it("uniform intervals → 'every N, all of them'", () => {
    const cs = [
      conn({ provider: "plaid", sync_interval_sec: 7200, min_interval_sec: 7200, default_interval_sec: 7200 }),
      conn({ provider: "plaid", sync_interval_sec: 7200, min_interval_sec: 7200, default_interval_sec: 7200 }),
    ];
    expect(plaidGroupCadence(cs)).toBe("every 2h, all of them");
  });
  it("divergent intervals are reported honestly, never faked into one", () => {
    const cs = [
      conn({ provider: "plaid", sync_interval_sec: 7200, min_interval_sec: 7200, default_interval_sec: 7200 }),
      conn({ provider: "plaid", sync_interval_sec: 21600, min_interval_sec: 7200, default_interval_sec: 7200 }),
    ];
    expect(plaidGroupCadence(cs)).toBe("2 cadences");
  });
});

describe("sourcesSummary — the design's spelled structural counts (#91)", () => {
  // The sentence spelled only to NINE and then fell back to digits, so the masthead read "24
  // connections behind seven providers, across six sectors" — digits and words in one clause, against
  // a design that reads "Twenty-four connections behind seven providers…" (`1KX-0`). Both spellers
  // are now the one in grain.ts.
  //
  // MUTATION: cap the speller at nine again (return digits above it) and the first cell goes red.
  it("spells the count past nine, in every clause of the lead", () => {
    const cs = [
      ...Array.from({ length: 22 }, (_, i) =>
        conn({ provider: "plaid", sector: "finance", connectionId: `p${i}`, credentialId: `pc${i}` }),
      ),
      conn({ provider: "apple", sector: "mail", connectionId: "am", credentialId: "apple-1" }),
      conn({ provider: "apple", sector: "calendar", connectionId: "ac", credentialId: "apple-1" }),
    ];
    const s = sourcesSummary(groupConnectors(cs));
    expect(s.sentence.startsWith("Twenty-four connections behind two providers, across three sectors")).toBe(
      true,
    );
    // …and no bare figure survives in the structural clause (the tell of the second speller).
    expect(s.sentence.split(" — ")[0]).not.toMatch(/\d/);
  });

  it("keeps the singular nouns singular", () => {
    const s = sourcesSummary(groupConnectors([conn({ provider: "apple", sector: "mail" })]));
    expect(s.sentence.startsWith("One connection behind one provider, across one sector")).toBe(true);
  });
});

describe("sourcesSummary — the exceptions-first masthead sentence (§14.4)", () => {
  it("all flowing keeps the explanatory tail", () => {
    const s = sourcesSummary(groupConnectors([conn({ provider: "apple", sector: "mail" })]));
    expect(s.needsYou).toBe(0);
    expect(s.sentence).toContain("all flowing");
    expect(s.sentence).toContain("Removing either takes everything under it");
  });
  it("changes shape when something is wrong and demotes the healthy summary to the last clause", () => {
    const cs = [
      // One Microsoft credential feeding mail+calendar, whole thing down.
      conn({ provider: "microsoft", sector: "mail", credentialId: "ms-1", freshness: fresh("error") }),
      conn({ provider: "microsoft", sector: "calendar", credentialId: "ms-1", freshness: fresh("error") }),
      conn({ provider: "apple", sector: "contacts", credentialId: "apple-1", freshness: fresh("ok") }),
    ];
    const s = sourcesSummary(groupConnectors(cs));
    expect(s.needsYou).toBe(2);
    expect(s.sentence).toMatch(/need you/i);
    expect(s.sentence).toContain("Microsoft needs you");
    expect(s.sentence).toContain("Everything else is flowing");
    // never a healthy badge word appended to an unchanged sentence — the shape changed.
    expect(s.sentence).not.toContain("all flowing");
  });

  // The two exception clauses were the only spelled counts in this file with no cell at all, and both
  // hand-rolled their plural — so "one Plaid banks are" and "one sectors held at once" were one
  // grouping-rule change away, the same borrowed safety that shipped #92's "feeds 1 banks". Both go
  // through the ONE spelled count-with-noun rule now.
  //
  // MUTATION: hand-roll either plural back (`${n} Plaid banks are`) and the singular cell goes red.
  it("agrees the Plaid clause's verb with its count", () => {
    const one = sourcesSummary(
      groupConnectors([
        conn({ provider: "plaid", sector: "finance", credentialId: "p-a", freshness: fresh("error") }),
      ]),
    );
    expect(one.sentence).toContain("one Plaid bank is due for re-approval");

    const two = sourcesSummary(
      groupConnectors([
        conn({ provider: "plaid", sector: "finance", credentialId: "p-a", freshness: fresh("error") }),
        conn({ provider: "plaid", sector: "finance", credentialId: "p-b", freshness: fresh("error") }),
      ]),
    );
    expect(two.sentence).toContain("two Plaid banks are due for re-approval");
  });

  it("spells the held-sector count of a credential that is wholly down", () => {
    const cs = ["mail", "calendar", "contacts"].map((sector) =>
      conn({ provider: "apple", sector: sector as Sector, credentialId: "apple-1", freshness: fresh("error") }),
    );
    expect(sourcesSummary(groupConnectors(cs)).sentence).toContain(
      "iCloud needs you — three sectors held at once",
    );
  });
});

describe("provider vocabulary", () => {
  it("maps display names and marks, never inventing one", () => {
    expect(providerDisplay("home_assistant")).toBe("Home Assistant");
    // The legacy unhyphenated spelling is still keyed on by the shared `marks/providerMarks` table,
    // by PROVIDER_SUB and by two other page groups; its display NAME now resolves in `HUMANIZED` itself rather than in a
    // normalising branch here (#95 item 2), because five surfaces call `humanize(c.provider)`
    // directly and that branch protected only this one. Pin it alongside the wire spelling rather
    // than instead of it — replacing this case left the alias unasserted anywhere in this file,
    // which is how the two-spelling defect went unnoticed in the first place.
    expect(providerDisplay("homeassistant")).toBe("Home Assistant");
    expect(providerDisplay("simplefin")).toBe("SimpleFIN");
    expect(providerTileId("apple_health")).toBe("apple_health");
    expect(providerTileId("nonsense")).toBeNull();
    expect(providerSub("apple")).toBe("app-password · imap + dav");
  });

  // Home Assistant is the one provider whose WIRE value (`home_assistant`) and whose MARK id
  // (`homeassistant`) are different strings, and every Console site that keyed on the mark id went
  // dark: no sector-card mark, no lens tile, no revoke row. The fixtures said `homeassistant` too,
  // so nothing went red. The served spelling is what these lookups must answer to.
  it("resolves the SERVED Home Assistant spelling, not just the mark id", () => {
    expect(providerDisplay("home_assistant")).toBe("Home Assistant");
    expect(providerTileId("home_assistant")).toBe("homeassistant");
    expect(providerSub("home_assistant")).toBe("long-lived token · home");
  });

  /**
   * #95 item 8 — this page group no longer owns a provider→mark table; it delegates.
   *
   * `providerTileId` was the THIRD copy of one map, and every past divergence of the wire spelling from
   * the mark id drew nothing at all on a real box. Pinned as an IDENTITY over every spelling the shared
   * table answers for, plus the misses, so a local "just this one case" branch reappearing here goes
   * red. `marks/providerMarks.test.tsx` owns the "no fourth copy anywhere" half.
   *
   * MUTATION: re-add a private table to `model.ts` (even one that agrees today) → RED in
   * `marks/providerMarks.test.tsx`; make it DISAGREE on any key → RED here.
   */
  it("providerTileId is exactly the shared marks table — no private copy, no local special case", () => {
    for (const wire of PROVIDER_MARK_KEYS) {
      expect(providerTileId(wire)).toBe(providerMarkFor(wire));
    }
    // The misses agree too: null, never a guessed mark.
    for (const wire of ["nonsense", "", "APPLE", "home-assistant"]) {
      expect(providerTileId(wire)).toBe(providerMarkFor(wire));
      expect(providerTileId(wire)).toBeNull();
    }
  });

  it("resolves every provider display name through the one humanisation rule", () => {
    // A SECOND display table lived in model.ts and is why the `apple` → iCloud rename (§18.4.1)
    // looked applied and was not: format.ts said "iCloud", the local map said "Apple", and every
    // Sources / connection-detail surface read the local one. The two had already drifted on a
    // second provider ("Whoop" vs "WHOOP"), so patching the entry would have left the mechanism.
    // This assertion kills the table for good — a reintroduced local name fails here immediately.
    for (const p of [
      "apple",
      "apple_health",
      "microsoft",
      "google",
      "gmail",
      "plaid",
      "simplefin",
      "whoop",
      "home_assistant",
      "homeassistant", // the mark-id spelling resolves in HUMANIZED now, not in a branch here
      "notion", // an unknown provider still falls through to the same generic rule
    ]) {
      expect(providerDisplay(p)).toBe(humanize(p));
    }
    // …and the two Home Assistant spellings still answer with ONE name, which is the property the
    // deleted normalising branch existed to hold. It now holds for every `humanize` caller, not
    // just this one (#95 item 2) — `api/format.test.ts` carries the mutation for the row itself.
    expect(providerDisplay("homeassistant")).toBe(humanize("home_assistant"));
  });

  it("names the two Apple providers apart on every Sources surface (§18.4.1)", () => {
    // "Apple" named the credential in the Sources row, the connection title, the breadcrumb and the
    // typed revoke confirmation — directly above "Apple Health" in the same list, so a user could
    // not tell which row the credential they just added had become. Provider KEYS are unchanged.
    expect(providerDisplay("apple")).toBe("iCloud");
    expect(providerDisplay("apple_health")).toBe("Apple Health");
    expect(providerDisplay("apple")).not.toBe(providerDisplay("apple_health"));
    // the mark is SHARED by both, per the plate — it is the name that splits, not the glyph
    expect(providerTileId("apple")).toBe("apple");
    expect(providerTileId("apple_health")).toBe("apple_health");
  });
});

// The pure lens derivations — the verdict SENTENCE (exceptions-first), the served transport
// descriptors, the coverage/merge helpers. These pin the behaviour a static artboard can't show and
// fail on regression of the named findings (#57 honest sync/transport, #64 framing, dedup evidence).

import { describe, it, expect } from "vitest";
import type { ConnectorStatus, FinanceBankSummary, SyncNowResult } from "../../api/types";
import {
  SECTOR_COVERAGE,
  cadenceLabel,
  composeVerdict,
  footprintGloss,
  mergedBanks,
  providerCount,
  sectorTransportCaption,
  summarizeSectorSync,
  transportLabel,
  unhealthyConnections,
} from "./lensmeta";
import { SECTOR_OBJECTS } from "../../api/types";
import type { FreshnessDisplay } from "../../api/freshness";

function conn(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    connectionId: "c1",
    provider: "simplefin",
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
    cached_count: 10,
    ...over,
  };
}

describe("composeVerdict — exceptions-first (build-notes §14.4)", () => {
  it("a healthy sector demotes the summary to the last clause, never leads with an alarm", () => {
    const s = composeVerdict({
      sector: "finance",
      connectionCount: 3,
      providerCount: 2,
      agentCount: 3,
      unhealthy: [],
      rollupState: "ok",
    });
    expect(s).toContain("all flowing");
    expect(s).toContain("nothing needs you");
    expect(s).toContain("behind 2 providers");
    expect(s).toContain("read by 3 agents");
    // Healthy must NOT open with an exception clause.
    expect(s.startsWith("1 need")).toBe(false);
  });

  it("an unhealthy sector LEADS with the exceptions and demotes the healthy summary", () => {
    const s = composeVerdict({
      sector: "finance",
      connectionCount: 5,
      providerCount: 2,
      agentCount: 1,
      unhealthy: [{ name: "Plaid", label: "Error" }],
      rollupState: "error",
    });
    expect(s.startsWith("Plaid needs you")).toBe(true);
    expect(s).toContain("Everything else is flowing");
  });

  it("multiple exceptions are counted and named", () => {
    const s = composeVerdict({
      sector: "health",
      connectionCount: 3,
      providerCount: 2,
      agentCount: 0,
      unhealthy: [
        { name: "Whoop", label: "Stale" },
        { name: "Apple Health", label: "Stale" },
      ],
      rollupState: "stale",
    });
    expect(s.startsWith("2 need you: Whoop, Apple Health.")).toBe(true);
  });

  it("no connections reads as unconnected, not as a false all-clear", () => {
    const s = composeVerdict({
      sector: "mail",
      connectionCount: 0,
      providerCount: 0,
      agentCount: 0,
      unhealthy: [],
      rollupState: "never_synced",
    });
    expect(s).toBe("Nothing is connected here yet.");
  });
});

describe("transport descriptors — SERVED only, no read/act claim", () => {
  it("a poll connection reads its cadence, never 'read-only'", () => {
    expect(transportLabel(conn({ policy_mode: "poll", sync_interval_sec: 7200 }))).toBe("every 2h · poll");
    // The action-catalog word 'read-only' must not leak in here (it is not served — #58/§3).
    expect(transportLabel(conn({ policy_mode: "poll" }))).not.toContain("read");
  });

  it("push transports read their kind", () => {
    expect(transportLabel(conn({ policy_mode: "push", push_kind: "stream" }))).toBe("push stream");
    expect(transportLabel(conn({ policy_mode: "push", push_kind: "webhook" }))).toBe("device push");
  });

  it("cadenceLabel renders coarse whole units", () => {
    expect(cadenceLabel(900)).toBe("15m");
    expect(cadenceLabel(7200)).toBe("2h");
    expect(cadenceLabel(604800)).toBe("7d");
  });

  it("the sector caption rolls one descriptor across connections and stays honest when mixed", () => {
    expect(sectorTransportCaption([conn({ sync_interval_sec: 7200 }), conn({ sync_interval_sec: 7200 })])).toBe(
      "polls every 2h",
    );
    expect(
      sectorTransportCaption([
        conn({ policy_mode: "poll", sync_interval_sec: 7200 }),
        conn({ policy_mode: "push", push_kind: "stream" }),
      ]),
    ).toBe("mixed sources");
    expect(sectorTransportCaption([])).toBe("");
  });
});

describe("unhealthyConnections — the server's word, never a derived state", () => {
  const okDisplay: FreshnessDisplay = {
    state: "ok",
    label: null,
    caption: "",
    nextLine: "",
    tone: "ok",
    lastHeardAt: null,
  };
  const errDisplay: FreshnessDisplay = {
    state: "error",
    label: "Error",
    caption: "",
    nextLine: "",
    tone: "error",
    lastHeardAt: null,
  };

  it("only attention/error tones surface; ok/idle are not exceptions", () => {
    const cs = [conn({ connectionId: "a", provider: "plaid" }), conn({ connectionId: "b", provider: "simplefin" })];
    const out = unhealthyConnections(
      cs,
      (c) => (c.connectionId === "a" ? errDisplay : okDisplay),
      (c) => c.provider,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "plaid", label: "Error", connectionId: "a" });
  });
});

describe("finance helpers", () => {
  function bank(over: Partial<FinanceBankSummary>): FinanceBankSummary {
    return {
      institution: "Chase",
      mask: "8830",
      bankKey: "k1",
      dedupGroupId: null,
      providers: [{ provider: "plaid", connectionId: "c1", itemStatus: null, lastSyncedAt: null }],
      accountCount: 1,
      health: "ok",
      unmergedDuplicate: false,
      classConflict: false,
      ...over,
    };
  }

  it("mergedBanks are those served as one across >1 provider with a dedup group", () => {
    const merged = bank({
      institution: "American Express",
      dedupGroupId: "g1",
      providers: [
        { provider: "plaid", connectionId: "c1", itemStatus: null, lastSyncedAt: null },
        { provider: "simplefin", connectionId: "c2", itemStatus: null, lastSyncedAt: null },
      ],
    });
    const single = bank({ institution: "Chase" });
    expect(mergedBanks([merged, single]).map((b) => b.institution)).toEqual(["American Express"]);
  });

  it("providerCount is the distinct providers across connections", () => {
    expect(
      providerCount([conn({ provider: "plaid" }), conn({ provider: "plaid" }), conn({ provider: "simplefin" })]),
    ).toBe(2);
  });
});

describe("static config integrity", () => {
  it("every coverage object is a real REGISTRY object for its sector", () => {
    for (const [sector, objs] of Object.entries(SECTOR_COVERAGE)) {
      const registry = SECTOR_OBJECTS[sector as keyof typeof SECTOR_OBJECTS];
      for (const o of objs) expect(registry).toContain(o.object);
    }
  });

  it("mail's footprint gloss names the metadata window; bounded sectors say cached in full", () => {
    expect(footprintGloss("mail")).toContain("metadata");
    expect(footprintGloss("finance")).toContain("cached in full");
  });

  // #106 §1 — a coverage sub speaks to the person reading the lens. Two spoke to us instead: the
  // signed-amount convention (verbatim from this repo's CLAUDE.md gotchas, written for agents working
  // on the code) and the holdings scope note (ADR 0022's — and false as well as internal, because the
  // store does carry `market_value`; declining to *show* a balance here is a display choice).
  //
  // MUTATION 1: restore either sub → RED (the first three expectations).
  // MUTATION 2: blanket-delete the two that survive → RED (the last). The finding was "drop the notes
  // to ourselves", never "drop every sub" — mail's is a privacy fact about the reader's own mail.
  it("no coverage sub is a note to ourselves, and the two that speak to the reader survive", () => {
    const subs = Object.values(SECTOR_COVERAGE).flat().map((o) => o.sub);
    expect(subs).not.toContain("signed — negative is money out");
    expect(subs).not.toContain("cost basis and quantity, never a price feed");
    for (const s of subs) expect(s).not.toMatch(/signed|price feed|cost basis/i);
    expect(SECTOR_COVERAGE.finance.map((o) => o.sub)).toEqual(["", "", ""]);
    expect(subs.filter((s) => s !== "")).toEqual([
      "sender · subject · snippet — bodies stay at the source",
      "the live state of every device",
    ]);
  });
});

// ── #100 item 10 — the verdict speaks the ONE sector-scoped phrase ─────────────

describe("composeVerdict — zero readers is one sentence, shared with the sector card", () => {
  it("a sector verdict with no readers reads the same sentence as the sector card", () => {
    const v = composeVerdict({
      sector: "finance",
      connectionCount: 2,
      providerCount: 1,
      agentCount: 0,
      unhealthy: [],
      rollupState: "ok",
    });
    expect(v).toContain("no agents hold keys here");
    // the singular third phrasing the lens used to carry
    expect(v).not.toContain("no agent holds keys here");
  });
});

// ── #100 item 6 — the sector "Sync now" outcome ────────────────────────────────
//
// The lens fired one `api.syncNow` per connection, awaited `Promise.allSettled`, and then showed an
// UNCONDITIONAL neutral "Sync requested for Finance" — over three failed logins if that is what
// happened. Its `catch` could never fire, because `allSettled` does not reject: dead code shaped
// like error handling. Every test below asserts the TONE as well as the words, because a summary
// that says the right thing in the wrong voice is the same defect wearing a different hat.

function ok(over: Partial<SyncNowResult> = {}): PromiseSettledResult<SyncNowResult> {
  return {
    status: "fulfilled",
    value: { connectionId: "c1", provider: "simplefin", mode: "poll", ran: true, ok: true, ...over },
  };
}
function rejected(reason: unknown): PromiseSettledResult<SyncNowResult> {
  return { status: "rejected", reason };
}

describe("summarizeSectorSync — a sector sync reports what actually happened (#100 item 6)", () => {
  it("every connection failing is reported as a failure, not as 'sync requested'", () => {
    const s = summarizeSectorSync("Finance", [ok({ ok: false, error: "item login required" })]);
    expect(s.tone).toBe("error");
    expect(s.message).toContain("item login required");
    expect(s.message.toLowerCase()).not.toContain("sync requested");
  });

  it("`ok: false` alone is a failure, even when the connector sent no error text", () => {
    // Every OTHER failure fixture in this block also carries a non-empty `error`, so all of them
    // stay green with the `v.ok === false` clause deleted from `isFailure`. `src/core/lifecycle.ts`
    // really can emit `{ ok: false, error: "" }` — a failed sync that reported no reason — and
    // without this case a bare `ok: false` would be summarised as a clean sync of 0 rows.
    const s = summarizeSectorSync("Finance", [ok({ ok: false, error: "" })]);
    expect(s.tone).toBe("error");
    expect(s.message).toContain("the connector reported a failure");
    expect(s.message).not.toContain("synced —");
  });

  it("a rejected promise is a failure with a readable reason", () => {
    // `allSettled` never throws, so a rejection is silent unless it is READ. That is exactly why the
    // old `catch` never fired and the toast stayed neutral.
    const s = summarizeSectorSync("Finance", [rejected(new Error("gateway unreachable"))]);
    expect(s.tone).toBe("error");
    expect(s.message).toContain("gateway unreachable");
  });

  it("a rejection with no Error message still says something a person can read", () => {
    const s = summarizeSectorSync("Finance", [rejected({ weird: true })]);
    expect(s.tone).toBe("error");
    expect(s.message).toContain("the gateway did not answer");
    expect(s.message).not.toContain("undefined");
    expect(s.message).not.toContain("[object Object]");
  });

  it("a timed-out sync is a failure and says so", () => {
    // `ok` is absent here: treating a missing `ok` as success is the mutation this catches.
    const s = summarizeSectorSync("Finance", [ok({ ran: true, ok: undefined, timed_out: true })]);
    expect(s.tone).toBe("error");
    expect(s.message).toContain("still running");
  });

  it("a partial failure names how many of how many", () => {
    const s = summarizeSectorSync("Finance", [
      ok({ upserted: 4 }),
      ok({ ok: false, error: "item login required" }),
      ok({ upserted: 1 }),
    ]);
    expect(s.tone).toBe("error");
    expect(s.message).toContain("2 of 3");
    expect(s.message).toContain("item login required");
  });

  it("a clean sync sums what actually landed", () => {
    const s = summarizeSectorSync("Finance", [ok({ upserted: 7 }), ok({ upserted: 5 })]);
    expect(s.tone).toBe("ok");
    expect(s.message).toContain("12"); // rows, not connections
    expect(s.message).not.toContain("NaN");
  });

  it("a clean sync with no upserted field reports zero, never NaN", () => {
    const s = summarizeSectorSync("Finance", [ok({}), ok({})]);
    expect(s.tone).toBe("ok");
    expect(s.message).not.toContain("NaN");
    expect(s.message).not.toContain("undefined");
  });

  it("an event-driven sector is not reported as a failed pull", () => {
    // Every Home Assistant sync answers ran:false, ok:true. Treating that as a failure would paint
    // the one sector that can ACT permanently red.
    const s = summarizeSectorSync("Home", [
      ok({ ran: false, note: "event-driven connector; no manual pull" }),
      ok({ ran: false, note: "event-driven connector; no manual pull" }),
    ]);
    expect(s.tone).toBe("ok");
    expect(s.message).not.toContain("failed");
    expect(s.message).toContain("event-driven");
  });

  it("nothing to sync is total, not a crash", () => {
    const s = summarizeSectorSync("Finance", []);
    expect(s.tone).toBe("ok");
    expect(s.message).toContain("Nothing to sync");
  });
});

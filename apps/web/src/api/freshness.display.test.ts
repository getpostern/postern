// The freshness RENDERER (ADR 0023, docs/design/freshness-grammar.md, #39/#40/#73/#75).
//
// Every test here is a bug that shipped. The load-bearing ones:
//   · `ok` must produce NO badge — a dead socket rendered a glowing "Live" for two weeks.
//   · The renderer must never compare a timestamp to decide health — three divergent client-side
//     staleness derivations existed, and the inspector's had no stale state at all.
//   · A device push must never be given a predicted next-time.
//   · A status pill must never read as an imperative verb, and one healthy state gets one word.

import { describe, expect, it } from "vitest";
import {
  FRESHNESS_SEVERITY,
  freshnessDisplay,
  freshnessRollup,
  renderFreshness,
} from "./freshness";
import type { ConnectorStatus, Freshness, FreshnessState, PushKind } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
// A tiny +2s cushion keeps a future timestamp OFF the floor boundary: `hence` floors to whole
// minutes, so `inFuture(5*MIN)` can render "4m" once a few real milliseconds elapse before the
// render. Sitting mid-bucket makes the assertion stable without weakening it.
const inFuture = (ms: number) => new Date(Date.now() + ms + 2_000).toISOString();

function conn(over: Partial<ConnectorStatus> = {}): ConnectorStatus {
  return {
    connectionId: "c1",
    provider: "home_assistant",
    sector: "home",
    status: "active",
    last_synced_at: iso(2 * MIN),
    last_error: null,
    last_error_at: null,
    policy_mode: "push",
    next_sync_at: null,
    scopes: [],
    credential: { status: "active", expires_at: null },
    credentialId: "cred_fixture",
    webhook_secret_set_at: null,
    sync_window_days: null,
    sync_interval_sec: null,
    min_interval_sec: null,
    default_interval_sec: null,
    cached_count: 42,
    ...over,
  };
}

function fresh(state: FreshnessState, over: Partial<Freshness> = {}): Freshness {
  return {
    state,
    last_heard_at: iso(2 * MIN),
    next_expected_at: null,
    stream_state: null,
    error: null,
    ...over,
  };
}

const ALL_STATES: FreshnessState[] = [
  "ok",
  "syncing",
  "stale",
  "unreachable",
  "error",
  "paused",
  "disconnected",
  "never_synced",
];

describe("there is NO healthy badge (#39/#40 — a dead socket read 'Live' for two weeks)", () => {
  it("ok returns label: null", () => {
    expect(freshnessDisplay(conn({ freshness: fresh("ok") })).label).toBeNull();
  });

  it("a healthy CONNECTED stream still gets no badge — connectedness is a caption fact", () => {
    const d = freshnessDisplay(
      conn({ push_kind: "stream", freshness: fresh("ok", { stream_state: "connected" }) }),
    );
    expect(d.label).toBeNull();
    expect(d.tone).toBe("ok");
    // The connectedness lives in the next-line, not in a health word.
    expect(d.nextLine).toBe("Instant — connected");
  });

  it("a quiet house at 3am (healthy, nothing pushed for hours) still gets no badge", () => {
    const d = freshnessDisplay(
      conn({
        push_kind: "stream",
        last_synced_at: iso(6 * HOUR),
        freshness: fresh("ok", { last_heard_at: iso(6 * HOUR), stream_state: "connected" }),
      }),
    );
    expect(d.label).toBeNull();
    expect(d.caption).toBe("Last synced 6h ago");
  });
});

describe("the server names the state; the renderer never computes one", () => {
  it("a YEAR-old last_heard_at with a served ok stays ok, unbadged — no staleness derivation", () => {
    const d = freshnessDisplay(
      conn({
        policy_mode: "poll",
        provider: "simplefin",
        last_synced_at: iso(365 * DAY),
        freshness: fresh("ok", { last_heard_at: iso(365 * DAY) }),
      }),
    );
    expect(d.state).toBe("ok");
    expect(d.label).toBeNull();
    expect(d.tone).toBe("ok");
  });

  it("an OVERDUE next_expected_at with a served ok stays ok — the FE does not overrule the server", () => {
    const d = freshnessDisplay(
      conn({
        policy_mode: "poll",
        next_sync_at: iso(3 * HOUR),
        freshness: fresh("ok", { next_expected_at: iso(3 * HOUR) }),
      }),
    );
    expect(d.state).toBe("ok");
    expect(d.label).toBeNull();
  });

  it("a served `stale` on a 30-second-old timestamp is still stale — the word wins, not the clock", () => {
    const d = freshnessDisplay(
      conn({ policy_mode: "poll", freshness: fresh("stale", { last_heard_at: iso(30_000) }) }),
    );
    expect(d.state).toBe("stale");
    expect(d.label).toBe("Stale");
  });

  it("passes every served state through untouched", () => {
    for (const s of ALL_STATES) {
      expect(freshnessDisplay(conn({ freshness: fresh(s) })).state).toBe(s);
    }
  });
});

describe("the no-tuple fallback is honest — it maps the lifecycle word and stops", () => {
  it("an ACTIVE connection with an ancient timestamp is NOT declared stale", () => {
    // The legacy fallback used a 24h threshold here. Rebuilding a freshness state from timestamps
    // is exactly the ban this renderer exists to enforce.
    const d = freshnessDisplay(
      conn({ policy_mode: "poll", last_synced_at: iso(400 * DAY), freshness: undefined }),
    );
    expect(d.state).toBe("ok");
    expect(d.label).toBeNull();
    expect(d.nextLine).toBe(""); // no promise we would have to compute
  });

  it("an ACTIVE connection with an overdue next_sync_at is NOT declared stale", () => {
    const d = freshnessDisplay(
      conn({ policy_mode: "poll", next_sync_at: iso(5 * HOUR), freshness: undefined }),
    );
    expect(d.state).toBe("ok");
    expect(d.nextLine).toBe("");
  });

  it("an active PUSH connection that has never been heard from is NOT declared never_synced", () => {
    const d = freshnessDisplay(conn({ last_synced_at: null, freshness: undefined }));
    expect(d.state).toBe("ok");
    expect(d.label).toBeNull();
  });

  it("maps the SERVED lifecycle statuses, which are stored columns and not derivations", () => {
    const of = (s: ConnectorStatus["status"]) =>
      freshnessDisplay(conn({ status: s, freshness: undefined }));
    expect(of("paused").state).toBe("paused");
    expect(of("revoked").state).toBe("disconnected");
    expect(of("syncing").state).toBe("syncing");
    expect(of("error").state).toBe("error");
  });
});

describe("never predict a device push", () => {
  const webhook = { provider: "apple_health", policy_mode: "push" as const, push_kind: "webhook" as PushKind };

  it("push-webhook next-line is 'Device controlled', full stop", () => {
    expect(freshnessDisplay(conn({ ...webhook, freshness: fresh("ok") })).nextLine).toBe(
      "Device controlled",
    );
  });

  it("stays 'Device controlled' even when the tuple carries a next_expected_at", () => {
    const d = freshnessDisplay(
      conn({ ...webhook, freshness: fresh("ok", { next_expected_at: inFuture(4 * HOUR) }) }),
    );
    expect(d.nextLine).toBe("Device controlled");
    expect(d.nextLine).not.toMatch(/Next check/);
  });

  it("a never-pushed webhook still gets the honest mode caption, not a countdown", () => {
    const d = freshnessDisplay(
      conn({ ...webhook, last_synced_at: null, freshness: fresh("never_synced", { last_heard_at: null }) }),
    );
    expect(d.nextLine).toBe("Device controlled");
    expect(d.label).toBe("Awaiting first push");
  });

  it("webhook staleness is ADVISORY — calm tone and a device sentence, never an alarm", () => {
    const d = freshnessDisplay(
      conn({ ...webhook, freshness: fresh("stale", { last_heard_at: iso(3 * DAY) }) }),
    );
    expect(d.tone).toBe("idle");
    expect(d.caption).toBe("last heard from your device 3d ago");
  });

  it("poll staleness the server COMPLAINS about is actionable — attention tone and the served words", () => {
    // Rebound by #116. This cell used to assert that ANY poll `stale` is red, keyed on
    // `pushKind !== "webhook"`. That condition is gone: the renderer now keys on whether the server
    // states a complaint in `freshness.error`, so the fixture must carry the complaint it is about
    // — otherwise the cell would have frozen into deafness and passed while asserting nothing.
    //
    // Rebound AGAIN by #113: the caption was `nothing since 3d ago — check overdue`, which
    // discarded the served complaint and put the SOURCE's emptiness in the subject slot of a
    // sentence built from a transport-only clock. The complaint is now rendered as served.
    const d = freshnessDisplay(
      conn({
        provider: "simplefin",
        policy_mode: "poll",
        push_kind: null,
        freshness: fresh("stale", {
          last_heard_at: iso(3 * DAY),
          error: { message: "scheduled sync overdue by several cadences", since: iso(3 * DAY) },
        }),
      }),
    );
    expect(d.tone).toBe("attention");
    expect(d.caption).toBe("scheduled sync overdue by several cadences · 3d ago");
  });
});

// ── #113: a correct warning must not print a number that argues against it ─────
//
// The Gatehouse attention band showed "nothing since 1h ago — check overdue" for a WHOOP connection
// carrying a 1 h cadence override — so stale past 1.5 h — at ~1 h 40 m elapsed. The state was right;
// the number rendered beside it was below its own trigger, and the operator read the band as crying
// wolf. Two independent defects: `magnitude()` floored the hours bucket, and the sentence's subject
// was the source's silence, which `last_heard_at` cannot speak about at all.
describe("a stale caption never understates its own age, and never claims the source is empty (#113)", () => {
  const whoopLate = (over: Partial<Freshness> = {}) =>
    freshnessDisplay(
      conn({
        provider: "whoop",
        sector: "health",
        policy_mode: "poll",
        push_kind: null,
        sync_interval_sec: 3600, // the live per-connection override → stale past 1.5 h
        freshness: fresh("stale", { last_heard_at: iso(100 * MIN), ...over }),
      }),
    );

  it("prints the age with its remainder, so 1 h 40 m never reads as '1h'", () => {
    // THE MUTATION FOR THIS ISSUE: restore `Math.floor(s / 3600)` as the whole hours branch of
    // api/format.ts `magnitude` and this cell goes red. The fixture sits INSIDE the bucket (100 min,
    // not a whole number of hours) — a 2 h or 3 h fixture passes either way, which is precisely why
    // the defect shipped.
    expect(whoopLate().caption).toContain("1h40m ago");
    expect(whoopLate().caption).not.toContain("1h ago");
  });

  it("the printed age is at or above the 1.5 × cadence threshold that produced the state", () => {
    // The argument the caption has to survive: the reader compares the number against the cadence.
    // 1.5 × 3600 s = 90 min, and the rendered magnitude must not sit under it. Parsed back out of
    // the string rather than asserted as a literal, so this fails for the CLASS (any bucket that
    // silently drops its remainder) and not only for this one duration.
    const m = /(?:(\d+)h)?(?:(\d+)m)? ago/.exec(whoopLate().caption);
    expect(m).not.toBeNull();
    const minutes = Number(m?.[1] ?? 0) * 60 + Number(m?.[2] ?? 0);
    expect(minutes).toBeGreaterThanOrEqual(90);
  });

  it("says nothing about the source having no new data — that is the other clock", () => {
    // src/core/freshness.ts:5-6: last_heard_at is transport only. WHOOP emits ~1 record a day, so
    // "nothing since 1h40m ago" is a normal, healthy fact dressed as an alarm.
    for (const caption of [whoopLate().caption, whoopLate({ error: { message: "scheduled sync overdue by several cadences", since: iso(100 * MIN) } }).caption]) {
      expect(caption).not.toMatch(/nothing since/);
      expect(caption).not.toMatch(/no new/);
    }
  });

  it("the calm near band states OUR lateness, and keeps the healthy caption's verb for the clock", () => {
    const d = whoopLate();
    expect(d.tone).toBe("idle"); // #116 — merely late is not an alarm
    expect(d.caption).toBe("last synced 1h40m ago — next check is late");
  });

  it("the non-poll arm of the lateness clause is DEFENSIVE, and reachable only by hand", () => {
    // `mode === "poll"` on that clause could be deleted with zero signal, and a reviewer's enumeration
    // of `deriveFreshness` showed why: a bare `stale` (no error, not a webhook) is produced in exactly
    // one place — the poll near band — because the push-stream silence fallback always attaches its
    // complaint, a webhook is handled earlier, and `on_demand`/absent modes never return `stale`. So
    // this input CANNOT come off the wire today, and it is built here by hand on purpose.
    //
    // It is kept rather than deleted because "next check is late" is a claim about a SCHEDULE: a
    // future mode that can go stale without promising one must degrade to the bare clock instead of
    // inheriting a promise it never made. That is what this cell pins, and it is what the comment in
    // `freshness.ts` now says — the code and the comment agree, and the condition can no longer be
    // removed silently.
    //
    // MUTATION: drop the `mode === "poll"` condition and this goes red.
    const stale: Freshness = {
      state: "stale",
      last_heard_at: iso(100 * MIN),
      next_expected_at: null,
      stream_state: null,
      error: null,
    };
    const defensive = renderFreshness({ freshness: stale, mode: "on_demand", pushKind: null });
    expect(defensive.caption).toBe("last synced 1h40m ago");
    expect(defensive.caption).not.toMatch(/next check/);
    // …and the poll arm, on the same tuple, DOES state the lateness — one input differs
    const polled = renderFreshness({ freshness: stale, mode: "poll", pushKind: null });
    expect(polled.caption).toBe("last synced 1h40m ago — next check is late");
  });

  it("a stale connection with no clock at all says nothing rather than 'never'", () => {
    // `ago(null)` renders "never", and "last synced never — next check is late" is a sentence about
    // a connection that has been heard from exactly zero times — which is `never_synced`, not this.
    const d = freshnessDisplay(
      conn({
        provider: "whoop",
        policy_mode: "poll",
        push_kind: null,
        freshness: fresh("stale", { last_heard_at: null }),
      }),
    );
    expect(d.caption).toBe("");
  });
});

// ── #116: a healthy connection must not sit in the red band ───────────────────
//
// Three Microsoft connections whose syncs had SUCCEEDED, 8–9 minutes old, sat in NEEDS ATTENTION
// beside genuinely broken sources. The server-side thresholds are pinned in src/core/freshness.test
// .ts; these cells pin the RENDERER's half — that red is earned by the served complaint, and by
// nothing else.
describe("staleness is red only when the server states a complaint (#116)", () => {
  const pollStale = (over: Partial<Freshness> = {}) =>
    freshnessDisplay(
      conn({
        provider: "microsoft",
        sector: "mail",
        policy_mode: "poll",
        push_kind: null,
        freshness: fresh("stale", { last_heard_at: iso(20 * MIN), ...over }),
      }),
    );

  it("a poll connection that is merely LATE renders calm — nothing is broken on our side", () => {
    const d = pollStale();
    expect(d.tone).toBe("idle");
    expect(d.state).toBe("stale"); // the wire word does not change; only the volume does
    expect(d.label).toBe("Stale");
  });

  it("the SAME row with a served complaint renders actionable", () => {
    // The pair is the assertion: one input differs, and it is the served `error`. A renderer that
    // ignored the field (returning a constant tone either way) fails one half or the other.
    const calm = pollStale();
    const loud = pollStale({ error: { message: "scheduled sync overdue", since: iso(3 * DAY) } });
    expect(loud.tone).toBe("attention");
    expect(calm.tone).not.toBe(loud.tone);
  });

  it("a silent push stream keeps its alarm — #40 is not reopened by the generalisation", () => {
    // core/freshness.ts attaches the complaint to the stream-silence fallback precisely so this
    // stays red after the tone rule stopped keying on the transport kind.
    const d = freshnessDisplay(
      conn({
        provider: "home_assistant",
        policy_mode: "push",
        push_kind: "stream",
        freshness: fresh("stale", {
          last_heard_at: iso(20 * MIN),
          error: { message: "push stream silent — the socket is not reporting", since: iso(20 * MIN) },
        }),
      }),
    );
    expect(d.tone).toBe("attention");
    // …and its CAPTION, which #113 put on screen for the first time. There are exactly TWO served
    // stale complaints (`POLL_ALARM_MESSAGE` and `PUSH_STREAM_SILENT_MESSAGE`, src/core/freshness.ts)
    // and the poll one was already pinned above; this cell asserted only the tone, so the renderer
    // could have dropped this sentence — or paraphrased it back into "nothing since {t}" — with no
    // signal at all. The literal mirrors the server constant deliberately: the Console does not import
    // server code, so a change to the string over there must show up as a red here rather than as a
    // silent divergence.
    //
    // MUTATION: discard `f.error.message` in the stale branch (the pre-#113 behaviour) and this goes
    // red. The strings themselves live in src/core and are NOT ours to change.
    expect(d.caption).toBe("push stream silent — the socket is not reporting · 20m ago");
    expect(d.caption).not.toMatch(/nothing since/);
  });

  it("a sync that was attempted and failed still alarms", () => {
    // THE ANTI-VACUITY PARTNER for this file: every cell above asserts something renders CALM, so a
    // renderer that returned "idle" for everything would pass them. `error` is untouched by #116.
    const d = freshnessDisplay(
      conn({
        provider: "microsoft",
        policy_mode: "poll",
        push_kind: null,
        freshness: fresh("error", {
          last_heard_at: iso(20 * MIN),
          error: { message: "microsoft graph returned 401", since: iso(MIN) },
        }),
      }),
    );
    expect(d.tone).toBe("error");
    expect(d.label).toBe("Error");
  });

  it("a merely-late connection does not drag its whole sector tile into the red", () => {
    // The rollup runs the same renderer, so the tile inherits the fix rather than re-deciding it.
    const late = conn({
      connectionId: "a",
      provider: "microsoft",
      policy_mode: "poll",
      push_kind: null,
      freshness: fresh("stale", { last_heard_at: iso(20 * MIN) }),
    });
    const healthy = conn({
      connectionId: "b",
      provider: "microsoft",
      policy_mode: "poll",
      push_kind: null,
      freshness: fresh("ok"),
    });
    expect(freshnessRollup([late, healthy]).tone).toBe("idle");
    // …but one genuinely broken sibling still turns the tile.
    const broken = conn({
      connectionId: "c",
      provider: "microsoft",
      policy_mode: "poll",
      push_kind: null,
      freshness: fresh("error", { error: { message: "401", since: null } }),
    });
    expect(freshnessRollup([late, healthy, broken]).tone).toBe("error");
  });
});

describe("a dead push stream never renders 'Instant — connected'", () => {
  for (const streamState of ["down", "retrying", null] as const) {
    it(`stream_state=${String(streamState)} → no connected promise`, () => {
      const d = freshnessDisplay(
        conn({ push_kind: "stream", freshness: fresh("ok", { stream_state: streamState }) }),
      );
      expect(d.nextLine).not.toBe("Instant — connected");
      expect(d.nextLine).toBe("");
    });
  }

  it("an unreachable stream reads as an alarm with the retry sentence", () => {
    const d = freshnessDisplay(
      conn({
        push_kind: "stream",
        freshness: fresh("unreachable", {
          stream_state: "down",
          error: { message: "socket closed", since: iso(20 * MIN) },
        }),
      }),
    );
    expect(d.label).toBe("Unreachable");
    expect(d.tone).toBe("error");
    expect(d.caption).toBe("can't reach source — since 20m ago, retrying");
    expect(d.nextLine).toBe("");
  });

  it("a gateway that predates push_kind says NOTHING rather than guessing the transport", () => {
    // The old heuristic read a missing stream_state as "Device controlled", which was wrong for HA.
    const d = freshnessDisplay(conn({ push_kind: undefined, freshness: fresh("ok") }));
    expect(d.nextLine).toBe("");
  });
});

describe("one word per concept (#75) and no imperative in a pill (#73)", () => {
  const labels = ALL_STATES.map((s) => freshnessDisplay(conn({ freshness: fresh(s) })).label);

  it("no label is one of the five synonyms the audit found for a healthy connection", () => {
    for (const banned of ["Synced", "Healthy", "Connected", "Active", "streaming", "Live"]) {
      expect(labels).not.toContain(banned);
    }
  });

  it("the error pill does NOT read as the imperative 'Reconnect' — that is a button", () => {
    const d = freshnessDisplay(
      conn({ freshness: fresh("error", { error: { message: "token expired", since: iso(MIN) } }) }),
    );
    expect(d.label).not.toBe("Reconnect");
    expect(d.label).toBe("Error");
    // The provider's own words carry the detail; we never paraphrase them.
    expect(d.caption).toBe("token expired · 1m ago");
  });

  it("no label anywhere is an imperative verb", () => {
    const imperatives = ["Reconnect", "Retry", "Fix", "Sign in", "Connect", "Check now", "Refresh"];
    for (const label of labels) {
      if (label === null) continue;
      expect(imperatives).not.toContain(label);
    }
  });

  it("every non-null label is distinct — one state, one word", () => {
    const nonNull = labels.filter((l): l is string => l !== null);
    expect(new Set(nonNull).size).toBe(nonNull.length);
  });

  it("the next-line vocabulary is exactly the four permitted strings", () => {
    const permitted = new Set(["", "Instant — connected", "Device controlled"]);
    const cases: ConnectorStatus[] = [
      conn({ freshness: fresh("ok") }),
      conn({ push_kind: "stream", freshness: fresh("ok", { stream_state: "connected" }) }),
      conn({ push_kind: "webhook", freshness: fresh("ok") }),
      conn({ policy_mode: "poll", freshness: fresh("ok", { next_expected_at: inFuture(12 * MIN) }) }),
      conn({ policy_mode: "on_demand", freshness: fresh("ok") }),
      ...ALL_STATES.map((s) => conn({ policy_mode: "poll", freshness: fresh(s, { next_expected_at: inFuture(MIN) }) })),
    ];
    for (const c of cases) {
      const line = freshnessDisplay(c).nextLine;
      expect(permitted.has(line) || /^Next check ~/.test(line)).toBe(true);
    }
  });
});

describe("the states with a real next-check promise", () => {
  it("poll ok → 'Next check ~{t}'", () => {
    const d = freshnessDisplay(
      conn({
        provider: "simplefin",
        policy_mode: "poll",
        push_kind: null,
        freshness: fresh("ok", { next_expected_at: inFuture(12 * MIN) }),
      }),
    );
    expect(d.nextLine).toBe("Next check ~12m");
  });

  it("a BROKEN connection makes no next-check promise it cannot keep", () => {
    for (const s of ["stale", "unreachable", "error", "paused", "disconnected"] as const) {
      const d = freshnessDisplay(
        conn({
          provider: "simplefin",
          policy_mode: "poll",
          push_kind: null,
          freshness: fresh(s, { next_expected_at: inFuture(12 * MIN) }),
        }),
      );
      expect(d.nextLine).toBe("");
    }
  });

  it("paused says its cached data still serves, with no next line", () => {
    const d = freshnessDisplay(conn({ status: "paused", freshness: fresh("paused") }));
    expect(d.label).toBe("Paused");
    expect(d.caption).toBe("syncing stopped — cached data still serves");
    expect(d.nextLine).toBe("");
    expect(d.tone).toBe("idle");
  });
});

describe("syncing — cached_count's ONE documented job", () => {
  it("first sync in progress shows the honest running total", () => {
    const d = freshnessDisplay(
      conn({
        last_synced_at: null,
        cached_count: 1234,
        freshness: fresh("syncing", { last_heard_at: null }),
      }),
    );
    expect(d.label).toBe("Syncing… (1,234)");
    expect(d.caption).toBe("first sync in progress");
  });

  it("a RE-sync has no meaningful running total and stays the plain word", () => {
    const d = freshnessDisplay(conn({ cached_count: 1234, freshness: fresh("syncing") }));
    expect(d.label).toBe("Syncing…");
    expect(d.caption).toBe("syncing now");
  });

  it("never_synced is labelled by transport", () => {
    expect(
      freshnessDisplay(conn({ policy_mode: "push", freshness: fresh("never_synced") })).label,
    ).toBe("Awaiting first push");
    expect(
      freshnessDisplay(conn({ policy_mode: "poll", freshness: fresh("never_synced") })).label,
    ).toBe("Awaiting first sync");
  });
});

describe("freshnessRollup — worst state, NEWEST clock, earliest promise", () => {
  it("mirrors the server's severity order exactly", () => {
    // src/core/freshness.ts FRESHNESS_SEVERITY. `disconnected` sits between paused and ok.
    expect([...FRESHNESS_SEVERITY]).toEqual([
      "error",
      "unreachable",
      "stale",
      "syncing",
      "never_synced",
      "paused",
      "disconnected",
      "ok",
    ]);
  });

  it("the worst state wins the tile", () => {
    const d = freshnessRollup([
      conn({ connectionId: "a", freshness: fresh("ok") }),
      conn({ connectionId: "b", freshness: fresh("stale") }),
      conn({ connectionId: "c", freshness: fresh("paused") }),
    ]);
    expect(d.state).toBe("stale");
    expect(d.label).toBe("Stale");
  });

  it("checks EVERY pair in the severity order", () => {
    for (let i = 0; i < FRESHNESS_SEVERITY.length; i++) {
      for (let j = i + 1; j < FRESHNESS_SEVERITY.length; j++) {
        const worse = FRESHNESS_SEVERITY[i];
        const better = FRESHNESS_SEVERITY[j];
        expect(
          freshnessRollup([
            conn({ connectionId: "x", freshness: fresh(better) }),
            conn({ connectionId: "y", freshness: fresh(worse) }),
          ]).state,
        ).toBe(worse);
      }
    }
  });

  it("last-heard is the NEWEST across connections — showing the oldest double-counts the alarm", () => {
    const newest = iso(3 * MIN);
    const d = freshnessRollup([
      conn({ connectionId: "a", freshness: fresh("ok", { last_heard_at: iso(9 * DAY) }) }),
      conn({ connectionId: "b", freshness: fresh("ok", { last_heard_at: newest }) }),
      conn({ connectionId: "c", freshness: fresh("ok", { last_heard_at: iso(2 * HOUR) }) }),
    ]);
    expect(d.lastHeardAt).toBe(newest);
    expect(d.caption).toBe("Last synced 3m ago");
  });

  it("next is the EARLIEST non-null next_expected_at", () => {
    const soonest = inFuture(5 * MIN);
    const d = freshnessRollup([
      conn({ connectionId: "a", provider: "simplefin", policy_mode: "poll", push_kind: null, freshness: fresh("ok", { next_expected_at: inFuture(2 * HOUR) }) }),
      conn({ connectionId: "b", provider: "whoop", policy_mode: "poll", push_kind: null, freshness: fresh("ok", { next_expected_at: soonest }) }),
      conn({ connectionId: "c", provider: "apple_health", policy_mode: "push", push_kind: "webhook", freshness: fresh("ok", { next_expected_at: null }) }),
    ]);
    expect(d.nextLine).toBe("Next check ~5m");
  });

  it("a sector of only device-push connections says 'Device controlled', never a time", () => {
    const d = freshnessRollup([
      conn({ connectionId: "a", provider: "apple_health", policy_mode: "push", push_kind: "webhook", freshness: fresh("ok") }),
    ]);
    expect(d.nextLine).toBe("Device controlled");
  });

  it("a broken connection anywhere in the sector suppresses the tile's next-check promise", () => {
    const d = freshnessRollup([
      conn({ connectionId: "a", provider: "simplefin", policy_mode: "poll", push_kind: null, freshness: fresh("ok", { next_expected_at: inFuture(5 * MIN) }) }),
      conn({ connectionId: "b", provider: "plaid", policy_mode: "poll", push_kind: null, freshness: fresh("error", { error: { message: "ITEM_LOGIN_REQUIRED", since: iso(2 * DAY) } }) }),
    ]);
    expect(d.state).toBe("error");
    expect(d.nextLine).toBe("");
    expect(d.caption).toBe("ITEM_LOGIN_REQUIRED · 2d ago");
  });

  it("a healthy sector rolls up to NO badge", () => {
    const d = freshnessRollup([
      conn({ connectionId: "a", freshness: fresh("ok") }),
      conn({ connectionId: "b", freshness: fresh("ok") }),
    ]);
    expect(d.label).toBeNull();
    expect(d.tone).toBe("ok");
  });

  it("an EMPTY sector says nothing at all — 'nothing connected' is a zero state, not a badge", () => {
    const d = freshnessRollup([]);
    expect(d.label).toBeNull();
    expect(d.caption).toBe("");
    expect(d.nextLine).toBe("");
    expect(d.lastHeardAt).toBeNull();
  });

  it("a webhook stale in a MIXED sector keeps its calm advisory sentence", () => {
    const newest = iso(2 * MIN);
    const d = freshnessRollup([
      conn({ connectionId: "a", provider: "whoop", policy_mode: "poll", push_kind: null, freshness: fresh("ok", { last_heard_at: newest, next_expected_at: inFuture(30 * MIN) }) }),
      conn({ connectionId: "b", provider: "apple_health", policy_mode: "push", push_kind: "webhook", freshness: fresh("stale", { last_heard_at: iso(3 * DAY) }) }),
    ]);
    expect(d.state).toBe("stale");
    expect(d.tone).toBe("idle");
    // The SENTENCE quotes the connection it is about (the device, 3d) …
    expect(d.caption).toBe("last heard from your device 3d ago");
    // … while the sector's own "last synced" clock is the newest across connections (the poll, 2m).
    // Two facts, two slots — never crossed inside one sentence.
    expect(d.lastHeardAt).toBe(newest);
  });
});

describe("renderFreshness — the kit's entry point takes served facts only", () => {
  it("takes the tuple + mode + pushKind and needs nothing else", () => {
    const d = renderFreshness({
      freshness: fresh("ok", { last_heard_at: iso(4 * MIN), stream_state: "connected" }),
      mode: "push",
      pushKind: "stream",
    });
    expect(d).toEqual({
      state: "ok",
      label: null,
      caption: "Last synced 4m ago",
      nextLine: "Instant — connected",
      tone: "ok",
      lastHeardAt: expect.any(String),
    });
  });
});

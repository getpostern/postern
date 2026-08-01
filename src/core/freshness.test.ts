// The freshness derivation table (#39/#40, ADR 0023) — pure, DB-free, fixture-controlled clock via
// the injectable `now` (no sleeps). Covers EVERY row of the spec's normative mapping, the three
// next_expected_at semantics, the webhook-never-unreachable rule, the stream_state-null fallback,
// and the severity rollup order.

import { describe, it, expect } from "vitest";
import {
  deriveFreshness,
  worstFreshness,
  pushKindOf,
  pollAlarmGraceMs,
  pollStaleGraceMs,
  FRESHNESS_SEVERITY,
  POLL_ALARM_FACTOR,
  POLL_ALARM_MIN_GRACE_MS,
  POLL_STALE_FACTOR,
  POLL_STALE_MIN_GRACE_MS,
  PUSH_STREAM_STALE_MS,
  WEBHOOK_STALE_MS,
  type FreshnessState,
} from "./freshness.js";

const NOW = new Date("2026-07-10T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const hoursAgo = (h: number) => minsAgo(h * 60);

type Input = Parameters<typeof deriveFreshness>[0];
const input = (over: Partial<Input> = {}): Input => ({
  status: "active",
  mode: "poll",
  pushKind: null,
  lastSyncedAt: null,
  nextSyncAt: null,
  intervalSec: null,
  cachedCount: null,
  streamState: null,
  streamError: null,
  streamChangedAt: null,
  lastError: null,
  lastErrorAt: null,
  ...over,
});

describe("deriveFreshness — status rows (the row's own word wins outright)", () => {
  it("revoked → disconnected, even over a connected stream", () => {
    const f = deriveFreshness(
      input({ status: "revoked", mode: "push", pushKind: "stream", streamState: "connected" }),
      NOW,
    );
    expect(f.state).toBe("disconnected");
    expect(f.error).toBeNull();
  });

  it("paused → paused", () => {
    const f = deriveFreshness(input({ status: "paused", lastSyncedAt: minsAgo(1) }), NOW);
    expect(f.state).toBe("paused");
    expect(f.last_heard_at).toBe(minsAgo(1));
  });

  it("error + push stream 'down' → error, NOT unreachable (the B1 terminal-death row: status precedence holds for push)", () => {
    // Exactly what B1 writes after a mid-run auth death: markError(status='error') + stream_state='down'.
    // status must win outright — a merge-fold test for the review mutation that survived (adv B2 MEDIUM).
    const f = deriveFreshness(
      input({
        status: "error",
        mode: "push",
        pushKind: "stream",
        streamState: "down",
        streamError: "auth invalid",
        streamChangedAt: minsAgo(5),
        lastError: "auth invalid: token revoked mid-run",
        lastErrorAt: minsAgo(5),
      }),
      NOW,
    );
    expect(f.state).toBe("error");
    expect(f.error?.message).toBe("auth invalid: token revoked mid-run");
  });

  it("error → error carrying last_error + last_error_at as error.{message,since}", () => {
    const f = deriveFreshness(
      input({ status: "error", lastError: "bridge returned 500", lastErrorAt: minsAgo(10) }),
      NOW,
    );
    expect(f.state).toBe("error");
    expect(f.error).toEqual({ message: "bridge returned 500", since: minsAgo(10) });
  });

  it("error with NO recorded last_error still carries a non-empty error.message", () => {
    const f = deriveFreshness(input({ status: "error" }), NOW);
    expect(f.state).toBe("error");
    expect(f.error?.message).toBeTruthy();
    expect(f.error?.since).toBeNull();
  });

  it("syncing → syncing", () => {
    expect(deriveFreshness(input({ status: "syncing" }), NOW).state).toBe("syncing");
  });
});

describe("deriveFreshness — active push-stream", () => {
  const stream = (over: Partial<Input> = {}) => input({ mode: "push", pushKind: "stream", ...over });

  it("stream_state='connected' → ok; connectedness is a caption fact (stream_state), never the badge", () => {
    const f = deriveFreshness(stream({ streamState: "connected", lastSyncedAt: hoursAgo(9) }), NOW);
    // A quiet house at 3 AM: old last-event + open socket is HEALTHY — the recency-only "Live" badge lied.
    expect(f.state).toBe("ok");
    expect(f.stream_state).toBe("connected");
    expect(f.next_expected_at).toBeNull(); // stream: no "next" — display "Instant — connected"
    expect(f.error).toBeNull();
  });

  it("stream_state='retrying' → unreachable with error = stream_error, since = stream_changed_at (the #39 state)", () => {
    const f = deriveFreshness(
      stream({
        streamState: "retrying",
        streamError: "socket closed — reconnecting",
        streamChangedAt: minsAgo(30),
        lastSyncedAt: hoursAgo(2),
      }),
      NOW,
    );
    expect(f.state).toBe("unreachable");
    expect(f.stream_state).toBe("retrying");
    expect(f.error).toEqual({ message: "socket closed — reconnecting", since: minsAgo(30) });
    expect(f.next_expected_at).toBeNull();
  });

  it("stream_state='down' → unreachable (terminal stop is still a transport fact)", () => {
    const f = deriveFreshness(
      stream({ streamState: "down", streamError: "auth invalid", streamChangedAt: minsAgo(5) }),
      NOW,
    );
    expect(f.state).toBe("unreachable");
    expect(f.error?.message).toBe("auth invalid");
    expect(f.error?.since).toBe(minsAgo(5));
  });

  it("stream_state null (pre-migration/never-started) falls back to last_synced_at age: within 15 min → ok", () => {
    const f = deriveFreshness(stream({ streamState: null, lastSyncedAt: minsAgo(5) }), NOW);
    expect(f.state).toBe("ok");
    expect(f.stream_state).toBeNull();
  });

  it("stream_state null + last_synced_at older than PUSH_STREAM_STALE_MS → stale, and it STATES its evidence (the #40 alarm)", () => {
    const f = deriveFreshness(stream({ streamState: null, lastSyncedAt: minsAgo(20) }), NOW);
    expect(f.state).toBe("stale");
    expect(PUSH_STREAM_STALE_MS).toBe(15 * 60 * 1000);
    // #116 moved the Console's red band onto `error` (evidence), off the transport kind. A socket WE
    // hold open that has said nothing for 20 minutes and never stamped a stream_state is the #40
    // state — "a dead push connector invisible for two weeks" — so the tuple must carry a complaint
    // or the renderer paints it calm and the two weeks come back.
    expect(f.error?.message).toBeTruthy();
    expect(f.error?.since).toBe(minsAgo(20));
  });

  it("stream_state null but RECENT carries no complaint — silence inside the window is not evidence", () => {
    const f = deriveFreshness(stream({ streamState: null, lastSyncedAt: minsAgo(5) }), NOW);
    expect(f.state).toBe("ok");
    expect(f.error).toBeNull();
  });

  it("stream_state null + never heard: cached rows → syncing, empty → never_synced", () => {
    expect(deriveFreshness(stream({ cachedCount: 42 }), NOW).state).toBe("syncing");
    expect(deriveFreshness(stream({ cachedCount: 0 }), NOW).state).toBe("never_synced");
    expect(deriveFreshness(stream({ cachedCount: null }), NOW).state).toBe("never_synced");
  });
});

describe("deriveFreshness — active push-webhook (device controlled)", () => {
  const webhook = (over: Partial<Input> = {}) => input({ mode: "push", pushKind: "webhook", ...over });

  it("within WEBHOOK_STALE_MS → ok; no next_expected_at (never predict the phone)", () => {
    const f = deriveFreshness(webhook({ lastSyncedAt: hoursAgo(12) }), NOW);
    expect(f.state).toBe("ok");
    expect(f.next_expected_at).toBeNull();
    expect(f.stream_state).toBeNull();
  });

  it("older than WEBHOOK_STALE_MS → stale (advisory — the device makes no promise)", () => {
    const f = deriveFreshness(webhook({ lastSyncedAt: hoursAgo(72) }), NOW);
    expect(f.state).toBe("stale");
    expect(WEBHOOK_STALE_MS).toBe(48 * 60 * 60 * 1000);
  });

  it("NEVER unreachable — stream columns are ignored (a webhook has no stream concept)", () => {
    const f = deriveFreshness(
      webhook({ lastSyncedAt: hoursAgo(1), streamState: "down", streamError: "bogus" }),
      NOW,
    );
    expect(f.state).toBe("ok");
    expect(f.stream_state).toBeNull();
    expect(f.error).toBeNull();
  });

  it("never heard from the device → never_synced (awaiting first push)", () => {
    expect(deriveFreshness(webhook(), NOW).state).toBe("never_synced");
  });
});

describe("deriveFreshness — active poll", () => {
  const NEXT = "2026-07-10T12:30:00Z";
  const poll = (over: Partial<Input> = {}) => input({ mode: "poll", intervalSec: 3600, ...over });

  it("no last_synced_at: cached rows → syncing (first sync landing), empty → never_synced", () => {
    expect(deriveFreshness(poll({ cachedCount: 3 }), NOW).state).toBe("syncing");
    expect(deriveFreshness(poll({ cachedCount: 0 }), NOW).state).toBe("never_synced");
    expect(deriveFreshness(poll({ cachedCount: null }), NOW).state).toBe("never_synced");
  });

  it("within the near grace → ok, next_expected_at = the computed next_sync_at (a real timestamp)", () => {
    const f = deriveFreshness(poll({ lastSyncedAt: minsAgo(30), nextSyncAt: NEXT }), NOW);
    expect(f.state).toBe("ok");
    expect(f.next_expected_at).toBe(NEXT);
    expect(f.last_heard_at).toBe(minsAgo(30));
  });

  it("past the near grace → stale (still carries the overdue next_expected_at)", () => {
    // interval 3600s → near grace = max(1.5 × 60 min, 60 min + 10 min) = 90 min. 91 min is stale,
    // 89 is not. (At this cadence the 1.5× term wins outright, so the numbers are unchanged by the
    // #116 floor — the SHORT-cadence cases below are where the floor bites.)
    expect(deriveFreshness(poll({ lastSyncedAt: minsAgo(91), nextSyncAt: NEXT }), NOW).state).toBe("stale");
    expect(deriveFreshness(poll({ lastSyncedAt: minsAgo(89), nextSyncAt: NEXT }), NOW).state).toBe("ok");
    const f = deriveFreshness(poll({ lastSyncedAt: minsAgo(91), nextSyncAt: NEXT }), NOW);
    expect(f.next_expected_at).toBe(NEXT);
    // …and a merely-late connection makes NO complaint — that is the whole of #116.
    expect(f.error).toBeNull();
  });

  it("no declared cadence (intervalSec null) → no staleness expectation: ok", () => {
    const f = deriveFreshness(input({ mode: "poll", intervalSec: null, lastSyncedAt: hoursAgo(500) }), NOW);
    expect(f.state).toBe("ok");
  });

  it("accepts Date inputs and normalizes last_heard_at to ISO", () => {
    const f = deriveFreshness(poll({ lastSyncedAt: new Date(minsAgo(10)) }), NOW);
    expect(f.last_heard_at).toBe(minsAgo(10));
  });
});

describe("deriveFreshness — intervalSec wiring (#41 item 5)", () => {
  // Pins that the staleness boundary moves WITH the effective interval passed in — the recorded
  // surviving mutation (nulling the intervalSec wiring, or hardcoding a default cadence) makes
  // every distinctive-cadence row below read 'ok' and fails this table.
  const poll = (intervalSec: number | null, ago: number) =>
    deriveFreshness(input({ mode: "poll", intervalSec, lastSyncedAt: minsAgo(ago) }), NOW);

  it("staleness follows the EFFECTIVE interval, not a constant", () => {
    const cases: Array<{ intervalSec: number | null; minutesAgo: number; expected: string }> = [
      // Distinctive 777s cadence: near grace = max(1.5 × 777s, 777s + 10 min) = 1377s ≈ 22.95 min.
      { intervalSec: 777, minutesAgo: 19, expected: "ok" },
      { intervalSec: 777, minutesAgo: 25, expected: "stale" },
      // A fast cadence still goes stale first — near grace = max(3 min, 12 min) = 12 min …
      { intervalSec: 120, minutesAgo: 15, expected: "stale" },
      // … while the SAME row age under a slow cadence stays ok (near grace = 36 h). No single
      // hardcoded threshold can satisfy this pair, which is the point of it.
      { intervalSec: 86400, minutesAgo: 15, expected: "ok" },
      // No declared cadence → no staleness expectation, ever.
      { intervalSec: null, minutesAgo: 25, expected: "ok" },
      { intervalSec: null, minutesAgo: 60_000, expected: "ok" },
    ];
    for (const c of cases) {
      expect(
        poll(c.intervalSec, c.minutesAgo).state,
        `intervalSec=${c.intervalSec} @ ${c.minutesAgo}m ago`,
      ).toBe(c.expected);
    }
  });

  it("the null-wiring mutation is killed: the SAME row age flips verdict purely on intervalSec", () => {
    // If a caller (or a mutation) nulls the wiring, this pair collapses to 'ok' === 'ok' and fails.
    expect(poll(777, 25).state).toBe("stale");
    expect(poll(null, 25).state).toBe("ok");
    expect(poll(777, 25).state).not.toBe(poll(null, 25).state);
    // And the hardcoded-constant mutation is killed separately: ONE age, two cadences, two verdicts.
    // #116 added an absolute FLOOR to the grace, which a constant could otherwise impersonate.
    expect(poll(120, 15).state).toBe("stale");
    expect(poll(86400, 15).state).toBe("ok");
  });

  it("next_expected_at rides through for poll rows regardless of staleness verdict", () => {
    const NEXT = "2026-07-10T12:12:57Z"; // the caller-computed last_synced + 777s
    const f = deriveFreshness(
      input({ mode: "poll", intervalSec: 777, lastSyncedAt: minsAgo(25), nextSyncAt: NEXT }),
      NOW,
    );
    expect(f.state).toBe("stale");
    expect(f.next_expected_at).toBe(NEXT);
  });
});

// ── #116: a healthy connection must not sit in the red band ───────────────────
//
// The operator's case, verbatim: three Microsoft connections, `sync_interval_sec` NULL so the
// cadence is microsoft.ts's 300 s default, `last_error` null, syncing on schedule, 8–9 minutes since
// the last SUCCESSFUL sync — and all three in NEEDS ATTENTION. Ten minutes later they read 82/113/
// 134 s old. Nothing was ever wrong.
//
// The alarm the Console paints is `freshness.error`; these cells pin which ages produce one.
describe("deriveFreshness — the two poll thresholds (#116)", () => {
  const MS = (min: number) => min * 60_000;
  /** The Microsoft shape: the shortest default cadence of any connector, no override. */
  const ms300 = (minutes: number) =>
    deriveFreshness(
      input({ mode: "poll", intervalSec: 300, lastSyncedAt: minsAgo(minutes) }),
      NOW,
    );

  it("a connection that synced successfully a few minutes ago is not in the attention band", () => {
    // THE operator's row. 8 minutes is past 1.5 × 300 s (7.5 min) — the old threshold, which is
    // exactly why it alarmed — and the connection is plainly healthy.
    const f = ms300(8);
    expect(f.state).toBe("ok");
    expect(f.error).toBeNull(); // ← the field the Console reads to paint red
  });

  it("the near threshold has a floor, so a short cadence is not tripped by one late tick", () => {
    // Mutation target: delete the `+ POLL_STALE_MIN_GRACE_MS` term and 300 s falls back to a 450 s
    // grace, which is 7.5 minutes — every assertion below flips.
    expect(pollStaleGraceMs(300)).not.toBe(POLL_STALE_FACTOR * 300_000); // not 450 s
    expect(pollStaleGraceMs(300)).toBe(MS(15)); // 300 s + 10 min
    expect(ms300(9).state).toBe("ok");
    expect(ms300(14).state).toBe("ok");
    expect(ms300(16).state).toBe("stale");
  });

  it("past the near threshold the word changes but no complaint is made", () => {
    const f = ms300(20);
    expect(f.state).toBe("stale");
    expect(f.error).toBeNull(); // calm: the last sync SUCCEEDED, we are simply no longer current
  });

  it("a connection nothing has checked for hours still alarms — a dead scheduler is not silence", () => {
    // #25 (a scheduler that never caught up after a restart) and #40 (a dead push connector
    // invisible for two weeks). A dead scheduler ATTEMPTS nothing, so `lastError` stays null forever
    // and a pure tried-and-failed rule would never surface it.
    const f = ms300(180);
    expect(f.state).toBe("stale");
    expect(f.error?.message).toBeTruthy();
    expect(f.error?.since).toBe(minsAgo(180));
  });

  it("the far threshold has its own floor and its own factor", () => {
    // 300 s: 4 × 300 s is 20 min, which is barely past the near grace — the 2 h floor is what makes
    // "far" actually far. Mutation: drop the floor and a 25-minute-old Microsoft row alarms again.
    expect(pollAlarmGraceMs(300)).not.toBe(POLL_ALARM_FACTOR * 300_000);
    expect(pollAlarmGraceMs(300)).toBe(MS(125)); // 300 s + 2 h
    expect(ms300(124).error).toBeNull();
    expect(ms300(126).error?.message).toBeTruthy();
    // A LONG cadence takes the factor, not the floor: 6 h Plaid alarms at 24 h, not at 8 h.
    expect(pollAlarmGraceMs(21600)).toBe(POLL_ALARM_FACTOR * 21600 * 1000);
    expect(pollAlarmGraceMs(21600)).toBeGreaterThan(21600 * 1000 + POLL_ALARM_MIN_GRACE_MS);
    // …and the near grace is scale-free at that end too (9 h, not 6 h 10 m).
    expect(pollStaleGraceMs(21600)).toBe(POLL_STALE_FACTOR * 21600 * 1000);
    expect(pollStaleGraceMs(21600)).toBeGreaterThan(21600 * 1000 + POLL_STALE_MIN_GRACE_MS);
  });

  it("the far threshold is strictly past the near one at every cadence we ship", () => {
    // A regression here would collapse the two bands back into one, silently.
    for (const iv of [60, 120, 300, 600, 900, 3600, 21600, 86400]) {
      expect(pollAlarmGraceMs(iv), `intervalSec=${iv}`).toBeGreaterThan(pollStaleGraceMs(iv));
    }
  });

  it("a sync that was attempted and failed still alarms", () => {
    // THE ANTI-VACUITY PARTNER. Every cell above asserts something does NOT alarm, so "refuse to
    // alarm, ever" passes all of them. This one must stay green under every mutation of the rules
    // above: a failed ATTEMPT is the original, unchanged reason for the red band, and #116 does not
    // touch it. `status='error'` is what the runner writes when a sync attempt fails.
    const f = deriveFreshness(
      input({
        mode: "poll",
        intervalSec: 300,
        status: "error",
        lastSyncedAt: minsAgo(2),
        lastError: "microsoft graph returned 401",
        lastErrorAt: minsAgo(1),
      }),
      NOW,
    );
    expect(f.state).toBe("error");
    expect(f.error).toEqual({ message: "microsoft graph returned 401", since: minsAgo(1) });
  });
});

describe("deriveFreshness — on_demand / unregistered provider", () => {
  it("on_demand with a prior sync → ok, no next", () => {
    const f = deriveFreshness(input({ mode: "on_demand", lastSyncedAt: hoursAgo(100) }), NOW);
    expect(f.state).toBe("ok");
    expect(f.next_expected_at).toBeNull();
  });

  it("unregistered provider (mode null) never heard → never_synced", () => {
    expect(deriveFreshness(input({ mode: null }), NOW).state).toBe("never_synced");
  });
});

describe("severity rollup (ADR 0023)", () => {
  it("FRESHNESS_SEVERITY is worst-first: error > unreachable > stale > syncing > never_synced > paused > … > ok", () => {
    expect(FRESHNESS_SEVERITY.slice(0, 6)).toEqual([
      "error",
      "unreachable",
      "stale",
      "syncing",
      "never_synced",
      "paused",
    ]);
    expect(FRESHNESS_SEVERITY[FRESHNESS_SEVERITY.length - 1]).toBe("ok");
    // Total over the enum: every state ranks exactly once.
    expect([...FRESHNESS_SEVERITY].sort()).toEqual(
      (
        ["ok", "syncing", "stale", "unreachable", "error", "paused", "disconnected", "never_synced"] as FreshnessState[]
      ).sort(),
    );
  });

  it("worstFreshness picks the worst state; empty input → null", () => {
    expect(worstFreshness(["ok", "stale", "syncing"])).toBe("stale");
    expect(worstFreshness(["paused", "unreachable", "ok"])).toBe("unreachable");
    expect(worstFreshness(["unreachable", "error"])).toBe("error");
    expect(worstFreshness(["ok", "never_synced", "paused"])).toBe("never_synced");
    expect(worstFreshness(["ok"])).toBe("ok");
    expect(worstFreshness([])).toBeNull();
  });
});

describe("pushKindOf — duck-typed transport kind", () => {
  const push = { policy: { mode: "push" } };
  it("push + start → stream; push + decodePush → webhook; both → stream (start wins)", () => {
    expect(pushKindOf({ ...push, start: () => {} })).toBe("stream");
    expect(pushKindOf({ ...push, decodePush: () => [] })).toBe("webhook");
    expect(pushKindOf({ ...push, start: () => {}, decodePush: () => [] })).toBe("stream");
  });
  it("push with neither hook → null; non-push / unregistered → null", () => {
    expect(pushKindOf(push)).toBeNull();
    expect(pushKindOf({ policy: { mode: "poll" }, start: () => {} })).toBeNull();
    expect(pushKindOf(null)).toBeNull();
    expect(pushKindOf(undefined)).toBeNull();
  });
});

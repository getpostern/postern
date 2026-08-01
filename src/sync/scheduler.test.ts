// Scheduler tests — deterministic, fully mocked (no real DB, no real wall-clock).
//
// Why mocked rather than DB-backed: the scheduler's FIRST tick now uses setTimeout (restart
// catch-up, #25). A test must fake setTimeout to drive that tick on demand — but pg's pool
// implements idleTimeoutMillis/connectionTimeoutMillis with setTimeout too, so faking setTimeout
// while a scheduler callback runs a REAL pool.query makes those timeouts fire on every fake-clock
// jump ("Connection terminated due to connection timeout"). (The old scheduler used only
// setInterval, so the wave-5 DB tests could leave pg's setTimeout real.) We therefore mock
// db.js + runner.js + registry.js and exercise the scheduler's timing/membership logic directly,
// with FULL fake timers (Date too) for exact control of
//   firstDelay = max(0, last_synced + interval - now) + jitter   (jitter ∈ [0, JITTER_MS]).
// The real-pg sync path is covered by runner.test.ts / *.db.test.ts; this unit is timer logic.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { SyncPolicy } from "../connectors/types.js";

const INTERVAL_SEC = 120;
const INTERVAL_MS = INTERVAL_SEC * 1000;
const JITTER_MS = 30_000; // mirrors scheduler.ts
const RESCAN_MS = 60_000; // mirrors scheduler.ts RESCAN_INTERVAL_MS
const NOW = new Date("2026-01-01T00:00:00Z").getTime();

/** Rows scan() will see (closed over by the db mock; reassignment is observed each query).
 *  sync_interval_sec is the ADR-0025 per-connection cadence override (absent/undefined = null). */
let rows: Array<{
  id: string;
  provider: string;
  last_synced_at: Date | null;
  sync_interval_sec?: number | null;
}> = [];
/** connectionIds passed to the (mocked) syncConnection, in order. */
let syncs: string[] = [];
/** The SQL the scan() pass last issued — lets us assert the status filter deterministically. */
let lastScanSql = "";

let startScheduler: () => Promise<() => void>;
let effectiveIntervalSec: (
  policy: SyncPolicy | undefined,
  storedSec: number | null | undefined,
) => number | null;
let effectiveToleranceSec: (
  policy: SyncPolicy | undefined,
  storedSec: number | null | undefined,
) => number | null;
let intervalFloorSec: (policy: SyncPolicy | null | undefined) => number | null;

beforeAll(async () => {
  vi.doMock("../db.js", () => ({
    pool: {
      query: async (sql: string) => {
        lastScanSql = sql;
        return { rows };
      },
    },
  }));
  vi.doMock("./runner.js", () => ({
    syncConnection: async (id: string) => {
      syncs.push(id);
      return { ok: true };
    },
  }));
  vi.doMock("./registry.js", () => ({
    // provider drives the mode so push/on_demand can be exercised; everything else is poll.
    getConnector: (provider: string) =>
      provider === "push_p"
        ? { policy: { mode: "push" } }
        : provider === "ondemand_p"
          ? { policy: { mode: "on_demand" } }
          : provider === "minfloor_p"
            ? {
                policy: {
                  mode: "poll",
                  defaultIntervalSec: INTERVAL_SEC,
                  minIntervalSec: 30, // a floor BELOW the default (the plaid/whoop shape)
                  freshnessToleranceSec: 0,
                },
              }
            : provider === "realistic_p"
              ? {
                  // The REAL connector shape (plaid/simplefin/whoop declare tolerance == default):
                  // this is the shape under which the static-tolerance skip-gate bug hid.
                  policy: {
                    mode: "poll",
                    defaultIntervalSec: 21600,
                    minIntervalSec: 900,
                    freshnessToleranceSec: 21600,
                  },
                }
              : {
                  policy: {
                    mode: "poll",
                    defaultIntervalSec: INTERVAL_SEC,
                    freshnessToleranceSec: 0, // every fired tick is stale → observable
                  },
                },
  }));
  ({ startScheduler, effectiveIntervalSec, effectiveToleranceSec, intervalFloorSec } = await import(
    "./scheduler.js"
  ));
});

afterAll(() => {
  vi.doUnmock("../db.js");
  vi.doUnmock("./runner.js");
  vi.doUnmock("./registry.js");
});

beforeEach(() => {
  rows = [];
  syncs = [];
  lastScanSql = "";
  vi.useFakeTimers(); // fakes Date too — deterministic firstDelay math
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const count = (id: string): number => syncs.filter((x) => x === id).length;

describe("startScheduler first-tick alignment (#25 restart catch-up)", () => {
  it("polls an overdue-at-scan connector within ~jitter, not after a full interval", async () => {
    // last_synced two intervals ago → last + interval is in the past → firstDelay = jitter (≤ 30s).
    rows = [{ id: "c-overdue", provider: "p", last_synced_at: new Date(NOW - 2 * INTERVAL_MS) }];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(JITTER_MS); // 30s ≪ 120s interval
    expect(syncs).toContain("c-overdue"); // caught up promptly, NOT after +interval
    stop();
  });

  it("does NOT poll a fresh-at-scan connector until ~last_synced + interval", async () => {
    // synced half an interval ago → firstDelay = INTERVAL/2 (+jitter) = 60..90s.
    rows = [{ id: "c-fresh", provider: "p", last_synced_at: new Date(NOW - INTERVAL_MS / 2) }];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(JITTER_MS); // 30s < 60s remaining → no premature poll
    expect(syncs).not.toContain("c-fresh");

    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // well past last + interval
    expect(syncs).toContain("c-fresh");
    stop();
  });

  it("polls a never-synced connector ~immediately (within jitter)", async () => {
    rows = [{ id: "c-new", provider: "p", last_synced_at: null }];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(JITTER_MS);
    expect(syncs).toContain("c-new");
    stop();
  });

  it("continues the recurring interval after the first aligned tick", async () => {
    rows = [{ id: "c-rec", provider: "p", last_synced_at: null }];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(JITTER_MS); // first tick
    const afterFirst = count("c-rec");
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // one recurring interval later
    expect(count("c-rec")).toBeGreaterThan(afterFirst);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // and again
    expect(count("c-rec")).toBeGreaterThan(afterFirst + 1);
    stop();
  });
});

describe("startScheduler timer lifecycle (no orphan timers)", () => {
  it("stop() clears the pending initial timeout (before the first tick fires)", async () => {
    rows = [{ id: "c-pending", provider: "p", last_synced_at: null }];
    const stop = await startScheduler();

    // Before the first tick fires: the rescan interval + the per-connector timeout are both live.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stop();
    expect(vi.getTimerCount()).toBe(0); // both the rescan AND the pending timeout cleared

    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
    expect(syncs).not.toContain("c-pending");
  });

  it("stop() clears the recurring interval once the first tick has installed it", async () => {
    rows = [{ id: "c-running", provider: "p", last_synced_at: null }];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(JITTER_MS); // first tick fires → timeout gone, interval live
    const before = count("c-running");
    expect(before).toBeGreaterThanOrEqual(1);

    stop();
    expect(vi.getTimerCount()).toBe(0); // interval handle cleared too
    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
    expect(count("c-running")).toBe(before); // no further ticks
  });

  it("removal on re-scan clears the live interval (no orphan after the row departs)", async () => {
    rows = [{ id: "c-gone", provider: "p", last_synced_at: null }];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(JITTER_MS); // first tick fired; interval live
    const before = count("c-gone");

    rows = []; // row departs (revoked/paused/deleted) → drops out of the scan's active set
    await vi.advanceTimersByTimeAsync(RESCAN_MS); // re-scan drops it → clears the interval

    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
    expect(count("c-gone")).toBe(before); // no ticks after removal
    stop();
  });
});

describe("startScheduler membership (re-scan + mode + status filter)", () => {
  it("never schedules push or on_demand connectors", async () => {
    rows = [
      { id: "c-push", provider: "push_p", last_synced_at: null },
      { id: "c-ondemand", provider: "ondemand_p", last_synced_at: null },
    ];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(5 * INTERVAL_MS);
    expect(syncs).not.toContain("c-push");
    expect(syncs).not.toContain("c-ondemand");
    stop();
  });

  it("schedules a connection that appears AFTER boot on the next 60s re-scan (no restart)", async () => {
    rows = []; // boot finds nothing
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(JITTER_MS + INTERVAL_MS); // nothing scheduled → no syncs
    expect(syncs).toHaveLength(0);

    rows = [{ id: "c-late", provider: "p", last_synced_at: null }]; // onboarded after boot
    await vi.advanceTimersByTimeAsync(RESCAN_MS); // a re-scan picks it up and schedules it
    await vi.advanceTimersByTimeAsync(JITTER_MS); // its aligned first tick fires

    expect(syncs).toContain("c-late");
    stop();
  });

  it("the scan query selects active/error/syncing connections (resumable 'syncing' kept)", async () => {
    // 'syncing' is a RESUMABLE mid-sync that MUST keep being re-polled (wave-11c); the scan must not
    // drop it. The status filter lives in the SQL, so assert it directly.
    rows = [];
    const stop = await startScheduler();
    expect(lastScanSql).toContain("status in ('active', 'error', 'syncing')");
    stop();
  });

  it("the scan query reads sync_interval_sec (the ADR-0025 override column)", async () => {
    rows = [];
    const stop = await startScheduler();
    expect(lastScanSql).toContain("sync_interval_sec");
    stop();
  });
});

describe("effectiveIntervalSec / intervalFloorSec (the ONE cadence derivation, ADR 0025)", () => {
  const poll: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 21600,
    minIntervalSec: 900,
    supportsIncremental: false,
  };

  it("honors an at-or-above-floor override verbatim (no ceiling)", () => {
    expect(effectiveIntervalSec(poll, 3600)).toBe(3600);
    expect(effectiveIntervalSec(poll, 900)).toBe(900); // the floor itself is valid
    expect(effectiveIntervalSec(poll, 86400)).toBe(86400); // slower than default — legitimate
  });

  it("clamps a below-floor stored value to the floor (a hand-edited row cannot hammer a provider)", () => {
    expect(effectiveIntervalSec(poll, 60)).toBe(900);
    expect(effectiveIntervalSec(poll, 0)).toBe(900);
    expect(effectiveIntervalSec(poll, -5)).toBe(900);
  });

  it("null/undefined stored → the connector default", () => {
    expect(effectiveIntervalSec(poll, null)).toBe(21600);
    expect(effectiveIntervalSec(poll, undefined)).toBe(21600);
  });

  it("no declared floor → the default IS the floor (users may only slow down)", () => {
    const noMin: SyncPolicy = { mode: "poll", defaultIntervalSec: 600, supportsIncremental: false };
    expect(effectiveIntervalSec(noMin, 300)).toBe(600); // faster-than-default clamped
    expect(effectiveIntervalSec(noMin, 7200)).toBe(7200); // slower honored
    expect(intervalFloorSec(noMin)).toBe(600);
  });

  it("a poll policy with NO default falls back to the legacy 3600s", () => {
    const bare: SyncPolicy = { mode: "poll", supportsIncremental: false };
    expect(effectiveIntervalSec(bare, null)).toBe(3600);
    expect(effectiveIntervalSec(bare, 60)).toBe(3600); // fallback is also the floor
    expect(effectiveIntervalSec(bare, 7200)).toBe(7200);
  });

  it("non-poll / unregistered → null (cadence is not ours to control)", () => {
    expect(effectiveIntervalSec({ mode: "push", supportsIncremental: false }, 300)).toBeNull();
    expect(effectiveIntervalSec({ mode: "on_demand", supportsIncremental: false }, 300)).toBeNull();
    expect(effectiveIntervalSec(undefined, 300)).toBeNull();
    expect(intervalFloorSec({ mode: "push", supportsIncremental: false })).toBeNull();
    expect(intervalFloorSec(undefined)).toBeNull();
  });

  it("intervalFloorSec prefers the declared floor over the default", () => {
    expect(intervalFloorSec(poll)).toBe(900);
    expect(intervalFloorSec({ mode: "poll", supportsIncremental: false })).toBe(3600);
  });
});

describe("effectiveToleranceSec (the skip-gate never exceeds the chosen cadence — review BLOCK fold)", () => {
  const poll: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 21600,
    minIntervalSec: 900,
    freshnessToleranceSec: 21600, // the real-connector shape: tolerance == default interval
    supportsIncremental: false,
  };

  it("default cadence → the declared tolerance verbatim (byte-identical to pre-cadence behavior)", () => {
    expect(effectiveToleranceSec(poll, null)).toBe(21600);
    expect(effectiveToleranceSec(poll, undefined)).toBe(21600);
  });

  it("a faster-than-tolerance override pulls the gate down to the cadence", () => {
    expect(effectiveToleranceSec(poll, 3600)).toBe(3600);
    expect(effectiveToleranceSec(poll, 900)).toBe(900); // at the floor
  });

  it("a slower-than-tolerance override keeps the declared tolerance (min, never widened)", () => {
    expect(effectiveToleranceSec(poll, 86400)).toBe(21600);
  });

  it("no declared tolerance → the effective interval itself", () => {
    const noTol: SyncPolicy = { mode: "poll", defaultIntervalSec: 600, supportsIncremental: false };
    expect(effectiveToleranceSec(noTol, null)).toBe(600);
    expect(effectiveToleranceSec(noTol, 7200)).toBe(7200);
  });

  it("a declared ZERO tolerance stays zero (always-stale connectors keep firing every tick)", () => {
    const zero: SyncPolicy = {
      mode: "poll",
      defaultIntervalSec: 120,
      freshnessToleranceSec: 0,
      supportsIncremental: false,
    };
    expect(effectiveToleranceSec(zero, null)).toBe(0);
  });

  it("non-poll / unregistered → null (matches effectiveIntervalSec)", () => {
    expect(effectiveToleranceSec({ mode: "push", supportsIncremental: false }, null)).toBeNull();
    expect(effectiveToleranceSec({ mode: "on_demand", supportsIncremental: false }, 300)).toBeNull();
    expect(effectiveToleranceSec(undefined, 300)).toBeNull();
  });
});

describe("startScheduler cadence override + reschedule-on-drift (ADR 0025)", () => {
  it("the timer fires on the OVERRIDE cadence, not the default", async () => {
    // jitter pinned to 0 → exact tick arithmetic (restored by afterEach's useRealTimers + this restore).
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    rows = [
      { id: "c-override", provider: "p", last_synced_at: null, sync_interval_sec: 2 * INTERVAL_SEC },
    ];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(0); // never-synced + zero jitter → first tick immediately
    expect(count("c-override")).toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // one DEFAULT interval — must NOT tick
    expect(count("c-override")).toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS); // now one full override interval has passed
    expect(count("c-override")).toBe(2);
    stop();
    rnd.mockRestore();
  });

  it("a hand-written below-floor row still syncs at the FLOOR (read-time clamp), never faster", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    // minfloor_p: default 120s, floor 30s; a hand-edited 1s row must clamp to the 30s floor.
    rows = [{ id: "c-floor", provider: "minfloor_p", last_synced_at: null, sync_interval_sec: 1 }];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(0); // first tick
    expect(count("c-floor")).toBe(1);

    await vi.advanceTimersByTimeAsync(29_000); // 1s cadence would have ticked ~29 more times
    expect(count("c-floor")).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000); // t=30s — the floor cadence ticks
    expect(count("c-floor")).toBe(2);
    stop();
    rnd.mockRestore();
  });

  it("an at-floor override on minfloor_p IS honored below the default (30s < 120s)", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    rows = [{ id: "c-fast", provider: "minfloor_p", last_synced_at: null, sync_interval_sec: 30 }];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(0);
    expect(count("c-fast")).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(count("c-fast")).toBe(2); // 30s cadence, NOT the 120s default
    stop();
    rnd.mockRestore();
  });

  it("reschedule-on-drift: a cadence change is picked up by the ~60s re-scan — the old timer is cleared and the new one aligns to last_synced + newInterval", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    // Fresh at boot (synced exactly NOW) on the 120s default → first tick would be at t=120s.
    rows = [{ id: "c-drift", provider: "p", last_synced_at: new Date(NOW), sync_interval_sec: null }];
    const stop = await startScheduler();

    // The operator sets a 600s override; the next re-scan (t=60s) must reinstall the timer.
    rows = [{ id: "c-drift", provider: "p", last_synced_at: new Date(NOW), sync_interval_sec: 600 }];
    await vi.advanceTimersByTimeAsync(RESCAN_MS); // t=60s: drift detected → reinstall aligned to +600s

    await vi.advanceTimersByTimeAsync(2 * INTERVAL_MS); // t=300s — the OLD 120s timer would have fired
    expect(count("c-drift")).toBe(0); // stale timer was CLEARED, not left on the old cadence

    await vi.advanceTimersByTimeAsync(300_000); // t=600s = last_synced + 600s: the NEW aligned tick
    expect(count("c-drift")).toBe(1);
    stop();
    rnd.mockRestore();
  });

  it("reschedule-on-drift: clearing the override (null) re-aligns back to the default cadence", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    rows = [{ id: "c-reset", provider: "p", last_synced_at: new Date(NOW), sync_interval_sec: 600 }];
    const stop = await startScheduler();

    rows = [{ id: "c-reset", provider: "p", last_synced_at: new Date(NOW), sync_interval_sec: null }];
    await vi.advanceTimersByTimeAsync(RESCAN_MS); // t=60s: drift (600 → default 120) → reinstall
    expect(count("c-reset")).toBe(0);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS - RESCAN_MS); // t=120s = last_synced + default
    expect(count("c-reset")).toBe(1);
    stop();
    rnd.mockRestore();
  });

  it("no drift → the installed timer is untouched by a re-scan (no double-firing)", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    rows = [{ id: "c-same", provider: "p", last_synced_at: new Date(NOW), sync_interval_sec: 600 }];
    const stop = await startScheduler();

    // Several re-scans pass with an unchanged cadence; the aligned first tick stays t=600s.
    await vi.advanceTimersByTimeAsync(599_000);
    expect(count("c-same")).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(count("c-same")).toBe(1);
    stop();
    rnd.mockRestore();
  });
});

describe("startScheduler skip-gate at the REALISTIC tolerance shape (review folds)", () => {
  // realistic_p mirrors the real connectors: default 21600 / tolerance 21600 / floor 900. All the
  // earlier override tests use tolerance 0, which is exactly the gap that masked the BLOCK: with a
  // static 21600s tolerance every faster-than-tolerance tick fired and silently did nothing.

  it("a faster-than-tolerance override actually SYNCS at its tick (default 21600/tol 21600/floor 900, override 3600)", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    rows = [
      { id: "c-tolgate", provider: "realistic_p", last_synced_at: new Date(NOW), sync_interval_sec: 3600 },
    ];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(3_600_000); // the 1h override tick
    // Pre-fix, the connector's STATIC 21600s tolerance judged the row "still fresh" here and the
    // tick no-oped — the override fired timers that never synced.
    expect(count("c-tolgate")).toBe(1);

    await vi.advanceTimersByTimeAsync(3_600_000); // and the override cadence keeps delivering
    expect(count("c-tolgate")).toBe(2);
    stop();
    rnd.mockRestore();
  });

  it("at the DEFAULT cadence the gate is byte-identical (tolerance == default → the aligned tick syncs, no earlier)", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    rows = [
      { id: "c-defgate", provider: "realistic_p", last_synced_at: new Date(NOW), sync_interval_sec: null },
    ];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(21_600_000 - 1_000); // just shy of last_synced + default
    expect(count("c-defgate")).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000); // t = 21600s — the aligned default tick
    expect(count("c-defgate")).toBe(1);
    stop();
    rnd.mockRestore();
  });

  it("reschedule-on-drift preserves the in-flight guard: the reinstalled catch-up tick starts no SECOND sync for a row already kicked", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    // Overdue at boot → the first tick kicks a sync immediately; the DB row's last_synced_at stays
    // OLD until that run completes and stamps it (exactly the window a cadence change can land in).
    const old = new Date(NOW - 21_700_000); // just past the 21600s tolerance
    rows = [
      { id: "c-inflight", provider: "realistic_p", last_synced_at: old, sync_interval_sec: null },
    ];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(0); // overdue + zero jitter → sync #1 kicked at t=0
    expect(count("c-inflight")).toBe(1);

    // The operator sets a 1h override while the run is still unstamped (the row keeps the old
    // timestamp). The t=60s re-scan reinstalls on drift — it must CARRY the local marker forward,
    // not reset it to the stale row value.
    rows = [
      { id: "c-inflight", provider: "realistic_p", last_synced_at: old, sync_interval_sec: 3600 },
    ];
    await vi.advanceTimersByTimeAsync(RESCAN_MS); // t=60s: drift → reinstall
    expect(count("c-inflight")).toBe(1); // NO second concurrent kick from the reinstalled catch-up tick

    // The next kick lands one OVERRIDE interval after the in-flight marker (t=3600s), not before.
    await vi.advanceTimersByTimeAsync(3_600_000 - RESCAN_MS - 1_000); // t=3599s
    expect(count("c-inflight")).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000); // t=3600s = kick(t=0) + 3600s
    expect(count("c-inflight")).toBe(2);
    stop();
    rnd.mockRestore();
  });
});

describe("startScheduler Node-timer overflow clamp (security fold)", () => {
  it("a hand-edited beyond-2^31−1ms cadence installs a BOUNDED timer — one tick at the ~24.8d ceiling, never a ~1ms loop", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0);
    // 100 days ≫ the 2^31−1 ms (~24.8d) setTimeout ceiling. Only a hand-edited row can look like
    // this (the API caps overrides at 14 days); unclamped, real Node would fire it every ~1ms.
    const HUNDRED_DAYS_SEC = 100 * 24 * 3600;
    rows = [
      { id: "c-huge", provider: "p", last_synced_at: new Date(NOW), sync_interval_sec: HUNDRED_DAYS_SEC },
    ];
    const stop = await startScheduler();

    await vi.advanceTimersByTimeAsync(1_000); // the overflow symptom would be ~1000 syncs by now
    expect(count("c-huge")).toBe(0);

    // The single timer sleeps the CLAMPED max, then ticks; provider "p" has tolerance 0 so the tick
    // syncs — proving the delay was the ceiling, not the raw 100-day value.
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
    expect(count("c-huge")).toBe(1);
    stop();
    rnd.mockRestore();
  });
});

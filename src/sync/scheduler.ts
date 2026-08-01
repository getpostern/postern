// The generic poll scheduler. Declarative: it reads each connector's SyncPolicy and drives every
// `poll` connector the same way — on its cadence, skipping a run when the connection is still fresh.
// `push`/`on_demand` are not scheduled. No per-sector logic. A periodic re-scan picks up
// connections onboarded AFTER boot (and drops revoked ones) without a restart.

import { pool } from "../db.js";
import { getConnector } from "./registry.js";
import { syncConnection } from "./runner.js";
import type { SyncPolicy } from "../connectors/types.js";

/** Re-scan cadence: connections onboarded AFTER boot get scheduled without a restart. */
const RESCAN_INTERVAL_MS = 60_000;

/** Legacy fallback for a poll policy that declares no defaultIntervalSec (pre-cadence behaviour). */
const FALLBACK_INTERVAL_SEC = 3600;

/**
 * The floor a user cadence override is clamped to (ADR 0025): the connector-declared
 * minIntervalSec, else its defaultIntervalSec (no floor declared → users may only slow down).
 * null = not a poll connection (cadence is not ours to control there).
 */
export function intervalFloorSec(policy: SyncPolicy | null | undefined): number | null {
  if (!policy || policy.mode !== "poll") return null;
  return policy.minIntervalSec ?? policy.defaultIntervalSec ?? FALLBACK_INTERVAL_SEC;
}

/**
 * The ONE cadence derivation (ADR 0025): effective = clamp(user_override ?? connector_default,
 * floor). Shared by the scheduler timer, next_sync_at, and both freshness call sites so the timer,
 * the displayed expectation, and the staleness judgment can never disagree. The clamp is the third
 * enforcement layer — a hand-edited below-floor row cannot hammer a provider (explicit API input is
 * REJECTED with a 400 instead; never silently clamped). null = not a poll connection.
 */
export function effectiveIntervalSec(
  policy: SyncPolicy | undefined,
  storedSec: number | null | undefined,
): number | null {
  const floor = intervalFloorSec(policy);
  if (floor == null) return null; // push/on_demand/unregistered — no cadence to control
  const base = storedSec ?? policy?.defaultIntervalSec ?? FALLBACK_INTERVAL_SEC;
  return Math.max(base, floor);
}

/**
 * The effective "skip if synced recently" tolerance (ADR 0025, review-BLOCK fold):
 * min(policy.freshnessToleranceSec ?? effectiveInterval, effectiveInterval). The gate must never
 * exceed the CHOSEN cadence — the connectors declare tolerance == their default interval, so with a
 * faster override the static tolerance would make every override tick fire and silently do nothing
 * (behavior at the default cadence is unchanged: min(default, default) = default). Derived beside
 * effectiveIntervalSec so the timer and its gate share the one cadence source of truth.
 * null = not a poll connection.
 */
export function effectiveToleranceSec(
  policy: SyncPolicy | undefined,
  storedSec: number | null | undefined,
): number | null {
  const interval = effectiveIntervalSec(policy, storedSec);
  if (interval == null) return null;
  return Math.min(policy?.freshnessToleranceSec ?? interval, interval);
}

/**
 * Node's timer-delay ceiling: a setTimeout/setInterval delay past 2^31−1 ms (~24.8 days) overflows
 * a signed 32-bit int and fires every ~1ms — an unbounded provider hammer. The API already caps
 * overrides at 14 days (MAX_SYNC_INTERVAL_SEC), so only a hand-edited row can reach this; the belt
 * here clamps the TIMER DELAY only, never the cadence semantics: the first tick stays aligned via
 * the catch-up math and every tick still passes the staleness gate, so the worst case for a
 * beyond-ceiling row is a bounded no-op-or-early tick every ~24.8 days — never a ~1ms loop.
 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Catch-up jitter: the first aligned tick is spread by a random [0, JITTER_MS] so a boot that finds
 * many overdue connectors doesn't hit every provider in the same millisecond (thundering-herd).
 */
const JITTER_MS = 30_000;

/** Both timer handles for one scheduled connection. The initial timeout fires the aligned first
 * tick, then installs the recurring interval; removal/stop clears whichever is currently live.
 * `intervalMs` records the EFFECTIVE cadence the timers were installed on, so a re-scan can detect
 * a cadence change (drift) and reinstall — handles are otherwise installed once. `lastKickedAt` is
 * the LOCAL freshness marker: advanced the moment a run is kicked off (the in-flight guard), while
 * the DB's last_synced_at is stamped only when that run completes — kept on the handle so a drift
 * reinstall can carry it forward instead of resetting to the stale row value. */
interface Handles {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
  intervalMs: number;
  lastKickedAt: Date | null;
}

/** True when the connection is stale enough to warrant a sync (or has never synced). */
export function isStale(lastSyncedAt: Date | null, toleranceSec: number | undefined): boolean {
  return !lastSyncedAt || Date.now() - lastSyncedAt.getTime() >= (toleranceSec ?? 0) * 1000;
}

/** Clear whichever handle(s) a scheduled entry currently holds — no orphan timers. */
function clearHandles(h: Handles): void {
  if (h.timeout) clearTimeout(h.timeout);
  if (h.interval) clearInterval(h.interval);
}

/**
 * Schedule every active/error/syncing connector whose registered connector is `poll`-mode at its
 * declared cadence. The FIRST tick is aligned to `last_synced_at + intervalMs` (plus jitter), so a
 * (re)start resumes the cadence instead of resetting the clock: an already-overdue connector is
 * caught up promptly (firstDelay ≈ jitter), a never-synced one runs ~immediately, and a still-fresh
 * one waits exactly the remaining time — no premature poll. After that first run the normal
 * recurring `setInterval(intervalMs)` takes over. Each tick runs syncConnection(id) but skips when
 * the connection is still fresh (!isStale). syncConnection swallows its own errors, so a timer can
 * never throw. The table is re-scanned every 60s: rows new since the last scan get a timer; rows no
 * longer `status in ('active','error','syncing')` lose theirs ('syncing' is a RESUMABLE mid-sync —
 * it must keep being re-polled so it resumes from connectors.cursor and converges); a row whose
 * EFFECTIVE cadence drifted from the installed one (sync_interval_sec changed, ADR 0025) gets its
 * timers reinstalled aligned on the new cadence — otherwise existing per-connection timers are
 * untouched by a re-scan. Returns a
 * stop() that clears every timer (both the pending initial timeout and the recurring interval).
 */
export async function startScheduler(): Promise<() => void> {
  /** Scheduled connections: connectionId → its timer handles (the membership the re-scan maintains). */
  const scheduled = new Map<string, Handles>();

  /** One pass over the connectors table: schedule new rows, drop departed ones, reinstall drifted ones. */
  async function scan(): Promise<void> {
    const res = await pool.query(
      `select id, provider, last_synced_at, sync_interval_sec from connectors where status in ('active', 'error', 'syncing')`,
    );

    const seen = new Set<string>();
    for (const row of res.rows) {
      const connector = getConnector(row.provider as string);
      if (!connector || connector.policy.mode !== "poll") continue; // push/on_demand are not scheduled
      const connectionId = row.id as string;
      seen.add(connectionId);

      const storedSec = row.sync_interval_sec as number | null;
      // The ONE cadence derivation (floor-clamped user override, else the connector default). Never
      // null here — the mode==='poll' guard above matches the helpers' own poll check. The timer
      // delay is additionally clamped to Node's 2^31−1 ms ceiling (see MAX_TIMER_DELAY_MS): the
      // clamp bounds ONLY how long one timer sleeps, never the cadence bookkeeping — the catch-up
      // alignment and the staleness gate below still run on every tick, so a hand-edited
      // beyond-ceiling row degrades to a bounded ~24.8-day tick instead of an overflowed ~1ms loop.
      const intervalMs = Math.min(
        (effectiveIntervalSec(connector.policy, storedSec) ?? FALLBACK_INTERVAL_SEC) * 1000,
        MAX_TIMER_DELAY_MS,
      );
      // The skip-gate's tolerance follows the SAME derivation (review-BLOCK fold): never wider than
      // the chosen cadence, so a faster-than-tolerance override actually syncs on its ticks.
      const toleranceSec = effectiveToleranceSec(connector.policy, storedSec) ?? undefined;

      // Pickup-on-change (ADR 0025): a cadence change (operator set/reset sync_interval_sec) is
      // detected by comparing the installed interval against the current effective value — clear the
      // old timers and fall through to a fresh install aligned on the NEW cadence (same ~60s
      // convention as onboarding pickup; no restart, no route→scheduler coupling).
      const existing = scheduled.get(connectionId);
      if (existing) {
        if (existing.intervalMs === intervalMs) continue; // keep the existing timer
        clearHandles(existing);
        scheduled.delete(connectionId);
      }

      // Seed the local freshness marker from the DB row, but a drift reinstall CARRIES FORWARD the
      // replaced handle's marker when it is newer: the marker advances when a run is KICKED OFF,
      // while last_synced_at is stamped only when that run completes — resetting to the stale row
      // value would let the reinstalled catch-up tick start a SECOND concurrent syncConnection for
      // a row already in flight / past tolerance (review LOW fold).
      let lastSyncedAt = (row.last_synced_at ?? null) as Date | null;
      const carried = existing?.lastKickedAt ?? null;
      if (carried && (!lastSyncedAt || carried > lastSyncedAt)) lastSyncedAt = carried;

      const handles: Handles = { intervalMs, lastKickedAt: lastSyncedAt };

      // Today's body: skip while fresh, else advance the local marker and fire-and-forget the sync.
      const runIfStale = (): void => {
        if (!isStale(handles.lastKickedAt, toleranceSec)) return; // still fresh — skip this run
        // syncConnection never throws; fire-and-forget. Advance our local freshness marker so the
        // next tick's staleness check reflects the run we just kicked off.
        handles.lastKickedAt = new Date();
        void syncConnection(connectionId);
      };

      // Align the first tick to last_synced + interval (never-synced → now), then jitter the
      // catch-up. Overdue/never-synced → firstDelay ≈ jitter (prompt); fresh → the remaining time.
      // The same MAX_TIMER_DELAY_MS clamp applies here (a ceiling-clamped intervalMs + jitter would
      // otherwise nudge the delay back over the overflow line).
      const jitter = Math.random() * JITTER_MS;
      const firstDelay = Math.min(
        Math.max(0, (lastSyncedAt ? lastSyncedAt.getTime() + intervalMs : Date.now()) - Date.now()) +
          jitter,
        MAX_TIMER_DELAY_MS,
      );
      handles.timeout = setTimeout(() => {
        handles.timeout = undefined; // the initial timeout has fired; only the interval is live now
        runIfStale();
        handles.interval = setInterval(runIfStale, intervalMs);
      }, firstDelay);

      scheduled.set(connectionId, handles);
    }

    // Rows no longer active/error/syncing (revoked/deleted/paused) lose their timer(s).
    for (const [connectionId, handles] of scheduled) {
      if (seen.has(connectionId)) continue;
      clearHandles(handles);
      scheduled.delete(connectionId);
    }
  }

  await scan(); // initial pass — a DB failure here propagates (index.ts logs and continues)

  const rescan = setInterval(() => {
    void scan().catch(() => {
      // best-effort: a flaky DB read must not kill the re-scan loop — the next tick retries
    });
  }, RESCAN_INTERVAL_MS);

  return () => {
    clearInterval(rescan);
    for (const handles of scheduled.values()) clearHandles(handles);
    scheduled.clear();
  };
}

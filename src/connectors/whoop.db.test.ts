// WHOOP DB round-trip, gated on DATABASE_URL so CI stays green without a database.
//
// Drives the generic runner end-to-end (HTTP mocked with v2 fixtures) to prove a SINGLE sync()
// stream fans out across all three health tables via per-record routing (ADR 0005): one sleep row in
// health_sleep_sessions, one workout row in health_workouts, and five recovery metric rows in
// health_samples. Also proves: unit conversion lands in the columns while `raw` keeps native values;
// the global cursor advances; a re-run over the same window is idempotent (the overlap upsert absorbs
// it); and deletion is ACCEPTED-NONE (ADR 0004) — a source-removed item just stops being fetched, its
// cached row persists (never tombstoned, since the connector emits no deletion records).
//
// Skips cleanly when DATABASE_URL is absent (the headline behaviours are covered network-free in
// whoop.test.ts).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { WhoopConnector } from "./whoop.js";
import {
  SLEEP_SCORED,
  WORKOUT_SCORED,
  RECOVERY_SCORED,
  CYCLE_SCORED,
  CYCLE_UNSCORED,
  whoopPage,
} from "./whoop.fixtures.js";

const HAS_DB = !!process.env.DATABASE_URL;
// A DEDICATED throwaway user so this round-trip can't race other connector DB tests (test files run
// in parallel; all would otherwise contend the unique(user_id, provider) credential row).
const TEST_USER = "00000000-0000-0000-0000-0000000007f1";

// URL pathnames the connector hits (the "/developer" base prefix lands in url.pathname).
const P_SLEEP = "/developer/v2/activity/sleep";
const P_WORKOUT = "/developer/v2/activity/workout";
const P_RECOVERY = "/developer/v2/recovery";
const P_CYCLE = "/developer/v2/cycle";

interface Page {
  records: unknown[];
  next_token: string | null;
}

/** Mock fetch: serve one page per pathname (single-page; the runner needs no chaining here). */
function mockWhoop(pagesByPath: Record<string, Page>): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const page = pagesByPath[url.pathname] ?? { records: [], next_token: null };
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe.skipIf(!HAS_DB)("WHOOP DB round-trip (HTTP mocked)", () => {
  let connectionId: string;
  let credentialId: string;
  let secretRef: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    const { seal } = await import("../secrets/index.js");
    await pool.query(
      `insert into users (id, label) values ($1, 'whoop-db-test') on conflict (id) do nothing`,
      [TEST_USER],
    );

    // Seal a (dummy) access token at purpose 'access'; refresh_ref stays null so resolveAccessToken
    // opens it as-is (no network refresh). HTTP is mocked.
    secretRef = await seal({ userId: TEST_USER, provider: "whoop", purpose: "access" }, "fake-access-token");

    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, secret_ref, status)
       values ($1, 'whoop', 'first_party', $2, 'active') returning id`,
      [TEST_USER, secretRef],
    );
    credentialId = cred.rows[0].id as string;

    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'health', 'whoop', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;

    // Preset a recent cursor -> incremental (single window, single fetch per endpoint) for determinism.
    await pool.query(`update connectors set cursor = $2 where id = $1`, [
      connectionId,
      new Date(Date.now() - 3600_000).toISOString(),
    ]);
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: credential -> connectors -> health_sleep_sessions/health_workouts/health_samples.
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from secrets where ref = $1`, [secretRef]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("fans one stream into all 3 health tables; converts units; advances cursor; idempotent; accepted-none deletion", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, syncConnection } = await import("../sync/index.js");
    registerConnector(new WhoopConnector());

    mockWhoop({
      [P_SLEEP]: whoopPage([SLEEP_SCORED]),
      [P_WORKOUT]: whoopPage([WORKOUT_SCORED]),
      [P_RECOVERY]: whoopPage([RECOVERY_SCORED]),
      // A SCORED cycle (4 metric rows) + an UNSCORED cycle (0 rows — proves it's skipped).
      [P_CYCLE]: whoopPage([CYCLE_SCORED, CYCLE_UNSCORED]),
    });

    const res1 = await syncConnection(connectionId);
    expect(res1.ok).toBe(true);
    expect(res1.upserted).toBe(11); // 1 sleep + 1 workout + 5 recovery + 4 cycle (unscored cycle → 0)
    expect(res1.deleted).toBe(0);
    expect(res1.newCursor).not.toBeNull();

    // One row per table for sleep/workout; five metric rows in health_samples.
    const sleepCount = await pool.query(
      `select count(*)::int as n from health_sleep_sessions where connection_id = $1`,
      [connectionId],
    );
    const workoutCount = await pool.query(
      `select count(*)::int as n from health_workouts where connection_id = $1`,
      [connectionId],
    );
    const sampleCount = await pool.query(
      `select count(*)::int as n from health_samples where connection_id = $1`,
      [connectionId],
    );
    expect(sleepCount.rows[0].n).toBe(1);
    expect(workoutCount.rows[0].n).toBe(1);
    expect(sampleCount.rows[0].n).toBe(9); // 5 recovery + 4 cycle metric rows

    // Sleep: milli→seconds in the column; raw keeps native milliseconds.
    const sleep = await pool.query(
      `select time_in_bed_seconds, time_asleep_seconds, efficiency_pct, raw
         from health_sleep_sessions where connection_id = $1 and source_object_id = $2`,
      [connectionId, SLEEP_SCORED.id],
    );
    expect(Number(sleep.rows[0].time_in_bed_seconds)).toBe(28_800);
    expect(Number(sleep.rows[0].time_asleep_seconds)).toBe(27_000);
    expect(Number(sleep.rows[0].efficiency_pct)).toBe(92.5);
    expect(sleep.rows[0].raw.score.stage_summary.total_in_bed_time_milli).toBe(28_800_000);

    // Workout: kJ→kcal in the column; raw keeps native kilojoule; sport lowercased.
    const workout = await pool.query(
      `select sport, duration_seconds, energy_kcal, strain, raw
         from health_workouts where connection_id = $1 and source_object_id = $2`,
      [connectionId, WORKOUT_SCORED.id],
    );
    expect(workout.rows[0].sport).toBe("running");
    expect(Number(workout.rows[0].duration_seconds)).toBe(3_600);
    expect(Number(workout.rows[0].energy_kcal)).toBe(1_000);
    expect(Number(workout.rows[0].strain)).toBe(12.3);
    expect(workout.rows[0].raw.score.kilojoule).toBe(4184);

    // Recovery metric: composite key, correct unit, daily_total aggregation, created_at window.
    const hrv = await pool.query(
      `select value, unit, aggregation, source, window_start, window_end
         from health_samples where connection_id = $1 and source_object_id = 'recovery:12345:hrv_rmssd'`,
      [connectionId],
    );
    expect(Number(hrv.rows[0].value)).toBe(42.5);
    expect(hrv.rows[0].unit).toBe("ms");
    expect(hrv.rows[0].aggregation).toBe("daily_total");
    expect(hrv.rows[0].source).toBe("whoop");
    expect(hrv.rows[0].window_start).toEqual(hrv.rows[0].window_end);

    // Cycle day-strain: cycle: namespace, faithful strain value/unit, window = cycle's OWN [start, end].
    const strain = await pool.query(
      `select value, unit, aggregation, source, window_start, window_end
         from health_samples where connection_id = $1 and source_object_id = 'cycle:93845:day_strain'`,
      [connectionId],
    );
    expect(Number(strain.rows[0].value)).toBe(14.2);
    expect(strain.rows[0].unit).toBe("strain");
    expect(strain.rows[0].aggregation).toBe("daily_total");
    expect(strain.rows[0].source).toBe("whoop");
    expect(new Date(strain.rows[0].window_start).toISOString()).toBe(CYCLE_SCORED.start);
    expect(new Date(strain.rows[0].window_end).toISOString()).toBe(CYCLE_SCORED.end);
    // day_kilojoule kept faithful (kJ, not kcal).
    const kj = await pool.query(
      `select value, unit from health_samples
         where connection_id = $1 and source_object_id = 'cycle:93845:day_kilojoule'`,
      [connectionId],
    );
    expect(Number(kj.rows[0].value)).toBe(8368);
    expect(kj.rows[0].unit).toBe("kJ");
    // The UNSCORED cycle produced no rows.
    const unscored = await pool.query(
      `select count(*)::int as n from health_samples where connection_id = $1 and source_object_id like 'cycle:93846:%'`,
      [connectionId],
    );
    expect(unscored.rows[0].n).toBe(0);

    // Cursor advanced to an ISO timestamp; connection active + fresh.
    const c1 = await pool.query(
      `select cursor, status, last_synced_at from connectors where id = $1`,
      [connectionId],
    );
    expect(c1.rows[0].cursor).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(c1.rows[0].status).toBe("active");
    expect(c1.rows[0].last_synced_at).not.toBeNull();

    // Re-run over the overlapping window -> still exactly 1 + 1 + 5 (idempotent upsert).
    const res2 = await syncConnection(connectionId);
    expect(res2.ok).toBe(true);
    const sleepCount2 = await pool.query(
      `select count(*)::int as n from health_sleep_sessions where connection_id = $1`,
      [connectionId],
    );
    const workoutCount2 = await pool.query(
      `select count(*)::int as n from health_workouts where connection_id = $1`,
      [connectionId],
    );
    const sampleCount2 = await pool.query(
      `select count(*)::int as n from health_samples where connection_id = $1`,
      [connectionId],
    );
    expect(sleepCount2.rows[0].n).toBe(1);
    expect(workoutCount2.rows[0].n).toBe(1);
    expect(sampleCount2.rows[0].n).toBe(9); // still 5 recovery + 4 cycle (idempotent)

    // Deletion = ACCEPTED-NONE: the source now returns nothing (the item was removed upstream). The
    // connector emits NO deletion record, so the runner tombstones nothing — the cached row persists,
    // deleted_at stays null. (Webhook-driven tombstones are a later P3 enhancement.)
    mockWhoop({
      [P_SLEEP]: whoopPage([]),
      [P_WORKOUT]: whoopPage([]),
      [P_RECOVERY]: whoopPage([]),
      [P_CYCLE]: whoopPage([]),
    });
    const res3 = await syncConnection(connectionId);
    expect(res3.ok).toBe(true);
    expect(res3.upserted).toBe(0);
    expect(res3.deleted).toBe(0);

    const persisted = await pool.query(
      `select deleted_at from health_sleep_sessions where connection_id = $1 and source_object_id = $2`,
      [connectionId, SLEEP_SCORED.id],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0].deleted_at).toBeNull();
  });
});

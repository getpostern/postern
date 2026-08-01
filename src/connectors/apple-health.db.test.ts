// Apple Health DB round-trip, gated on DATABASE_URL so CI stays green without a database.
//
// Drives the generic runner's push path (ingestRecords) end-to-end with a real HAE fixture to prove a
// SINGLE decoded batch fans out across all three health tables via per-record routing (ADR 0005): the
// step_count + 3 heart-rate fan-out rows in health_samples, 2 rows in health_workouts, 1 row in
// health_sleep_sessions. Also proves: unit/date conversion lands in the columns while `raw` keeps the
// native HAE values; the synthetic source_object_ids are deterministic so an OVERLAPPING re-post upserts
// idempotently (no dupes); and a push leaves the connection 'active' (custody 'on_device', no secret).
//
// Skips cleanly when DATABASE_URL is absent (the headline behaviours are covered DB-free in the unit test).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AppleHealthConnector } from "./apple-health.js";
import {
  HAE_PAYLOAD,
  HR_WINDOW_ISO,
  STEP_WINDOW_ISO,
  SLEEP_START_ISO,
} from "./apple-health.fixtures.js";

const HAS_DB = !!process.env.DATABASE_URL;
// A DEDICATED throwaway user so this round-trip can't race other connector DB tests (test files run in
// parallel; all would otherwise contend the unique(user_id, provider) credential row).
const TEST_USER = "00000000-0000-0000-0000-0000000008b0";

describe.skipIf(!HAS_DB)("Apple Health DB round-trip (ingestRecords)", () => {
  let connectionId: string;
  let credentialId: string;

  beforeAll(async () => {
    const { pool } = await import("../db.js");
    await pool.query(
      `insert into users (id, label) values ($1, 'apple-health-db-test') on conflict (id) do nothing`,
      [TEST_USER],
    );
    // Apple Health has no upstream token — the credential is custody 'on_device' with NO secret_ref
    // (the per-connection webhook secret is the auth; ingestRecords never resolves a token).
    const cred = await pool.query(
      `insert into provider_credentials (user_id, provider, custody, status)
       values ($1, 'apple_health', 'on_device', 'active') returning id`,
      [TEST_USER],
    );
    credentialId = cred.rows[0].id as string;
    const conn = await pool.query(
      `insert into connectors (user_id, credential_id, sector, provider, status)
       values ($1, $2, 'health', 'apple_health', 'active') returning id`,
      [TEST_USER, credentialId],
    );
    connectionId = conn.rows[0].id as string;
  });

  afterAll(async () => {
    const { pool } = await import("../db.js");
    // FK cascade: credential -> connectors -> health_samples/health_workouts/health_sleep_sessions.
    await pool.query(`delete from provider_credentials where id = $1`, [credentialId]);
    await pool.query(`delete from users where id = $1`, [TEST_USER]);
    await pool.end();
  });

  it("fans one HAE batch into all 3 health tables; converts units; idempotent overlap re-post; stays active", async () => {
    const { pool } = await import("../db.js");
    const { registerConnector, ingestRecords } = await import("../sync/index.js");
    const connector = new AppleHealthConnector();
    registerConnector(connector);

    const records = connector.decodePush(HAE_PAYLOAD);
    const res1 = await ingestRecords(connectionId, records);
    expect(res1.ok).toBe(true);
    expect(res1.upserted).toBe(7); // 4 samples (3 hr + 1 step) + 2 workouts + 1 sleep
    expect(res1.deleted).toBe(0);

    const count = async (table: string) =>
      Number(
        (
          await pool.query(`select count(*)::int as n from ${table} where connection_id = $1`, [connectionId])
        ).rows[0].n,
      );
    expect(await count("health_samples")).toBe(4);
    expect(await count("health_workouts")).toBe(2);
    expect(await count("health_sleep_sessions")).toBe(1);

    // Sample: heart-rate fan-out lands with the synthetic id + daily_total aggregation; raw is native.
    const hrAvg = await pool.query(
      `select value, unit, aggregation, source, window_start, window_end, raw
         from health_samples where connection_id = $1 and source_object_id = $2`,
      [connectionId, `heart_rate_avg:${HR_WINDOW_ISO}`],
    );
    expect(Number(hrAvg.rows[0].value)).toBe(68);
    expect(hrAvg.rows[0].unit).toBe("count/min");
    expect(hrAvg.rows[0].aggregation).toBe("daily_total");
    expect(hrAvg.rows[0].source).toBe("apple_health");
    expect(hrAvg.rows[0].window_start).toEqual(hrAvg.rows[0].window_end);
    expect(hrAvg.rows[0].raw.Avg).toBe(68); // native HAE point preserved in raw

    const step = await pool.query(
      `select value, aggregation from health_samples where connection_id = $1 and source_object_id = $2`,
      [connectionId, `step_count:${STEP_WINDOW_ISO}`],
    );
    expect(Number(step.rows[0].value)).toBe(8432);
    expect(step.rows[0].aggregation).toBe("sample");

    // Workout: mi→meters, kJ→kcal in the columns; native kJ kept in raw.
    const wk = await pool.query(
      `select sport, duration_seconds, energy_kcal, distance_meters, avg_heart_rate, strain, raw
         from health_workouts where connection_id = $1 and source_object_id = 'AH-WK-0001'`,
      [connectionId],
    );
    expect(wk.rows[0].sport).toBe("running");
    expect(Number(wk.rows[0].duration_seconds)).toBe(3600);
    expect(Number(wk.rows[0].energy_kcal)).toBeCloseTo(500, 6);
    expect(Number(wk.rows[0].distance_meters)).toBeCloseTo(8046.7, 1);
    expect(Number(wk.rows[0].avg_heart_rate)).toBe(140);
    expect(wk.rows[0].strain).toBeNull();
    expect(wk.rows[0].raw.activeEnergyBurned.units).toBe("kJ");

    // Sleep: hours→seconds, efficiency derived.
    const sleep = await pool.query(
      `select time_in_bed_seconds, time_asleep_seconds, efficiency_pct, is_nap
         from health_sleep_sessions where connection_id = $1 and source_object_id = $2`,
      [connectionId, `sleep:${SLEEP_START_ISO}`],
    );
    expect(Number(sleep.rows[0].time_in_bed_seconds)).toBe(28_800);
    expect(Number(sleep.rows[0].time_asleep_seconds)).toBe(25_200);
    expect(Number(sleep.rows[0].efficiency_pct)).toBe(87.5);
    expect(sleep.rows[0].is_nap).toBeNull();

    // Re-post the SAME (overlapping) batch → idempotent on (connection_id, source_object_id): no dupes.
    const res2 = await ingestRecords(connectionId, connector.decodePush(HAE_PAYLOAD));
    expect(res2.ok).toBe(true);
    expect(await count("health_samples")).toBe(4);
    expect(await count("health_workouts")).toBe(2);
    expect(await count("health_sleep_sessions")).toBe(1);

    // The push leaves the connection active + fresh (never tombstones — HAE pushes present state only).
    const c = await pool.query(`select status, last_synced_at from connectors where id = $1`, [connectionId]);
    expect(c.rows[0].status).toBe("active");
    expect(c.rows[0].last_synced_at).not.toBeNull();
  });
});

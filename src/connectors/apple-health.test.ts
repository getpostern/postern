// Apple Health connector unit tests (pure — decodePush has no I/O). Covers: HAE → RawRecords across the
// three EXACT object strings; the heart-rate Min/Avg/Max fan-out; sleep_analysis → sleep_session;
// workouts → workout; deterministic synthetic source_object_ids (idempotent re-decode); unit + HAE-date
// conversions (hours→seconds, mi/km→meters, kJ→kcal); the read-only contract; and decodePush throwing a
// payload-free error on a malformed body.

import { describe, it, expect } from "vitest";
import {
  AppleHealthConnector,
  type HealthSampleRow,
  type WorkoutRow,
  type SleepSessionRow,
} from "./apple-health.js";
import {
  HAE_PAYLOAD,
  HR_WINDOW_ISO,
  STEP_WINDOW_ISO,
  SLEEP_START_ISO,
  SLEEP_END_ISO,
  WORKOUT1_START_ISO,
  WORKOUT1_END_ISO,
} from "./apple-health.fixtures.js";

const c = new AppleHealthConnector();

describe("AppleHealthConnector — decodePush object routing + fan-out", () => {
  it("turns one HAE payload into RawRecords across all 3 EXACT object strings; heart-rate fans to 3 rows", () => {
    const recs = c.decodePush(HAE_PAYLOAD);

    const samples = recs.filter((r) => r.object === "health_sample");
    const workouts = recs.filter((r) => r.object === "workout");
    const sleeps = recs.filter((r) => r.object === "sleep_session");

    // 3 heart-rate stat rows + 1 step_count qty row = 4 samples; 2 workouts; 1 sleep.
    expect(samples).toHaveLength(4);
    expect(workouts).toHaveLength(2);
    expect(sleeps).toHaveLength(1);

    const metricTypes = samples.map((r) => c.normalize(r) as HealthSampleRow).map((r) => r.metric_type).sort();
    expect(metricTypes).toEqual(["heart_rate_avg", "heart_rate_max", "heart_rate_min", "step_count"]);
  });

  it("strongKeys: workout {workout_id}, sleep {sleep_id}, sample {sample_id} — all the synthetic/native id", () => {
    const recs = c.decodePush(HAE_PAYLOAD);
    const workout = recs.find((r) => r.object === "workout")!;
    const sleep = recs.find((r) => r.object === "sleep_session")!;
    const sample = recs.find((r) => r.object === "health_sample")!;

    expect(c.strongKeys(workout)).toEqual({ workout_id: workout.externalId });
    expect(c.strongKeys(sleep)).toEqual({ sleep_id: sleep.externalId });
    expect(c.strongKeys(sample)).toEqual({ sample_id: sample.externalId });
  });
});

describe("AppleHealthConnector — sample normalizer (fan-out + units + dates)", () => {
  it("heart-rate Min/Avg/Max → _min/_avg/_max rows; daily_total; source apple_health; window from the HAE date", () => {
    const rows = c
      .decodePush(HAE_PAYLOAD)
      .filter((r) => r.object === "health_sample")
      .map((r) => c.normalize(r) as HealthSampleRow);
    const byMetric = new Map(rows.map((r) => [r.metric_type, r]));

    for (const m of ["heart_rate_min", "heart_rate_avg", "heart_rate_max"]) {
      const row = byMetric.get(m)!;
      expect(row.aggregation).toBe("daily_total");
      expect(row.unit).toBe("count/min");
      expect(row.source).toBe("apple_health");
      expect(row.window_start).toBe(HR_WINDOW_ISO);
      expect(row.window_end).toBe(HR_WINDOW_ISO);
      // deterministic synthetic id "<metric_type>:<window_start ISO>"
      expect(row.source_object_id).toBe(`${m}:${HR_WINDOW_ISO}`);
    }
    expect(byMetric.get("heart_rate_min")!.value).toBe(52);
    expect(byMetric.get("heart_rate_avg")!.value).toBe(68);
    expect(byMetric.get("heart_rate_max")!.value).toBe(142);
  });

  it("a bare qty metric → a single 'sample' row with the qty value", () => {
    const step = c
      .decodePush(HAE_PAYLOAD)
      .map((r) => c.normalize(r) as HealthSampleRow)
      .find((r) => r.metric_type === "step_count")!;
    expect(step.value).toBe(8432);
    expect(step.unit).toBe("count");
    expect(step.aggregation).toBe("sample");
    expect(step.window_start).toBe(STEP_WINDOW_ISO);
    expect(step.source_object_id).toBe(`step_count:${STEP_WINDOW_ISO}`);
  });
});

describe("AppleHealthConnector — sleep normalizer (hours→seconds, efficiency)", () => {
  it("sleep_analysis → sleep_session: hours→seconds, efficiency = asleep/inBed×100, is_nap/respiratory null", () => {
    const rec = c.decodePush(HAE_PAYLOAD).find((r) => r.object === "sleep_session")!;
    const sleep = c.normalize(rec) as SleepSessionRow;
    expect(sleep.source_object_id).toBe(`sleep:${SLEEP_START_ISO}`);
    expect(sleep.started_at).toBe(SLEEP_START_ISO);
    expect(sleep.ended_at).toBe(SLEEP_END_ISO);
    expect(sleep.time_in_bed_seconds).toBe(28_800); // 8h
    expect(sleep.time_asleep_seconds).toBe(25_200); // 7h
    expect(sleep.efficiency_pct).toBe(87.5); // 7/8 × 100
    expect(sleep.is_nap).toBeNull();
    expect(sleep.respiratory_rate).toBeNull();
  });
});

describe("AppleHealthConnector — workout normalizer (mi/km→meters, kJ/kcal, hr)", () => {
  it("workout #1 (mi + kJ): native id; sport lowercased; mi→meters; kJ→kcal; hr avg/max; strain null", () => {
    const rec = c.decodePush(HAE_PAYLOAD).find((r) => r.object === "workout" && r.externalId === "AH-WK-0001")!;
    const w = c.normalize(rec) as WorkoutRow;
    expect(w.source_object_id).toBe("AH-WK-0001");
    expect(w.sport).toBe("running");
    expect(w.started_at).toBe(WORKOUT1_START_ISO);
    expect(w.ended_at).toBe(WORKOUT1_END_ISO);
    expect(w.duration_seconds).toBe(3600);
    expect(w.distance_meters).toBeCloseTo(8046.7, 1); // 5 mi × 1609.34
    expect(w.energy_kcal).toBeCloseTo(500, 6); // 2092 kJ ÷ 4.184
    expect(w.avg_heart_rate).toBe(140);
    expect(w.max_heart_rate).toBe(175);
    expect(w.strain).toBeNull();
  });

  it("workout #2 (km + kcal): km→meters exactly; kcal passes through unconverted", () => {
    const rec = c.decodePush(HAE_PAYLOAD).find((r) => r.object === "workout" && r.externalId === "AH-WK-0002")!;
    const w = c.normalize(rec) as WorkoutRow;
    expect(w.sport).toBe("cycling");
    expect(w.distance_meters).toBe(20_000); // 20 km × 1000
    expect(w.energy_kcal).toBe(600); // already kcal — no conversion
  });
});

describe("AppleHealthConnector — idempotent synthetic ids", () => {
  it("re-decoding the SAME payload yields the SAME source_object_ids (deterministic → idempotent upsert)", () => {
    const ids = (p: unknown) =>
      c
        .decodePush(p)
        .map((r) => {
          const n = c.normalize(r) as { source_object_id: string };
          return n.source_object_id;
        })
        .sort();
    expect(ids(HAE_PAYLOAD)).toEqual(ids(HAE_PAYLOAD));
  });
});

describe("AppleHealthConnector — read-only contract", () => {
  it("declares push policy, no actions, and execute() throws", async () => {
    expect(c.provider).toBe("apple_health");
    expect(c.sector).toBe("health");
    expect(c.policy.mode).toBe("push");
    expect(c.policy.pushKind).toBe("webhook"); // #41: the Console's "Device controlled" caption word
    expect(c.actions).toEqual([]);
    await expect(c.execute()).rejects.toThrow(/no actions/i);
  });

  it("sync() yields nothing (push source, never pulled)", async () => {
    const out: unknown[] = [];
    for await (const r of c.sync({
      userId: "u",
      connectionId: "conn",
      secretRef: null,
    })) {
      out.push(r);
    }
    expect(out).toEqual([]);
  });
});

describe("AppleHealthConnector — malformed payload throws (payload-free)", () => {
  it("a non-object body / missing data object throws; a well-formed empty payload returns []", () => {
    expect(() => c.decodePush("not-an-object")).toThrow();
    expect(() => c.decodePush(null)).toThrow();
    expect(() => c.decodePush({ data: 5 })).toThrow();
    expect(() => c.decodePush({})).toThrow();
    // A well-formed but empty payload is valid → no records, no throw.
    expect(c.decodePush({ data: {} })).toEqual([]);
    expect(c.decodePush({ data: { metrics: [], workouts: [] } })).toEqual([]);
  });

  it("the thrown message never echoes the payload", () => {
    let msg = "";
    try {
      c.decodePush({ data: 5, secretish: "SHOULD-NOT-APPEAR" });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).not.toContain("SHOULD-NOT-APPEAR");
  });
});

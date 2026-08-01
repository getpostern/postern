// WHOOP connector unit tests (network-free — globalThis.fetch is mocked with v2 fixtures).
// Covers: object routing + the three normalizers, unit conversions (milli→s, kJ→kcal), the
// score_state guard (null, never 0), recovery fan-out (one row per metric), the overlap-window
// cursor (30d backfill / cursor−3d incremental, one global cursor per run), next_token paging to
// exhaustion, and the read-only contract (no actions; execute throws; token never leaks).

import { describe, it, expect, afterEach, vi } from "vitest";
import type { RawRecord, SyncContext } from "./types.js";
import {
  WhoopConnector,
  type SleepSessionRow,
  type WorkoutRow,
  type HealthSampleRow,
} from "./whoop.js";
import {
  SLEEP_SCORED,
  SLEEP_SCORED_PAGE2,
  SLEEP_PENDING,
  WORKOUT_SCORED,
  WORKOUT_UNSCORABLE,
  RECOVERY_SCORED,
  RECOVERY_NO_SPO2,
  CYCLE_SCORED,
  CYCLE_UNSCORED,
  whoopPage,
} from "./whoop.fixtures.js";

const DAY_MS = 86_400_000;

// URL pathnames (note the "/developer" base prefix lands in url.pathname).
const P_SLEEP = "/developer/v2/activity/sleep";
const P_WORKOUT = "/developer/v2/activity/workout";
const P_RECOVERY = "/developer/v2/recovery";
const P_CYCLE = "/developer/v2/cycle";

interface Page {
  records: unknown[];
  next_token: string | null;
}
interface Captured {
  path: string;
  url: URL;
  authorization: unknown;
  nextToken: string | null;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/**
 * Install a fetch mock that serves pages per pathname. For a path with [P0,P1,...]: P0 is served when
 * `nextToken` is absent; thereafter the page whose predecessor's next_token === the incoming token.
 * Returns the captured-call log (path, url, Authorization header, nextToken).
 */
function installFetch(pagesByPath: Record<string, Page[]>): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const headers = (init as { headers?: Record<string, unknown> } | undefined)?.headers ?? {};
    const nextToken = url.searchParams.get("nextToken");
    calls.push({ path: url.pathname, url, authorization: headers.Authorization, nextToken });

    const pages = pagesByPath[url.pathname] ?? [];
    let page: Page;
    if (nextToken == null) {
      page = pages[0] ?? { records: [], next_token: null };
    } else {
      const idx = pages.findIndex((_p, i) => i > 0 && pages[i - 1].next_token === nextToken);
      page = idx >= 0 ? pages[idx] : { records: [], next_token: null };
    }
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

function ctx(secret = "tok", cursor?: string): SyncContext {
  return {
    userId: "00000000-0000-0000-0000-000000000001",
    connectionId: "00000000-0000-0000-0000-0000000000aa",
    secretRef: null,
    secret,
    cursor,
  };
}

async function collect(c: WhoopConnector, c0: SyncContext): Promise<RawRecord[]> {
  const recs: RawRecord[] = [];
  for await (const r of c.sync(c0)) recs.push(r);
  return recs;
}

describe("WhoopConnector — object routing + multi-object fan-out", () => {
  it("one sync() stream yields the three EXACT object strings; recovery fans to 5 metric rows", async () => {
    const calls = installFetch({
      [P_SLEEP]: [whoopPage([SLEEP_SCORED])],
      [P_WORKOUT]: [whoopPage([WORKOUT_SCORED])],
      [P_RECOVERY]: [whoopPage([RECOVERY_SCORED])],
    });
    const recs = await collect(new WhoopConnector(), ctx());

    expect(recs.filter((r) => r.object === "sleep_session")).toHaveLength(1);
    expect(recs.filter((r) => r.object === "workout")).toHaveLength(1);
    expect(recs.filter((r) => r.object === "health_sample")).toHaveLength(5); // 5 metrics

    // The bearer rides the Authorization header (positive check; the negative-leak check is below).
    expect(calls[0].authorization).toBe("Bearer tok");
  });

  it("strongKeys: sleep {sleep_id}, workout {workout_id}, recovery {cycle_id, sleep_id}", async () => {
    installFetch({
      [P_SLEEP]: [whoopPage([SLEEP_SCORED])],
      [P_WORKOUT]: [whoopPage([WORKOUT_SCORED])],
      [P_RECOVERY]: [whoopPage([RECOVERY_SCORED])],
    });
    const c = new WhoopConnector();
    const recs = await collect(c, ctx());

    const sleep = recs.find((r) => r.object === "sleep_session")!;
    const workout = recs.find((r) => r.object === "workout")!;
    const recovery = recs.find((r) => r.object === "health_sample")!;

    expect(c.strongKeys(sleep)).toEqual({ sleep_id: SLEEP_SCORED.id });
    expect(c.strongKeys(workout)).toEqual({ workout_id: WORKOUT_SCORED.id });
    expect(c.strongKeys(recovery)).toEqual({
      cycle_id: "12345",
      sleep_id: RECOVERY_SCORED.sleep_id,
    });
  });
});

describe("WhoopConnector — recovery normalizer", () => {
  it("fans into one health_sample per metric: ids, units, values, daily_total, created_at window", async () => {
    installFetch({ [P_RECOVERY]: [whoopPage([RECOVERY_SCORED])] });
    const c = new WhoopConnector();
    const recs = await collect(c, ctx());
    const rows = recs
      .filter((r) => r.object === "health_sample")
      .map((r) => c.normalize(r) as HealthSampleRow);
    const byMetric = new Map(rows.map((r) => [r.metric_type, r]));

    for (const r of rows) {
      expect(r.aggregation).toBe("daily_total");
      expect(r.source).toBe("whoop");
      expect(r.window_start).toBe(RECOVERY_SCORED.created_at);
      expect(r.window_end).toBe(RECOVERY_SCORED.created_at);
    }

    expect(byMetric.get("recovery_score")).toMatchObject({
      source_object_id: "recovery:12345:recovery_score",
      value: 66,
      unit: "%",
    });
    expect(byMetric.get("resting_heart_rate")).toMatchObject({
      source_object_id: "recovery:12345:resting_heart_rate",
      value: 55,
      unit: "count/min",
    });
    expect(byMetric.get("hrv_rmssd")).toMatchObject({
      source_object_id: "recovery:12345:hrv_rmssd",
      value: 42.5,
      unit: "ms",
    });
    expect(byMetric.get("spo2")).toMatchObject({ value: 97.2, unit: "%" });
    expect(byMetric.get("skin_temperature")).toMatchObject({ value: 33.5, unit: "Cel" });
  });

  it("3.0 strap: spo2 + skin_temperature rows exist with value null (not dropped)", async () => {
    installFetch({ [P_RECOVERY]: [whoopPage([RECOVERY_NO_SPO2])] });
    const c = new WhoopConnector();
    const recs = await collect(c, ctx());
    const rows = recs
      .filter((r) => r.object === "health_sample")
      .map((r) => c.normalize(r) as HealthSampleRow);
    const byMetric = new Map(rows.map((r) => [r.metric_type, r]));

    expect(rows).toHaveLength(5);
    expect(byMetric.get("recovery_score")?.value).toBe(71);
    expect(byMetric.get("resting_heart_rate")?.value).toBe(52);
    expect(byMetric.get("hrv_rmssd")?.value).toBe(55.0);
    expect(byMetric.get("spo2")?.value).toBeNull();
    expect(byMetric.get("skin_temperature")?.value).toBeNull();
  });
});

describe("WhoopConnector — cycle (day-strain) projection", () => {
  it("a SCORED cycle fans into exactly 4 health_sample rows: metric_types/units/window/soid namespace", async () => {
    installFetch({ [P_CYCLE]: [whoopPage([CYCLE_SCORED])] });
    const c = new WhoopConnector();
    const recs = await collect(c, ctx());

    const cycleRecs = recs.filter((r) => r.object === "health_sample");
    expect(cycleRecs).toHaveLength(4);
    // All four sit in the cycle: namespace (never collide with recovery:).
    for (const r of cycleRecs) {
      expect(String(r.externalId)).toMatch(/^cycle:93845:/);
    }

    const rows = cycleRecs.map((r) => c.normalize(r) as HealthSampleRow);
    const byMetric = new Map(rows.map((r) => [r.metric_type, r]));

    // Window is the cycle's OWN [start, end] (a cycle is a time period, unlike recovery's point time).
    for (const r of rows) {
      expect(r.aggregation).toBe("daily_total");
      expect(r.source).toBe("whoop");
      expect(r.window_start).toBe(CYCLE_SCORED.start);
      expect(r.window_end).toBe(CYCLE_SCORED.end);
    }

    expect(byMetric.get("day_strain")).toMatchObject({
      source_object_id: "cycle:93845:day_strain",
      value: 14.2,
      unit: "strain",
    });
    expect(byMetric.get("day_average_heart_rate")).toMatchObject({
      source_object_id: "cycle:93845:day_average_heart_rate",
      value: 72,
      unit: "bpm",
    });
    expect(byMetric.get("day_max_heart_rate")).toMatchObject({
      source_object_id: "cycle:93845:day_max_heart_rate",
      value: 165,
      unit: "bpm",
    });
    expect(byMetric.get("day_kilojoule")).toMatchObject({
      source_object_id: "cycle:93845:day_kilojoule",
      value: 8368, // faithful kJ (agent converts to kcal ÷4.184 at query time)
      unit: "kJ",
    });

    // strongKeys for a cycle metric: {cycle_id, metric_type}.
    expect(c.strongKeys(cycleRecs.find((r) => String(r.externalId).endsWith("day_strain"))!)).toEqual({
      cycle_id: "93845",
      metric_type: "day_strain",
    });
    // raw stays lossless (native score kept).
    expect((cycleRecs[0].raw as { score: { strain: number } }).score.strain).toBe(14.2);
  });

  it("an UNSCORED (PENDING_SCORE) cycle yields NO rows (skipped silently, no error)", async () => {
    installFetch({ [P_CYCLE]: [whoopPage([CYCLE_UNSCORED])] });
    const c = new WhoopConnector();
    const recs = await collect(c, ctx());
    expect(recs.filter((r) => r.object === "health_sample")).toHaveLength(0);
  });

  it("cycle and recovery coexist in health_sample without soid collision (recovery: vs cycle:)", async () => {
    installFetch({
      [P_RECOVERY]: [whoopPage([RECOVERY_SCORED])],
      [P_CYCLE]: [whoopPage([CYCLE_SCORED])],
    });
    const c = new WhoopConnector();
    const recs = await collect(c, ctx());
    const rows = recs
      .filter((r) => r.object === "health_sample")
      .map((r) => c.normalize(r) as HealthSampleRow);
    // 5 recovery metrics + 4 cycle metrics, all distinct source_object_ids.
    expect(rows).toHaveLength(9);
    const soids = rows.map((r) => r.source_object_id);
    expect(new Set(soids).size).toBe(9);
    expect(soids.filter((s) => s.startsWith("recovery:"))).toHaveLength(5);
    expect(soids.filter((s) => s.startsWith("cycle:"))).toHaveLength(4);
  });

  it("cycle is fetched paged + windowed like the other endpoints (limit=25, window params)", async () => {
    const calls = installFetch({ [P_CYCLE]: [whoopPage([CYCLE_SCORED])] });
    await collect(new WhoopConnector(), ctx());
    const cycleCall = calls.find((call) => call.path === P_CYCLE)!;
    expect(cycleCall).toBeDefined();
    expect(cycleCall.url.searchParams.get("limit")).toBe("25");
    expect(cycleCall.url.searchParams.get("start")).toBeTruthy();
    expect(cycleCall.url.searchParams.get("end")).toBeTruthy();
  });
});

describe("WhoopConnector — unit conversion + score-state guard", () => {
  it("sleep: milli→seconds; workout: kJ→kcal + derived duration; raw keeps native values", async () => {
    installFetch({
      [P_SLEEP]: [whoopPage([SLEEP_SCORED])],
      [P_WORKOUT]: [whoopPage([WORKOUT_SCORED])],
    });
    const c = new WhoopConnector();
    const recs = await collect(c, ctx());

    const sleepRec = recs.find((r) => r.object === "sleep_session")!;
    const sleep = c.normalize(sleepRec) as SleepSessionRow;
    expect(sleep.time_in_bed_seconds).toBe(28_800); // 28_800_000 / 1000
    expect(sleep.time_asleep_seconds).toBe(27_000); // (28_800_000 − 1_800_000) / 1000
    expect(sleep.efficiency_pct).toBe(92.5);
    expect(sleep.respiratory_rate).toBe(15.7);
    expect(sleep.is_nap).toBe(false);
    expect(sleep.started_at).toBe(SLEEP_SCORED.start);
    // raw keeps the native milliseconds (lossless).
    expect((sleepRec.raw as typeof SLEEP_SCORED).score.stage_summary.total_in_bed_time_milli).toBe(
      28_800_000,
    );

    const workoutRec = recs.find((r) => r.object === "workout")!;
    const workout = c.normalize(workoutRec) as WorkoutRow;
    expect(workout.duration_seconds).toBe(3_600); // 06:00 → 07:00
    expect(workout.energy_kcal).toBe(1_000); // 4184 / 4.184
    expect(workout.distance_meters).toBe(5_000);
    expect(workout.avg_heart_rate).toBe(140);
    expect(workout.max_heart_rate).toBe(175);
    expect(workout.strain).toBe(12.3);
    expect(workout.sport).toBe("running"); // sport_name lowercased
    // raw keeps native kilojoule.
    expect((workoutRec.raw as typeof WORKOUT_SCORED).score.kilojoule).toBe(4184);
  });

  it("score_state != SCORED → score columns null (not 0); non-score columns still land", async () => {
    installFetch({
      [P_SLEEP]: [whoopPage([SLEEP_PENDING])],
      [P_WORKOUT]: [whoopPage([WORKOUT_UNSCORABLE])],
    });
    const c = new WhoopConnector();
    const recs = await collect(c, ctx());

    const sleep = c.normalize(recs.find((r) => r.object === "sleep_session")!) as SleepSessionRow;
    expect(sleep.time_in_bed_seconds).toBeNull();
    expect(sleep.time_asleep_seconds).toBeNull();
    expect(sleep.efficiency_pct).toBeNull();
    expect(sleep.respiratory_rate).toBeNull();
    // Non-score fields still present.
    expect(sleep.started_at).toBe(SLEEP_PENDING.start);
    expect(sleep.ended_at).toBe(SLEEP_PENDING.end);
    expect(sleep.is_nap).toBe(true);

    const workout = c.normalize(recs.find((r) => r.object === "workout")!) as WorkoutRow;
    expect(workout.energy_kcal).toBeNull();
    expect(workout.distance_meters).toBeNull();
    expect(workout.avg_heart_rate).toBeNull();
    expect(workout.max_heart_rate).toBeNull();
    expect(workout.strain).toBeNull();
    // duration_seconds derives from start/end, not score → still present.
    expect(workout.duration_seconds).toBe(1_800); // 18:00 → 18:30
    expect(workout.sport).toBe("walking");
  });
});

describe("WhoopConnector — overlap-window cursor", () => {
  it("first run (no cursor) backfills ~30 days; one global window-end cursor on every record", async () => {
    const before = Date.now();
    const calls = installFetch({
      [P_SLEEP]: [whoopPage([SLEEP_SCORED])],
      [P_RECOVERY]: [whoopPage([RECOVERY_SCORED])],
    });
    const recs = await collect(new WhoopConnector(), ctx());
    const after = Date.now();

    const start = Date.parse(calls[0].url.searchParams.get("start")!);
    const end = Date.parse(calls[0].url.searchParams.get("end")!);
    // end ≈ now; start ≈ now − 30d (tolerance covers the in-test clock advance).
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(after);
    expect(start).toBeGreaterThanOrEqual(before - 30 * DAY_MS - 1000);
    expect(start).toBeLessThanOrEqual(after - 30 * DAY_MS + 1000);
    expect(calls[0].url.searchParams.get("limit")).toBe("25");

    // Single global cursor (= window end ISO) on every record, advanced once per run.
    const cursors = new Set(recs.map((r) => r.cursor));
    expect(cursors.size).toBe(1);
    expect([...cursors][0]).toBe(calls[0].url.searchParams.get("end"));
  });

  it("incremental: start = cursor − 3 days; end ≈ now", async () => {
    const cursorIso = "2026-06-01T00:00:00.000Z";
    const before = Date.now();
    const calls = installFetch({ [P_SLEEP]: [whoopPage([SLEEP_SCORED])] });
    await collect(new WhoopConnector(), ctx("tok", cursorIso));
    const after = Date.now();

    const start = Date.parse(calls[0].url.searchParams.get("start")!);
    const end = Date.parse(calls[0].url.searchParams.get("end")!);
    expect(start).toBe(Date.parse(cursorIso) - 3 * DAY_MS);
    expect(end).toBeGreaterThanOrEqual(before);
    expect(end).toBeLessThanOrEqual(after);
  });
});

describe("WhoopConnector — paging", () => {
  it("follows next_token to exhaustion (≥2 pages collected; 2 sleep fetches)", async () => {
    const calls = installFetch({
      [P_SLEEP]: [whoopPage([SLEEP_SCORED], "PAGE2"), whoopPage([SLEEP_SCORED_PAGE2], null)],
    });
    const recs = await collect(new WhoopConnector(), ctx());

    const sleep = recs.filter((r) => r.object === "sleep_session");
    expect(sleep).toHaveLength(2);
    expect(sleep.map((r) => r.externalId).sort()).toEqual(
      [SLEEP_SCORED.id, SLEEP_SCORED_PAGE2.id].sort(),
    );

    const sleepCalls = calls.filter((c) => c.path === P_SLEEP);
    expect(sleepCalls).toHaveLength(2);
    expect(sleepCalls[0].nextToken).toBeNull();
    expect(sleepCalls[1].nextToken).toBe("PAGE2");
  });
});

describe("WhoopConnector — read-only contract + secret hygiene", () => {
  it("declares no actions and execute() throws", async () => {
    const c = new WhoopConnector();
    expect(c.actions).toEqual([]);
    expect(c.provider).toBe("whoop");
    expect(c.sector).toBe("health");
    await expect(c.execute()).rejects.toThrow(/no actions/i);
  });

  it("never leaks the bearer token in an error (network failure)", async () => {
    const TOKEN = "WHOOP-SECRET-abc123";
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;
    const c = new WhoopConnector();
    await expect(collect(c, ctx(TOKEN))).rejects.toThrow(
      /^whoop: fetch \/v2\/activity\/sleep failed$/,
    );
    await expect(collect(c, ctx(TOKEN))).rejects.not.toThrow(new RegExp(TOKEN));
  });

  it("never leaks the bearer token in an error (non-2xx); reports status only", async () => {
    const TOKEN = "WHOOP-SECRET-abc123";
    globalThis.fetch = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof globalThis.fetch;
    const c = new WhoopConnector();
    let message = "";
    try {
      await collect(c, ctx(TOKEN));
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toBe("whoop: /v2/activity/sleep returned 401");
    expect(message).not.toContain(TOKEN);
  });

  it("throws cleanly (no token) when ctx.secret is missing", async () => {
    const c = new WhoopConnector();
    await expect(collect(c, ctx(""))).rejects.toThrow(/missing access token/);
  });
});

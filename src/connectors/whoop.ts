// WHOOP health connector — read-only over the WHOOP v2 API. Single sector (health), multi-object:
// one sync() stream fans out across three domain tables via RawRecord.object (ADR 0005, the SimpleFIN
// pattern): sleep → health_sleep_sessions, workout → health_workouts, recovery + cycle →
// health_samples (tall metric rows, one per metric). The runner routes each record by its EXACT
// REGISTRY `object` string and idempotently upserts on (connection_id, source_object_id).
//
// Recovery and the physiological CYCLE (day-strain) BOTH project into health_samples (object string
// "health_sample"); they share no source_object_id (recovery:{cycle_id}:… vs cycle:{id}:…) and the
// normalizer discriminates them by a threaded `__pci_ns` marker on the raw.
//
// API v2 ONLY (v1 was removed 2025-10-01). Base https://api.prod.whoop.com/developer. The runner
// resolves + refreshes the OAuth bearer (ADR 0006) and hands it in ctx.secret — we NEVER refresh
// here. Overlap-window incremental cursor (no updated-since upstream); bounded → cached in full.
// Deletions are ACCEPTED-NONE (ADR 0004): v2 signals deletes only via webhooks, which V0 lacks, so a
// removed item simply stops being re-fetched — we never tombstone WHOOP rows.
//
// SECURITY: ctx.secret is the bearer access token — it is NEVER logged and NEVER appears in an error
// message. Every fetch failure throws a clean error carrying only the path + HTTP status.

import type {
  Connector,
  RawRecord,
  SyncContext,
  SyncPolicy,
  ActionSpec,
  ActionResult,
} from "./types.js";

// ── Endpoint / windowing constants ──────────────────────────────────────────────
const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";
const SLEEP_PATH = "/v2/activity/sleep";
const WORKOUT_PATH = "/v2/activity/workout";
const RECOVERY_PATH = "/v2/recovery";
const CYCLE_PATH = "/v2/cycle";
const PAGE_LIMIT = 25; // upstream max per page
const DAY_MS = 86_400_000;
const BACKFILL_MS = 30 * DAY_MS; // first sync backfills 30 days
const OVERLAP_MS = 3 * DAY_MS; // incremental re-pulls a 3-day overlap (absorbs late-scored items)
const KJ_PER_KCAL = 4.184; // kilojoule → kcal divisor

// ── EXACT REGISTRY `object` strings (tableForObject matches RawRecord.object against the entry's
//    `object` field — asymmetric, NB recovery is "health_sample" NOT "sample"). ───────────────────
const OBJ_SLEEP = "sleep_session"; // → health_sleep_sessions
const OBJ_WORKOUT = "workout"; // → health_workouts
const OBJ_RECOVERY = "health_sample"; // → health_samples
const OBJ_CYCLE = "health_sample"; // → health_samples (same table as recovery; discriminated by __pci_ns)

// ── Normalized row shapes (match the REGISTRY scalar columns; never id/raw — the runner adds those) ─

/** Normalized sleep row (matches health_sleep_sessions). */
export interface SleepSessionRow {
  source_object_id: string;
  started_at: string | null;
  ended_at: string | null;
  is_nap: boolean | null;
  time_asleep_seconds: number | null;
  time_in_bed_seconds: number | null;
  efficiency_pct: number | null;
  respiratory_rate: number | null;
}

/** Normalized workout row (matches health_workouts). */
export interface WorkoutRow {
  source_object_id: string;
  sport: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  energy_kcal: number | null;
  distance_meters: number | null;
  avg_heart_rate: number | null;
  max_heart_rate: number | null;
  strain: number | null;
}

/** Normalized recovery metric row (matches health_samples) — one per metric. */
export interface HealthSampleRow {
  source_object_id: string;
  metric_type: string;
  value: number | null;
  unit: string;
  aggregation: string;
  window_start: string | null;
  window_end: string | null;
  source: string;
}

// ── WHOOP v2 raw shapes — the subset we read, parsed defensively ──────────────────
/** A v2 collection page: `{ records, next_token }`. */
interface WhoopPage<T> {
  records?: T[];
  next_token?: string | null;
}

interface SleepStageSummary {
  total_in_bed_time_milli?: number;
  total_awake_time_milli?: number;
  [k: string]: unknown;
}
interface SleepScore {
  stage_summary?: SleepStageSummary;
  sleep_efficiency_percentage?: number;
  respiratory_rate?: number;
  [k: string]: unknown;
}
interface WhoopSleep {
  id: string;
  start?: string;
  end?: string;
  nap?: boolean;
  score_state?: string;
  score?: SleepScore | null;
  [k: string]: unknown;
}

interface WorkoutScore {
  kilojoule?: number;
  distance_meter?: number;
  average_heart_rate?: number;
  max_heart_rate?: number;
  strain?: number;
  [k: string]: unknown;
}
interface WhoopWorkout {
  id: string;
  start?: string;
  end?: string;
  sport_name?: string;
  sport_id?: number;
  score_state?: string;
  score?: WorkoutScore | null;
  [k: string]: unknown;
}

interface RecoveryScore {
  recovery_score?: number;
  resting_heart_rate?: number;
  hrv_rmssd_milli?: number;
  spo2_percentage?: number;
  skin_temp_celsius?: number;
  [k: string]: unknown;
}
interface WhoopRecovery {
  cycle_id?: number;
  sleep_id?: string;
  created_at?: string;
  score_state?: string;
  score?: RecoveryScore | null;
  [k: string]: unknown;
}

/** A recovery metric projection threaded onto the raw so normalize() stays a pure single-record fn. */
interface RecoveryMetric {
  metric_type: string;
  value: number | null;
  unit: string;
}
/** The recovery raw we hand to normalize(): the native v2 recovery payload (lossless) + the metric. */
type RecoveryRaw = WhoopRecovery & { __pci_metric: RecoveryMetric };

// ── v2 physiological cycle (day-strain). Scored only when score_state === "SCORED". ────────────────
interface CycleScore {
  strain?: number;
  kilojoule?: number;
  average_heart_rate?: number;
  max_heart_rate?: number;
  [k: string]: unknown;
}
interface WhoopCycle {
  id: string | number;
  start?: string;
  end?: string;
  score_state?: string;
  score?: CycleScore | null;
  [k: string]: unknown;
}

/** A cycle metric projection threaded onto the raw (same idiom as RecoveryMetric). */
interface CycleMetric {
  metric_type: string;
  value: number | null;
  unit: string;
}
/**
 * The cycle raw we hand to normalize(): the native v2 cycle payload (lossless) + the metric + a `__pci_ns`
 * discriminator (cycle and recovery share the "health_sample" object string, so normalize() branches on it).
 */
type CycleRaw = WhoopCycle & { __pci_metric: CycleMetric; __pci_ns: "cycle" };

/** True when a health_sample raw is a cycle projection (vs a recovery one). */
function isCycleRaw(raw: unknown): raw is CycleRaw {
  return typeof raw === "object" && raw != null && (raw as { __pci_ns?: unknown }).__pci_ns === "cycle";
}

/**
 * The cycle metric table: each (metric_type, unit, source score field). A SCORED cycle fans into four
 * health_samples rows. Units are faithful — kJ (not kcal); the agent converts to kcal (÷4.184) at query.
 */
const CYCLE_METRICS: ReadonlyArray<{
  metric_type: string;
  unit: string;
  field: keyof CycleScore;
}> = [
  { metric_type: "day_strain", unit: "strain", field: "strain" },
  { metric_type: "day_average_heart_rate", unit: "bpm", field: "average_heart_rate" },
  { metric_type: "day_max_heart_rate", unit: "bpm", field: "max_heart_rate" },
  { metric_type: "day_kilojoule", unit: "kJ", field: "kilojoule" },
];

/**
 * The recovery metric table: each (metric_type, unit, source score field). Recovery fans into one
 * health_samples row per entry. spo2/skin_temperature are 4.0-strap only (null on the 3.0 strap).
 */
const RECOVERY_METRICS: ReadonlyArray<{
  metric_type: string;
  unit: string;
  field: keyof RecoveryScore;
}> = [
  { metric_type: "recovery_score", unit: "%", field: "recovery_score" },
  { metric_type: "resting_heart_rate", unit: "count/min", field: "resting_heart_rate" },
  { metric_type: "hrv_rmssd", unit: "ms", field: "hrv_rmssd_milli" },
  { metric_type: "spo2", unit: "%", field: "spo2_percentage" },
  { metric_type: "skin_temperature", unit: "Cel", field: "skin_temp_celsius" },
];

/** A finite number passes through; everything else (undefined/null/NaN/non-number) → null. */
function numericOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Parse the stored cursor (the last window-end ISO) to epoch ms; null/empty/invalid → NaN. */
function parseCursorMs(cursor: string | undefined): number {
  if (cursor == null || cursor === "") return NaN;
  const ms = Date.parse(cursor);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * GET one page of a v2 collection over the window. The bearer rides the Authorization header (never
 * logged); the page token rides the `nextToken` query param; the response carries `next_token`. On
 * network/non-2xx failure throws a secret-free error (path + status only — never the token).
 */
async function fetchPage<T>(
  token: string,
  path: string,
  start: string,
  end: string,
  nextToken: string | undefined,
): Promise<WhoopPage<T>> {
  const url = new URL(`${WHOOP_API_BASE}${path}`);
  url.searchParams.set("start", start);
  url.searchParams.set("end", end);
  url.searchParams.set("limit", String(PAGE_LIMIT));
  if (nextToken) url.searchParams.set("nextToken", nextToken);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch {
    throw new Error(`whoop: fetch ${path} failed`);
  }
  if (!resp.ok) throw new Error(`whoop: ${path} returned ${resp.status}`);
  return (await resp.json()) as WhoopPage<T>;
}

/** Page one endpoint to exhaustion within the window: follow `next_token` until it's absent. */
async function* fetchAll<T>(
  token: string,
  path: string,
  start: string,
  end: string,
): AsyncIterable<T> {
  let nextToken: string | undefined;
  do {
    const page = await fetchPage<T>(token, path, start, end, nextToken);
    for (const rec of page.records ?? []) yield rec;
    nextToken = page.next_token ?? undefined;
  } while (nextToken);
}

/** WHOOP connector (health, read-only). Multi-object: yields sleep + workout + recovery metrics. */
export class WhoopConnector implements Connector {
  readonly provider = "whoop";
  readonly sector = "health";
  // Fallback object when a record sets none; sync() always tags, so this is a floor only.
  readonly objectType = "workout";

  // Poll source: 6h cadence. A 30-day × 3-endpoint backfill at ≤25/page sits well under WHOOP's
  // 100/min, 10k/day budget.
  readonly policy: SyncPolicy = {
    mode: "poll",
    defaultIntervalSec: 21600,
    // Floor 900s: WHOOP's API budget is 100 req/min + 10,000 req/day
    // (developer.whoop.com/docs/developing/rate-limiting/) — a 3-endpoint paged sync every 15 min
    // (96 runs/day, a few hundred calls) sits far under the daily cap.
    minIntervalSec: 900,
    freshnessToleranceSec: 21600,
    supportsIncremental: true,
  };

  // Health is read-only by nature — no actions on the WHOOP side.
  readonly actions: ActionSpec[] = [];

  /**
   * Pull sleep + workout + recovery over one global window (the SimpleFIN overlap pattern). WHOOP has
   * no updated-since (collections sort/filter by record `start`), so a late-scored recovery or edited
   * sleep can land with an older start → re-pull a 3-day overlap each run. First sync (no cursor):
   * [now-30d, now). Incremental: [cursor-3d, now). Every record carries cursor=String(window-end ISO)
   * so the single global cursor advances once per run; the idempotent upsert absorbs the overlap.
   */
  async *sync(ctx: SyncContext): AsyncIterable<RawRecord> {
    const token = ctx.secret;
    if (!token) throw new Error("whoop: missing access token");

    const now = Date.now();
    const cursorMs = parseCursorMs(ctx.cursor);
    const startMs = Number.isFinite(cursorMs) ? cursorMs - OVERLAP_MS : now - BACKFILL_MS;
    const start = new Date(Math.max(0, startMs)).toISOString();
    const end = new Date(now).toISOString();
    const endCursor = end; // String(window end ISO) — advances the global cursor once per run

    // Sleep → health_sleep_sessions.
    for await (const s of fetchAll<WhoopSleep>(token, SLEEP_PATH, start, end)) {
      yield { object: OBJ_SLEEP, externalId: s.id, raw: s, cursor: endCursor };
    }

    // Workout → health_workouts.
    for await (const w of fetchAll<WhoopWorkout>(token, WORKOUT_PATH, start, end)) {
      yield { object: OBJ_WORKOUT, externalId: w.id, raw: w, cursor: endCursor };
    }

    // Recovery → health_samples, fanned out one row PER METRIC (keyed on cycle_id — recovery has no
    // own id). Read score.* ONLY when SCORED; otherwise the value stays null (never written as 0).
    for await (const r of fetchAll<WhoopRecovery>(token, RECOVERY_PATH, start, end)) {
      if (r.cycle_id == null) continue; // no cycle_id → no stable key; skip
      const scored = r.score_state === "SCORED" && r.score != null;
      for (const m of RECOVERY_METRICS) {
        const value = scored ? numericOrNull((r.score as RecoveryScore)[m.field]) : null;
        const raw: RecoveryRaw = {
          ...r,
          __pci_metric: { metric_type: m.metric_type, value, unit: m.unit },
        };
        yield {
          object: OBJ_RECOVERY,
          externalId: `recovery:${r.cycle_id}:${m.metric_type}`,
          raw,
          cursor: endCursor,
        };
      }
    }

    // Cycle (day-strain) → health_samples, fanned out one row PER METRIC (keyed on the cycle id). ONLY
    // SCORED cycles project rows; UNSCORED/PENDING_SCORE carry no score and are skipped SILENTLY (no
    // rows, no error — they simply appear once they score, via the idempotent upsert on a later run).
    for await (const cy of fetchAll<WhoopCycle>(token, CYCLE_PATH, start, end)) {
      if (cy.id == null) continue; // no id → no stable soid; skip (mirrors the recovery cycle_id guard)
      if (cy.score_state !== "SCORED" || cy.score == null) continue; // unscored → nothing
      for (const m of CYCLE_METRICS) {
        const value = numericOrNull((cy.score as CycleScore)[m.field]);
        const raw: CycleRaw = {
          ...cy,
          __pci_metric: { metric_type: m.metric_type, value, unit: m.unit },
          __pci_ns: "cycle",
        };
        yield {
          object: OBJ_CYCLE,
          externalId: `cycle:${cy.id}:${m.metric_type}`,
          raw,
          cursor: endCursor,
        };
      }
    }
  }

  /**
   * Branch on rec.object: sleep_session → SleepSessionRow, workout → WorkoutRow. health_sample carries
   * BOTH recovery and cycle projections (same object string) — the `__pci_ns` marker picks the normalizer.
   */
  normalize(rec: RawRecord): SleepSessionRow | WorkoutRow | HealthSampleRow {
    if (rec.object === OBJ_SLEEP) return normalizeSleep(rec);
    if (rec.object === OBJ_RECOVERY) {
      return isCycleRaw(rec.raw) ? normalizeCycle(rec) : normalizeRecovery(rec);
    }
    return normalizeWorkout(rec); // OBJ_WORKOUT and the objectType fallback
  }

  /**
   * Deterministic strong keys per object: sleep {sleep_id}, workout {workout_id}, recovery
   * {cycle_id, sleep_id}, cycle {cycle_id, metric_type}.
   */
  strongKeys(rec: RawRecord): Record<string, string> {
    if (rec.object === OBJ_SLEEP) {
      const s = rec.raw as WhoopSleep;
      return { sleep_id: String(s.id) };
    }
    if (rec.object === OBJ_RECOVERY) {
      if (isCycleRaw(rec.raw)) {
        const c = rec.raw;
        return { cycle_id: String(c.id), metric_type: c.__pci_metric.metric_type };
      }
      const r = rec.raw as RecoveryRaw;
      const keys: Record<string, string> = {};
      if (r.cycle_id != null) keys.cycle_id = String(r.cycle_id);
      if (r.sleep_id != null) keys.sleep_id = String(r.sleep_id);
      return keys;
    }
    const w = rec.raw as WhoopWorkout;
    return { workout_id: String(w.id) };
  }

  /** Read-only: WHOOP exposes no actions. */
  async execute(): Promise<ActionResult> {
    throw new Error("WhoopConnector has no actions (health is read-only)");
  }
}

/** Map a v2 sleep → SleepSessionRow. Score-derived columns are null unless score_state === SCORED. */
function normalizeSleep(rec: RawRecord): SleepSessionRow {
  const s = rec.raw as WhoopSleep;
  const score = s.score_state === "SCORED" && s.score != null ? s.score : null;
  const stage = score?.stage_summary;
  const inBedMilli = numericOrNull(stage?.total_in_bed_time_milli);
  const awakeMilli = numericOrNull(stage?.total_awake_time_milli);
  return {
    source_object_id: s.id,
    started_at: s.start ?? null,
    ended_at: s.end ?? null,
    is_nap: typeof s.nap === "boolean" ? s.nap : null,
    time_in_bed_seconds: inBedMilli != null ? inBedMilli / 1000 : null,
    time_asleep_seconds:
      inBedMilli != null && awakeMilli != null ? (inBedMilli - awakeMilli) / 1000 : null,
    efficiency_pct: score != null ? numericOrNull(score.sleep_efficiency_percentage) : null,
    respiratory_rate: score != null ? numericOrNull(score.respiratory_rate) : null,
  };
}

/**
 * Map a v2 workout → WorkoutRow. duration_seconds is derived from start/end (present even when
 * unscored); the score-derived columns are null unless score_state === SCORED. kJ → kcal (÷4.184).
 */
function normalizeWorkout(rec: RawRecord): WorkoutRow {
  const w = rec.raw as WhoopWorkout;
  const score = w.score_state === "SCORED" && w.score != null ? w.score : null;
  const startMs = w.start != null ? Date.parse(w.start) : NaN;
  const endMs = w.end != null ? Date.parse(w.end) : NaN;
  const duration =
    Number.isFinite(startMs) && Number.isFinite(endMs) ? (endMs - startMs) / 1000 : null;
  const kj = score != null ? numericOrNull(score.kilojoule) : null;
  return {
    source_object_id: w.id,
    sport: typeof w.sport_name === "string" ? w.sport_name.toLowerCase() : null,
    started_at: w.start ?? null,
    ended_at: w.end ?? null,
    duration_seconds: duration,
    energy_kcal: kj != null ? kj / KJ_PER_KCAL : null,
    distance_meters: score != null ? numericOrNull(score.distance_meter) : null,
    avg_heart_rate: score != null ? numericOrNull(score.average_heart_rate) : null,
    max_heart_rate: score != null ? numericOrNull(score.max_heart_rate) : null,
    strain: score != null ? numericOrNull(score.strain) : null,
  };
}

/**
 * Map a recovery metric → HealthSampleRow. The metric (type/value/unit) is threaded on __pci_metric
 * at sync time; window_start = window_end = created_at (recovery has no start/end; created_at ≈ wake).
 * aggregation="daily_total" keeps an agent from SUMming these against point samples.
 */
function normalizeRecovery(rec: RawRecord): HealthSampleRow {
  const r = rec.raw as RecoveryRaw;
  const m = r.__pci_metric;
  const at = r.created_at ?? null;
  return {
    source_object_id: `recovery:${r.cycle_id}:${m.metric_type}`,
    metric_type: m.metric_type,
    value: m.value,
    unit: m.unit,
    aggregation: "daily_total",
    window_start: at,
    window_end: at,
    source: "whoop",
  };
}

/**
 * Map a cycle metric → HealthSampleRow. The metric (type/value/unit) is threaded on __pci_metric at
 * sync time; UNLIKE recovery (a point-in-time created_at), a cycle IS a time period, so the window is
 * the cycle's own [start, end]. aggregation="daily_total" keeps an agent from SUMming a day aggregate
 * against point samples. The source_object_id lives in the cycle:{id}:{metric} namespace (distinct
 * from recovery:{cycle_id}:… — the two never collide on (connection_id, source_object_id)).
 */
function normalizeCycle(rec: RawRecord): HealthSampleRow {
  const c = rec.raw as CycleRaw;
  const m = c.__pci_metric;
  return {
    source_object_id: `cycle:${c.id}:${m.metric_type}`,
    metric_type: m.metric_type,
    value: m.value,
    unit: m.unit,
    aggregation: "daily_total",
    window_start: c.start ?? null,
    window_end: c.end ?? null,
    source: "whoop",
  };
}

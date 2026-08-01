// Apple Health connector — read-only over DEVICE PUSH (Apple Health → the "Health Auto Export" app →
// POST /api/ingest/:connectionId). There is NO upstream API: the phone pushes the HAE REST JSON to the
// connection's ingest URL, the generic route calls decodePush(), and the result runs through the SAME
// runner path as a pull sync (ingestRecords). So this connector implements ONLY decodePush + the three
// normalizers; it has no sync() pull, no socket, and no fetchRecordLive.
//
// Multi-object (the whoop pattern, ADR 0005): one pushed payload fans out across three domain tables
// via RawRecord.object — metrics → health_samples (one tall row per data-point), sleep_analysis →
// health_sleep_sessions, workouts → health_workouts. The runner routes each record by its EXACT
// REGISTRY `object` string and idempotently upserts on (connection_id, source_object_id).
//
// Idempotency (the critical bit): HAE metrics + sleep carry NO native UUID and the device's
// "Since Last Sync" windows OVERLAP, so re-exports re-deliver the same points. We synthesize a
// DETERMINISTIC source_object_id — sample = "<metric_type>:<window_start ISO>", sleep =
// "sleep:<sleepStart ISO>", workout = workouts[].id (already stable) — so overlapping re-posts upsert
// in place instead of duplicating.
//
// SECURITY: decodePush is PURE (no I/O, no secrets) and never logs. The per-connection webhook secret
// is the edge's auth (verified in src/rest/ingest.ts) — it never reaches this connector. A malformed
// payload throws a generic, payload-free Error (the ingest route maps it to a safe 400).

import type {
  Connector,
  SyncContext,
  RawRecord,
  SyncPolicy,
  ActionSpec,
  ActionResult,
} from "./types.js";

// ── EXACT REGISTRY `object` strings (asymmetric, NB samples is "health_sample" NOT "sample" — the same
//    set whoop uses; tableForObject matches RawRecord.object against the REGISTRY entry's `object`). ──
const OBJ_SAMPLE = "health_sample"; // → health_samples
const OBJ_WORKOUT = "workout"; // → health_workouts
const OBJ_SLEEP = "sleep_session"; // → health_sleep_sessions

const SOURCE = "apple_health"; // health_samples.source value
const SLEEP_METRIC = "sleep_analysis"; // the HAE metric name that maps to a sleep session

// ── Conversion constants ────────────────────────────────────────────────────────
const KJ_PER_KCAL = 4.184; // kilojoule → kcal divisor
const METERS_PER_MILE = 1609.34;
const METERS_PER_KM = 1000;
const SECONDS_PER_HOUR = 3600; // HAE sleep durations arrive in hours

// ── aggregation vocabulary, aligned to the health_samples.aggregation enum ('sample' | 'daily_total';
//    the column is NOT NULL, default 'sample'). Resolves the spec's open question: a bare `qty` point is
//    a single point/interval reading → 'sample'; a Min/Avg/Max statistic is a pre-aggregated window →
//    'daily_total' (mirrors whoop's recovery rows; an agent must never SUM across mixed aggregation). ──
const AGG_SAMPLE = "sample";
const AGG_DAILY = "daily_total";

// ── Normalized row shapes (match the REGISTRY scalar columns; never id/raw — the runner adds those) ──

/** Normalized metric row (matches health_samples) — one per data-point (or per fanned-out statistic). */
export interface HealthSampleRow {
  source_object_id: string;
  metric_type: string;
  value: number | null;
  unit: string | null;
  aggregation: string;
  window_start: string | null;
  window_end: string | null;
  source: string;
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

// ── Health Auto Export raw shapes — the subset we read, parsed defensively ────────
/** A quantity wrapper HAE uses for workout distance/energy: `{ qty, units }`. */
interface HaeQuantity {
  qty?: number;
  units?: string;
  [k: string]: unknown;
}

/** One data-point under a metric: a `qty` reading, OR a Min/Avg/Max statistic, OR a sleep_analysis row. */
interface HaeMetricPoint {
  date?: string;
  qty?: number;
  Min?: number;
  Avg?: number;
  Max?: number;
  // sleep_analysis fields (hours):
  sleepStart?: string;
  sleepEnd?: string;
  inBed?: number;
  asleep?: number;
  [k: string]: unknown;
}

interface HaeMetric {
  name?: string;
  units?: string;
  data?: HaeMetricPoint[];
  [k: string]: unknown;
}

interface HaeWorkout {
  id?: string;
  name?: string;
  start?: string;
  end?: string;
  duration?: number;
  distance?: HaeQuantity;
  activeEnergyBurned?: HaeQuantity;
  heartRate?: { avg?: HaeQuantity; max?: HaeQuantity; [k: string]: unknown };
  [k: string]: unknown;
}

interface HaeBody {
  data?: { metrics?: HaeMetric[]; workouts?: HaeWorkout[] };
  [k: string]: unknown;
}

// ── Per-object raw projections threaded onto RawRecord.raw so normalize() stays a pure read of `raw`
//    (the whoop __pci_metric pattern). The native HAE point/workout is preserved alongside (lossless). ──
type SampleRaw = HaeMetricPoint & { __pci_sample: HealthSampleRow };
type SleepRaw = HaeMetricPoint & { __pci_sleep: SleepSessionRow };
type WorkoutRaw = HaeWorkout & { __pci_workout: WorkoutRow };

/** A finite number passes through; everything else (undefined/null/NaN/non-number) → null. */
function numericOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// HAE emits "yyyy-MM-dd HH:mm:ss Z" (e.g. "2026-06-10 06:00:00 -0700") — NOT strict ISO, so Date.parse
// is unreliable on it. Match it explicitly, rebuild a canonical ISO, and return the UTC ISO string.
const HAE_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*([+-])(\d{2}):?(\d{2})$/;

/** Parse an HAE date to a canonical UTC ISO string. Unparseable/non-string → null. */
function parseHaeDate(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  const m = HAE_DATE_RE.exec(trimmed);
  if (m) {
    const [, year, mon, day, hh, mm, ss, sign, offH, offM] = m;
    const iso = `${year}-${mon}-${day}T${hh}:${mm}:${ss}${sign}${offH}:${offM}`;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  // Fallback: a strict-ISO string, should HAE ever emit one.
  const t = Date.parse(trimmed);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Build a sample RawRecord with a deterministic synthetic id "<metric_type>:<window_start ISO>". */
function makeSample(
  metricType: string,
  value: number | null,
  unit: string | null,
  aggregation: string,
  windowStart: string,
  point: HaeMetricPoint,
): RawRecord {
  const sourceObjectId = `${metricType}:${windowStart}`;
  const projection: HealthSampleRow = {
    source_object_id: sourceObjectId,
    metric_type: metricType,
    value,
    unit,
    aggregation,
    window_start: windowStart,
    window_end: windowStart,
    source: SOURCE,
  };
  const raw: SampleRaw = { ...point, __pci_sample: projection };
  return { object: OBJ_SAMPLE, externalId: sourceObjectId, raw };
}

/**
 * One metric data-point → health_sample row(s). A bare `qty` point is a single row ('sample'); a
 * Min/Avg/Max statistic fans out to <name>_min/_avg/_max rows ('daily_total') — mirrors whoop's
 * recovery fan-out, loses no signal. A point with no parseable date is skipped (no stable key).
 */
function sampleRecords(name: string, unit: string | null, point: HaeMetricPoint): RawRecord[] {
  const windowStart = parseHaeDate(point.date);
  if (windowStart === null) return [];
  const qty = numericOrNull(point.qty);
  const hasStats = point.Min !== undefined || point.Avg !== undefined || point.Max !== undefined;
  if (qty !== null || !hasStats) {
    return [makeSample(name, qty, unit, AGG_SAMPLE, windowStart, point)];
  }
  const records: RawRecord[] = [];
  if (point.Min !== undefined) {
    records.push(makeSample(`${name}_min`, numericOrNull(point.Min), unit, AGG_DAILY, windowStart, point));
  }
  if (point.Avg !== undefined) {
    records.push(makeSample(`${name}_avg`, numericOrNull(point.Avg), unit, AGG_DAILY, windowStart, point));
  }
  if (point.Max !== undefined) {
    records.push(makeSample(`${name}_max`, numericOrNull(point.Max), unit, AGG_DAILY, windowStart, point));
  }
  return records;
}

/** A sleep_analysis data-point → a sleep_session row (hours→seconds; efficiency = asleep/inBed×100). */
function sleepRecord(point: HaeMetricPoint): RawRecord | null {
  const startedAt = parseHaeDate(point.sleepStart);
  if (startedAt === null) return null; // sleepStart is the synthetic key — no key, no row
  const endedAt = parseHaeDate(point.sleepEnd);
  const asleepHours = numericOrNull(point.asleep);
  const inBedHours = numericOrNull(point.inBed);
  const sourceObjectId = `sleep:${startedAt}`;
  const projection: SleepSessionRow = {
    source_object_id: sourceObjectId,
    started_at: startedAt,
    ended_at: endedAt,
    is_nap: null,
    time_asleep_seconds: asleepHours !== null ? asleepHours * SECONDS_PER_HOUR : null,
    time_in_bed_seconds: inBedHours !== null ? inBedHours * SECONDS_PER_HOUR : null,
    efficiency_pct:
      asleepHours !== null && inBedHours !== null && inBedHours > 0
        ? (asleepHours / inBedHours) * 100
        : null,
    respiratory_rate: null, // HAE carries respiratory rate as a SEPARATE metric (→ health_samples)
  };
  const raw: SleepRaw = { ...point, __pci_sleep: projection };
  return { object: OBJ_SLEEP, externalId: sourceObjectId, raw };
}

/** activeEnergyBurned → kcal (÷4.184 only when the native unit is kJ; Apple usually reports kcal). */
function energyKcal(q: HaeQuantity | undefined): number | null {
  const qty = numericOrNull(q?.qty);
  if (qty === null) return null;
  return q?.units === "kJ" ? qty / KJ_PER_KCAL : qty;
}

/** distance → meters (mi→1609.34, km→1000; anything else is assumed to already be meters). */
function distanceMeters(q: HaeQuantity | undefined): number | null {
  const qty = numericOrNull(q?.qty);
  if (qty === null) return null;
  if (q?.units === "mi") return qty * METERS_PER_MILE;
  if (q?.units === "km") return qty * METERS_PER_KM;
  return qty;
}

/** A workout → a workout row, keyed on the native (stable) workouts[].id. */
function workoutRecord(w: HaeWorkout): RawRecord | null {
  const id = typeof w.id === "string" && w.id.length > 0 ? w.id : null;
  if (id === null) return null; // workouts[].id is the stable key — no id, no row
  const projection: WorkoutRow = {
    source_object_id: id,
    sport: typeof w.name === "string" ? w.name.toLowerCase() : null,
    started_at: parseHaeDate(w.start),
    ended_at: parseHaeDate(w.end),
    duration_seconds: numericOrNull(w.duration),
    energy_kcal: energyKcal(w.activeEnergyBurned),
    distance_meters: distanceMeters(w.distance),
    avg_heart_rate: numericOrNull(w.heartRate?.avg?.qty),
    max_heart_rate: numericOrNull(w.heartRate?.max?.qty),
    strain: null, // Apple has no strain analogue
  };
  const raw: WorkoutRaw = { ...w, __pci_workout: projection };
  return { object: OBJ_WORKOUT, externalId: id, raw };
}

/** Apple Health connector (health, read-only, device-push). decodePush is the real work. */
export class AppleHealthConnector implements Connector {
  readonly provider = "apple_health";
  readonly sector = "health";
  // Fallback object when a record sets none; decodePush always tags, so this is a floor only.
  readonly objectType = "health_sample";

  // Push source: no cadence, no start() — startPushConnectors ignores it (no socket to open), the poll
  // scheduler skips it (ADR 0008). Records arrive via decodePush()/ingestRecords.
  // pushKind 'webhook': the device POSTs at will — the Console's "Device controlled" caption (#41).
  readonly policy: SyncPolicy = { mode: "push", pushKind: "webhook", supportsIncremental: false };

  // Health is read-only by nature — no actions on the Apple Health side.
  readonly actions: ActionSpec[] = [];

  /**
   * Decode an HAE REST payload `{ data: { metrics: [...], workouts: [...] } }` into RawRecords across
   * the three health objects. PURE: no I/O, no secrets, never logs. A fundamentally malformed payload
   * (not an object / no `data` object) throws a generic, payload-free Error — the ingest route maps it
   * to a safe 400. Individual bad points (no date, no id) are skipped rather than failing the batch.
   */
  decodePush(rawBody: unknown): RawRecord[] {
    if (rawBody === null || typeof rawBody !== "object") {
      throw new Error("apple_health: malformed push payload");
    }
    const data = (rawBody as HaeBody).data;
    if (data === null || typeof data !== "object") {
      throw new Error("apple_health: malformed push payload");
    }

    const out: RawRecord[] = [];

    const metrics = Array.isArray(data.metrics) ? data.metrics : [];
    for (const metric of metrics) {
      if (metric === null || typeof metric !== "object") continue;
      const name = typeof metric.name === "string" ? metric.name : null;
      if (name === null) continue;
      const points = Array.isArray(metric.data) ? metric.data : [];
      if (name === SLEEP_METRIC) {
        for (const p of points) {
          if (p === null || typeof p !== "object") continue;
          const rec = sleepRecord(p);
          if (rec) out.push(rec);
        }
        continue;
      }
      const unit = typeof metric.units === "string" ? metric.units : null;
      for (const p of points) {
        if (p === null || typeof p !== "object") continue;
        out.push(...sampleRecords(name, unit, p));
      }
    }

    const workouts = Array.isArray(data.workouts) ? data.workouts : [];
    for (const w of workouts) {
      if (w === null || typeof w !== "object") continue;
      const rec = workoutRecord(w);
      if (rec) out.push(rec);
    }

    return out;
  }

  /** No-op: push source, never pulled (no upstream API). Present to satisfy the Connector contract. */
  async *sync(_ctx: SyncContext): AsyncIterable<RawRecord> {
    // intentionally yields nothing
  }

  /** Branch on rec.object: sleep_session → SleepSessionRow, workout → WorkoutRow, else HealthSampleRow. */
  normalize(rec: RawRecord): HealthSampleRow | WorkoutRow | SleepSessionRow {
    if (rec.object === OBJ_SLEEP) return (rec.raw as SleepRaw).__pci_sleep;
    if (rec.object === OBJ_WORKOUT) return (rec.raw as WorkoutRaw).__pci_workout;
    return (rec.raw as SampleRaw).__pci_sample; // OBJ_SAMPLE + the objectType fallback
  }

  /** Deterministic strong keys per object — the synthetic id (samples/sleep) or native id (workout). */
  strongKeys(rec: RawRecord): Record<string, string> {
    if (rec.object === OBJ_WORKOUT) return { workout_id: rec.externalId };
    if (rec.object === OBJ_SLEEP) return { sleep_id: rec.externalId };
    return { sample_id: rec.externalId };
  }

  /** Read-only: Apple Health exposes no actions. */
  async execute(): Promise<ActionResult> {
    throw new Error("AppleHealthConnector has no actions (health is read-only)");
  }
}

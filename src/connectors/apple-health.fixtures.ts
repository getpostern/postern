// Captured Health Auto Export (HAE) REST payloads for fixture-based unit + DB-round-trip tests.
//
// HAE posts `{ data: { metrics: [...], workouts: [...] } }`. Dates are the HAE production string form
// "yyyy-MM-dd HH:mm:ss Z" (e.g. "2026-06-10 06:00:00 -0700") — NOT strict ISO. Metric data-points are
// either a bare `qty` reading or a Min/Avg/Max statistic; sleep_analysis points carry sleepStart/End +
// hour durations; workout distance/energy are `{ qty, units }` wrappers.
//
// Chosen for clean assertions (all offsets -0700 → UTC = wall+7h):
//   heart_rate stat 2026-06-10 12:00:00 -0700  → window 2026-06-10T19:00:00.000Z; Min/Avg/Max 52/68/142
//   step_count qty  2026-06-10 00:00:00 -0700  → window 2026-06-10T07:00:00.000Z; qty 8432
//   sleep  23:00→06:30 (-0700)                 → 2026-06-10T06:00:00Z .. 13:30:00Z; inBed 8h asleep 7h
//          → 28_800s in bed, 25_200s asleep, efficiency 7/8×100 = 87.5
//   workout #1 running 06:00→07:00 (-0700)     → 13:00:00Z..14:00:00Z; 3600s; 5 mi → 8046.7 m;
//          2092 kJ → 500 kcal (2092/4.184); hr avg 140 / max 175
//   workout #2 cycling km + kcal branch        → 20 km → 20_000 m; 600 kcal (no conversion)

/** A full HAE payload: a heart-rate statistic (fans to 3 rows) + a qty metric + sleep + 2 workouts. */
export const HAE_PAYLOAD = {
  data: {
    metrics: [
      {
        name: "heart_rate",
        units: "count/min",
        data: [
          {
            date: "2026-06-10 12:00:00 -0700",
            Min: 52,
            Avg: 68,
            Max: 142,
            source: "Apple Watch",
          },
        ],
      },
      {
        name: "step_count",
        units: "count",
        data: [
          {
            date: "2026-06-10 00:00:00 -0700",
            qty: 8432,
            source: "iPhone",
          },
        ],
      },
      {
        name: "sleep_analysis",
        units: "hr",
        data: [
          {
            date: "2026-06-10 06:30:00 -0700",
            sleepStart: "2026-06-09 23:00:00 -0700",
            sleepEnd: "2026-06-10 06:30:00 -0700",
            inBedStart: "2026-06-09 22:55:00 -0700",
            inBedEnd: "2026-06-10 06:30:00 -0700",
            inBed: 8.0,
            asleep: 7.0,
            core: 4.0,
            deep: 1.5,
            rem: 1.5,
            awake: 0.5,
            source: "Apple Watch",
          },
        ],
      },
    ],
    workouts: [
      {
        id: "AH-WK-0001",
        name: "Running",
        start: "2026-06-10 06:00:00 -0700",
        end: "2026-06-10 07:00:00 -0700",
        duration: 3600,
        distance: { qty: 5, units: "mi" },
        activeEnergyBurned: { qty: 2092, units: "kJ" },
        heartRate: { avg: { qty: 140, units: "count/min" }, max: { qty: 175, units: "count/min" } },
        source: "Apple Watch",
      },
      {
        id: "AH-WK-0002",
        name: "Cycling",
        start: "2026-06-10 17:00:00 -0700",
        end: "2026-06-10 17:45:00 -0700",
        duration: 2700,
        distance: { qty: 20, units: "km" },
        activeEnergyBurned: { qty: 600, units: "kcal" },
        heartRate: { avg: { qty: 128, units: "count/min" }, max: { qty: 156, units: "count/min" } },
        source: "Apple Watch",
      },
    ],
  },
} as const;

// Canonical UTC ISO forms the connector synthesizes (for asserting deterministic source_object_ids).
export const HR_WINDOW_ISO = "2026-06-10T19:00:00.000Z";
export const STEP_WINDOW_ISO = "2026-06-10T07:00:00.000Z";
export const SLEEP_START_ISO = "2026-06-10T06:00:00.000Z";
export const SLEEP_END_ISO = "2026-06-10T13:30:00.000Z";
export const WORKOUT1_START_ISO = "2026-06-10T13:00:00.000Z";
export const WORKOUT1_END_ISO = "2026-06-10T14:00:00.000Z";

// Captured WHOOP v2 records (production string forms) for fixture-based unit + DB-round-trip tests.
//
// v2 uses UUID ids for sleep/workout (recovery has no own id — it's keyed on cycle_id). Times are ISO
// strings; durations are in milliseconds (sleep stage summary) and energy in kilojoule — the connector
// converts milli→seconds and kJ→kcal while keeping the native values in `raw`.
//
// Coverage: a SCORED sleep + a PENDING_SCORE sleep (score-state guard), a SCORED workout + an
// UNSCORABLE workout, a SCORED recovery on a 4.0 strap (spo2 + skin_temp present) and one on a 3.0
// strap (spo2/skin_temp absent → null), a SCORED cycle (day-strain → 4 metric rows) + an UNSCORED
// cycle (proves it's skipped), plus a two-page sleep collection (next_token paging).
//
// Chosen for clean assertions:
//   sleep: total_in_bed=28_800_000ms→28_800s; awake=1_800_000ms; asleep=(28_800_000−1_800_000)/1000=27_000s
//   workout: 06:00→07:00 = 3_600s; kilojoule 4184 → 1000 kcal (4184/4.184)

export const SLEEP_SCORED = {
  id: "0d3f1b9a-1a2b-4c3d-8e9f-000000000a01",
  v1_id: 93845,
  user_id: 10129,
  created_at: "2026-06-10T11:25:44.774Z",
  updated_at: "2026-06-10T14:25:44.774Z",
  start: "2026-06-10T02:00:00.000Z",
  end: "2026-06-10T10:00:00.000Z",
  timezone_offset: "-07:00",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 28_800_000,
      total_awake_time_milli: 1_800_000,
      total_no_data_time_milli: 0,
      total_light_sleep_time_milli: 14_905_851,
      total_slow_wave_sleep_time_milli: 6_630_370,
      total_rem_sleep_time_milli: 5_879_573,
      sleep_cycle_count: 4,
      disturbance_count: 9,
    },
    sleep_needed: {
      baseline_milli: 27_000_000,
      need_from_sleep_debt_milli: 352_230,
      need_from_recent_strain_milli: 208_595,
      need_from_recent_nap_milli: 0,
    },
    respiratory_rate: 15.7,
    sleep_performance_percentage: 94,
    sleep_consistency_percentage: 90,
    sleep_efficiency_percentage: 92.5,
  },
} as const;

// A second scored sleep (different id/window) — used to fill a 2nd page for the paging test.
export const SLEEP_SCORED_PAGE2 = {
  id: "0d3f1b9a-1a2b-4c3d-8e9f-000000000a02",
  v1_id: 93846,
  user_id: 10129,
  created_at: "2026-06-09T11:10:00.000Z",
  updated_at: "2026-06-09T14:10:00.000Z",
  start: "2026-06-09T02:30:00.000Z",
  end: "2026-06-09T09:30:00.000Z",
  timezone_offset: "-07:00",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 25_200_000,
      total_awake_time_milli: 1_200_000,
    },
    respiratory_rate: 15.2,
    sleep_efficiency_percentage: 90.1,
  },
} as const;

// PENDING_SCORE: score is null upstream — every score-derived column must normalize to null (not 0),
// while the non-score fields (start/end/nap) still land.
export const SLEEP_PENDING = {
  id: "0d3f1b9a-1a2b-4c3d-8e9f-000000000a03",
  v1_id: 93847,
  user_id: 10129,
  created_at: "2026-06-11T07:05:00.000Z",
  updated_at: "2026-06-11T07:05:00.000Z",
  start: "2026-06-11T03:00:00.000Z",
  end: "2026-06-11T06:30:00.000Z",
  timezone_offset: "-07:00",
  nap: true,
  score_state: "PENDING_SCORE",
  score: null,
} as const;

export const WORKOUT_SCORED = {
  id: "1e4a2c0b-2b3c-4d5e-9faf-000000000b01",
  v1_id: 1043,
  user_id: 10129,
  created_at: "2026-06-10T08:10:00.000Z",
  updated_at: "2026-06-10T08:15:00.000Z",
  start: "2026-06-10T06:00:00.000Z",
  end: "2026-06-10T07:00:00.000Z",
  timezone_offset: "-07:00",
  sport_name: "Running",
  sport_id: 1,
  score_state: "SCORED",
  score: {
    strain: 12.3,
    average_heart_rate: 140,
    max_heart_rate: 175,
    kilojoule: 4184,
    percent_recorded: 100,
    distance_meter: 5000,
    altitude_gain_meter: 46.64,
    altitude_change_meter: -0.78,
    zone_durations: {
      zone_zero_milli: 0,
      zone_one_milli: 600_000,
      zone_two_milli: 1_200_000,
      zone_three_milli: 1_200_000,
      zone_four_milli: 540_000,
      zone_five_milli: 60_000,
    },
  },
} as const;

// UNSCORABLE: score null — score-derived columns null, but duration still derives from start/end.
export const WORKOUT_UNSCORABLE = {
  id: "1e4a2c0b-2b3c-4d5e-9faf-000000000b02",
  v1_id: 1044,
  user_id: 10129,
  created_at: "2026-06-09T18:40:00.000Z",
  updated_at: "2026-06-09T18:45:00.000Z",
  start: "2026-06-09T18:00:00.000Z",
  end: "2026-06-09T18:30:00.000Z",
  timezone_offset: "-07:00",
  sport_name: "Walking",
  sport_id: 63,
  score_state: "UNSCORABLE",
  score: null,
} as const;

// SCORED recovery, 4.0 strap (spo2 + skin_temp present).
export const RECOVERY_SCORED = {
  cycle_id: 12345,
  sleep_id: "0d3f1b9a-1a2b-4c3d-8e9f-000000000a01",
  user_id: 10129,
  created_at: "2026-06-10T13:00:00.000Z",
  updated_at: "2026-06-10T13:05:00.000Z",
  score_state: "SCORED",
  score: {
    user_calibrating: false,
    recovery_score: 66,
    resting_heart_rate: 55,
    hrv_rmssd_milli: 42.5,
    spo2_percentage: 97.2,
    skin_temp_celsius: 33.5,
  },
} as const;

// SCORED recovery, 3.0 strap (no spo2/skin_temp → those metric rows carry value null).
export const RECOVERY_NO_SPO2 = {
  cycle_id: 12346,
  sleep_id: "0d3f1b9a-1a2b-4c3d-8e9f-000000000a02",
  user_id: 10129,
  created_at: "2026-06-09T12:50:00.000Z",
  updated_at: "2026-06-09T12:55:00.000Z",
  score_state: "SCORED",
  score: {
    user_calibrating: false,
    recovery_score: 71,
    resting_heart_rate: 52,
    hrv_rmssd_milli: 55.0,
  },
} as const;

// SCORED physiological cycle (day-strain). Real v2 `GET /v2/cycle` shape: an integer `id`, ISO
// start/end (a cycle IS a time period), and a `score` present ONLY when score_state === "SCORED"
// (WHOOP writes no partial score). Fans into FOUR health_samples rows: day_strain / day_average_heart_rate
// / day_max_heart_rate / day_kilojoule (units strain/bpm/bpm/kJ; kJ kept faithful, not kcal).
export const CYCLE_SCORED = {
  id: 93845,
  user_id: 10129,
  created_at: "2026-06-10T02:05:00.000Z",
  updated_at: "2026-06-10T20:00:00.000Z",
  start: "2026-06-10T02:00:00.000Z",
  end: "2026-06-10T20:00:00.000Z",
  timezone_offset: "-07:00",
  score_state: "SCORED",
  score: {
    strain: 14.2,
    kilojoule: 8368,
    average_heart_rate: 72,
    max_heart_rate: 165,
  },
} as const;

// UNSCORED cycle (the in-progress current day): score_state !== "SCORED" and NO score. Must produce
// ZERO health_samples rows (skipped silently — no rows, no error) until it scores on a later sync.
export const CYCLE_UNSCORED = {
  id: 93846,
  user_id: 10129,
  created_at: "2026-06-11T02:00:00.000Z",
  updated_at: "2026-06-11T09:00:00.000Z",
  start: "2026-06-11T02:00:00.000Z",
  end: null,
  timezone_offset: "-07:00",
  score_state: "PENDING_SCORE",
  score: null,
} as const;

/** Build a v2 collection page envelope: `{ records, next_token }`. */
export function whoopPage<T>(records: T[], nextToken: string | null = null): {
  records: T[];
  next_token: string | null;
} {
  return { records, next_token: nextToken };
}
